import { useSyncExternalStore } from 'react';

// No app de computador a URL vem do build; na versão web o servidor é a própria origem da página.
export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? 'http://localhost:8787' : location.origin);
const TOKEN_KEY = 'concord.token';

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** Versão da foto de perfil; null ou ausente = sem foto. */
  avatar?: number | null;
}

export interface Sound {
  id: string;
  scope: 'group' | 'user';
  groupId: string | null;
  ownerId: string;
  name: string;
  emoji: string;
  createdAt: number;
}
export interface Channel {
  id: string;
  name: string;
  type: 'text' | 'voice';
}
export interface Group {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  channels: Channel[];
  members: User[];
}
export interface Friend {
  user: User;
  status: 'accepted' | 'incoming' | 'outgoing';
  online: boolean;
}
export interface Message {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  createdAt: number;
  author: string;
}
export interface Participant {
  userId: string;
  muted: boolean;
  deafened: boolean;
  sessionId: string | null;
  /** Sessão separada da tela, usada por quem transmite pelo app Android. */
  screenSessionId?: string | null;
  tracks: string[];
}

export interface PttKey {
  type: 'key' | 'mouse';
  code: number;
  label: string;
}

export interface Settings {
  inputDeviceId: string;
  outputDeviceId: string;
  /** Ganho do microfone: 1 = normal, até 2 = dobro. */
  inputVolume: number;
  /** Volume geral do que eu ouço, de 0 a 1. */
  outputVolume: number;
  inputMode: 'voice' | 'ptt';
  /** Limite do portão de voz (RMS de 0 a 1); abaixo disso o microfone não transmite. */
  sensitivity: number;
  pttKey: PttKey | null;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Volume dos sons da mesa de som, de 0 a 1. */
  soundVolume: number;
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

const SETTINGS_KEY = 'concord.settings';
const DEFAULT_SETTINGS: Settings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 1,
  outputVolume: 1,
  inputMode: 'voice',
  sensitivity: 0.015,
  pttKey: null,
  noiseSuppression: true,
  echoCancellation: true,
  autoGain: true,
  soundVolume: 0.6,
};
function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export type View =
  | { kind: 'home'; dmUserId?: string }
  | { kind: 'group'; groupId: string; channelId?: string };

export interface State {
  status: 'signed-out' | 'connecting' | 'ready' | 'reconnecting';
  me: User | null;
  groups: Group[];
  friends: Friend[];
  online: Record<string, true>;
  voice: Record<string, Participant[]>;
  /** Mensagens já carregadas, por sala. Sala ausente = ainda não carregada. */
  messages: Record<string, Message[]>;
  /** Salas cujo histórico mais antigo já acabou. */
  historyEnd: Record<string, true>;
  unread: Record<string, number>;
  myVoice: { channelId: string; muted: boolean; deafened: boolean } | null;
  view: View;
  /** O servidor tem o serviço de voz configurado? */
  sfu: boolean;
  /** Quem está falando agora (inclui eu). */
  speaking: Record<string, true>;
  /** Transmissões de tela que escolhi assistir, por usuário. */
  watching: Record<string, true>;
  /** Estou transmitindo minha tela? */
  sharing: boolean;
  /** Volume por usuário, de 0 a 1. */
  volumes: Record<string, number>;
  /** O microfone não pôde ser aberto (sem permissão ou sem aparelho). */
  micError: boolean;
  /** Muda sempre que um vídeo entra ou sai, para a tela se redesenhar. */
  mediaRev: number;
  settings: Settings;
  /** Estado da atualização automática (só no app de computador). */
  update: UpdateStatus;
  appVersion: string;
  /** Em telas estreitas: true mostra o conteúdo, false mostra a navegação. */
  mobileMain: boolean;
  /** Código de um link de convite aberto, esperando a pessoa aceitar ou recusar. */
  pendingInvite: string | null;
  /** Sons dos meus grupos e os meus sons pessoais. */
  sounds: Sound[];
}

