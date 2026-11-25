import { useEffect, useState } from 'react';
import { patch, request, setView, uploadSound, type State, type User } from './store';
import { validate } from './Sounds';
import { Avatar, Icon } from './ui';
import { BADGE_GROUPS, badgesOf, findUser } from './Badges';

export const openProfile = (userId: string) => patch({ profileUserId: userId });
const close = () => patch({ profileUserId: null });

/** Cartão que abre ao clicar em uma pessoa: foto, nome, status, selos e atalhos de amizade e conversa. */
export function ProfileModal({ s, userId }: { s: State; userId: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const user = findUser(s, userId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // A pessoa saiu de todos os meus grupos e não é amiga: não há mais o que mostrar.
  useEffect(() => { if (!user) close(); }, [user]);
  if (!user) return null;

  const mine = user.id === s.me!.id;
  const online = mine || Boolean(s.online[user.id]);
  const friend = s.friends.find((f) => f.user.id === user.id);
  let room = '';
  for (const g of s.groups) {
    for (const c of g.channels) {
      if ((s.voice[c.id] ?? []).some((p) => p.userId === user.id)) room = `${c.name} · ${g.name}`;
    }
  }
  const badges = badgesOf(user);

  const run = async (op: string, d: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await request(op, d);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal profile">
        <Avatar name={user.displayName} id={user.id} size={96} />
        <h2>{user.displayName}</h2>
        <div className="muted">@{user.username}</div>
        <div className="profile-status">
          <span className={`dot-inline ${online ? 'on' : 'off'}`} /> {online ? 'Online' : 'Offline'}
        </div>
        {room && <div className="profile-status"><Icon name="speaker" size={15} /> Em chamada: {room}</div>}
        {friend?.status === 'accepted' && <div className="profile-status"><Icon name="users" size={15} /> Vocês são amigos</div>}

        {badges.length > 0 && (
          <div className="profile-badges">
            {badges.map((b) => (
              <div className="profile-badge" key={b.id}>
                <span className="emoji">{b.emoji}</span>
                <div><b>{b.name}</b><small>{b.text}</small></div>
              </div>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}

        {mine && <div className="muted">Este é você.</div>}
        {!mine && !friend && (
          <button className="btn primary wide" disabled={busy} onClick={() => void run('friend.add', { username: user.username })}>
            Adicionar amigo
          </button>
        )}
        {friend?.status === 'outgoing' && (
          <>
            <button className="btn primary wide" disabled>Pedido de amizade enviado</button>
            <button className="btn ghost" disabled={busy} onClick={() => void run('friend.remove', { userId: user.id })}>Cancelar pedido</button>
          </>
        )}
        {friend?.status === 'incoming' && (
          <>
            <button className="btn primary wide" disabled={busy} onClick={() => void run('friend.accept', { userId: user.id })}>
              Aceitar pedido de amizade
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => void run('friend.remove', { userId: user.id })}>Recusar</button>
          </>
        )}
        {friend?.status === 'accepted' && (
          <button className="btn primary wide" onClick={() => { close(); setView({ kind: 'home', dmUserId: user.id }); }}>
            Enviar mensagem
          </button>
        )}

        {s.me!.admin && <AdminTools s={s} user={user} inCall={Boolean(room)} busy={busy} run={run} />}
        <button className="btn ghost" onClick={close}>Fechar</button>
      </div>
    </div>
  );
}

/** Só o admin geral vê: dar e tirar selos, tirar da chamada e remover do grupo aberto. */
function AdminTools({ s, user, inCall, busy, run }: {
  s: State; user: User; inCall: boolean; busy: boolean; run: (op: string, d: Record<string, unknown>) => Promise<void>;
}) {
  const [confirmKick, setConfirmKick] = useState(false);
  const has = new Set(user.badges ?? []);
  const toggle = (id: string) => {
    const next = has.has(id) ? [...has].filter((x) => x !== id) : [...has, id];
    void run('admin.badges', { userId: user.id, badges: next });
  };
  const group = s.view.kind === 'group' ? s.groups.find((g) => g.id === (s.view as { groupId: string }).groupId) : undefined;
  const canKick = group && user.id !== s.me!.id && user.id !== group.ownerId && group.members.some((m) => m.id === user.id);

  return (
    <div className="admin-box">
      <div className="admin-title">🛡️ Admin</div>
      {BADGE_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="admin-sub">{g.title}</div>
          <div className="badge-picker">
            {g.badges.map((b) => (
              <button key={b.id} type="button" disabled={busy} title={b.text}
                className={`badge-chip${has.has(b.id) ? ' on' : ''}`} onClick={() => toggle(b.id)}>
                <span>{b.emoji}</span> {b.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <EntrySound s={s} user={user} busy={busy} run={run} />
      {(inCall || canKick) && <div className="admin-sub">Ações</div>}
      {inCall && user.id !== s.me!.id && (
        <button className="btn danger wide" disabled={busy} onClick={() => void run('admin.voice.kick', { userId: user.id })}>
          Tirar da chamada
        </button>
      )}
      {canKick && (
        <button className="btn danger wide" disabled={busy} onClick={() => {
          if (!confirmKick) return setConfirmKick(true);
          void run('admin.group.kick', { groupId: group.id, userId: user.id });
        }}>
          {confirmKick ? `Confirmar: remover de "${group.name}"` : `Remover do grupo "${group.name}"`}
        </button>
      )}
    </div>
  );
}

/** Som que toca para a sala quando a pessoa entra em uma chamada. Só o admin define. */
function EntrySound({ s, user, busy, run }: {
  s: State; user: User; busy: boolean; run: (op: string, d: Record<string, unknown>) => Promise<void>;
}) {
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const groupName = (id: string | null | undefined) => s.groups.find((g) => g.id === id)?.name ?? 'Grupo';
  const options = [...s.sounds].sort((a, b) => a.name.localeCompare(b.name));

  async function upload(file: File | undefined) {
    if (!file) return;
    setNote('');
    const problem = await validate(file);
    if (problem) return setNote(`${file.name}: ${problem}`);
    setSending(true);
    try {
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 32) || 'Entrada';
      await uploadSound(file, { scope: 'entry', userId: user.id, name, emoji: '🚪' });
    } catch (err) {
      setNote((err as Error).message);
    }
    setSending(false);
  }

  return (
    <div>
      <div className="admin-sub">Som de entrada</div>
      <div className="entry-now">
        {user.entrySound
          ? <><span className="grow ellipsis">{user.entrySound.emoji} {user.entrySound.name}</span>
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run('admin.entry.clear', { userId: user.id })}>Remover</button></>
          : <span className="muted">Nenhum. Toca para a sala quando a pessoa entra em uma chamada.</span>}
      </div>
      <div className="entry-row">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Escolher um som que já existe…</option>
          {options.map((x) => (
            <option key={x.id} value={x.id}>{x.emoji} {x.name} — {x.scope === 'group' ? groupName(x.groupId) : 'meus sons'}</option>
          ))}
        </select>
        <button type="button" className="btn primary small" disabled={busy || !pick}
          onClick={() => { void run('admin.entry.set', { userId: user.id, soundId: pick }); setPick(''); }}>Definir</button>
      </div>
      <label className="btn ghost small entry-upload">
        {sending ? 'Enviando…' : 'Enviar um som novo (até 10 s)'}
        <input type="file" accept="audio/*,video/webm,video/mp4,.mp3,.ogg,.wav,.m4a" hidden disabled={sending}
          onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {note && <div className="error">{note}</div>}
    </div>
  );
}
