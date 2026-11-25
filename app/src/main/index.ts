import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';

let win: BrowserWindow | null = null;
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

// ------------------------------------------------------------------ captura de tela

/** Tela ou janela escolhida no seletor do app, usada no próximo pedido de captura. */
let captureChoice: { id: string; audio: boolean } | null = null;

function setupCapture(): void {
  ipcMain.handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  ipcMain.handle('capture:choose', (_e, id: unknown, audio: unknown) => {
    captureChoice = { id: String(id), audio: Boolean(audio) };
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const choice = captureChoice;
    captureChoice = null;
    try {
      const sources = choice ? await desktopCapturer.getSources({ types: ['screen', 'window'] }) : [];
      const source = sources.find((s) => s.id === choice?.id);
      if (!source) return callback({});
      if (!choice!.audio) return callback({ video: source });
      // 'loopbackWithoutChrome' captura o som do computador SEM o som do próprio Concord,
      // o que elimina o eco da voz dos amigos na transmissão (ver scripts/echo-test.cjs).
      try {
        callback({ video: source, audio: 'loopbackWithoutChrome' as 'loopback' });
      } catch {
        callback({ video: source, audio: 'loopback' });
      }
    } catch {
      callback({});
    }
  });
}

// ------------------------------------------------------------------ apertar para falar (atalho global)

type Hook = typeof import('uiohook-napi');
type PttKey = { type: 'key' | 'mouse'; code: number };

let hook: Hook['uIOhook'] | null = null;
let hookRunning = false;
let pttKey: PttKey | null = null;
let pttDown = false;
let capture: ((key: PttKey | null) => void) | null = null;

function loadHook(): Hook['uIOhook'] | null {
  if (hook) return hook;
  try {
    // Módulo nativo: se não carregar neste computador, o app segue sem o atalho global.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    hook = (require('uiohook-napi') as Hook).uIOhook;
    const setDown = (down: boolean) => {
      if (down === pttDown) return;
      pttDown = down;
      send('ptt:state', down);
    };
    const matches = (type: PttKey['type'], code: number) => pttKey?.type === type && pttKey.code === code;

    hook.on('keydown', (e) => {
      if (capture) return finishCapture({ type: 'key', code: e.keycode });
      if (matches('key', e.keycode)) setDown(true);
    });
    hook.on('keyup', (e) => matches('key', e.keycode) && setDown(false));
    hook.on('mousedown', (e) => {
      const button = Number(e.button);
      // Botões 1 e 2 (esquerdo/direito) não podem virar tecla de falar.
      if (capture && button > 2) return finishCapture({ type: 'mouse', code: button });
      if (matches('mouse', button)) setDown(true);
    });
    hook.on('mouseup', (e) => matches('mouse', Number(e.button)) && setDown(false));
    return hook;
  } catch (e) {
    console.error('uiohook indisponível', e);
    return null;
  }
}

/** O gancho global só fica ligado enquanto é necessário. */
function syncHook(): void {
  const needed = Boolean(pttKey) || Boolean(capture);
  if (needed === hookRunning) return;
  const h = loadHook();
  if (!h) return;
  try {
    if (needed) h.start();
    else h.stop();
    hookRunning = needed;
  } catch (e) {
    console.error('uiohook start/stop', e);
  }
}

function finishCapture(key: PttKey | null): void {
  const done = capture;
  capture = null;
  done?.(key);
  syncHook();
}

function setupPtt(): void {
  ipcMain.handle('ptt:configure', (_e, key: PttKey | null) => {
    pttKey = key && (key.type === 'key' || key.type === 'mouse') ? { type: key.type, code: Number(key.code) } : null;
    if (!pttKey && pttDown) {
      pttDown = false;
      send('ptt:state', false);
    }
    syncHook();
    return hookRunning || !pttKey;
  });
  ipcMain.handle('ptt:capture', () =>
    new Promise<PttKey | null>((resolve) => {
      capture?.(null);
      capture = resolve;
      syncHook();
      if (!hookRunning) return finishCapture(null);
      setTimeout(() => capture === resolve && finishCapture(null), 10_000);
    }),
  );
}

// ------------------------------------------------------------------ atualização automática

function setupUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (i) => send('update:status', { state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'none' }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send('update:status', { state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => send('update:status', { state: 'error', message: e.message.split('\n')[0] }));

  const check = () => {
    if (!app.isPackaged) return send('update:status', { state: 'none' });
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  ipcMain.handle('update:version', () => app.getVersion());
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:download', () => void autoUpdater.downloadUpdate().catch(() => undefined));
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));

  setTimeout(check, 5000);
  setInterval(check, 2 * 60 * 60 * 1000);
}

// ------------------------------------------------------------------ janela

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#120e1d',
    autoHideMenuBar: true,
    title: 'Concord',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A voz precisa continuar em tempo real com a janela minimizada ou atrás do jogo.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  win.on('closed', () => (win = null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  void app.whenReady().then(() => {
    setupCapture();
    setupPtt();
    setupUpdater();
    createWindow();
  });
  app.on('will-quit', () => {
    try {
      if (hookRunning) hook?.stop();
    } catch {
      /* encerrando */
    }
  });
  app.on('window-all-closed', () => app.quit());
}