/** Aceita "ABCD2345", "?convite=ABCD2345" ou "concord://convite/ABCD2345". */
export function parseInvite(text: string | null | undefined): string | null {
  const m = /(?:convite[=/])?([A-Za-z0-9]{6,16})\/?$/.exec((text ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}

export function inviteLink(code: string): string {
  return `${SERVER_URL}/?convite=${code}`;
}

export async function inviteInfo(code: string): Promise<{ name: string; members: number }> {
  const res = await fetch(`${SERVER_URL}/api/invite/${encodeURIComponent(code)}`).catch(() => null);
  if (!res) throw new Error('Não foi possível falar com o servidor');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Convite inválido');
  return data;
}

const INVITE_KEY = 'concord.invite';

function inviteFromUrl(): string | null {
  const raw = new URLSearchParams(location.search).get('convite');
  if (raw) {
    // Tira o código da barra de endereço e guarda até a pessoa responder,
    // mesmo que ela recarregue a página antes de entrar na conta.
    history.replaceState(null, '', location.pathname);
    sessionStorage.setItem(INVITE_KEY, raw);
  }
  return parseInvite(sessionStorage.getItem(INVITE_KEY));
}

export function clearInvite(): void {
  sessionStorage.removeItem(INVITE_KEY);
  set({ pendingInvite: null });
}

/** Ligações com o motor de voz (voice.ts), preenchidas quando ele carrega. */
export const voiceHooks = {
  start: (_channelId: string): void => undefined,
  stop: (): void => undefined,
  sync: (): void => undefined,
  flags: (): void => undefined,
  settings: (_changed: (keyof Settings)[]): void => undefined,
  playSound: (_soundId: string): void => undefined,
};

const VOLUMES_KEY = 'concord.volumes';
function loadVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUMES_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const initial: State = {
  status: localStorage.getItem(TOKEN_KEY) ? 'connecting' : 'signed-out',
  me: null,
  groups: [],
  friends: [],
  online: {},
  voice: {},
  messages: {},
  historyEnd: {},
  unread: {},
  myVoice: null,
  view: { kind: 'home' },
  sfu: false,
  speaking: {},
  watching: {},
  sharing: false,
  volumes: loadVolumes(),
  micError: false,
  mediaRev: 0,
  settings: loadSettings(),
  update: { state: 'idle' },
  appVersion: '',
  mobileMain: false,
  pendingInvite: inviteFromUrl(),
  sounds: [],
};

let state = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getState(): State {
  return state;
}

export const patch = set;

export function updateSettings(change: Partial<Settings>): void {
  const settings = { ...state.settings, ...change };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  set({ settings });
  voiceHooks.settings(Object.keys(change) as (keyof Settings)[]);
}

export function setVolume(userId: string, volume: number): void {
  const volumes = { ...state.volumes, [userId]: volume };
  localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes));
  set({ volumes });
  voiceHooks.flags();
}

export function setWatching(userId: string, on: boolean): void {
  const watching = { ...state.watching };
  if (on) watching[userId] = true;
  else delete watching[userId];
  set({ watching });
  voiceHooks.sync();
}

export function useStore(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function dmChannelId(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

/** Sala de texto que está aberta na tela agora (grupo ou conversa direta). */
export function activeTextChannel(s: State = state): string | null {
  if (s.view.kind === 'home') {
    return s.view.dmUserId && s.me ? dmChannelId(s.me.id, s.view.dmUserId) : null;
  }
  const { groupId, channelId } = s.view;
  const ch = s.groups.find((g) => g.id === groupId)?.channels.find((c) => c.id === channelId);
  return ch?.type === 'text' ? ch.id : null;
}

// ------------------------------------------------------------------ conexão

let ws: WebSocket | null = null;
let seq = 0;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve: (d: any) => void; reject: (e: Error) => void }>();

function rawRequest<T = any>(op: string, d: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Sem conexão com o servidor'));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, op, d }));
  });
}

