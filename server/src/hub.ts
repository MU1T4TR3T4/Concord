import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { hashPassword, inviteCode, randomHex, safeEqual, sha256Hex } from './auth';

/** Erro com mensagem que pode ser mostrada ao usuário. */
class Fail extends Error {}

/** Estado guardado em cada conexão (sobrevive à hibernação do Durable Object). */
interface Att {
  uid: string;
  /** Sala de voz em que esta conexão está. */
  vc: string | null;
  m: boolean; // microfone mutado
  d: boolean; // áudio silenciado
  /** Sessão no SFU da Cloudflare e nomes das faixas publicadas (mic, screen, ...). */
  sid: string | null;
  tr: string[];
  /**
   * Segunda sessão no SFU, só para a tela. O app Android captura a tela em código nativo,
   * com uma conexão separada da voz (que roda dentro do WebView).
   */
  ss?: string | null;
  /** Controle remoto: quem esta pessoa autorizou a mexer na tela que ela transmite. */
  ct?: string | null;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  /** Versão da foto de perfil (data do envio) ou null se não tem foto. */
  avatar: number | null;
  /** Selos dados pelo admin: lista de ids em JSON. */
  badges: string | null;
}

const MAX_AVATAR_BYTES = 200 * 1024;
const MAX_SOUND_BYTES = 512 * 1024;
const MAX_SOUNDS = 60;
const SOUND_MIME = /^(audio\/|video\/(webm|mp4|ogg)|application\/ogg)/;
const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

type Row = Record<string, SqlStorageValue>;

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const BADGE_RE = /^[a-z0-9-]{1,24}$/;
const MAX_BADGES = 12;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new Fail(`Campo inválido: ${field}`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new Fail(`${field} deve ter entre ${min} e ${max} caracteres`);
  return s;
}

