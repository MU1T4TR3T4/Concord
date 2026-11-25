import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';

let win: BrowserWindow | null = null;

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
      // 'loopback' captura o áudio que sai do computador (só existe no Windows).
      callback(choice!.audio ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      callback({});
    }
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#12151a',
    autoHideMenuBar: true,
    title: 'Concord',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