export function request<T = any>(op: string, d: Record<string, unknown> = {}): Promise<T> {
  return rawRequest<T>(op, d);
}

function connect(): void {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  clearTimeout(retryTimer);
  const sock = new WebSocket(SERVER_URL.replace(/^http/, 'ws') + '/ws');
  ws = sock;

  sock.onopen = async () => {
    try {
      const snap = await rawRequest('auth', { token });
      retry = 0;
      applySnapshot(snap);
    } catch (e) {
      if ((e as Error).message === 'Sessão expirada') signOutLocal();
      else sock.close();
    }
  };

  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.ev) return onEvent(m.ev, m.d);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.d);
    else p.reject(new Error(m.error ?? 'Erro'));
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    voiceHooks.stop();
    for (const p of pending.values()) p.reject(new Error('Conexão perdida'));
    pending.clear();
    if (!localStorage.getItem(TOKEN_KEY)) return;
    set({ status: state.me ? 'reconnecting' : 'connecting' });
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}

function applySnapshot(snap: any): void {
  const online: Record<string, true> = {};
  for (const id of snap.online as string[]) online[id] = true;
  const groups: Group[] = snap.groups;
  let view = state.view;
  if (view.kind === 'group' && !groups.some((g) => g.id === (view as any).groupId)) view = { kind: 'home' };
  const wasIn = state.myVoice;
  set({
    status: 'ready',
    me: snap.me,
    groups,
    friends: snap.friends,
    online,
    voice: snap.voice,
    sfu: snap.sfu,
    sounds: snap.sounds ?? [],
    messages: {},
    historyEnd: {},
    myVoice: null,
    view,
  });
  // Depois de uma queda, volta para a sala de voz em que estava.
  if (wasIn) void joinVoice(wasIn.channelId, wasIn).catch(() => undefined);
}

function onEvent(ev: string, d: any): void {
  const hadVoice = state.myVoice;
  handleEvent(ev, d);
  // A sala em que eu estava sumiu (apagada, ou saí do grupo): desliga o áudio.
  if (hadVoice && !state.myVoice) {
    voiceHooks.stop();
    set({ watching: {}, speaking: {}, sharing: false });
  }
}

