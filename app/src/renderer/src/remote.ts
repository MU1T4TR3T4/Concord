/**
 * Controle remoto (estilo TeamViewer) em cima da transmissão de tela.
 *
 * Quem transmite ("host") escolhe UMA pessoa da sala para mexer na tela ou janela transmitida.
 * Quem controla captura mouse e teclado sobre o vídeo e envia os comandos por uma ligação direta
 * entre os dois aparelhos (WebRTC, sem passar por servidor). Se a ligação direta não abrir,
 * os comandos passam pelo servidor do Concord, um pouco mais devagar.
 */
import { getState, patch, remoteHooks, request, sendNow } from './store';
import { shareSourceId } from './voice';

type Ev = [string, ...(string | number)[]];

const ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const signal = (to: string, data: unknown) => request('rc.signal', { to, data }).catch(() => undefined);
const setControl = (change: Partial<NonNullable<ReturnType<typeof getState>['control']>>) => {
  const cur = getState().control;
  if (cur) patch({ control: { ...cur, ...change } });
};

let pc: RTCPeerConnection | null = null;
let watchTimer: ReturnType<typeof setInterval> | undefined;

function closePeer(): void {
  try {
    pc?.close();
  } catch {
    /* já fechada */
  }
  pc = null;
}

// ------------------------------------------------------------------ quem cede a tela

/** Este aparelho consegue ceder o controle? (app de computador para Windows) */
export let canHostControl = false;
void window.concord?.control?.available().then((ok) => {
  canHostControl = ok;
  patch({ mediaRev: getState().mediaRev + 1 });
}).catch(() => undefined);

export async function grantControl(userId: string): Promise<void> {
  const api = window.concord?.control;
  const source = shareSourceId();
  if (!api || !canHostControl) throw new Error('Ceder o controle só funciona no app de computador para Windows.');
  if (!source) throw new Error('Comece a transmitir a tela antes de dar o controle.');
  const res = await api.start(source);
  if (!res.ok) throw new Error(res.error ?? 'Não foi possível ativar o controle.');
  try {
    await request('rc.grant', { userId });
  } catch (e) {
    void api.stop();
    throw e;
  }
  closePeer();
  patch({ control: { role: 'host', peer: userId, link: 'ligando', focused: true } });
  clearInterval(watchTimer);
  // Qualquer coisa que mude (parei de transmitir, saí da sala, a pessoa saiu) corta o controle.
  watchTimer = setInterval(() => {
    const s = getState();
    const c = s.control;
    if (c?.role !== 'host') return;
    const room = s.myVoice ? s.voice[s.myVoice.channelId] ?? [] : [];
    if (!s.sharing || !s.myVoice || !room.some((p) => p.userId === c.peer)) void revokeControl();
  }, 1000);
}

export async function revokeControl(note?: string): Promise<void> {
  if (getState().control?.role !== 'host') return;
  clearInterval(watchTimer);
  closePeer();
  patch({ control: null, ...(note ? { notice: note } : {}) });
  void window.concord?.control?.stop();
  await request('rc.revoke').catch(() => undefined);
}

function hostApply(events: unknown): void {
  if (getState().control?.role !== 'host' || !Array.isArray(events)) return;
  window.concord?.control?.input(events);
}

async function hostAnswer(from: string, data: any): Promise<void> {
  const c = getState().control;
  if (c?.role !== 'host' || c.peer !== from) return;
  if (data?.type === 'offer') {
    closePeer();
    const conn = new RTCPeerConnection({ iceServers: ICE });
    pc = conn;
    conn.onicecandidate = (e) => e.candidate && void signal(from, { type: 'ice', candidate: e.candidate.toJSON() });
    conn.ondatachannel = (e) => {
      e.channel.onmessage = (m) => {
        try {
          hostApply(JSON.parse(String(m.data)));
        } catch {
          /* mensagem inválida */
        }
      };
      e.channel.onopen = () => pc === conn && setControl({ link: 'direta' });
      e.channel.onclose = () => pc === conn && setControl({ link: 'servidor' });
    };
    await conn.setRemoteDescription(data.sdp);
    await conn.setLocalDescription(await conn.createAnswer());
    void signal(from, { type: 'answer', sdp: conn.localDescription });
  } else if (data?.type === 'ice' && pc) {
    await pc.addIceCandidate(data.candidate).catch(() => undefined);
  }
}

