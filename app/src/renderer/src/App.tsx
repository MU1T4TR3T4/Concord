import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  activeTextChannel, clearUnread, dmChannelId, joinVoice, leaveVoice, loadHistory, login, logout, openGroup,
  register, request, setView, setVoiceFlags, useStore, type Friend, type Group, type State, type User,
} from './store';
import { Avatar, FormModal, Icon, IconButton, type FormSpec } from './ui';
import { VoiceStage } from './VoiceStage';

export function App() {
  const s = useStore();
  const [form, setForm] = useState<FormSpec | null>(null);

  if (s.status === 'signed-out') return <AuthScreen />;
  if (!s.me) return <div className="splash">Conectando ao Concord…</div>;

  const group = s.view.kind === 'group' ? s.groups.find((g) => g.id === (s.view as { groupId: string }).groupId) : undefined;

  return (
    <div className="shell">
      {s.status === 'reconnecting' && <div className="banner">Conexão perdida. Reconectando…</div>}
      <Rail s={s} ask={setForm} />
      <aside className="sidebar">
        {group ? <GroupSidebar s={s} group={group} ask={setForm} /> : <HomeSidebar s={s} />}
        <VoicePanel s={s} />
        <UserPanel s={s} ask={setForm} />
      </aside>
      <main className="main">
        {group ? <GroupMain s={s} group={group} /> : <HomeMain s={s} ask={setForm} />}
      </main>
      {group && <Members s={s} group={group} />}
      {form && <FormModal spec={form} onClose={() => setForm(null)} />}
    </div>
  );
}

type Ask = (spec: FormSpec) => void;

// ------------------------------------------------------------------ entrada

