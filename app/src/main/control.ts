/**
 * Controle remoto: aplica no Windows os cliques, movimentos e teclas que um amigo autorizado
 * envia enquanto assiste à transmissão. Só roda no computador de quem cedeu o controle.
 *
 * Regras de segurança aplicadas aqui (e não só na tela):
 *  - janela compartilhada: os comandos só valem enquanto ELA está em primeiro plano;
 *  - tecla Windows, Alt+Tab, Alt+Esc, Ctrl+Esc, Alt+F4 e Ctrl+Alt+Del nunca são enviadas;
 *  - ao parar, toda tecla e botão ainda apertados são soltos.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Target = { kind: 'window'; hwnd: number } | { kind: 'screen'; rect: Rect };
/** ['m',x,y] posição 0..1 · ['r',dx,dy] movimento relativo · ['d'|'u',botão] · ['w',dx,dy] roda · ['k',code,1|0] tecla */
export type InputEvent = [string, ...(string | number)[]];

declare const require: (id: string) => any;

// Códigos de varredura (scan codes, conjunto 1) por KeyboardEvent.code. Jogos leem estes códigos.
const SCAN: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58, IntlRo: 0x73, NumpadComma: 0x7e,
};
// Teclas "estendidas" (prefixo E0).
const SCAN_EXT: Record<string, number> = {
  NumpadEnter: 0x1c, ControlRight: 0x1d, NumpadDivide: 0x35, AltRight: 0x38, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49,
  ArrowLeft: 0x4b, ArrowRight: 0x4d, End: 0x4f, ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
};

const MOUSE = { MOVE: 0x1, ABSOLUTE: 0x8000, VIRTUALDESK: 0x4000, WHEEL: 0x800, HWHEEL: 0x1000 };
// botão do navegador → [apertar, soltar, mouseData]
const BUTTONS: Record<number, [number, number, number]> = {
  0: [0x2, 0x4, 0], 1: [0x20, 0x40, 0], 2: [0x8, 0x10, 0], 3: [0x80, 0x100, 1], 4: [0x80, 0x100, 2],
};

interface Api {
  mouse(dx: number, dy: number, data: number, flags: number): void;
  key(scan: number, flags: number): void;
  foreground(): number;
  focus(hwnd: number): void;
  isWindow(hwnd: number): boolean;
  windowRect(hwnd: number): Rect | null;
  virtualScreen(): Rect;
}

let api: Api | null | undefined;

function load(): Api | null {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwm = koffi.load('dwmapi.dll');

    // INPUT tem 40 bytes em 64 bits; em vez da união do C, declaramos uma forma para mouse e outra para teclado.
    const MouseInput = koffi.struct('ConcordMouseInput', {
      type: 'uint32', _p: 'uint32', dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
    });
    const KeyInput = koffi.struct('ConcordKeyInput', {
      type: 'uint32', _p: 'uint32', wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
      pad: koffi.array('uint8', 8),
    });
    const RECT = koffi.struct('ConcordRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    if (koffi.sizeof(MouseInput) !== 40 || koffi.sizeof(KeyInput) !== 40) throw new Error('tamanho de INPUT inesperado');

    const sendMouse = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(MouseInput), 'int']);
    const sendKey = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(KeyInput), 'int']);
    const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []);
    const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'int', ['uintptr_t']);
    const IsWindow = user32.func('__stdcall', 'IsWindow', 'int', ['uintptr_t']);
    const IsIconic = user32.func('__stdcall', 'IsIconic', 'int', ['uintptr_t']);
    const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int', ['uintptr_t', 'int']);
    const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
    const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
    const DwmGetWindowAttribute = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32',
      ['uintptr_t', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']);

    const toRect = (r: { left: number; top: number; right: number; bottom: number }): Rect | null =>
      r.right > r.left && r.bottom > r.top ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null;

    api = {
      mouse: (dx, dy, data, flags) => {
        sendMouse(1, [{ type: 0, _p: 0, dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 }], 40);
      },
      key: (scan, flags) => {
        sendKey(1, [{ type: 1, _p: 0, wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0, pad: new Array(8).fill(0) }], 40);
      },
      foreground: () => Number(GetForegroundWindow()),
      focus: (hwnd) => {
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
        SetForegroundWindow(hwnd);
      },
      isWindow: (hwnd) => Boolean(IsWindow(hwnd)),
      windowRect: (hwnd) => {
        // Limites visíveis de verdade (sem a sombra invisível); é o que a captura da janela mostra.
        const r = { left: 0, top: 0, right: 0, bottom: 0 };
        if (DwmGetWindowAttribute(hwnd, 9, r, 16) === 0) return toRect(r);
        return GetWindowRect(hwnd, r) ? toRect(r) : null;
      },
      virtualScreen: () => ({ x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) }),
    };
  } catch (e) {
    console.error('controle remoto indisponível', e);
    api = null;
  }
  return api;
}

export const controlAvailable = (): boolean => load() !== null;

let target: Target | null = null;
const keysDown = new Set<string>();
const buttonsDown = new Set<number>();

