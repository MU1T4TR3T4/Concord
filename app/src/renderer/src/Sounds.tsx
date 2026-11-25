import { useEffect, useRef, useState } from 'react';
import {
  MAX_SOUND_BYTES, MAX_SOUND_SECONDS, request, soundUrl, updateSettings, uploadSound, type Sound, type State,
} from './store';
import { Icon } from './ui';

const EMOJIS = [
  '🔊', '😂', '🤣', '😎', '😭', '😡', '🤡', '💀', '👻', '🔥',
  '💩', '🎉', '👏', '🤘', '🙏', '👀', '🫡', '🤔', '😱', '🥳',
  '🐒', '🐱', '🐶', '🐔', '🦆', '🐸', '🐷', '🦖', '🏍️', '🚗',
  '🚨', '📢', '🔔', '🎺', '🥁', '🎸', '🎮', '⚽', '💥', '💣',
  '❤️', '⭐', '✅', '❌', '⚠️', '💤', '🍺', '🍕', '💰', '👑',
];

/** O grupo dono da sala de voz em que estou (os "sons da sala" são os desse grupo). */
export function voiceGroup(s: State) {
  return s.groups.find((g) => g.channels.some((c) => c.id === s.myVoice?.channelId));
}

const canManage = (s: State, sound: Sound) =>
  sound.ownerId === s.me?.id || s.groups.find((g) => g.id === sound.groupId)?.ownerId === s.me?.id;

// ------------------------------------------------------------------ mesa de som (abre acima do painel de voz)

export function SoundBoard({ s, onClose, onUpload }: { s: State; onClose: () => void; onUpload: (scope: 'group' | 'user') => void }) {
  const group = voiceGroup(s);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const room = s.sounds.filter((x) => x.scope === 'group' && x.groupId === group?.id).sort(byDate);
  const mine = s.sounds.filter((x) => x.scope === 'user' && x.ownerId === s.me?.id).sort(byDate);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Clique fora fecha, menos no próprio botão "Sons" (que já alterna) e em janelas por cima.
      if (!ref.current?.contains(t) && !t.closest('.voice-actions') && !t.closest('.overlay')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const play = (sound: Sound) =>
    request('sound.play', { soundId: sound.id }).then(() => setError('')).catch((e) => setError((e as Error).message));

  const grid = (list: Sound[], scope: 'group' | 'user') => (
    <div className="sb-grid">
      {list.map((sound) => (
        <div className="sb-item" key={sound.id}>
          <button className="sb-play" title={`Tocar "${sound.name}" para todos na sala`} onClick={() => void play(sound)}>
            <span className="emoji">{sound.emoji}</span>
            <span className="ellipsis">{sound.name}</span>
          </button>
          {canManage(s, sound) && (
            <button className="sb-del" title="Apagar som" onClick={() => void request('sound.delete', { soundId: sound.id }).catch((e) => setError((e as Error).message))}>×</button>
          )}
        </div>
      ))}
      <button className="sb-play sb-add" onClick={() => onUpload(scope)}>
        <Icon name="plus" size={16} /> Adicionar
      </button>
    </div>
  );

  return (
    <div className="soundboard" ref={ref}>
      {error && <div className="error">{error}</div>}
      {group && (
        <>
          <div className="sb-head"><span>Sons da sala · {group.name}</span></div>
          {room.length === 0 && <p className="muted small">Ninguém adicionou sons aqui ainda. Os sons da sala ficam para todo mundo do grupo usar.</p>}
          {grid(room, 'group')}
        </>
      )}
      <div className="sb-head"><span>Meus sons</span></div>
      {mine.length === 0 && <p className="muted small">Sons só seus, que você pode tocar em qualquer sala.</p>}
      {grid(mine, 'user')}
    </div>
  );
}

const byDate = (a: Sound, b: Sound) => a.createdAt - b.createdAt;

// ------------------------------------------------------------------ envio de sons (um ou vários)

interface Draft {
  file: File;
  name: string;
  emoji: string;
  state: 'ready' | 'sending' | 'done' | 'error';
  error?: string;
}

/** Confere tamanho e duração antes de enviar; devolve a mensagem de erro, se houver. */
export async function validate(file: File): Promise<string | undefined> {
  if (file.size > MAX_SOUND_BYTES) return 'Maior que 512 KB';
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    if (audio.duration > MAX_SOUND_SECONDS + 0.5) return `Mais de ${MAX_SOUND_SECONDS} segundos`;
  } catch {
    return 'Formato de áudio não suportado';
  } finally {
    void ctx.close();
  }
  return undefined;
}