function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await login(username, password);
      else await register({ username, displayName, password, code });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="logo">Concord</div>
        <p className="muted">{mode === 'login' ? 'Entre para falar com seus amigos.' : 'Crie sua conta em segundos.'}</p>
        <label>
          <span>Usuário</span>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} maxLength={20} autoComplete="username" />
        </label>
        {mode === 'register' && (
          <label>
            <span>Nome que os amigos vão ver</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        <label>
          <span>Senha</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={100}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {mode === 'register' && (
          <label>
            <span>Código de convite (se o dono do servidor pediu)</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary wide" disabled={busy}>{mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'Ainda não tenho conta' : 'Já tenho conta'}
        </button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ barra de grupos

function Rail({ s, ask }: { s: State; ask: Ask }) {
  const dmUnread = s.friends.some((f) => s.me && s.unread[dmChannelId(s.me.id, f.user.id)]);
  const pending = s.friends.filter((f) => f.status === 'incoming').length;
  return (
    <nav className="rail">
      <button className={`rail-item home${s.view.kind === 'home' ? ' active' : ''}`} title="Amigos e conversas"
        onClick={() => setView({ kind: 'home' })}>
        <Icon name="users" size={22} />
        {(dmUnread || pending > 0) && <span className="badge" />}
      </button>
      <div className="rail-sep" />
      {s.groups.map((g) => {
        const unread = g.channels.some((c) => s.unread[c.id]);
        const active = s.view.kind === 'group' && s.view.groupId === g.id;
        return (
          <button key={g.id} className={`rail-item${active ? ' active' : ''}`} title={g.name} onClick={() => openGroup(g.id)}>
            {g.name.trim().slice(0, 2).toUpperCase()}
            {unread && !active && <span className="badge" />}
          </button>
        );
      })}
      <button className="rail-item add" title="Criar ou entrar em um grupo"
        onClick={() => ask({
          title: 'Novo grupo',
          choices: { name: 'mode', label: '', options: [{ value: 'create', label: 'Criar grupo' }, { value: 'join', label: 'Entrar com convite' }] },
          fields: [{ name: 'value', label: 'Nome do grupo ou código de convite', placeholder: 'Ex.: Jogatina ou ABCD2345' }],
          confirm: 'Continuar',
          onSubmit: async (v) => {
            const r = v.mode === 'create'
              ? await request<{ groupId: string }>('group.create', { name: v.value })
              : await request<{ groupId: string }>('group.join', { code: v.value });
            // O grupo chega por evento; abre assim que estiver na lista.
            setTimeout(() => openGroup(r.groupId), 150);
          },
        })}>
        <Icon name="plus" size={22} />
      </button>
    </nav>
  );
}

// ------------------------------------------------------------------ início (amigos e conversas)

function HomeSidebar({ s }: { s: State }) {
  const friends = s.friends.filter((f) => f.status === 'accepted').sort(byName);
  const view = s.view as { kind: 'home'; dmUserId?: string };
  const pending = s.friends.filter((f) => f.status === 'incoming').length;
  return (
    <div className="side-scroll">
      <button className={`row${!view.dmUserId ? ' active' : ''}`} onClick={() => setView({ kind: 'home' })}>
        <Icon name="users" /> <span className="grow">Amigos</span>
        {pending > 0 && <span className="count">{pending}</span>}
      </button>
      <div className="section">Conversas</div>
      {friends.length === 0 && <div className="empty-hint">Adicione um amigo para conversar.</div>}
      {friends.map((f) => {
        const ch = dmChannelId(s.me!.id, f.user.id);
        return (
          <button key={f.user.id} className={`row${view.dmUserId === f.user.id ? ' active' : ''}`}
            onClick={() => setView({ kind: 'home', dmUserId: f.user.id })}>
            <Avatar name={f.user.displayName} id={f.user.id} size={28} online={f.online} />
            <span className="grow ellipsis">{f.user.displayName}</span>
            {s.unread[ch] ? <span className="count">{s.unread[ch]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

const byName = (a: Friend, b: Friend) => a.user.displayName.localeCompare(b.user.displayName);

function HomeMain({ s, ask }: { s: State; ask: Ask }) {
  const view = s.view as { kind: 'home'; dmUserId?: string };
  const friend = s.friends.find((f) => f.user.id === view.dmUserId && f.status === 'accepted');
  if (friend) {
    return (
      <Chat s={s} channelId={dmChannelId(s.me!.id, friend.user.id)} title={friend.user.displayName} icon="chat"
        placeholder={`Mensagem para ${friend.user.displayName}`} />
    );
  }
  return <FriendsView s={s} ask={ask} />;
}

function FriendsView({ s, ask }: { s: State; ask: Ask }) {
  const [username, setUsername] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    try {
      await request('friend.add', { username });
      setNote({ ok: true, text: `Pedido enviado para ${username.trim()}.` });
      setUsername('');
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  }

  const incoming = s.friends.filter((f) => f.status === 'incoming');
  const outgoing = s.friends.filter((f) => f.status === 'outgoing');
  const accepted = s.friends.filter((f) => f.status === 'accepted').sort(byName);

  const remove = (f: Friend, title: string, confirm: string) => ask({
    title, text: `${f.user.displayName} (@${f.user.username})`, confirm, danger: true,
    onSubmit: () => request('friend.remove', { userId: f.user.id }),
  });

  return (
    <>
      <header className="topbar"><Icon name="users" /> <h1>Amigos</h1></header>
      <div className="page">
        <form className="add-friend" onSubmit={add}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Nome de usuário do seu amigo" maxLength={20} />
          <button className="btn primary">Adicionar amigo</button>
        </form>
        {note && <div className={note.ok ? 'success' : 'error'}>{note.text}</div>}

        {incoming.length > 0 && <div className="section">Pedidos recebidos</div>}
        {incoming.map((f) => (
          <div className="person" key={f.user.id}>
            <Avatar name={f.user.displayName} id={f.user.id} />
            <div className="grow"><b>{f.user.displayName}</b><small>@{f.user.username}</small></div>
            <IconButton icon="check" title="Aceitar" onClick={() => void request('friend.accept', { userId: f.user.id })} />
            <IconButton icon="x" title="Recusar" danger onClick={() => void request('friend.remove', { userId: f.user.id })} />
          </div>
        ))}

        {outgoing.length > 0 && <div className="section">Pedidos enviados</div>}
        {outgoing.map((f) => (
          <div className="person" key={f.user.id}>
            <Avatar name={f.user.displayName} id={f.user.id} />
            <div className="grow"><b>{f.user.displayName}</b><small>Aguardando resposta</small></div>
            <IconButton icon="x" title="Cancelar pedido" danger onClick={() => void request('friend.remove', { userId: f.user.id })} />
          </div>
        ))}

        <div className="section">Todos os amigos ({accepted.length})</div>
        {accepted.length === 0 && <div className="empty-hint">Você ainda não tem amigos adicionados.</div>}
        {accepted.map((f) => (
          <div className="person" key={f.user.id}>
            <Avatar name={f.user.displayName} id={f.user.id} online={f.online} />
            <div className="grow"><b>{f.user.displayName}</b><small>{f.online ? 'Online' : 'Offline'} · @{f.user.username}</small></div>
            <IconButton icon="chat" title="Conversar" onClick={() => setView({ kind: 'home', dmUserId: f.user.id })} />
            <IconButton icon="trash" title="Excluir amigo" danger onClick={() => remove(f, 'Excluir amigo?', 'Excluir')} />
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ grupo

function GroupSidebar({ s, group, ask }: { s: State; group: Group; ask: Ask }) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const owner = group.ownerId === s.me!.id;
  const view = s.view as { channelId?: string };
  const nameOf = (id: string) => group.members.find((m) => m.id === id)?.displayName ?? 'Alguém';

  const newChannel = (type: 'text' | 'voice') => ask({
    title: type === 'voice' ? 'Nova sala de voz' : 'Nova sala de texto',
    fields: [{ name: 'name', label: 'Nome da sala', maxLength: 32 }],
    confirm: 'Criar',
    onSubmit: (v) => request('channel.create', { groupId: group.id, name: v.name, type }),
  });

  const channelMenu = (id: string, name: string) => ask({
    title: `Sala "${name}"`,
    choices: { name: 'action', label: '', options: [{ value: 'rename', label: 'Renomear' }, { value: 'delete', label: 'Apagar' }] },
    fields: [{ name: 'name', label: 'Novo nome (só para renomear)', initial: name, maxLength: 32 }],
    confirm: 'Aplicar',
    onSubmit: (v) => v.action === 'delete'
      ? request('channel.delete', { channelId: id })
      : request('channel.rename', { channelId: id, name: v.name }),
  });

  return (
    <>
      <header className="side-header">
        <span className="grow ellipsis">{group.name}</span>
        <IconButton icon="more" title="Opções do grupo" active={menu} onClick={() => setMenu(!menu)} />
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => { void navigator.clipboard.writeText(group.inviteCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              <Icon name="copy" /> {copied ? 'Copiado!' : `Convite: ${group.inviteCode}`}
            </button>
            {owner && (
              <button onClick={() => { setMenu(false); ask({
                title: 'Renomear grupo', fields: [{ name: 'name', label: 'Nome', initial: group.name }], confirm: 'Salvar',
                onSubmit: (v) => request('group.rename', { groupId: group.id, name: v.name }),
              }); }}><Icon name="edit" /> Renomear grupo</button>
            )}
            {owner ? (
              <button className="danger" onClick={() => { setMenu(false); ask({
                title: 'Apagar grupo?', text: `"${group.name}" e todas as mensagens serão apagados para todos. Não dá para desfazer.`,
                confirm: 'Apagar grupo', danger: true, onSubmit: () => request('group.delete', { groupId: group.id }),
              }); }}><Icon name="trash" /> Apagar grupo</button>
            ) : (
              <button className="danger" onClick={() => { setMenu(false); ask({
                title: 'Sair do grupo?', text: group.name, confirm: 'Sair', danger: true,
                onSubmit: () => request('group.leave', { groupId: group.id }),
              }); }}><Icon name="logout" /> Sair do grupo</button>
            )}
          </div>
        )}
      </header>
      <div className="side-scroll">
        <div className="section">Texto
          <button className="mini" title="Nova sala de texto" onClick={() => newChannel('text')}><Icon name="plus" size={15} /></button>
        </div>
        {group.channels.filter((c) => c.type === 'text').map((c) => (
          <button key={c.id} className={`row${view.channelId === c.id ? ' active' : ''}`}
            onClick={() => setView({ kind: 'group', groupId: group.id, channelId: c.id })}
            onContextMenu={(e) => { e.preventDefault(); if (owner) channelMenu(c.id, c.name); }}>
            <Icon name="hash" /> <span className="grow ellipsis">{c.name}</span>
            {s.unread[c.id] ? <span className="count">{s.unread[c.id]}</span> : null}
          </button>
        ))}

        <div className="section">Voz
          <button className="mini" title="Nova sala de voz" onClick={() => newChannel('voice')}><Icon name="plus" size={15} /></button>
        </div>
        {group.channels.filter((c) => c.type === 'voice').map((c) => (
          <div key={c.id}>
            <button className={`row${s.myVoice?.channelId === c.id ? ' joined' : ''}${view.channelId === c.id ? ' active' : ''}`}
              title="Clique para entrar"
              onClick={() => { setView({ kind: 'group', groupId: group.id, channelId: c.id }); void joinVoice(c.id); }}
              onContextMenu={(e) => { e.preventDefault(); if (owner) channelMenu(c.id, c.name); }}>
              <Icon name="speaker" /> <span className="grow ellipsis">{c.name}</span>
            </button>
            {(s.voice[c.id] ?? []).map((p) => (
              <div className={`voice-user${s.speaking[p.userId] ? ' speaking' : ''}`} key={p.userId + (p.sessionId ?? '')}>
                <Avatar name={nameOf(p.userId)} id={p.userId} size={22} />
                <span className="grow ellipsis">{nameOf(p.userId)}</span>
                {p.tracks.some((t) => t.startsWith('screen')) && <span className="live">AO VIVO</span>}
                {p.deafened ? <Icon name="earOff" size={14} /> : p.muted ? <Icon name="micOff" size={14} /> : null}
              </div>
            ))}
          </div>
        ))}
        {owner && <div className="empty-hint">Clique com o botão direito em uma sala para renomear ou apagar.</div>}
      </div>
    </>
  );
}

function GroupMain({ s, group }: { s: State; group: Group }) {
  const view = s.view as { channelId?: string };
  const channel = group.channels.find((c) => c.id === view.channelId);
  if (!channel) return <div className="splash">Escolha uma sala ao lado.</div>;
  if (channel.type === 'voice') return <VoiceStage s={s} group={group} channel={channel} />;
  return <Chat s={s} channelId={channel.id} title={channel.name} icon="hash" placeholder={`Mensagem em #${channel.name}`} />;
}

function Members({ s, group }: { s: State; group: Group }) {
  const isOn = (u: User) => u.id === s.me!.id || Boolean(s.online[u.id]);
  const on = group.members.filter(isOn);
  const off = group.members.filter((u) => !isOn(u));
  const row = (u: User, online: boolean) => (
    <div className={`row static${online ? '' : ' dim'}`} key={u.id}>
      <Avatar name={u.displayName} id={u.id} size={28} online={online} />
      <span className="grow ellipsis">{u.displayName}{u.id === group.ownerId ? ' ★' : ''}</span>
    </div>
  );
  return (
    <aside className="members">
      <div className="section">Online — {on.length}</div>
      {on.map((u) => row(u, true))}
      {off.length > 0 && <div className="section">Offline — {off.length}</div>}
      {off.map((u) => row(u, false))}
    </aside>
  );
}

// ------------------------------------------------------------------ chat

function Chat({ s, channelId, title, icon, placeholder }: { s: State; channelId: string; title: string; icon: string; placeholder: string }) {
  const messages = s.messages[channelId];
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
    setError('');
    clearUnread(channelId);
    if (!s.messages[channelId] && s.status === 'ready') void loadHistory(channelId).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, s.status]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, channelId]);

  useEffect(() => {
    const onFocus = () => activeTextChannel() === channelId && clearUnread(channelId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channelId]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setText('');
    stick.current = true;
    try {
      await request('msg.send', { channelId, content });
      setError('');
    } catch (err) {
      setText(content);
      setError((err as Error).message);
    }
  }

  return (
    <>
      <header className="topbar"><Icon name={icon} /> <h1>{title}</h1></header>
      <div className="messages" ref={listRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {messages && !s.historyEnd[channelId] && (
          <button className="link center" onClick={() => { stick.current = false; void loadHistory(channelId, true); }}>
            Carregar mensagens anteriores
          </button>
        )}
        {messages?.length === 0 && <div className="empty-hint center">Nenhuma mensagem ainda. Diga oi!</div>}
        {(messages ?? []).map((m, i) => {
          const prev = messages![i - 1];
          const grouped = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60_000;
          return (
            <div className={`msg${grouped ? ' grouped' : ''}`} key={m.id}>
              {!grouped && <Avatar name={m.author} id={m.userId} size={36} />}
              <div className="msg-body">
                {!grouped && <div className="msg-head"><b>{m.author}</b><time>{formatTime(m.createdAt)}</time></div>}
                <div className="msg-text">{m.content}</div>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="error inline">{error}</div>}
      <form className="composer" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={2000} />
      </form>
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('pt-BR')} ${time}`;
}

// ------------------------------------------------------------------ painéis de baixo

function VoicePanel({ s }: { s: State }) {
  if (!s.myVoice) return null;
  let label = 'Sala de voz';
  for (const g of s.groups) {
    const c = g.channels.find((x) => x.id === s.myVoice!.channelId);
    if (c) label = `${c.name} · ${g.name}`;
  }
  return (
    <div className="voice-panel">
      <div className="grow">
        <div className="voice-status">Na sala de voz</div>
        <div className="muted ellipsis">{label}</div>
        {!s.sfu && <div className="warn">O áudio ainda não foi ativado no servidor.</div>}
        {s.sharing && <div className="warn">Você está transmitindo a tela.</div>}
      </div>
      <IconButton icon="hangup" title="Sair da sala de voz" danger onClick={() => void leaveVoice()} />
    </div>
  );
}

function UserPanel({ s, ask }: { s: State; ask: Ask }) {
  const me = s.me!;
  const v = s.myVoice;
  return (
    <div className="user-panel">
      <button className="me" title="Editar meu nome" onClick={() => ask({
        title: 'Meu nome', fields: [{ name: 'displayName', label: 'Nome que os amigos veem', initial: me.displayName, maxLength: 32 }],
        confirm: 'Salvar', onSubmit: (x) => request('profile.update', { displayName: x.displayName }),
      })}>
        <Avatar name={me.displayName} id={me.id} size={32} online />
        <span className="grow"><b className="ellipsis">{me.displayName}</b><small>@{me.username}</small></span>
      </button>
      {v && (
        <>
          <IconButton icon={v.muted ? 'micOff' : 'mic'} title={v.muted ? 'Ativar microfone' : 'Mutar microfone'} active={v.muted}
            onClick={() => void setVoiceFlags({ muted: !v.muted, deafened: v.muted ? false : v.deafened })} />
          <IconButton icon={v.deafened ? 'earOff' : 'ear'} title={v.deafened ? 'Voltar a ouvir' : 'Silenciar áudio'} active={v.deafened}
            onClick={() => void setVoiceFlags({ deafened: !v.deafened })} />
        </>
      )}
      <IconButton icon="logout" title="Sair da conta" onClick={() => ask({
        title: 'Sair da conta?', confirm: 'Sair', danger: true, onSubmit: () => logout(),
      })} />
    </div>
  );
}