/** 'window:1234:0' → identificador da janela. */
export function windowOfSource(sourceId: string): number | null {
  const m = /^window:(\d+):/.exec(sourceId);
  return m ? Number(m[1]) : null;
}

export function startControl(t: Target): { ok: boolean; error?: string } {
  const a = load();
  if (!a) return { ok: false, error: 'O controle remoto só funciona no app de computador para Windows.' };
  if (t.kind === 'window') {
    if (!a.isWindow(t.hwnd)) return { ok: false, error: 'A janela transmitida não existe mais.' };
    a.focus(t.hwnd);
  }
  stopControl();
  target = t;
  return { ok: true };
}

export function stopControl(): void {
  const a = load();
  if (a && target) {
    for (const code of keysDown) sendKey(a, code, false);
    for (const b of buttonsDown) a.mouse(0, 0, BUTTONS[b][2], BUTTONS[b][1]);
  }
  keysDown.clear();
  buttonsDown.clear();
  target = null;
}

export const controlActive = (): boolean => target !== null;

function sendKey(a: Api, code: string, down: boolean): void {
  const ext = SCAN_EXT[code];
  const scan = ext ?? SCAN[code];
  if (!scan) return;
  a.key(scan, 0x8 | (down ? 0 : 0x2) | (ext ? 0x1 : 0));
}

const has = (...codes: string[]) => codes.some((c) => keysDown.has(c));

/** Teclas e combinações que tirariam o amigo de dentro do jogo ou mexeriam no Windows. */
function blocked(code: string): boolean {
  if (code === 'MetaLeft' || code === 'MetaRight') return true;
  const alt = has('AltLeft', 'AltRight');
  const ctrl = has('ControlLeft', 'ControlRight');
  if (alt && (code === 'Tab' || code === 'Escape' || code === 'F4')) return true;
  if (ctrl && code === 'Escape') return true;
  if (ctrl && alt && code === 'Delete') return true;
  return false;
}

const num = (v: unknown, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};

/**
 * Aplica um lote de comandos. Devolve 'unfocused' quando a janela cedida não está em primeiro
 * plano (nada é aplicado), 'gone' quando ela foi fechada e 'ok' no resto.
 */
export function applyInput(events: InputEvent[]): 'ok' | 'unfocused' | 'gone' | 'off' {
  const a = load();
  const t = target;
  if (!a || !t) return 'off';

  let rect: Rect | null;
  if (t.kind === 'window') {
    if (!a.isWindow(t.hwnd)) return 'gone';
    if (a.foreground() !== t.hwnd) {
      // Soltar o que ficou apertado evita tecla "presa" em outra janela.
      if (keysDown.size || buttonsDown.size) {
        const keep = target;
        stopControl();
        target = keep;
      }
      return 'unfocused';
    }
    rect = a.windowRect(t.hwnd);
  } else {
    rect = t.rect;
  }

  for (const ev of events.slice(0, 200)) {
    if (!Array.isArray(ev)) continue;
    switch (ev[0]) {
      case 'm': {
        if (!rect) break;
        const v = a.virtualScreen();
        const px = rect.x + num(ev[1], 0, 1) * (rect.w - 1);
        const py = rect.y + num(ev[2], 0, 1) * (rect.h - 1);
        const nx = Math.round(((px - v.x) * 65535) / Math.max(1, v.w - 1));
        const ny = Math.round(((py - v.y) * 65535) / Math.max(1, v.h - 1));
        a.mouse(nx, ny, 0, MOUSE.MOVE | MOUSE.ABSOLUTE | MOUSE.VIRTUALDESK);
        break;
      }
      case 'r':
        a.mouse(Math.round(num(ev[1], -600, 600)), Math.round(num(ev[2], -600, 600)), 0, MOUSE.MOVE);
        break;
      case 'd':
      case 'u': {
        const b = Number(ev[1]);
        const def = BUTTONS[b];
        if (!def) break;
        if (ev[0] === 'd') {
          buttonsDown.add(b);
          a.mouse(0, 0, def[2], def[0]);
        } else if (buttonsDown.delete(b)) {
          a.mouse(0, 0, def[2], def[1]);
        }
        break;
      }
      case 'w': {
        // Navegador: 100 por "clique" da roda, positivo para baixo. Windows: 120, positivo para cima.
        const dy = Math.round(num(ev[2], -2000, 2000) * -1.2);
        const dx = Math.round(num(ev[1], -2000, 2000) * 1.2);
        if (dy) a.mouse(0, 0, dy, MOUSE.WHEEL);
        if (dx) a.mouse(0, 0, dx, MOUSE.HWHEEL);
        break;
      }
      case 'k': {
        const code = String(ev[1]);
        if (ev[2]) {
          if (blocked(code)) break;
          keysDown.add(code);
          sendKey(a, code, true);
        } else if (keysDown.delete(code)) {
          sendKey(a, code, false);
        }
        break;
      }
    }
  }
  return 'ok';
}

/** Só para o teste em scripts/control-test.mjs. */
export const _test = { load, blocked, keysDown };
