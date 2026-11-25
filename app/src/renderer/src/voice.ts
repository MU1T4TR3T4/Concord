// Motor de voz e transmissão de tela: uma conexão WebRTC com o SFU da Cloudflare por sala.
// O servidor do Concord repassa as chamadas ao SFU (o segredo nunca chega ao aplicativo).
import { getState, patch, request, soundUrl, voiceHooks, type PttKey, type Settings, type UpdateStatus } from './store';

export type Quality = '720p30' | '1080p30' | '1080p60';

const QUALITY: Record<Quality, { w: number; h: number; fps: number; bitrate: number }> = {
  '720p30': { w: 1280, h: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 5_000_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 8_000_000 },
};

interface CaptureSource {
  id: string;
  name: string;
  thumbnail: string;
}

declare global {
  interface Window {
    /** Ponte exposta pelo app Android (WebView). Não existe no navegador nem no computador. */
    ConcordNative?: {
      startShare(width: number, height: number, fps: number, bitrate: number): void;
      setAnswer(sdp: string): void;
      stopShare(): void;
      setInCall(inCall: boolean): void;
    };
    /** Chamadas que o app Android faz de volta para a página. */
    __concordNative?: {
      onOffer(sdp: string, mid: string): void;
      onShareError(message: string): void;
      onShareStopped(): void;
      back(): boolean;
    };
    concord?: {
      desktop: boolean;
      capture: {
        sources(): Promise<CaptureSource[]>;
        choose(id: string, audio: boolean): Promise<void>;
      };
      ptt: {
        configure(key: { type: 'key' | 'mouse'; code: number } | null): Promise<boolean>;
        capture(): Promise<{ type: 'key' | 'mouse'; code: number } | null>;
        onState(cb: (down: boolean) => void): void;
      };
      invite: {
        pending(): Promise<string | null>;
        onInvite(cb: (url: string) => void): void;
      };
      update: {
        version(): Promise<string>;
        check(): Promise<void>;
        download(): Promise<void>;
        install(): Promise<void>;
        onStatus(cb: (status: UpdateStatus) => void): void;
      };
    };
  }
}

interface Pulled {
  key: string;
  mid: string;
  userId: string;
  trackName: string;
}

const ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const isScreen = (t: string) => t.startsWith('screen');
const isScreenAudio = (t: string) => t.startsWith('screen-audio');

let gen = 0; // muda a cada entrada/saída; operações antigas se cancelam ao notar
let pc: RTCPeerConnection | null = null;
let channelId: string | null = null;
let mySid: string | null = null;
let share: { stream: MediaStream; mids: string[]; names: string[] } | null = null;
let shareSeq = 0;
/** Transmissão feita pelo app Android: o vídeo sai por uma conexão nativa, fora desta página. */
let nativeShare: { names: string[] } | null = null;
let nativeWaiting: { resolve: () => void; reject: (e: Error) => void } | null = null;
let retries = 0;
let queue: Promise<void> = Promise.resolve();

const pulled = new Map<string, Pulled>();
const byMid = new Map<string, Pulled>();
const audioEls = new Map<string, HTMLAudioElement>();
const screenStreams = new Map<string, MediaStream>();

const sfu = (action: string, body?: unknown) => request<any>('voice.sfu', { action, body });
const bump = () => patch({ mediaRev: getState().mediaRev + 1 });

/** Enfileira uma operação: o SFU exige uma negociação por vez em cada sessão. */
function enqueue(fn: (g: number) => Promise<void>): Promise<void> {
  const g = gen;
  queue = queue
    .then(() => (g === gen ? fn(g) : undefined))
    .catch((e) => console.error('[voz]', e));
  return queue;
}

function waitIce(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      conn.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => conn.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, 2000);
    conn.addEventListener('icegatheringstatechange', check);
  });
}