function handleEvent(ev: string, d: any): void {
  switch (ev) {
    case 'presence': {
      const online = { ...state.online };
      if (d.online) online[d.userId] = true;
      else delete online[d.userId];
      set({
        online,
        friends: state.friends.map((f) => (f.user.id === d.userId ? { ...f, online: d.online && f.status === 'accepted' } : f)),
      });
      break;
    }
    case 'user.update': {
      const u = d as User;
      set({
        me: state.me?.id === u.id ? u : state.me,
        friends: state.friends.map((f) => (f.user.id === u.id ? { ...f, user: u } : f)),
        groups: state.groups.map((g) => ({ ...g, members: g.members.map((m) => (m.id === u.id ? u : m)) })),
      });
      break;
    }
    case 'friend.update': {
      const f = d as Friend;
      const rest = state.friends.filter((x) => x.user.id !== f.user.id);
      const online = { ...state.online };
      if (f.online) online[f.user.id] = true;
      set({ friends: [...rest, f], online });
      break;
    }
    case 'friend.removed': {
      const view = state.view.kind === 'home' && state.view.dmUserId === d.userId ? ({ kind: 'home' } as View) : state.view;
      set({ friends: state.friends.filter((x) => x.user.id !== d.userId), view });
      break;
    }
    case 'group.update': {
      const g = d as Group;
      const exists = state.groups.some((x) => x.id === g.id);
      let view = state.view;
      if (view.kind === 'group' && view.groupId === g.id && view.channelId && !g.channels.some((c) => c.id === (view as any).channelId)) {
        view = { kind: 'group', groupId: g.id, channelId: g.channels.find((c) => c.type === 'text')?.id };
      }
      let myVoice = state.myVoice;
      if (myVoice && state.groups.find((x) => x.id === g.id)?.channels.some((c) => c.id === myVoice!.channelId) && !g.channels.some((c) => c.id === myVoice!.channelId)) {
        myVoice = null;
      }
      set({ groups: exists ? state.groups.map((x) => (x.id === g.id ? g : x)) : [...state.groups, g], view, myVoice });
      break;
    }
    case 'group.removed': {
      const gone = state.groups.find((g) => g.id === d.groupId);
      const view = state.view.kind === 'group' && state.view.groupId === d.groupId ? ({ kind: 'home' } as View) : state.view;
      const myVoice = state.myVoice && gone?.channels.some((c) => c.id === state.myVoice!.channelId) ? null : state.myVoice;
      set({
        groups: state.groups.filter((g) => g.id !== d.groupId),
        sounds: state.sounds.filter((x) => x.groupId !== d.groupId),
        view,
        myVoice,
      });
      break;
    }
    case 'msg.new': {
      const m = d as Message;
      const patch: Partial<State> = {};
      const loaded = state.messages[m.channelId];
      if (loaded && !loaded.some((x) => x.id === m.id)) patch.messages = { ...state.messages, [m.channelId]: [...loaded, m] };
      const visible = activeTextChannel() === m.channelId && document.hasFocus();
      if (!visible && m.userId !== state.me?.id) {
        patch.unread = { ...state.unread, [m.channelId]: (state.unread[m.channelId] ?? 0) + 1 };
      }
      set(patch);
      break;
    }
    case 'voice.update': {
      const voice = { ...state.voice };
      if (d.participants.length) voice[d.channelId] = d.participants;
      else delete voice[d.channelId];
      set({ voice });
      if (state.myVoice?.channelId === d.channelId) voiceHooks.sync();
      break;
    }
    case 'sound.added': {
      const sound = d as Sound;
      set({ sounds: [...state.sounds.filter((x) => x.id !== sound.id), sound] });
      break;
    }
    case 'sound.removed':
      set({ sounds: state.sounds.filter((x) => x.id !== d.soundId) });
      break;
    case 'sound.played':
      // Só toca para quem está de fato naquela sala de voz.
      if (state.myVoice?.channelId === d.channelId) voiceHooks.playSound(d.soundId);
      break;
    case 'voice.snapshot':
      set({ voice: { ...state.voice, ...d } });
      break;
  }
}

// ------------------------------------------------------------------ ações

async function authCall(path: string, body: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Não foi possível falar com o servidor');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Erro');
  localStorage.setItem(TOKEN_KEY, data.token);
  set({ status: 'connecting' });
  connect();
}

export const login = (username: string, password: string) => authCall('/api/login', { username, password });
export const register = (b: { username: string; displayName: string; password: string; code: string }) =>
  authCall('/api/register', b);

function signOutLocal(): void {
  localStorage.removeItem(TOKEN_KEY);
  clearTimeout(retryTimer);
  const old = ws;
  ws = null;
  old?.close();
  state = { ...initial, status: 'signed-out', settings: state.settings, volumes: state.volumes, update: state.update, appVersion: state.appVersion, pendingInvite: state.pendingInvite };
  for (const l of listeners) l();
}

export async function logout(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  await rawRequest('logout', { token }).catch(() => undefined);
  signOutLocal();
}

// ------------------------------------------------------------------ fotos e sons

export const MAX_SOUND_BYTES = 512 * 1024;
export const MAX_SOUND_SECONDS = 10;

export function soundUrl(soundId: string): string {
  return `${SERVER_URL}/api/sound/${soundId}`;
}