export function SoundUpload({ s, scope: initialScope, groupId, onClose }: {
  s: State; scope: 'group' | 'user'; groupId: string | null; onClose: () => void;
}) {
  const group = s.groups.find((g) => g.id === groupId);
  const [scope, setScope] = useState<'group' | 'user'>(group ? initialScope : 'user');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const change = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const next: Draft[] = [];
    for (const file of Array.from(files).slice(0, 30)) {
      const error = await validate(file);
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 32) || 'Som';
      next.push({ file, name, emoji: '🔊', state: error ? 'error' : 'ready', error });
    }
    setDrafts((d) => [...d, ...next]);
  }

  async function send() {
    setBusy(true);
    let failed = false;
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (d.state !== 'ready') continue;
      change(i, { state: 'sending' });
      try {
        await uploadSound(d.file, { scope, groupId, name: d.name.trim() || 'Som', emoji: d.emoji });
        change(i, { state: 'done' });
      } catch (e) {
        failed = true;
        change(i, { state: 'error', error: (e as Error).message });
      }
    }
    setBusy(false);
    if (!failed) onClose();
  }

  const ready = drafts.filter((d) => d.state === 'ready').length;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal big">
        <h2>Adicionar sons</h2>
        {group && (
          <div className="segmented">
            <button className={scope === 'group' ? 'active' : ''} onClick={() => setScope('group')}>Sons da sala ({group.name})</button>
            <button className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>Meus sons</button>
          </div>
        )}
        <p className="muted small">
          {scope === 'group' ? 'Todo mundo do grupo vai poder tocar esses sons.' : 'Só você toca esses sons, em qualquer sala.'}
          {' '}Até {MAX_SOUND_SECONDS} segundos e 512 KB cada (MP3, OGG, WAV, M4A).
        </p>

        <input ref={input} type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.webm" multiple hidden
          onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        <div className="drop" onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void add(e.dataTransfer.files); }}>
          <Icon name="upload" size={22} />
          <span>Clique para escolher os arquivos, ou arraste para cá. Pode selecionar vários de uma vez.</span>
        </div>

        {drafts.length > 0 && (
          <div className="upload-list">
            {drafts.map((d, i) => (
              <div key={i}>
                <div className="upload-row">
                  <button className="emoji-btn" title="Escolher emoji" disabled={busy} onClick={() => setPicking(picking === i ? null : i)}>{d.emoji}</button>
                  <input value={d.name} maxLength={32} disabled={busy || d.state === 'done'} onChange={(e) => change(i, { name: e.target.value })} />
                  <span className="state" title={d.error}>
                    {d.state === 'done' ? '✅' : d.state === 'error' ? '⚠️' : d.state === 'sending' ? '⏳' : ''}
                  </span>
                  <button className="icon-btn danger" title="Tirar da lista" disabled={busy} onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}>
                    <Icon name="x" />
                  </button>
                </div>
                {d.error && <div className="error small">{d.file.name}: {d.error}</div>}
                {picking === i && (
                  <div className="emoji-grid">
                    {EMOJIS.map((e) => <button key={e} onClick={() => { change(i, { emoji: e }); setPicking(null); }}>{e}</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={onClose}>Fechar</button>
          <button className="btn primary" disabled={busy || ready === 0} onClick={() => void send()}>
            {busy ? 'Enviando…' : ready > 1 ? `Enviar ${ready} sons` : 'Enviar som'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ aba "Sons" das configurações

export function SoundsTab({ s }: { s: State }) {
  const [upload, setUpload] = useState(false);
  const [error, setError] = useState('');
  const mine = s.sounds.filter((x) => x.scope === 'user' && x.ownerId === s.me?.id).sort(byDate);
  const preview = (sound: Sound) => {
    const el = new Audio(soundUrl(sound.id));
    el.volume = s.settings.soundVolume;
    void el.play().catch(() => undefined);
  };

  return (
    <>
      <label>
        <span>Volume dos sons — {Math.round(s.settings.soundVolume * 100)}%</span>
        <input type="range" min={0} max={100} value={Math.round(s.settings.soundVolume * 100)}
          onChange={(e) => updateSettings({ soundVolume: Number(e.target.value) / 100 })} />
      </label>
      <div className="field">
        <span className="field-label">Meus sons ({mine.length})</span>
        <p className="muted small">Sons só seus, que aparecem na mesa de som de qualquer sala de voz. Os sons de cada sala são adicionados dentro da própria sala.</p>
      </div>
      {error && <div className="error">{error}</div>}
      <div>
        {mine.map((sound) => (
          <div className="sound-row" key={sound.id}>
            <span className="emoji">{sound.emoji}</span>
            <span className="grow ellipsis">{sound.name}</span>
            <button className="icon-btn" title="Ouvir" onClick={() => preview(sound)}><Icon name="speaker" /></button>
            <button className="icon-btn danger" title="Apagar" onClick={() => void request('sound.delete', { soundId: sound.id }).catch((e) => setError((e as Error).message))}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <div className="modal-actions left">
        <button className="btn primary" onClick={() => setUpload(true)}>Enviar sons (um ou vários)</button>
      </div>
      {upload && <SoundUpload s={s} scope="user" groupId={null} onClose={() => setUpload(false)} />}
    </>
  );
}