// ------------------------------------------------------------------ microfone
// microfone -> volume de entrada -> portão (atividade de voz ou apertar-para-falar) -> faixa enviada.
// A faixa enviada é sempre a mesma; trocar de aparelho só troca a fonte, sem renegociar a chamada.

interface Input {
  ctx: AudioContext;
  raw: MediaStream;
  source: MediaStreamAudioSourceNode;
  vol: GainNode;
  gate: AudioWorkletNode | null;
  dest: MediaStreamAudioDestinationNode;
}

let input: Input | null = null;
let inputBuilding: Promise<Input> | null = null;
const inputUsers = { voice: false, preview: false };
let pttDown = false;
let localOpen = false;
const levelListeners = new Set<(level: number, open: boolean) => void>();

function openRaw(): Promise<MediaStream> {
  if (import.meta.env.DEV && localStorage.getItem('concord.fakeMedia')) return Promise.resolve(fakeAudio());
  const s = getState().settings;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGain,
    },
  });
}

function postGate(): void {
  const s = getState().settings;
  // Sem tecla definida (ou fora do app de computador), "apertar para falar" não teria como abrir.
  const ptt = s.inputMode === 'ptt' && Boolean(s.pttKey) && Boolean(window.concord?.ptt);
  input?.gate?.port.postMessage({ mode: ptt ? 'ptt' : 'voice', threshold: s.sensitivity, ptt: pttDown });
}

async function buildInput(): Promise<Input> {
  const raw = await openRaw();
  const ctx = new AudioContext();
  void ctx.resume().catch(() => undefined);
  let gate: AudioWorkletNode | null = null;
  try {
    await ctx.audioWorklet.addModule(new URL('gate-worklet.js', document.baseURI).href);
    gate = new AudioWorkletNode(ctx, 'concord-gate');
  } catch (e) {
    console.warn('[voz] portão de voz indisponível; microfone fica sempre aberto', e);
  }
  const source = ctx.createMediaStreamSource(raw);
  const vol = ctx.createGain();
  vol.gain.value = getState().settings.inputVolume;
  const dest = ctx.createMediaStreamDestination();
  source.connect(vol);
  if (gate) {
    vol.connect(gate).connect(dest);
    gate.port.onmessage = (e) => {
      const { level, open } = e.data as { level: number; open: boolean };
      for (const l of levelListeners) l(level, open);
      if (open !== localOpen) {
        localOpen = open;
        pushSpeaking();
      }
    };
  } else {
    vol.connect(dest);
  }
  input = { ctx, raw, source, vol, gate, dest };
  postGate();
  return input;
}

async function acquireInput(user: 'voice' | 'preview'): Promise<Input> {
  inputUsers[user] = true;
  if (input) return input;
  inputBuilding ??= buildInput().finally(() => (inputBuilding = null));
  try {
    const built = await inputBuilding;
    if (!inputUsers.voice && !inputUsers.preview) closeInput();
    return built;
  } catch (e) {
    inputUsers[user] = false;
    throw e;
  }
}

function releaseInput(user: 'voice' | 'preview'): void {
  inputUsers[user] = false;
  if (!inputUsers.voice && !inputUsers.preview) closeInput();
}

function closeInput(): void {
  const cur = input;
  if (!cur) return;
  input = null;
  localOpen = false;
  cur.raw.getTracks().forEach((t) => t.stop());
  void cur.ctx.close().catch(() => undefined);
}

/** Troca o aparelho (ou o tratamento de ruído) mantendo a mesma faixa enviada. */
async function replaceRaw(): Promise<void> {
  const cur = input;
  if (!cur) return;
  try {
    const raw = await openRaw();
    if (input !== cur) return raw.getTracks().forEach((t) => t.stop());
    cur.source.disconnect();
    cur.raw.getTracks().forEach((t) => t.stop());
    cur.raw = raw;
    cur.source = cur.ctx.createMediaStreamSource(raw);
    cur.source.connect(cur.vol);
    patch({ micError: false });
  } catch {
    patch({ micError: true });
  }
}