/** Endereço da foto de um usuário, ou null se ele não tem foto (ou não o conhecemos). */
export function avatarUrl(userId: string, s: State = state): string | null {
  let version: number | null | undefined = s.me?.id === userId ? s.me.avatar : undefined;
  if (version === undefined) version = s.friends.find((f) => f.user.id === userId)?.user.avatar;
  if (version === undefined) {
    for (const g of s.groups) {
      const m = g.members.find((u) => u.id === userId);
      if (m) {
        version = m.avatar;
        break;
      }
    }
  }
  return version ? `${SERVER_URL}/api/avatar/${userId}?v=${version}` : null;
}

async function upload(path: string, body: Blob, type: string): Promise<any> {
  const res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': type, Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` },
    body,
  }).catch(() => null);
  if (!res) throw new Error('Não foi possível falar com o servidor');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Falha no envio');
  return data;
}

export const uploadAvatar = (image: Blob) => upload('/api/avatar', image, image.type);

export function uploadSound(file: Blob, o: { scope: 'group' | 'user'; groupId?: string | null; name: string; emoji: string }): Promise<Sound> {
  const q = new URLSearchParams({ scope: o.scope, name: o.name, emoji: o.emoji });
  if (o.scope === 'group' && o.groupId) q.set('groupId', o.groupId);
  return upload(`/api/sounds?${q}`, file, file.type || 'audio/mpeg');
}

export function setView(view: View, showMain = true): void {
  set({ view, mobileMain: showMain });
  const ch = activeTextChannel();
  if (ch) {
    clearUnread(ch);
    if (!state.messages[ch]) void loadHistory(ch);
  }
}

export function openGroup(groupId: string): void {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return;
  // No celular, abrir um grupo mostra primeiro a lista de salas dele.
  setView({ kind: 'group', groupId, channelId: g.channels.find((c) => c.type === 'text')?.id }, false);
}

export function clearUnread(channelId: string): void {
  if (!state.unread[channelId]) return;
  const unread = { ...state.unread };
  delete unread[channelId];
  set({ unread });
}

export async function loadHistory(channelId: string, older = false): Promise<void> {
  const current = state.messages[channelId] ?? [];
  const before = older && current.length ? current[0].createdAt : undefined;
  const page = await request<Message[]>('msg.history', { channelId, before });
  const fresh = state.messages[channelId] ?? [];
  const ids = new Set(fresh.map((m) => m.id));
  const merged = [...page.filter((m) => !ids.has(m.id)), ...fresh].sort((a, b) => a.createdAt - b.createdAt);
  set({
    messages: { ...state.messages, [channelId]: merged },
    historyEnd: page.length < 50 ? { ...state.historyEnd, [channelId]: true } : state.historyEnd,
  });
}

export async function joinVoice(channelId: string, keep?: { muted: boolean; deafened: boolean }): Promise<void> {
  if (state.myVoice?.channelId === channelId) return;
  await request('voice.join', { channelId });
  const muted = keep?.muted ?? false;
  const deafened = keep?.deafened ?? false;
  set({ myVoice: { channelId, muted, deafened }, watching: {}, speaking: {}, sharing: false, micError: false });
  if (muted || deafened) await request('voice.state', { muted, deafened });
  voiceHooks.start(channelId);
}

export async function leaveVoice(): Promise<void> {
  if (!state.myVoice) return;
  voiceHooks.stop();
  set({ myVoice: null, watching: {}, speaking: {}, sharing: false });
  await request('voice.leave').catch(() => undefined);
}

export async function setVoiceFlags(flags: { muted?: boolean; deafened?: boolean }): Promise<void> {
  if (!state.myVoice) return;
  let { muted, deafened } = { ...state.myVoice, ...flags };
  // Silenciar o áudio também muta o microfone, como nos apps de voz em geral.
  if (flags.deafened) muted = true;
  set({ myVoice: { ...state.myVoice, muted, deafened } });
  voiceHooks.flags();
  await request('voice.state', { muted, deafened });
}

if (localStorage.getItem(TOKEN_KEY)) connect();