function dmId(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

const SOUND_COLS = 'SELECT id, scope, group_id, owner_id, name, emoji, created_at FROM sounds';

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Última vez que o som de entrada de cada pessoa tocou, para não repetir a cada reconexão. */
  private lastEntry = new Map<string, number>();
  /** Último som tocado por usuário, para segurar quem aperta sem parar. */
  private lastSound = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS friendships (
        a TEXT NOT NULL, b TEXT NOT NULL, requester TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL,
        invite_code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id));
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_members_user ON group_members (user_id);
      CREATE TABLE IF NOT EXISTS avatars (
        user_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
      -- scope 'group': som do grupo, qualquer membro usa. scope 'user': som pessoal do dono.
      CREATE TABLE IF NOT EXISTS sounds (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, group_id TEXT, owner_id TEXT NOT NULL,
        name TEXT NOT NULL, emoji TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sounds_group ON sounds (group_id);
      CREATE INDEX IF NOT EXISTS idx_sounds_owner ON sounds (owner_id, scope);
    `);
    // Coluna acrescentada depois da primeira versão; em banco novo ou já migrado, segue adiante.
    try {
      this.sql.exec('ALTER TABLE users ADD COLUMN avatar INTEGER');
    } catch {
      /* a coluna já existe */
    }
    // Selos que o admin dá às pessoas: lista de ids em JSON.
    try {
      this.sql.exec('ALTER TABLE users ADD COLUMN badges TEXT');
    } catch {
      /* a coluna já existe */
    }
  }

  // ---------------------------------------------------------------- HTTP

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Lista de contas, só para o dono do servidor (segredo ADMIN_KEY). Ver scripts/list-users.mjs.
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      const key = this.env.ADMIN_KEY?.trim();
      const given = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!key || !given || !safeEqual(given, key)) return Response.json({ error: 'Não autorizado' }, { status: 401 });
      return Response.json(this.all('SELECT username, display_name AS displayName, created_at AS createdAt FROM users ORDER BY created_at'));
    }
    // Prévia pública de um convite: quem recebe o link vê o nome do grupo antes de entrar.
    if (req.method === 'GET' && url.pathname.startsWith('/api/invite/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/invite/'.length)).trim().toUpperCase();
      const g = this.one(
        'SELECT name, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members FROM groups g WHERE invite_code = ?',
        code,
      );
      return g ? json({ name: g.name, members: g.members }) : json({ error: 'Convite inválido ou expirado' }, 404);
    }

    // Fotos e sons são públicos para quem tem o endereço (o id é impossível de adivinhar)
    // e nunca mudam: uma foto nova ganha outra versão no endereço.
    if (req.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
      return this.blob('SELECT mime, data FROM avatars WHERE user_id = ?', url.pathname.slice('/api/avatar/'.length));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sound/')) {
      return this.blob('SELECT mime, data FROM sounds WHERE id = ?', url.pathname.slice('/api/sound/'.length));
    }

    if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405);
    try {
      if (url.pathname === '/api/avatar') return json(await this.uploadAvatar(req));
      if (url.pathname === '/api/sounds') return json(await this.uploadSound(req, url));
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (url.pathname === '/api/register') return json(await this.register(body));
      if (url.pathname === '/api/login') return json(await this.login(body));
      return json({ error: 'Não encontrado' }, 404);
    } catch (e) {
      if (e instanceof Fail) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: 'Erro interno' }, 500);
    }
  }

  private blob(query: string, id: string): Response {
    const row = this.one(query, decodeURIComponent(id));
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(row.data as ArrayBuffer, {
      headers: { 'Content-Type': String(row.mime), 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }

  /** Identifica o usuário de uma chamada HTTP pelo cabeçalho Authorization: Bearer <token>. */
  private async httpUser(req: Request): Promise<string> {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const row = token ? this.one('SELECT user_id FROM sessions WHERE token_hash = ?', await sha256Hex(token)) : null;
    if (!row) throw new Fail('Sessão expirada');
    return String(row.user_id);
  }

  private async uploadAvatar(req: Request) {
    const uid = await this.httpUser(req);
    const mime = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIME.test(mime)) throw new Fail('A foto precisa ser JPG, PNG ou WebP');
    const data = await req.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > MAX_AVATAR_BYTES) throw new Fail('Foto grande demais');
    this.sql.exec('INSERT OR REPLACE INTO avatars (user_id, mime, data) VALUES (?,?,?)', uid, mime, data);
    this.sql.exec('UPDATE users SET avatar = ? WHERE id = ?', Date.now(), uid);
    const me = this.user(uid)!;
    this.sendTo([...this.audienceOf(uid), uid], 'user.update', me);
    return me;
  }

  private async uploadSound(req: Request, url: URL) {
    const uid = await this.httpUser(req);
    const wanted = url.searchParams.get('scope');
    const scope = wanted === 'group' || wanted === 'entry' ? wanted : 'user';
    const name = str(url.searchParams.get('name'), 'Nome do som', 1, 32);
    const emoji = (url.searchParams.get('emoji') ?? '').trim().slice(0, 16) || '🔊';
    const mime = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (!SOUND_MIME.test(mime)) throw new Fail('Formato de áudio não aceito');
    const data = await req.arrayBuffer();
    if (data.byteLength === 0) throw new Fail('Arquivo vazio');
    if (data.byteLength > MAX_SOUND_BYTES) throw new Fail('Som grande demais (máximo 512 KB)');

    if (scope === 'entry') {
      // Som de entrada: o admin escolhe para outra pessoa; fica guardado em nome dela.
      this.requireAdmin(uid);
      const target = this.user(String(url.searchParams.get('userId') ?? ''));
      if (!target) throw new Fail('Usuário não encontrado');
      this.sql.exec("DELETE FROM sounds WHERE scope = 'entry' AND owner_id = ?", target.id);
      this.sql.exec(
        'INSERT INTO sounds (id, scope, group_id, owner_id, name, emoji, mime, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        crypto.randomUUID(), 'entry', null, target.id, name, emoji, mime, data, Date.now(),
      );
      this.pushUser(target.id, uid);
      return this.user(target.id);
    }

    let gid: string | null = null;
    if (scope === 'group') {
      gid = this.memberGroup(uid, url.searchParams.get('groupId'));
      const n = Number(this.one("SELECT COUNT(*) AS n FROM sounds WHERE scope = 'group' AND group_id = ?", gid)!.n);
      if (n >= MAX_SOUNDS) throw new Fail(`Limite de ${MAX_SOUNDS} sons por grupo`);
    } else {
      const n = Number(this.one("SELECT COUNT(*) AS n FROM sounds WHERE scope = 'user' AND owner_id = ?", uid)!.n);
      if (n >= MAX_SOUNDS) throw new Fail(`Limite de ${MAX_SOUNDS} sons próprios`);
    }

    const id = crypto.randomUUID();
    this.sql.exec(
      'INSERT INTO sounds (id, scope, group_id, owner_id, name, emoji, mime, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, scope, gid, uid, name, emoji, mime, data, Date.now(),
    );
    const sound = this.soundObj(this.one(SOUND_COLS + ' WHERE id = ?', id)!);
    this.sendTo(gid ? this.memberIds(gid) : [uid], 'sound.added', sound);
    return sound;
  }

  private soundObj(r: Row) {
    return { id: r.id, scope: r.scope, groupId: r.group_id, ownerId: r.owner_id, name: r.name, emoji: r.emoji, createdAt: r.created_at };
  }

  private soundsFor(uid: string, gids: string[]) {
    const out = this.all(SOUND_COLS + " WHERE scope = 'user' AND owner_id = ? ORDER BY created_at", uid);
    for (const gid of gids) out.push(...this.all(SOUND_COLS + " WHERE scope = 'group' AND group_id = ? ORDER BY created_at", gid));
    return out.map((r) => this.soundObj(r));
  }

  /** O som existe e este usuário pode mexer nele (dono do som ou dono do grupo)? */
  private manageableSound(uid: string, soundId: unknown): Row {
    const s = this.one(SOUND_COLS + ' WHERE id = ?', String(soundId ?? ''));
    if (!s || s.scope === 'entry') throw new Fail('Som não encontrado');
    if (s.owner_id === uid) return s;
    const g = s.group_id ? this.one('SELECT owner_id FROM groups WHERE id = ?', String(s.group_id)) : null;
    if (g?.owner_id !== uid) throw new Fail('Só quem enviou o som ou o dono do grupo pode fazer isso');
    return s;
  }

  private async register(body: Record<string, unknown>) {
    // Compara sem diferenciar maiúsculas e ignorando espaços/quebras de linha nas pontas.
    const required = this.env.REGISTRATION_CODE?.trim().toUpperCase();
    if (required && !safeEqual(String(body.code ?? '').trim().toUpperCase(), required)) {
      throw new Fail('Código de convite inválido');
    }
    const username = str(body.username, 'Usuário', 3, 20).toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Fail('Usuário: use só letras, números, ponto e sublinhado');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 6 || password.length > 100) throw new Fail('A senha deve ter pelo menos 6 caracteres');
    const displayName = body.displayName ? str(body.displayName, 'Nome', 1, 32) : username;

    if (this.one('SELECT id FROM users WHERE username = ?', username)) throw new Fail('Esse usuário já existe');

    const id = crypto.randomUUID();
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    this.sql.exec(
      'INSERT INTO users (id, username, display_name, pass_hash, salt, created_at) VALUES (?,?,?,?,?,?)',
      id, username, displayName, hash, salt, Date.now(),
    );
    return { token: await this.newSession(id), user: this.user(id)! };
  }

  private async login(body: Record<string, unknown>) {
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const row = this.one('SELECT * FROM users WHERE username = ?', username);
    // Calcula o hash mesmo sem usuário, para não revelar pelo tempo se ele existe.
    const hash = await hashPassword(password, row ? String(row.salt) : '00');
    if (!row || !safeEqual(hash, String(row.pass_hash))) throw new Fail('Usuário ou senha incorretos');
    const id = String(row.id);
    return {
      token: await this.newSession(id),
      user: this.user(id)!,
    };
  }

  private async newSession(userId: string): Promise<string> {
    const token = randomHex(32);
    this.sql.exec('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)',
      await sha256Hex(token), userId, Date.now());
    return token;
  }

  // ---------------------------------------------------------------- WebSocket

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 200_000) return;
    let msg: { id?: number; op?: string; d?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, op } = msg;
    const d = msg.d ?? {};
    try {
      let result: unknown;
      if (op === 'auth') {
        result = await this.opAuth(ws, d);
      } else {
        const att = ws.deserializeAttachment() as Att | null;
        if (!att) throw new Fail('Não autenticado');
        result = await this.handle(String(op), ws, att, d);
      }
      if (id !== undefined) ws.send(JSON.stringify({ id, ok: true, d: result ?? null }));
    } catch (e) {
      if (!(e instanceof Fail)) console.error(op, e);
      ws.send(JSON.stringify({ id, ok: false, error: e instanceof Fail ? e.message : 'Erro interno' }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.dropSocket(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      /* já fechado */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  private dropSocket(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Att | null;
    if (!att) return;
    ws.serializeAttachment(null);
    if (att.vc) this.broadcastVoice(att.vc);
    if (!this.isOnline(att.uid)) this.sendTo(this.audienceOf(att.uid), 'presence', { userId: att.uid, online: false });
  }

  // ---------------------------------------------------------------- Operações

  private async opAuth(ws: WebSocket, d: Record<string, unknown>) {
    const token = String(d.token ?? '');
    const row = this.one('SELECT user_id FROM sessions WHERE token_hash = ?', await sha256Hex(token));
    if (!row) throw new Fail('Sessão expirada');
    const uid = String(row.user_id);
    const wasOnline = this.isOnline(uid);
    const att: Att = { uid, vc: null, m: false, d: false, sid: null, tr: [], ss: null };
    ws.serializeAttachment(att);
    if (!wasOnline) this.sendTo(this.audienceOf(uid), 'presence', { userId: uid, online: true });
    return this.snapshot(uid);
  }

  private async handle(op: string, ws: WebSocket, att: Att, d: Record<string, unknown>): Promise<unknown> {
    const uid = att.uid;
    switch (op) {
      // ---- conta
      case 'logout': {
        this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(String(d.token ?? '')));
        return null;
      }
      case 'profile.avatar.remove': {
        this.sql.exec('DELETE FROM avatars WHERE user_id = ?', uid);
        this.sql.exec('UPDATE users SET avatar = NULL WHERE id = ?', uid);
        const me = this.user(uid)!;
        this.sendTo([...this.audienceOf(uid), uid], 'user.update', me);
        return me;
      }

      // ---- sons
      case 'sound.update': {
        const s = this.manageableSound(uid, d.soundId);
        const emoji = String(d.emoji ?? '').trim().slice(0, 16) || '🔊';
        this.sql.exec('UPDATE sounds SET name = ?, emoji = ? WHERE id = ?', str(d.name, 'Nome do som', 1, 32), emoji, s.id);
        const sound = this.soundObj(this.one(SOUND_COLS + ' WHERE id = ?', s.id)!);
        this.sendTo(s.group_id ? this.memberIds(String(s.group_id)) : [uid], 'sound.added', sound);
        return null;
      }
      case 'sound.delete': {
        const s = this.manageableSound(uid, d.soundId);
        this.sql.exec('DELETE FROM sounds WHERE id = ?', s.id);
        this.sendTo(s.group_id ? this.memberIds(String(s.group_id)) : [String(s.owner_id)], 'sound.removed', { soundId: s.id });
        return null;
      }
      case 'sound.play': {
        if (!att.vc) throw new Fail('Entre em uma sala de voz para tocar sons');
        const s = this.one(SOUND_COLS + ' WHERE id = ?', String(d.soundId ?? ''));
        if (!s || s.scope === 'entry') throw new Fail('Som não encontrado');
        const ch = this.channel(att.vc);
        // Som de grupo só toca nas salas daquele grupo; som pessoal só o dono toca.
        if (s.scope === 'group' ? s.group_id !== ch.group_id : s.owner_id !== uid) throw new Fail('Você não pode usar esse som aqui');
        const now = Date.now();
        if (now - (this.lastSound.get(uid) ?? 0) < 700) throw new Fail('Calma, um som de cada vez');
        this.lastSound.set(uid, now);
        const listeners = this.sockets().filter((x) => x.att.vc === att.vc).map((x) => x.att.uid);
        this.sendTo(listeners, 'sound.played', { soundId: s.id, userId: uid, channelId: att.vc });
        return null;
      }

      case 'profile.update': {
        const name = str(d.displayName, 'Nome', 1, 32);
        this.sql.exec('UPDATE users SET display_name = ? WHERE id = ?', name, uid);
        const me = this.user(uid)!;
        this.sendTo([...this.audienceOf(uid), uid], 'user.update', me);
        return me;
      }

      // ---- amigos
      case 'friend.add': {
        const username = String(d.username ?? '').trim().toLowerCase();
        const other = this.one('SELECT id FROM users WHERE username = ?', username);
        if (!other) throw new Fail('Usuário não encontrado');
        const oid = String(other.id);
        if (oid === uid) throw new Fail('Você não pode adicionar a si mesmo');
        const [a, b] = uid < oid ? [uid, oid] : [oid, uid];
        const existing = this.one('SELECT * FROM friendships WHERE a = ? AND b = ?', a, b);
        if (existing) {
          if (existing.status === 'accepted') throw new Fail('Vocês já são amigos');
          if (existing.requester === uid) throw new Fail('Pedido já enviado');
          this.sql.exec("UPDATE friendships SET status = 'accepted' WHERE a = ? AND b = ?", a, b);
        } else {
          this.sql.exec('INSERT INTO friendships (a, b, requester, status, created_at) VALUES (?,?,?,?,?)',
            a, b, uid, 'pending', Date.now());
        }
        this.pushFriend(uid, oid);
        return null;
      }
      case 'friend.accept': {
        const oid = String(d.userId ?? '');
        const [a, b] = uid < oid ? [uid, oid] : [oid, uid];
        const row = this.one('SELECT * FROM friendships WHERE a = ? AND b = ?', a, b);
        if (!row || row.status !== 'pending' || row.requester === uid) throw new Fail('Pedido não encontrado');
        this.sql.exec("UPDATE friendships SET status = 'accepted' WHERE a = ? AND b = ?", a, b);
        this.pushFriend(uid, oid);
        return null;
      }
      case 'friend.remove': {
        const oid = String(d.userId ?? '');
        const [a, b] = uid < oid ? [uid, oid] : [oid, uid];
        this.sql.exec('DELETE FROM friendships WHERE a = ? AND b = ?', a, b);
        this.sendTo([uid], 'friend.removed', { userId: oid });
        this.sendTo([oid], 'friend.removed', { userId: uid });
        return null;
      }

      // ---- grupos
      case 'group.create': {
        const name = str(d.name, 'Nome do grupo', 2, 40);
        const gid = crypto.randomUUID();
        const now = Date.now();
        this.sql.exec('INSERT INTO groups (id, name, owner_id, invite_code, created_at) VALUES (?,?,?,?,?)',
          gid, name, uid, inviteCode(), now);
        this.sql.exec('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?,?,?)', gid, uid, now);
        this.sql.exec('INSERT INTO channels (id, group_id, name, type, position) VALUES (?,?,?,?,?)',
          crypto.randomUUID(), gid, 'geral', 'text', 0);
        this.sql.exec('INSERT INTO channels (id, group_id, name, type, position) VALUES (?,?,?,?,?)',
          crypto.randomUUID(), gid, 'Sala 1', 'voice', 1);
        this.broadcastGroup(gid);
        return { groupId: gid };
      }
      case 'group.join': {
        const code = String(d.code ?? '').trim().toUpperCase();
        const g = this.one('SELECT id FROM groups WHERE invite_code = ?', code);
        if (!g) throw new Fail('Convite inválido');
        const gid = String(g.id);
        this.addMember(gid, uid);
        return { groupId: gid };
      }
      case 'group.rename': {
        const gid = this.ownedGroup(uid, d.groupId);
        this.sql.exec('UPDATE groups SET name = ? WHERE id = ?', str(d.name, 'Nome do grupo', 2, 40), gid);
        this.broadcastGroup(gid);
        return null;
      }
      case 'group.leave': {
        const gid = this.memberGroup(uid, d.groupId);
        const g = this.one('SELECT owner_id FROM groups WHERE id = ?', gid)!;
        if (g.owner_id === uid) throw new Fail('O dono não pode sair; apague o grupo');
        this.kickFromVoice(uid, gid);
        this.sql.exec('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', gid, uid);
        this.sendTo([uid], 'group.removed', { groupId: gid });
        this.broadcastGroup(gid);
        return null;
      }
      case 'group.delete': {
        const gid = this.ownedGroup(uid, d.groupId);
        const members = this.memberIds(gid);
        for (const m of members) this.kickFromVoice(m, gid);
        this.sql.exec('DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?)', gid);
        this.sql.exec('DELETE FROM channels WHERE group_id = ?', gid);
        this.sql.exec('DELETE FROM group_members WHERE group_id = ?', gid);
        this.sql.exec("DELETE FROM sounds WHERE scope = 'group' AND group_id = ?", gid);
        this.sql.exec('DELETE FROM groups WHERE id = ?', gid);
        this.sendTo(members, 'group.removed', { groupId: gid });
        return null;
      }

      // ---- salas
      case 'channel.create': {
        const gid = this.memberGroup(uid, d.groupId);
        const type = d.type === 'voice' ? 'voice' : 'text';
        const name = str(d.name, 'Nome da sala', 1, 32);
        const count = Number(this.one('SELECT COUNT(*) AS n FROM channels WHERE group_id = ?', gid)!.n);
        if (count >= 50) throw new Fail('Limite de 50 salas por grupo');
        this.sql.exec('INSERT INTO channels (id, group_id, name, type, position) VALUES (?,?,?,?,?)',
          crypto.randomUUID(), gid, name, type, Date.now());
        this.broadcastGroup(gid);
        return null;
      }
      case 'channel.rename': {
        const ch = this.channel(d.channelId);
        this.ownedGroup(uid, ch.group_id);
        this.sql.exec('UPDATE channels SET name = ? WHERE id = ?', str(d.name, 'Nome da sala', 1, 32), ch.id);
        this.broadcastGroup(String(ch.group_id));
        return null;
      }
      case 'channel.delete': {
        const ch = this.channel(d.channelId);
        const gid = this.ownedGroup(uid, ch.group_id);
        for (const s of this.sockets()) {
          if (s.att.vc === ch.id) this.setAtt(s.ws, { ...s.att, vc: null, sid: null, tr: [], ss: null, ct: null });
        }
        this.sql.exec('DELETE FROM messages WHERE channel_id = ?', ch.id);
        this.sql.exec('DELETE FROM channels WHERE id = ?', ch.id);
        this.broadcastGroup(gid);
        this.sendTo(this.memberIds(gid), 'voice.update', { channelId: ch.id, participants: [] });
        return null;
      }

      // ---- mensagens (salas de texto e conversas diretas)
      case 'msg.send': {
        const channelId = String(d.channelId ?? '');
        const audience = this.textAudience(uid, channelId);
        const content = str(d.content, 'Mensagem', 1, 2000);
        const m = { id: crypto.randomUUID(), channelId, userId: uid, content, createdAt: Date.now() };
        this.sql.exec('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?,?,?,?,?)',
          m.id, channelId, uid, content, m.createdAt);
        const author = this.user(uid)!.displayName;
        this.sendTo(audience, 'msg.new', { ...m, author });
        return null;
      }
      case 'msg.history': {
        const channelId = String(d.channelId ?? '');
        this.textAudience(uid, channelId);
        const before = typeof d.before === 'number' ? d.before : Number.MAX_SAFE_INTEGER;
        const rows = this.all(
          `SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at, u.display_name
           FROM messages m LEFT JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 50`,
          channelId, before,
        );
        return rows.reverse().map((r) => ({
          id: r.id, channelId: r.channel_id, userId: r.user_id, content: r.content,
          createdAt: r.created_at, author: r.display_name ?? 'Usuário removido',
        }));
      }

      // ---- admin geral (conta definida em ADMIN_USER)
      case 'admin.badges': {
        this.requireAdmin(uid);
        const target = this.user(String(d.userId ?? ''));
        if (!target) throw new Fail('Usuário não encontrado');
        const list = Array.isArray(d.badges) ? d.badges : [];
        const badges = [...new Set(list.filter((b): b is string => typeof b === 'string' && BADGE_RE.test(b)))].slice(0, MAX_BADGES);
        this.sql.exec('UPDATE users SET badges = ? WHERE id = ?', JSON.stringify(badges), target.id);
        this.pushUser(target.id, uid);
        return null;
      }
      case 'admin.entry.set': {
        this.requireAdmin(uid);
        const target = this.user(String(d.userId ?? ''));
        if (!target) throw new Fail('Usuário não encontrado');
        const src = this.one('SELECT id FROM sounds WHERE id = ?', String(d.soundId ?? ''));
        if (!src) throw new Fail('Som não encontrado');
        // Guarda uma cópia: o som de entrada continua valendo mesmo que o original seja apagado.
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO sounds (id, scope, group_id, owner_id, name, emoji, mime, data, created_at)
           SELECT ?, 'entry', NULL, ?, name, emoji, mime, data, ? FROM sounds WHERE id = ?`,
          id, target.id, Date.now(), String(src.id),
        );
        this.sql.exec("DELETE FROM sounds WHERE scope = 'entry' AND owner_id = ? AND id != ?", target.id, id);
        this.pushUser(target.id, uid);
        return null;
      }
      case 'admin.entry.clear': {
        this.requireAdmin(uid);
        const target = String(d.userId ?? '');
        this.sql.exec("DELETE FROM sounds WHERE scope = 'entry' AND owner_id = ?", target);
        this.pushUser(target, uid);
        return null;
      }
      case 'admin.voice.kick': {
        this.requireAdmin(uid);
        const target = String(d.userId ?? '');
        for (const s of this.sockets()) {
          if (s.att.uid !== target || !s.att.vc) continue;
          const vc = s.att.vc;
          this.setAtt(s.ws, { ...s.att, vc: null, sid: null, tr: [], ss: null, ct: null });
          this.broadcastVoice(vc);
          this.sendTo([target], 'voice.kicked', { channelId: vc });
        }
        return null;
      }
      case 'admin.group.kick': {
        this.requireAdmin(uid);
        const gid = String(d.groupId ?? '');
        const target = String(d.userId ?? '');
        const g = this.one('SELECT owner_id FROM groups WHERE id = ?', gid);
        if (!g) throw new Fail('Grupo não encontrado');
        if (g.owner_id === target) throw new Fail('O dono do grupo não pode ser removido');
        this.kickFromVoice(target, gid);
        this.sql.exec('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', gid, target);
        this.sendTo([target], 'group.removed', { groupId: gid, kicked: true });
        this.broadcastGroup(gid);
        return null;
      }
      case 'admin.group.add': {
        this.requireAdmin(uid);
        const gid = String(d.groupId ?? '');
        if (!this.one('SELECT id FROM groups WHERE id = ?', gid)) throw new Fail('Grupo não encontrado');
        const other = this.one('SELECT id FROM users WHERE username = ?', String(d.username ?? '').trim().toLowerCase());
        if (!other) throw new Fail('Usuário não encontrado');
        this.addMember(gid, String(other.id));
        return null;
      }

      // ---- voz
      case 'voice.join': {
        const ch = this.channel(d.channelId);
        if (ch.type !== 'voice') throw new Fail('Essa sala não é de voz');
        this.memberGroup(uid, ch.group_id);
        const prev = att.vc;
        this.setAtt(ws, { ...att, vc: String(ch.id), sid: null, tr: [], ss: null, ct: null });
        if (prev && prev !== ch.id) this.broadcastVoice(prev);
        this.broadcastVoice(String(ch.id));
        // Som de entrada (escolhido pelo admin): toca para todos da sala, inclusive para quem chegou.
        let entrySound: string | null = null;
        const es = prev === ch.id ? null : this.one("SELECT id FROM sounds WHERE scope = 'entry' AND owner_id = ?", uid);
        const now = Date.now();
        if (es && now - (this.lastEntry.get(uid) ?? 0) > 8000) {
          this.lastEntry.set(uid, now);
          entrySound = String(es.id);
          const others = this.sockets(ws).filter((x) => x.att.vc === ch.id).map((x) => x.att.uid);
          this.sendTo(others, 'sound.played', { soundId: entrySound, userId: uid, channelId: String(ch.id) });
        }
        return { sfu: Boolean(this.env.SFU_APP_ID && this.env.SFU_APP_SECRET), entrySound };
      }
      case 'voice.leave': {
        if (!att.vc) return null;
        this.setAtt(ws, { ...att, vc: null, sid: null, tr: [], ss: null, ct: null });
        this.broadcastVoice(att.vc);
        return null;
      }
      case 'voice.state': {
        if (!att.vc) throw new Fail('Você não está em uma sala de voz');
        const tr = Array.isArray(d.tracks)
          ? d.tracks.filter((t): t is string => typeof t === 'string' && t.length <= 32).slice(0, 6)
          : att.tr;
        const stillSharing = tr.some((t) => t.startsWith('screen'));
        this.setAtt(ws, {
          ...att,
          m: typeof d.muted === 'boolean' ? d.muted : att.m,
          d: typeof d.deafened === 'boolean' ? d.deafened : att.d,
          tr,
          ct: stillSharing ? att.ct ?? null : null,
        });
        if (att.ct && !stillSharing) this.sendTo([att.ct], 'rc.ended', { hostId: uid });
        this.broadcastVoice(att.vc);
        return null;
      }
      case 'voice.sfu':
        return this.sfu(ws, att, d);

      // ---- controle remoto: quem transmite a tela autoriza UMA pessoa da mesma sala a mexer nela
      case 'rc.grant': {
        if (!att.vc) throw new Fail('Entre em uma sala de voz primeiro');
        if (!att.tr.some((t) => t.startsWith('screen'))) throw new Fail('Comece a transmitir a tela antes de dar o controle');
        const target = String(d.userId ?? '');
        if (target === uid) throw new Fail('Escolha outra pessoa');
        if (!this.sockets().some((x) => x.att.uid === target && x.att.vc === att.vc)) throw new Fail('Essa pessoa não está na sua sala');
        if (att.ct && att.ct !== target) this.sendTo([att.ct], 'rc.ended', { hostId: uid });
        this.setAtt(ws, { ...att, ct: target });
        this.broadcastVoice(att.vc);
        return null;
      }
      case 'rc.revoke': {
        if (!att.ct) return null;
        this.setAtt(ws, { ...att, ct: null });
        this.sendTo([att.ct], 'rc.ended', { hostId: uid });
        if (att.vc) this.broadcastVoice(att.vc);
        return null;
      }
      case 'rc.signal': {
        // Combinação da ligação direta entre os dois aparelhos (ofertas e endereços).
        const to = String(d.to ?? '');
        const data = d.data;
        if (!att.vc || JSON.stringify(data ?? null).length > 20_000) throw new Fail('Sinal inválido');
        const peers = this.sockets().filter((x) => x.att.uid === to && x.att.vc === att.vc);
        const asHost = att.ct === to;
        const targets = asHost ? peers : peers.filter((x) => x.att.ct === uid);
        if (targets.length === 0) throw new Fail('Sem permissão de controle');
        const payload = JSON.stringify({ ev: 'rc.signal', d: { from: uid, data } });
        for (const t of targets) t.ws.send(payload);
        return null;
      }
      case 'rc.input': {
        // Reserva para quando a ligação direta não abre: os comandos passam pelo servidor.
        const to = String(d.to ?? '');
        const e = Array.isArray(d.e) ? d.e.slice(0, 64) : [];
        if (!att.vc || e.length === 0) return null;
        const payload = JSON.stringify({ ev: 'rc.input', d: { from: uid, e } });
        for (const x of this.sockets()) {
          if (x.att.uid === to && x.att.vc === att.vc && x.att.ct === uid) x.ws.send(payload);
        }
        return null;
      }

      default:
        throw new Fail('Operação desconhecida');
    }
  }

  // ---------------------------------------------------------------- SFU (Cloudflare Realtime)

  /** Repassa chamadas ao SFU usando o segredo do app, que nunca sai do servidor. */
  private async sfu(ws: WebSocket, att: Att, d: Record<string, unknown>): Promise<unknown> {
    const { SFU_APP_ID: appId, SFU_APP_SECRET: secret } = this.env;
    if (!appId || !secret) throw new Fail('Voz ainda não configurada no servidor');
    if (!att.vc) throw new Fail('Você não está em uma sala de voz');

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${SFU_BASE}/${appId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        console.error('SFU', path, res.status, JSON.stringify(data));
        throw new Fail('Falha no servidor de voz');
      }
      return data;
    };

    const action = String(d.action ?? '');
    if (action === 'session') {
      const data = await call('POST', '/sessions/new');
      const sid = String(data.sessionId);
      // Relê o estado: ele pode ter mudado enquanto a chamada ao SFU estava em andamento.
      const cur = ws.deserializeAttachment() as Att | null;
      if (!cur || cur.vc !== att.vc) throw new Fail('Você saiu da sala');
      this.setAtt(ws, { ...cur, sid, tr: [], ss: null });
      this.broadcastVoice(att.vc);
      return { sessionId: sid };
    }

    const body = (d.body ?? {}) as Record<string, unknown>;

    // ---- tela capturada pelo app Android (sessão própria)
    if (action === 'screen-session') {
      const data = await call('POST', '/sessions/new');
      const ss = String(data.sessionId);
      const cur = ws.deserializeAttachment() as Att | null;
      if (!cur || cur.vc !== att.vc) throw new Fail('Você saiu da sala');
      this.setAtt(ws, { ...cur, ss });
      this.broadcastVoice(att.vc);
      return { sessionId: ss };
    }
    if (action === 'screen-tracks') {
      if (!att.ss) throw new Fail('Transmissão não iniciada');
      const tracks = Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]) : [];
      // Esta sessão só publica; nunca puxa faixas de ninguém.
      if (tracks.some((t) => t.location !== 'local')) throw new Fail('Faixa inválida');
      return call('POST', `/sessions/${att.ss}/tracks/new`, body);
    }
    if (action === 'screen-end') {
      const cur = ws.deserializeAttachment() as Att | null;
      if (cur?.ss) {
        this.setAtt(ws, { ...cur, ss: null, tr: cur.tr.filter((t) => !t.startsWith('screen')) });
        if (cur.vc) this.broadcastVoice(cur.vc);
      }
      return null;
    }

    if (!att.sid) throw new Fail('Sessão de voz não iniciada');

    if (action === 'tracks') {
      // Só permite puxar faixas de quem está na mesma sala.
      const allowed = new Set<string>();
      for (const s of this.sockets()) {
        if (s.att.vc !== att.vc) continue;
        if (s.att.sid) allowed.add(s.att.sid);
        if (s.att.ss) allowed.add(s.att.ss);
      }
      const tracks = Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]) : [];
      for (const t of tracks) {
        if (t.location === 'remote' && !allowed.has(String(t.sessionId))) throw new Fail('Faixa fora da sua sala');
      }
      return call('POST', `/sessions/${att.sid}/tracks/new`, body);
    }
    if (action === 'renegotiate') return call('PUT', `/sessions/${att.sid}/renegotiate`, body);
    if (action === 'close') return call('PUT', `/sessions/${att.sid}/tracks/close`, body);
    throw new Fail('Ação de voz desconhecida');
  }

  // ---------------------------------------------------------------- Consultas e envio

  private all(query: string, ...args: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...args).toArray() as Row[];
  }

  private one(query: string, ...args: SqlStorageValue[]): Row | null {
    return this.all(query, ...args)[0] ?? null;
  }

  private user(id: string) {
    const r = this.one('SELECT id, username, display_name, avatar, badges FROM users WHERE id = ?', id) as UserRow | null;
    return r ? this.userObj(r) : null;
  }

  private userObj(r: UserRow) {
    let badges: string[] = [];
    try {
      badges = r.badges ? (JSON.parse(r.badges) as string[]) : [];
    } catch {
      /* valor antigo ou inválido: fica sem selos */
    }
    const es = this.one("SELECT id, name, emoji FROM sounds WHERE scope = 'entry' AND owner_id = ?", r.id);
    return {
      id: r.id, username: r.username, displayName: r.display_name, avatar: r.avatar ?? null, badges,
      admin: r.username === this.adminUser(),
      entrySound: es ? { id: es.id, name: es.name, emoji: es.emoji } : null,
    };
  }

  /** Avisa todo mundo que vê esta pessoa (e o admin que mexeu) de que os dados dela mudaram. */
  private pushUser(id: string, also: string): void {
    const u = this.user(id);
    if (u) this.sendTo([...this.audienceOf(id), id, also], 'user.update', u);
  }

  private adminUser(): string {
    return (this.env.ADMIN_USER ?? '').trim().toLowerCase();
  }

  private requireAdmin(uid: string): void {
    const admin = this.adminUser();
    const me = this.one('SELECT username FROM users WHERE id = ?', uid);
    if (!admin || me?.username !== admin) throw new Fail('Só o admin pode fazer isso');
  }

  /** Coloca a pessoa no grupo e manda para ela tudo o que um membro precisa ver. */
  private addMember(gid: string, uid: string): void {
    this.sql.exec('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?,?,?)', gid, uid, Date.now());
    this.broadcastGroup(gid);
    this.sendTo([uid], 'voice.snapshot', this.voiceFor([gid]));
    for (const r of this.all(SOUND_COLS + " WHERE scope = 'group' AND group_id = ?", gid)) {
      this.sendTo([uid], 'sound.added', this.soundObj(r));
    }
    const members = this.memberIds(gid);
    if (this.isOnline(uid)) this.sendTo(members, 'presence', { userId: uid, online: true });
    // Quem entrou também precisa saber quem já está online.
    for (const m of members) if (m !== uid && this.isOnline(m)) this.sendTo([uid], 'presence', { userId: m, online: true });
  }

  private sockets(except?: WebSocket): { ws: WebSocket; att: Att }[] {
    const out: { ws: WebSocket; att: Att }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const att = ws.deserializeAttachment() as Att | null;
      if (att) out.push({ ws, att });
    }
    return out;
  }

  private setAtt(ws: WebSocket, att: Att): void {
    ws.serializeAttachment(att);
  }

  private isOnline(uid: string): boolean {
    return this.sockets().some((s) => s.att.uid === uid);
  }

  private sendTo(uids: Iterable<string>, ev: string, d: unknown): void {
    const set = uids instanceof Set ? uids : new Set(uids);
    if (set.size === 0) return;
    const payload = JSON.stringify({ ev, d });
    for (const s of this.sockets()) {
      if (!set.has(s.att.uid)) continue;
      try {
        s.ws.send(payload);
      } catch {
        /* conexão caindo */
      }
    }
  }

  private memberIds(gid: string): string[] {
    return this.all('SELECT user_id FROM group_members WHERE group_id = ?', gid).map((r) => String(r.user_id));
  }

  private groupIdsOf(uid: string): string[] {
    return this.all('SELECT group_id FROM group_members WHERE user_id = ?', uid).map((r) => String(r.group_id));
  }

  private friendRows(uid: string): Row[] {
    return this.all('SELECT * FROM friendships WHERE a = ? OR b = ?', uid, uid);
  }

  /** Quem deve saber da presença deste usuário: amigos aceitos e colegas de grupo. */
  private audienceOf(uid: string): Set<string> {
    const out = new Set<string>();
    for (const f of this.friendRows(uid)) {
      if (f.status === 'accepted') out.add(String(f.a === uid ? f.b : f.a));
    }
    for (const r of this.all(
      'SELECT DISTINCT m2.user_id FROM group_members m1 JOIN group_members m2 ON m1.group_id = m2.group_id WHERE m1.user_id = ?',
      uid,
    )) out.add(String(r.user_id));
    out.delete(uid);
    return out;
  }

  private memberGroup(uid: string, groupId: unknown): string {
    const gid = String(groupId ?? '');
    if (!this.one('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', gid, uid)) {
      throw new Fail('Você não faz parte desse grupo');
    }
    return gid;
  }

  private ownedGroup(uid: string, groupId: unknown): string {
    const gid = String(groupId ?? '');
    const g = this.one('SELECT owner_id FROM groups WHERE id = ?', gid);
    if (!g) throw new Fail('Grupo não encontrado');
    if (g.owner_id !== uid) throw new Fail('Só o dono do grupo pode fazer isso');
    return gid;
  }

  private channel(channelId: unknown): Row {
    const ch = this.one('SELECT * FROM channels WHERE id = ?', String(channelId ?? ''));
    if (!ch) throw new Fail('Sala não encontrada');
    return ch;
  }

  /** Confere o acesso a um chat e devolve quem recebe as mensagens dele. */
  private textAudience(uid: string, channelId: string): string[] {
    if (channelId.startsWith('dm:')) {
      const [, a, b] = channelId.split(':');
      if ((a !== uid && b !== uid) || !a || !b || a >= b) throw new Fail('Conversa inválida');
      const f = this.one('SELECT status FROM friendships WHERE a = ? AND b = ?', a, b);
      if (!f || f.status !== 'accepted') throw new Fail('Vocês precisam ser amigos para conversar');
      return [a, b];
    }
    const ch = this.channel(channelId);
    if (ch.type !== 'text') throw new Fail('Essa sala não é de texto');
    return this.memberIds(this.memberGroup(uid, ch.group_id));
  }

  private groupObj(gid: string) {
    const g = this.one('SELECT * FROM groups WHERE id = ?', gid);
    if (!g) return null;
    return {
      id: gid,
      name: g.name,
      ownerId: g.owner_id,
      inviteCode: g.invite_code,
      channels: this.all('SELECT id, name, type FROM channels WHERE group_id = ? ORDER BY position', gid),
      members: this.all(
        `SELECT u.id, u.username, u.display_name, u.avatar, u.badges FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? ORDER BY u.display_name COLLATE NOCASE`,
        gid,
      ).map((u) => this.userObj(u as unknown as UserRow)),
    };
  }

  private broadcastGroup(gid: string): void {
    const g = this.groupObj(gid);
    if (g) this.sendTo(this.memberIds(gid), 'group.update', g);
  }

  private participants(channelId: string) {
    const inRoom = new Set(this.sockets().filter((s) => s.att.vc === channelId).map((s) => s.att.uid));
    return this.sockets()
      .filter((s) => s.att.vc === channelId)
      .map((s) => ({
        userId: s.att.uid, muted: s.att.m, deafened: s.att.d, sessionId: s.att.sid, screenSessionId: s.att.ss ?? null, tracks: s.att.tr,
        // Só vale enquanto quem recebeu o controle continua na sala.
        controlBy: s.att.ct && inRoom.has(s.att.ct) ? s.att.ct : null,
      }));
  }

  private broadcastVoice(channelId: string): void {
    const ch = this.one('SELECT group_id FROM channels WHERE id = ?', channelId);
    if (!ch) return;
    this.sendTo(this.memberIds(String(ch.group_id)), 'voice.update', {
      channelId, participants: this.participants(channelId),
    });
  }

  private voiceFor(gids: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const gid of gids) {
      for (const ch of this.all("SELECT id FROM channels WHERE group_id = ? AND type = 'voice'", gid)) {
        const p = this.participants(String(ch.id));
        if (p.length) out[String(ch.id)] = p;
      }
    }
    return out;
  }

  private kickFromVoice(uid: string, gid: string): void {
    const ids = new Set(this.all('SELECT id FROM channels WHERE group_id = ?', gid).map((r) => String(r.id)));
    for (const s of this.sockets()) {
      if (s.att.uid === uid && s.att.vc && ids.has(s.att.vc)) {
        const vc = s.att.vc;
        this.setAtt(s.ws, { ...s.att, vc: null, sid: null, tr: [], ss: null, ct: null });
        this.broadcastVoice(vc);
      }
    }
  }

  private friendView(uid: string, f: Row) {
    const oid = String(f.a === uid ? f.b : f.a);
    const user = this.user(oid);
    if (!user) return null;
    const status = f.status === 'accepted' ? 'accepted' : f.requester === uid ? 'outgoing' : 'incoming';
    return { user, status, online: status === 'accepted' && this.isOnline(oid) };
  }

  private pushFriend(x: string, y: string): void {
    const [a, b] = x < y ? [x, y] : [y, x];
    const f = this.one('SELECT * FROM friendships WHERE a = ? AND b = ?', a, b);
    if (!f) return;
    this.sendTo([x], 'friend.update', this.friendView(x, f));
    this.sendTo([y], 'friend.update', this.friendView(y, f));
  }

  private snapshot(uid: string) {
    const gids = this.groupIdsOf(uid);
    const audience = this.audienceOf(uid);
    const onlineNow = new Set(this.sockets().map((s) => s.att.uid));
    return {
      me: this.user(uid),
      groups: gids.map((g) => this.groupObj(g)).filter(Boolean),
      friends: this.friendRows(uid).map((f) => this.friendView(uid, f)).filter(Boolean),
      online: [...audience].filter((u) => onlineNow.has(u)),
      voice: this.voiceFor(gids),
      sfu: Boolean(this.env.SFU_APP_ID && this.env.SFU_APP_SECRET),
      sounds: this.soundsFor(uid, gids),
    };
  }
}

export { dmId };