export function startMicPreview(): Promise<unknown> {
  return acquireInput('preview').catch(() => patch({ micError: true }));
}
export function stopMicPreview(): void {
  releaseInput('preview');
}
export function onMicLevel(cb: (level: number, open: boolean) => void): () => void {
  levelListeners.add(cb);
  return () => levelListeners.delete(cb);
}

function micTrack(): MediaStreamTrack | null {
  return inputUsers.voice && input ? input.dest.stream.getAudioTracks()[0] : null;
}

// ------------------------------------------------------------------ entrar / sair

function start(ch: string, isRetry = false): void {
  const tries = retries;
  stop();
  retries = isRetry ? tries : 0;
  const g = gen;
  channelId = ch;
  window.ConcordNative?.setInCall(true);
  queue = setup(g).catch((e) => console.error('[voz] falha ao entrar', e));
}

async function setup(g: number): Promise<void> {
  if (!getState().sfu) return;
  const { sessionId } = await sfu('session');
  if (g !== gen) return;
  mySid = sessionId;

  const conn = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
  pc = conn;
  conn.ontrack = onTrack;
  conn.onconnectionstatechange = () => {
    if (conn !== pc || conn.connectionState !== 'failed') return;
    // A conexão de mídia caiu: refaz tudo, no máximo algumas vezes seguidas.
    if (retries++ < 3 && channelId) setTimeout(() => channelId && conn === pc && start(channelId, true), 1000);
  };

  try {
    await acquireInput('voice');
  } catch {
    patch({ micError: true });
  }
  if (g !== gen) return;

  const track = micTrack();
  if (track) {
    track.enabled = !getState().myVoice?.muted;
    const tr = conn.addTransceiver(track, { direction: 'sendonly' });
    await conn.setLocalDescription(await conn.createOffer());
    await waitIce(conn);
    const res = await sfu('tracks', {
      sessionDescription: { type: 'offer', sdp: conn.localDescription!.sdp },
      tracks: [{ location: 'local', mid: tr.mid, trackName: 'mic' }],
    });
    if (g !== gen) return;
    await conn.setRemoteDescription(res.sessionDescription);
    // Sem o portão (worklet indisponível), mede o próprio microfone do jeito simples.
    const me = getState().me;
    if (me && input && !input.gate) watchLevel(me.id, input.dest.stream, true);
    await publish();
  }
  await syncNow(g);
}

function stop(): void {
  gen++;
  for (const el of audioEls.values()) {
    el.pause();
    el.srcObject = null;
  }
  audioEls.clear();
  pulled.clear();
  byMid.clear();
  screenStreams.clear();
  for (const id of [...levels.keys()]) unwatchLevel(id);
  releaseInput('voice');
  share?.stream.getTracks().forEach((t) => t.stop());
  share = null;
  if (nativeShare || nativeWaiting) window.ConcordNative?.stopShare();
  nativeShare = null;
  nativeWaiting?.reject(new Error('Você saiu da sala.'));
  nativeWaiting = null;
  window.ConcordNative?.setInCall(false);
  remoteSpeaking.clear();
  pc?.close();
  pc = null;
  mySid = null;
  channelId = null;
  bump();
}

function publish(): Promise<unknown> {
  const tracks = [...(micTrack() ? ['mic'] : []), ...(share?.names ?? nativeShare?.names ?? [])];
  return request('voice.state', { tracks });
}

// ------------------------------------------------------------------ receber os outros

