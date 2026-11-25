import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { patch } from './store';

const PATHS: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M3 3l18 18M9 9v3a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.5 2.6M12 18v3',
  ear: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z',
  earOff: 'M3 3l18 18M4 14v-2a8 8 0 0 1 2.2-5.5M9 4.6A8 8 0 0 1 20 12v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v3M17 20h2a1 1 0 0 0 1-1',
  hangup: 'M3 14c0-5 18-5 18 0v2l-4 1-1-3H8l-1 3-4-1z',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  plus: 'M12 5v14M5 12h14',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  chat: 'M4 5h16v11H9l-5 4z',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M9 12h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  back: 'M15 5l-7 7 7 7',
  gear: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const AVATAR_COLORS = ['#ffb39a', '#3ecf8e', '#5aa9ff', '#b094ff', '#ffb84d', '#ff6b9a', '#4dd4d4'];

export function Avatar({ name, id, size = 34, online }: { name: string; id: string; size?: number; online?: boolean }) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (
    <span className="avatar" style={{ width: size, height: size, background: AVATAR_COLORS[h % AVATAR_COLORS.length], fontSize: size * 0.42 }}>
      {name.trim().charAt(0).toUpperCase() || '?'}
      {online !== undefined && <span className={`dot ${online ? 'on' : 'off'}`} />}
    </span>
  );
}

export interface FormSpec {
  title: string;
  text?: string;
  fields?: { name: string; label: string; placeholder?: string; initial?: string; maxLength?: number }[];
  choices?: { name: string; label: string; options: { value: string; label: string }[] };
  confirm: string;
  danger?: boolean;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
}

export function FormModal({ spec, onClose }: { spec: FormSpec; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of spec.fields ?? []) v[f.name] = f.initial ?? '';
    if (spec.choices) v[spec.choices.name] = spec.choices.options[0].value;
    return v;
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await spec.onSubmit(values);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h2>{spec.title}</h2>
        {spec.text && <p className="muted">{spec.text}</p>}
        {spec.choices && (
          <div className="segmented">
            {spec.choices.options.map((o) => (
              <button type="button" key={o.value} className={values[spec.choices!.name] === o.value ? 'active' : ''}
                onClick={() => setValues({ ...values, [spec.choices!.name]: o.value })}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        {(spec.fields ?? []).map((f, i) => (
          <label key={f.name}>
            <span>{f.label}</span>
            <input autoFocus={i === 0} value={values[f.name]} placeholder={f.placeholder} maxLength={f.maxLength ?? 40}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          </label>
        ))}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className={`btn ${spec.danger ? 'danger' : 'primary'}`} disabled={busy}>{spec.confirm}</button>
        </div>
      </form>
    </div>
  );
}

/** Só aparece em telas estreitas: volta do conteúdo para a navegação. */
export function Back() {
  return (
    <button type="button" className="icon-btn back" title="Voltar" aria-label="Voltar" onClick={() => patch({ mobileMain: false })}>
      <Icon name="back" />
    </button>
  );
}

export function IconButton(props: { icon: string; title: string; onClick: () => void; active?: boolean; danger?: boolean; children?: ReactNode }) {
  return (
    <button type="button" className={`icon-btn${props.active ? ' active' : ''}${props.danger ? ' danger' : ''}`}
      title={props.title} aria-label={props.title} onClick={props.onClick}>
      <Icon name={props.icon} />
      {props.children}
    </button>
  );
}
