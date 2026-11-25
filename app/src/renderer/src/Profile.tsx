import { useEffect, useState } from 'react';
import { patch, request, setView, type State, type User } from './store';
import { Avatar, Icon } from './ui';

export const openProfile = (userId: string) => patch({ profileUserId: userId });
const close = () => patch({ profileUserId: null });

function findUser(s: State, id: string): User | undefined {
  if (s.me?.id === id) return s.me;
  for (const g of s.groups) {
    const m = g.members.find((u) => u.id === id);
    if (m) return m;
  }
  return s.friends.find((f) => f.user.id === id)?.user;
}

/** Cartão que abre ao clicar em uma pessoa: foto, nome, status e atalhos de amizade e conversa. */
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
        <button className="btn ghost" onClick={close}>Fechar</button>
      </div>
    </div>
  );
}