async function syncNow(g: number): Promise<void> {
  const conn = pc;
  if (!conn || !channelId || !mySid || g !== gen) return;
  const s = getState();
  const parts = s.voice[channelId] ?? [];

  const desired = new Map<string, { userId: string; sessionId: string; trackName: string }>();
  for (const p of parts) {
    if (!p.sessionId || p.sessionId === mySid) continue;
    for (const t of p.tracks) {
      // Voz entra sempre; tela (e o áudio dela) só de quem eu escolhi assistir.
      if (t === 'mic' || (isScreen(t) && s.watching[p.userId])) {
        // Quem transmite pelo app Android publica a tela em uma sessão separada da voz.
        const sid = isScreen(t) ? (p.screenSessionId ?? p.sessionId) : p.sessionId;
        desired.set(`${sid}/${t}`, { userId: p.userId, sessionId: sid, trackName: t });
      }
    }
  }

  const gone = [...pulled.values()].filter((x) => !desired.has(x.key));
  if (gone.length) {
    await closeMids(conn, gone.map((x) => x.mid));
    gone.forEach(drop);
  }

  const want = [...desired].filter(([key]) => !pulled.has(key));
  if (want.length) {
    const res = await sfu('tracks', {
      tracks: want.map(([, d]) => ({ location: 'remote', sessionId: d.sessionId, trackName: d.trackName })),
    });
    if (g !== gen) return;
    let failed = false;
    for (const t of (res.tracks ?? []) as any[]) {
      const key = `${t.sessionId}/${t.trackName}`;
      const d = desired.get(key);
      if (!d || t.errorCode || !t.mid) {
        failed = true;
        continue;
      }
      const item: Pulled = { key, mid: String(t.mid), userId: d.userId, trackName: d.trackName };
      pulled.set(key, item);
      byMid.set(item.mid, item);
    }
    if (res.requiresImmediateRenegotiation && res.sessionDescription) {
      await conn.setRemoteDescription(res.sessionDescription);
      await conn.setLocalDescription(await conn.createAnswer());
      await waitIce(conn);
      await sfu('renegotiate', { sessionDescription: { type: 'answer', sdp: conn.localDescription!.sdp } });
    }
    // A faixa pode ainda não estar pronta do lado de quem publica: tenta de novo em instantes.
    if (failed && retries++ < 5) setTimeout(() => voiceHooks.sync(), 1500);
  }

  // Quem parou de transmitir sai da lista do que estou assistindo.
  const streaming = new Set(parts.filter((p) => p.tracks.some(isScreen)).map((p) => p.userId));
  const watching = Object.keys(s.watching).filter((u) => streaming.has(u));
  if (watching.length !== Object.keys(s.watching).length) {
    patch({ watching: Object.fromEntries(watching.map((u) => [u, true as const])) });
  }
}

function onTrack(ev: RTCTrackEvent): void {
  const item = ev.transceiver.mid ? byMid.get(ev.transceiver.mid) : undefined;
  if (!item) return;
  const stream = new MediaStream([ev.track]);
  if (ev.track.kind === 'audio') {
    const el = new Audio();
    el.srcObject = stream;
    el.autoplay = true;
    audioEls.set(item.key, el);
    applyFlags();
    void el.play().catch(() => undefined);
    if (item.trackName === 'mic') watchLevel(item.userId, stream, false);
  } else {
    screenStreams.set(item.userId, stream);
    bump();
  }
}

function drop(item: Pulled): void {
  pulled.delete(item.key);
  byMid.delete(item.mid);
  const el = audioEls.get(item.key);
  if (el) {
    el.pause();
    el.srcObject = null;
    audioEls.delete(item.key);
  }
  if (item.trackName === 'mic') unwatchLevel(item.userId);
  if (isScreen(item.trackName) && !isScreenAudio(item.trackName)) {
    screenStreams.delete(item.userId);
    bump();
  }
}

