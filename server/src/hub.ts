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
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
}

type Row = Record<string, SqlStorageValue>;

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

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

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;

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
    `);
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

    if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405);
    try {
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
    return { token: await this.newSession(id), user: { id, username, displayName } };
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
      user: { id, username: String(row.username), displayName: String(row.display_name) },
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
      ws.send(JSON.stringify({ id, ok: true, d: result ?? null }));
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
    const att: Att = { uid, vc: null, m: false, d: false, sid: null, tr: [] };
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
        this.sql.exec('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?,?,?)',
          gid, uid, Date.now());
        this.broadcastGroup(gid);
        this.sendTo([uid], 'voice.snapshot', this.voiceFor([gid]));
        if (this.isOnline(uid)) this.sendTo(this.memberIds(gid), 'presence', { userId: uid, online: true });
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
          if (s.att.vc === ch.id) this.setAtt(s.ws, { ...s.att, vc: null, sid: null, tr: [] });
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

      // ---- voz
      case 'voice.join': {
        const ch = this.channel(d.channelId);
        if (ch.type !== 'voice') throw new Fail('Essa sala não é de voz');
        this.memberGroup(uid, ch.group_id);
        const prev = att.vc;
        this.setAtt(ws, { ...att, vc: String(ch.id), sid: null, tr: [] });
        if (prev && prev !== ch.id) this.broadcastVoice(prev);
        this.broadcastVoice(String(ch.id));
        return { sfu: Boolean(this.env.SFU_APP_ID && this.env.SFU_APP_SECRET) };
      }
      case 'voice.leave': {
        if (!att.vc) return null;
        this.setAtt(ws, { ...att, vc: null, sid: null, tr: [] });
        this.broadcastVoice(att.vc);
        return null;
      }
      case 'voice.state': {
        if (!att.vc) throw new Fail('Você não está em uma sala de voz');
        const tr = Array.isArray(d.tracks)
          ? d.tracks.filter((t): t is string => typeof t === 'string' && t.length <= 32).slice(0, 6)
          : att.tr;
        this.setAtt(ws, {
          ...att,
          m: typeof d.muted === 'boolean' ? d.muted : att.m,
          d: typeof d.deafened === 'boolean' ? d.deafened : att.d,
          tr,
        });
        this.broadcastVoice(att.vc);
        return null;
      }
      case 'voice.sfu':
        return this.sfu(ws, att, d);

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
      this.setAtt(ws, { ...cur, sid, tr: [] });
      this.broadcastVoice(att.vc);
      return { sessionId: sid };
    }

    if (!att.sid) throw new Fail('Sessão de voz não iniciada');
    const body = (d.body ?? {}) as Record<string, unknown>;

    if (action === 'tracks') {
      // Só permite puxar faixas de quem está na mesma sala.
      const allowed = new Set(this.sockets().filter((s) => s.att.vc === att.vc && s.att.sid).map((s) => s.att.sid));
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
    const r = this.one('SELECT id, username, display_name FROM users WHERE id = ?', id) as UserRow | null;
    return r ? { id: r.id, username: r.username, displayName: r.display_name } : null;
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
        `SELECT u.id, u.username, u.display_name FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? ORDER BY u.display_name COLLATE NOCASE`,
        gid,
      ).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })),
    };
  }

  private broadcastGroup(gid: string): void {
    const g = this.groupObj(gid);
    if (g) this.sendTo(this.memberIds(gid), 'group.update', g);
  }

  private participants(channelId: string) {
    return this.sockets()
      .filter((s) => s.att.vc === channelId)
      .map((s) => ({
        userId: s.att.uid, muted: s.att.m, deafened: s.att.d, sessionId: s.att.sid, tracks: s.att.tr,
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
        this.setAtt(s.ws, { ...s.att, vc: null, sid: null, tr: [] });
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
    };
  }
}

export { dmId };
