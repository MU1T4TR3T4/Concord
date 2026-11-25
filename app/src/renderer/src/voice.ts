// Motor de voz e transmissão de tela: uma conexão WebRTC com o SFU da Cloudflare por sala.
// O servidor do Concord repassa as chamadas ao SFU (o segredo nunca chega ao aplicativo).
import { getState, patch, request, voiceHooks } from './store';

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
    concord?: {
      desktop: boolean;
      capture: {
        sources(): Promise<CaptureSource[]>;
        choose(id: string, audio: boolean): Promise<void>;
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
let mic: MediaStream | null = null;
let share: { stream: MediaStream; mids: string[]; names: string[] } | null = null;
let shareSeq = 0;
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

async function getMic(): Promise<MediaStream> {
  if (import.meta.env.DEV && localStorage.getItem('concord.fakeMedia')) return fakeAudio();
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

// ------------------------------------------------------------------ entrar / sair

function start(ch: string, isRetry = false): void {
  const tries = retries;
  stop();
  retries = isRetry ? tries : 0;
  const g = gen;
  channelId = ch;
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

  let stream: MediaStream | null = null;
  try {
    stream = await getMic();
  } catch {
    patch({ micError: true });
  }
  if (g !== gen) {
    stream?.getTracks().forEach((t) => t.stop());
    return;
  }
  mic = stream;

  if (stream) {
    const track = stream.getAudioTracks()[0];
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
    const me = getState().me;
    if (me) watchLevel(me.id, stream, true);
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
  mic?.getTracks().forEach((t) => t.stop());
  share?.stream.getTracks().forEach((t) => t.stop());
  mic = null;
  share = null;
  pc?.close();
  pc = null;
  mySid = null;
  channelId = null;
  bump();
}

function publish(): Promise<unknown> {
  const tracks = [...(mic ? ['mic'] : []), ...(share?.names ?? [])];
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
        desired.set(`${p.sessionId}/${t}`, { userId: p.userId, sessionId: p.sessionId, trackName: t });
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
  if (mic) for (const t of mic.getAudioTracks()) t.enabled = !s.myVoice?.muted;
  for (const [key, el] of audioEls) {
    const item = pulled.get(key);
    el.muted = Boolean(s.myVoice?.deafened);
    el.volume = Math.min(1, Math.max(0, item ? (s.volumes[item.userId] ?? 1) : 1));
  }
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
  if (levels.size === 0) {
    clearInterval(levelTimer);
    levelTimer = undefined;
    if (Object.keys(getState().speaking).length) patch({ speaking: {} });
  }
}

const buf = new Uint8Array(512);
function pollLevels(): void {
  const s = getState();
  const now = Date.now();
  const speaking: Record<string, true> = {};
  for (const [userId, l] of levels) {
    l.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    const rms = Math.sqrt(sum / buf.length) / 128;
    if (rms > 0.02 && !(l.local && s.myVoice?.muted)) l.last = now;
    if (now - l.last < 350) speaking[userId] = true;
  }
  const a = Object.keys(speaking);
  const b = Object.keys(s.speaking);
  if (a.length !== b.length || a.some((k) => !s.speaking[k])) patch({ speaking });
}

// ------------------------------------------------------------------ transmitir a tela

export function captureSources(): Promise<CaptureSource[]> | null {
  return window.concord?.capture ? window.concord.capture.sources() : null;
}

export async function startShare(opts: { sourceId?: string; audio: boolean; quality: Quality }): Promise<void> {
  if (!pc) throw new Error('A voz ainda está conectando. Tente de novo em instantes.');
  if (share) return;
  const q = QUALITY[opts.quality];

  let stream: MediaStream;
  if (import.meta.env.DEV && localStorage.getItem('concord.fakeMedia')) {
    stream = fakeScreen(q.w, q.h, q.fps, opts.audio);
  } else {
    if (window.concord?.capture && opts.sourceId) await window.concord.capture.choose(opts.sourceId, opts.audio);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: opts.audio,
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

if (import.meta.env.DEV) {
  // Só em desenvolvimento: permite inspecionar a conexão pelo console.
  (window as any).__voice = { pc: () => pc, pulled, audioEls, screenStreams, share: () => share };
}