async function closeMids(conn: RTCPeerConnection, mids: string[]): Promise<void> {
  for (const t of conn.getTransceivers()) {
    if (t.mid && mids.includes(t.mid)) {
      try {
        t.stop();
      } catch {
        /* já parado */
      }
    }
  }
  const tracks = mids.map((mid) => ({ mid }));
  try {
    await conn.setLocalDescription(await conn.createOffer());
    const res = await sfu('close', {
      tracks,
      sessionDescription: { type: 'offer', sdp: conn.localDescription!.sdp },
      force: false,
    });
    if (res.sessionDescription) await conn.setRemoteDescription(res.sessionDescription);
  } catch (e) {
    console.warn('[voz] fechamento negociado falhou, forçando', e);
    if (conn.signalingState === 'have-local-offer') await conn.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
    await sfu('close', { tracks, force: true }).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ volume, mudo e "quem está falando"

function applyFlags(): void {
  const s = getState();
  const track = micTrack();
  if (track) track.enabled = !s.myVoice?.muted;
  const sink = s.settings.outputDeviceId === 'default' ? '' : s.settings.outputDeviceId;
  for (const [key, el] of audioEls) {
    const item = pulled.get(key);
    el.muted = Boolean(s.myVoice?.deafened);
    const user = item ? (s.volumes[item.userId] ?? 1) : 1;
    el.volume = Math.min(1, Math.max(0, user * s.settings.outputVolume));
    // Escolha do aparelho de saída (não existe em todos os navegadores de celular).
    const out = el as HTMLAudioElement & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
    if (out.setSinkId && out.sinkId !== sink) void out.setSinkId(sink).catch(() => undefined);
  }
  pushSpeaking();
}

const remoteSpeaking = new Set<string>();

/** Junta "eu falando" (portão aberto) com os outros e atualiza a tela só quando muda. */
function pushSpeaking(): void {
  const s = getState();
  const next: Record<string, true> = {};
  for (const id of remoteSpeaking) next[id] = true;
  if (localOpen && s.me && s.myVoice && !s.myVoice.muted && micTrack()) next[s.me.id] = true;
  const a = Object.keys(next);
  const b = Object.keys(s.speaking);
  if (a.length !== b.length || a.some((k) => !s.speaking[k])) patch({ speaking: next });
}

let audioCtx: AudioContext | null = null;
const levels = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; local: boolean; last: number }>();
let levelTimer: ReturnType<typeof setInterval> | undefined;

function watchLevel(userId: string, stream: MediaStream, local: boolean): void {
  unwatchLevel(userId);
  audioCtx ??= new AudioContext();
  void audioCtx.resume().catch(() => undefined);
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  levels.set(userId, { source, analyser, local, last: 0 });
  levelTimer ??= setInterval(pollLevels, 120);
}

function unwatchLevel(userId: string): void {
  const l = levels.get(userId);
  if (!l) return;
  l.source.disconnect();
  levels.delete(userId);
  remoteSpeaking.delete(userId);
  if (levels.size === 0) {
    clearInterval(levelTimer);
    levelTimer = undefined;
  }
  pushSpeaking();
}

const buf = new Uint8Array(512);
function pollLevels(): void {
  const s = getState();
  const now = Date.now();
  for (const [userId, l] of levels) {
    l.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    const rms = Math.sqrt(sum / buf.length) / 128;
    if (rms > 0.02 && !(l.local && s.myVoice?.muted)) l.last = now;
    if (now - l.last < 350) remoteSpeaking.add(userId);
    else remoteSpeaking.delete(userId);
  }
  pushSpeaking();
}

// ------------------------------------------------------------------ transmitir a tela

export function captureSources(): Promise<CaptureSource[]> | null {
  return window.concord?.capture ? window.concord.capture.sources() : null;
}

export async function startShare(opts: { sourceId?: string; audio: boolean; quality: Quality }): Promise<void> {
  if (!pc) throw new Error('A voz ainda está conectando. Tente de novo em instantes.');
  if (share || nativeShare) return;
  const q = QUALITY[opts.quality];

  // App Android: quem captura e envia o vídeo é o código nativo; aqui só cuidamos da sinalização.
  if (window.ConcordNative) {
    if (nativeWaiting) return;
    await new Promise<void>((resolve, reject) => {
      nativeWaiting = { resolve, reject };
      window.ConcordNative!.startShare(q.w, q.h, q.fps, q.bitrate);
    }).finally(() => (nativeWaiting = null));
    return;
  }

  let stream: MediaStream;
  if (import.meta.env.DEV && localStorage.getItem('concord.fakeMedia')) {
    stream = fakeScreen(q.w, q.h, q.fps, opts.audio);
  } else {
    if (window.concord?.capture && opts.sourceId) await window.concord.capture.choose(opts.sourceId, opts.audio);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      // restrictOwnAudio tira da captura o som que o próprio Concord toca (a voz dos amigos),
      // que era a causa do eco. Verificado com scripts/echo-test.cjs.
      audio: opts.audio ? ({ restrictOwnAudio: true } as MediaTrackConstraints) : false,
    });
  }

  await enqueue(async (g) => {
    const conn = pc;
    if (!conn || g !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const n = ++shareSeq;
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    video.contentHint = 'motion';

    const vt = conn.addTransceiver(video, { direction: 'sendonly' });
    // H.264 primeiro: costuma usar a placa de vídeo e pesa menos durante o jogo.
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    if (codecs.length && vt.setCodecPreferences) {
      const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
      vt.setCodecPreferences([...h264, ...codecs.filter((c) => !h264.includes(c))]);
    }
    const at = audio ? conn.addTransceiver(audio, { direction: 'sendonly' }) : null;

    await conn.setLocalDescription(await conn.createOffer());
    await waitIce(conn);
    const defs = [{ location: 'local', mid: vt.mid, trackName: `screen-${n}` }];
    if (at) defs.push({ location: 'local', mid: at.mid, trackName: `screen-audio-${n}` });
    const res = await sfu('tracks', {
      sessionDescription: { type: 'offer', sdp: conn.localDescription!.sdp },
      tracks: defs,
    });
    await conn.setRemoteDescription(res.sessionDescription);

    const params = vt.sender.getParameters();
    if (params.encodings?.length) {
      params.encodings[0].maxBitrate = q.bitrate;
      params.encodings[0].maxFramerate = q.fps;
      await vt.sender.setParameters(params).catch(() => undefined);
    }

    share = { stream, mids: defs.map((d) => String(d.mid)), names: defs.map((d) => d.trackName) };
    video.onended = () => void stopShare(); // o usuário fechou a janela ou parou pelo sistema
    patch({ sharing: true });
    bump();
    await publish();
  });
  if (!share) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Não foi possível iniciar a transmissão.');
  }
}