window.concord?.control?.onState((state) => {
  if (getState().control?.role === 'host') setControl({ focused: state !== 'unfocused' });
});
window.concord?.control?.onEnded((reason) => {
  void revokeControl(reason === 'hotkey' ? 'Controle remoto encerrado pelo atalho Ctrl+Shift+F12.' : 'A janela transmitida fechou; o controle remoto foi encerrado.');
});

// ------------------------------------------------------------------ quem controla

let hostId: string | null = null;
let area: HTMLElement | null = null;
let video: HTMLVideoElement | null = null;
let moveCh: RTCDataChannel | null = null;
let keyCh: RTCDataChannel | null = null;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let queue: Ev[] = [];
let absMove: [number, number] | null = null;
let relMove: [number, number] = [0, 0];
let lastRelay = 0;
const held = new Set<string>();
const heldButtons = new Set<number>();
const cleanup: (() => void)[] = [];

const direct = () => keyCh?.readyState === 'open' && moveCh?.readyState === 'open';

function flush(): void {
  if (!hostId) return;
  const moves: Ev[] = [];
  if (absMove) moves.push(['m', absMove[0], absMove[1]]);
  if (relMove[0] || relMove[1]) moves.push(['r', relMove[0], relMove[1]]);

  if (direct()) {
    absMove = null;
    relMove = [0, 0];
    if (queue.length) {
      // Cliques e teclas vão pelo canal garantido, junto com a última posição do mouse.
      keyCh!.send(JSON.stringify([...moves, ...queue]));
      queue = [];
    } else if (moves.length) {
      moveCh!.send(JSON.stringify(moves));
    }
    return;
  }
  // Reserva pelo servidor: no máximo ~30 envios por segundo.
  const now = performance.now();
  if (!moves.length && !queue.length) return;
  if (!queue.length && now - lastRelay < 33) return;
  lastRelay = now;
  absMove = null;
  relMove = [0, 0];
  sendNow('rc.input', { to: hostId, e: [...moves, ...queue] });
  queue = [];
}

/** Posição do ponteiro dentro da imagem (0..1), descontando as faixas pretas do vídeo. */
function position(e: MouseEvent): [number, number] | null {
  if (!video || !video.videoWidth) return null;
  const box = video.getBoundingClientRect();
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const x = (e.clientX - box.left - (box.width - w) / 2) / w;
  const y = (e.clientY - box.top - (box.height - h) / 2) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
}

async function connect(host: string): Promise<void> {
  closePeer();
  const conn = new RTCPeerConnection({ iceServers: ICE });
  pc = conn;
  // Movimento do mouse: sem reenvio (um pacote perdido não trava os seguintes). Teclas e cliques: garantidos.
  moveCh = conn.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
  keyCh = conn.createDataChannel('keys', { ordered: true });
  keyCh.onopen = () => pc === conn && setControl({ link: 'direta' });
  keyCh.onclose = () => pc === conn && setControl({ link: 'servidor' });
  conn.onicecandidate = (e) => e.candidate && void signal(host, { type: 'ice', candidate: e.candidate.toJSON() });
  await conn.setLocalDescription(await conn.createOffer());
  void signal(host, { type: 'offer', sdp: conn.localDescription });
  // Se em 5 s a ligação direta não abrir, segue pelo servidor.
  setTimeout(() => pc === conn && !direct() && setControl({ link: 'servidor' }), 5000);
}

function on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Document | Window, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions): void {
  el.addEventListener(type, fn as EventListener, opts);
  cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
}

/** Começa a controlar: `el` é a moldura do vídeo (vai para tela cheia) e `v` o vídeo da transmissão. */
export async function beginControl(host: string, el: HTMLElement, v: HTMLVideoElement): Promise<void> {
  if (getState().control) return;
  hostId = host;
  area = el;
  video = v;
  queue = [];
  absMove = null;
  relMove = [0, 0];
  patch({ control: { role: 'controller', peer: host, link: 'ligando', gameMouse: false } });
  void connect(host);

  const locked = () => document.pointerLockElement === el;
  const key = (e: KeyboardEvent, down: boolean) => {
    // F8 fica com o Concord: liga e desliga o "mouse de jogo".
    if (e.code === 'F8') {
      e.preventDefault();
      if (down && !e.repeat) toggleGameMouse();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (down) held.add(e.code);
    else held.delete(e.code);
    queue.push(['k', e.code, down ? 1 : 0]);
  };
  on(window, 'keydown', (e: KeyboardEvent) => key(e, true), { capture: true });
  on(window, 'keyup', (e: KeyboardEvent) => key(e, false), { capture: true });
  on(el, 'mousemove', (e: MouseEvent) => {
    if (locked()) {
      relMove = [relMove[0] + e.movementX, relMove[1] + e.movementY];
    } else {
      const p = position(e);
      if (p) absMove = p;
    }
  });
  on(el, 'mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.control-hud button')) return;
    e.preventDefault();
    if (!locked()) {
      const p = position(e);
      if (!p) return;
      absMove = p;
    }
    heldButtons.add(e.button);
    queue.push(['d', e.button]);
  });
  on(window, 'mouseup', (e: MouseEvent) => {
    if (!heldButtons.delete(e.button)) return;
    queue.push(['u', e.button]);
  });
  on(el, 'wheel', (e: WheelEvent) => {
    e.preventDefault();
    queue.push(['w', Math.round(e.deltaX), Math.round(e.deltaY)]);
  }, { passive: false });
  on(el, 'contextmenu', (e: Event) => e.preventDefault());
  on(document, 'pointerlockchange', () => setControl({ gameMouse: locked() }));
  // Sair da tela cheia (segurar Esc) ou trocar de janela encerra o controle e solta as teclas.
  on(document, 'fullscreenchange', () => {
    if (document.fullscreenElement !== el) endControl();
  });
  on(window, 'blur', () => releaseHeld());

  flushTimer = setInterval(flush, 8);
  try {
    await el.requestFullscreen();
    // Em tela cheia o navegador entrega Esc, Alt+Tab etc. para a página em vez de agir sozinho.
    await (navigator as any).keyboard?.lock?.().catch(() => undefined);
  } catch {
    /* sem tela cheia o controle continua, só que dentro da janela */
  }
}

function releaseHeld(): void {
  for (const code of held) queue.push(['k', code, 0]);
  for (const b of heldButtons) queue.push(['u', b]);
  held.clear();
  heldButtons.clear();
  flush();
}

export function toggleGameMouse(): void {
  if (!area) return;
  if (document.pointerLockElement === area) document.exitPointerLock();
  else void (area.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => undefined);
}

export function endControl(note?: string): void {
  if (getState().control?.role !== 'controller') return;
  releaseHeld();
  clearInterval(flushTimer);
  for (const off of cleanup.splice(0)) off();
  (navigator as any).keyboard?.unlock?.();
  if (document.pointerLockElement) document.exitPointerLock();
  if (area && document.fullscreenElement === area) void document.exitFullscreen().catch(() => undefined);
  closePeer();
  moveCh = keyCh = null;
  hostId = null;
  area = video = null;
  patch({ control: null, ...(note ? { notice: note } : {}) });
}

// ------------------------------------------------------------------ ligação com a store

remoteHooks.signal = (from, data) => {
  const c = getState().control;
  if (c?.role === 'host') return void hostAnswer(from, data).catch(() => undefined);
  if (c?.role !== 'controller' || c.peer !== from || !pc) return;
  if (data?.type === 'answer') void pc.setRemoteDescription(data.sdp).catch(() => undefined);
  else if (data?.type === 'ice') void pc.addIceCandidate(data.candidate).catch(() => undefined);
};
remoteHooks.input = (from, events) => {
  if (getState().control?.peer === from) hostApply(events);
};
remoteHooks.ended = (host) => {
  const c = getState().control;
  if (c?.role === 'controller' && c.peer === host) endControl('O controle da tela foi encerrado por quem estava transmitindo.');
};

if (import.meta.env.DEV) (window as any).__remote = { direct, peer: () => pc, setHost: (v: boolean) => (canHostControl = v) };