export function stopShare(): Promise<void> {
  if (nativeShare) {
    window.ConcordNative?.stopShare();
    return endNativeShare();
  }
  return enqueue(async () => {
    const cur = share;
    if (!cur) return;
    share = null;
    cur.stream.getTracks().forEach((t) => t.stop());
    patch({ sharing: false });
    bump();
    if (pc) await closeMids(pc, cur.mids);
    await publish();
  });
}

async function endNativeShare(): Promise<void> {
  if (!nativeShare) return;
  nativeShare = null;
  patch({ sharing: false });
  bump();
  await sfu('screen-end').catch(() => undefined);
  await publish().catch(() => undefined);
}

export const canShareScreen = (): boolean =>
  Boolean(window.ConcordNative) || typeof navigator.mediaDevices?.getDisplayMedia === 'function';

window.__concordNative = {
  // O app Android criou a oferta WebRTC da tela; registramos no SFU e devolvemos a resposta.
  onOffer: (sdp, mid) => {
    void (async () => {
      try {
        await sfu('screen-session');
        const name = `screen-${++shareSeq}`;
        const res = await sfu('screen-tracks', {
          sessionDescription: { type: 'offer', sdp },
          tracks: [{ location: 'local', mid, trackName: name }],
        });
        window.ConcordNative?.setAnswer(res.sessionDescription.sdp);
        nativeShare = { names: [name] };
        patch({ sharing: true });
        bump();
        await publish();
        nativeWaiting?.resolve();
      } catch (e) {
        window.ConcordNative?.stopShare();
        await sfu('screen-end').catch(() => undefined);
        nativeWaiting?.reject(e as Error);
      }
    })();
  },
  onShareError: (message) => nativeWaiting?.reject(new Error(message || 'Transmissão cancelada.')),
  // Parou pelo aviso do Android ou pela notificação.
  onShareStopped: () => void endNativeShare(),
  // Botão "voltar" do Android: volta do conteúdo para a navegação; false deixa o app minimizar.
  back: () => {
    if (!getState().mobileMain) return false;
    patch({ mobileMain: false });
    return true;
  },
};

/** Vídeo da tela de um usuário (o meu próprio, se for eu transmitindo). */
export function screenStreamOf(userId: string): MediaStream | null {
  if (userId === getState().me?.id) return share ? share.stream : null;
  return screenStreams.get(userId) ?? null;
}

// ------------------------------------------------------------------ mídia sintética (só em desenvolvimento)

function fakeAudio(): MediaStream {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  osc.frequency.value = 330 + Math.random() * 220;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(dest);
  osc.start();
  return dest.stream;
}

function fakeScreen(w: number, h: number, fps: number, audio: boolean): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  let i = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${i % 360} 60% 30%)`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = '80px sans-serif';
    g.fillText(`Tela de teste ${i++}`, 80, 160);
  }, 1000 / fps);
  const stream = canvas.captureStream(fps);
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
  if (audio) stream.addTrack(fakeAudio().getAudioTracks()[0]);
  return stream;
}

// ------------------------------------------------------------------ ligação com a store

voiceHooks.start = start;
voiceHooks.stop = stop;
voiceHooks.sync = () => void enqueue(syncNow);
voiceHooks.flags = applyFlags;

// Mesa de som: cada pessoa da sala toca o arquivo no próprio aparelho (não passa pelo microfone).
voiceHooks.playSound = (soundId: string) => {
  const s = getState();
  if (!s.myVoice || s.myVoice.deafened) return;
  const el = new Audio(soundUrl(soundId)) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  el.volume = Math.min(1, Math.max(0, s.settings.soundVolume * s.settings.outputVolume));
  const sink = s.settings.outputDeviceId === 'default' ? '' : s.settings.outputDeviceId;
  if (el.setSinkId && sink) void el.setSinkId(sink).catch(() => undefined);
  void el.play().catch(() => undefined);
};
voiceHooks.settings = (changed: (keyof Settings)[]) => {
  const has = (...keys: (keyof Settings)[]) => keys.some((k) => changed.includes(k));
  if (has('inputDeviceId', 'noiseSuppression', 'echoCancellation', 'autoGain')) void replaceRaw();
  if (has('inputVolume') && input) input.vol.gain.value = getState().settings.inputVolume;
  if (has('inputMode', 'sensitivity', 'pttKey')) postGate();
  if (has('inputMode', 'pttKey')) configurePtt();
  if (has('outputDeviceId', 'outputVolume')) applyFlags();
};

// ------------------------------------------------------------------ apertar para falar (app de computador)

function configurePtt(): void {
  const s = getState().settings;
  const key: PttKey | null = s.inputMode === 'ptt' ? s.pttKey : null;
  void window.concord?.ptt?.configure(key ? { type: key.type, code: key.code } : null).catch(() => undefined);
}

window.concord?.ptt?.onState((down) => {
  pttDown = down;
  postGate();
});
configurePtt();

if (import.meta.env.DEV) {
  // Só em desenvolvimento: permite inspecionar a conexão pelo console.
  (window as any).__voice = { pc: () => pc, pulled, audioEls, screenStreams, share: () => share, input: () => input };
}
