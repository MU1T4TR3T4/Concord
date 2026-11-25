import { useEffect, useRef, useState } from 'react';
import { avatarUrl, logout, patch, request, updateSettings, uploadAvatar, type State } from './store';
import { onMicLevel, startMicPreview, stopMicPreview } from './voice';
import { Avatar, Icon } from './ui';
import { SoundsTab } from './Sounds';

// O medidor trabalha em decibéis: -60 dB (silêncio) a 0 dB (máximo).
const toDb = (rms: number) => (rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60);
const fromDb = (db: number) => 10 ** (db / 20);
const pct = (db: number) => ((db + 60) / 60) * 100;

type Tab = 'voz' | 'sons' | 'atualizacao' | 'conta';

export function SettingsModal({ s, onClose }: { s: State; onClose: () => void }) {
  const desktop = Boolean(window.concord?.update);
  const [tab, setTab] = useState<Tab>('voz');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <div className="settings-head">
          <h2>Configurações</h2>
          <button className="icon-btn" title="Fechar" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="segmented">
          <button className={tab === 'voz' ? 'active' : ''} onClick={() => setTab('voz')}>Voz e áudio</button>
          <button className={tab === 'sons' ? 'active' : ''} onClick={() => setTab('sons')}>Sons</button>
          {desktop && (
            <button className={tab === 'atualizacao' ? 'active' : ''} onClick={() => setTab('atualizacao')}>
              Atualização{s.update.state === 'available' || s.update.state === 'ready' ? ' •' : ''}
            </button>
          )}
          <button className={tab === 'conta' ? 'active' : ''} onClick={() => setTab('conta')}>Conta</button>
        </div>
        <div className="settings-body">
          {tab === 'voz' && <VoiceTab s={s} />}
          {tab === 'sons' && <SoundsTab s={s} />}
          {tab === 'atualizacao' && <UpdateTab s={s} />}
          {tab === 'conta' && <AccountTab s={s} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => undefined);
    load();
    // Os nomes só aparecem depois que o microfone é liberado; recarrega em seguida.
    const t = setTimeout(load, 1200);
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => {
      clearTimeout(t);
      navigator.mediaDevices?.removeEventListener('devicechange', load);
    };
  }, []);
  return devices;
}

function VoiceTab({ s }: { s: State }) {
  const st = s.settings;
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;
  const canPtt = Boolean(window.concord?.ptt);
  const barRef = useRef<HTMLDivElement>(null);
  const [binding, setBinding] = useState(false);

  // Liga o microfone enquanto a aba está aberta, para o medidor funcionar fora de uma sala.
  useEffect(() => {
    void startMicPreview();
    const off = onMicLevel((level, open) => {
      const bar = barRef.current;
      if (!bar) return;
      bar.style.width = `${pct(toDb(level))}%`;
      bar.classList.toggle('open', open);
    });
    return () => {
      off();
      stopMicPreview();
    };
  }, []);

  async function bindKey() {
    setBinding(true);
    let label = '';
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      label = e.code.replace(/^Key|^Digit/, '');
    };
    window.addEventListener('keydown', onKey, true);
    const key = await window.concord!.ptt.capture().catch(() => null);
    window.removeEventListener('keydown', onKey, true);
    setBinding(false);
    if (!key) return;
    updateSettings({ pttKey: { ...key, label: key.type === 'mouse' ? `Botão ${key.code} do mouse` : label || `Tecla ${key.code}` } });
  }

  const sensDb = Math.round(toDb(st.sensitivity));

  return (
    <>
      {s.micError && <div className="error">Não consegui abrir o microfone. Confira se ele está conectado e liberado no sistema.</div>}

      <div className="two">
        <label>
          <span>Dispositivo de entrada (microfone)</span>
          <select value={st.inputDeviceId} onChange={(e) => updateSettings({ inputDeviceId: e.target.value })}>
            <option value="default">Padrão do sistema</option>
            {inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microfone'}</option>)}
          </select>
        </label>
        <label>
          <span>Dispositivo de saída (fone ou caixa)</span>
          <select value={st.outputDeviceId} disabled={!canPickOutput} onChange={(e) => updateSettings({ outputDeviceId: e.target.value })}>
            <option value="default">Padrão do sistema</option>
            {canPickOutput && outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Saída'}</option>)}
          </select>
        </label>
      </div>

      <div className="two">
        <label>
          <span>Volume do microfone — {Math.round(st.inputVolume * 100)}%</span>
          <input type="range" min={0} max={200} value={Math.round(st.inputVolume * 100)}
            onChange={(e) => updateSettings({ inputVolume: Number(e.target.value) / 100 })} />
        </label>
        <label>
          <span>Volume de saída — {Math.round(st.outputVolume * 100)}%</span>
          <input type="range" min={0} max={100} value={Math.round(st.outputVolume * 100)}
            onChange={(e) => updateSettings({ outputVolume: Number(e.target.value) / 100 })} />
        </label>
      </div>

      <div className="field">
        <span className="field-label">Modo de entrada</span>
        <div className="segmented">
          <button className={st.inputMode === 'voice' ? 'active' : ''} onClick={() => updateSettings({ inputMode: 'voice' })}>Atividade de voz</button>
          <button className={st.inputMode === 'ptt' ? 'active' : ''} disabled={!canPtt} onClick={() => updateSettings({ inputMode: 'ptt' })}>Apertar para falar</button>
        </div>
        {!canPtt && <p className="muted small">Apertar para falar só existe no aplicativo de computador.</p>}
      </div>

      {st.inputMode === 'ptt' && canPtt ? (
        <div className="field">
          <span className="field-label">Tecla de falar</span>
          <div className="keybind">
            <span className={`key${st.pttKey ? '' : ' empty'}`}>{binding ? 'Aperte uma tecla…' : st.pttKey?.label ?? 'Nenhuma tecla definida'}</span>
            <button className="btn primary" disabled={binding} onClick={() => void bindKey()}>{st.pttKey ? 'Trocar tecla' : 'Definir tecla'}</button>
          </div>
          <p className="muted small">Funciona com o Concord minimizado ou atrás do jogo. Botões laterais do mouse também valem.
            {!st.pttKey && ' Enquanto não houver tecla, o microfone segue por atividade de voz.'}</p>
        </div>
      ) : (
        <div className="field">
          <span className="field-label">Sensibilidade do microfone — {sensDb} dB</span>
          <p className="muted small">Fale normalmente: a barra deve passar do marcador. Abaixo dele, o microfone não transmite (corta teclado e ruído de fundo).</p>
        </div>
      )}

      <div className="meter">
        <div className="meter-bar" ref={barRef} />
        {st.inputMode === 'voice' && <div className="meter-mark" style={{ left: `${pct(sensDb)}%` }} />}
      </div>
      {st.inputMode === 'voice' && (
        <input type="range" className="sens" min={-60} max={-10} value={sensDb}
          onChange={(e) => updateSettings({ sensitivity: fromDb(Number(e.target.value)) })} />
      )}

      <div className="field">
        <span className="field-label">Tratamento da voz</span>
        <Toggle label="Redução de ruído" on={st.noiseSuppression} set={(v) => updateSettings({ noiseSuppression: v })} />
        <Toggle label="Cancelamento de eco" on={st.echoCancellation} set={(v) => updateSettings({ echoCancellation: v })} />
        <Toggle label="Ajuste automático de volume" on={st.autoGain} set={(v) => updateSettings({ autoGain: v })} />
      </div>
    </>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function UpdateTab({ s }: { s: State }) {
  const u = s.update;
  const api = window.concord!.update;
  const text: Record<typeof u.state, string> = {
    idle: 'Ainda não verificado.',
    checking: 'Procurando atualização…',
    none: 'Você está na versão mais recente.',
    available: `Versão ${u.version} disponível.`,
    downloading: `Baixando… ${u.percent ?? 0}%`,
    ready: `Versão ${u.version} baixada. Reinicie para instalar.`,
    error: `Não foi possível atualizar: ${u.message ?? 'erro desconhecido'}`,
  };
  return (
    <>
      <div className="field">
        <span className="field-label">Versão instalada</span>
        <div className="version">Concord {s.appVersion || '—'}</div>
      </div>
      <div className={u.state === 'error' ? 'error' : u.state === 'available' || u.state === 'ready' ? 'success' : 'muted'}>{text[u.state]}</div>
      {u.state === 'downloading' && <div className="meter"><div className="meter-bar open" style={{ width: `${u.percent ?? 0}%` }} /></div>}
      <div className="modal-actions left">
        {u.state === 'available' && <button className="btn primary" onClick={() => { patch({ update: { ...u, state: 'downloading', percent: 0 } }); void api.download(); }}>Baixar atualização</button>}
        {u.state === 'ready' && <button className="btn primary" onClick={() => void api.install()}>Reiniciar e instalar</button>}
        {(u.state === 'idle' || u.state === 'none' || u.state === 'error') && <button className="btn primary" onClick={() => void api.check()}>Procurar atualização</button>}
      </div>
      <p className="muted small">O Concord procura atualizações sozinho ao abrir e a cada 15 minutos. Quando houver uma, aparece um aviso no meio da tela.</p>
    </>
  );
}

function AccountTab({ s, onClose }: { s: State; onClose: () => void }) {
  const me = s.me!;
  const [name, setName] = useState(me.displayName);
  const [note, setNote] = useState('');
  const [photoNote, setPhotoNote] = useState('');
  const file = useRef<HTMLInputElement>(null);

  async function pickPhoto(f: File | undefined) {
    if (!f) return;
    setPhotoNote('Enviando…');
    try {
      await uploadAvatar(await squarePhoto(f));
      setPhotoNote('');
    } catch (e) {
      setPhotoNote((e as Error).message);
    }
  }
  async function save() {
    try {
      await request('profile.update', { displayName: name });
      setNote('Nome salvo.');
    } catch (e) {
      setNote((e as Error).message);
    }
  }
  return (
    <>
      <div className="field">
        <span className="field-label">Foto de perfil</span>
        <div className="avatar-edit">
          <Avatar name={me.displayName} id={me.id} size={84} />
          <div className="btns">
            <input ref={file} type="file" accept="image/*" hidden
              onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn primary" onClick={() => file.current?.click()}>{avatarUrl(me.id, s) ? 'Trocar foto' : 'Escolher foto'}</button>
            {avatarUrl(me.id, s) && (
              <button className="btn ghost" onClick={() => void request('profile.avatar.remove').catch((e) => setPhotoNote((e as Error).message))}>Remover</button>
            )}
          </div>
        </div>
        {photoNote && <span className="muted small">{photoNote}</span>}
      </div>
      <label>
        <span>Nome que os amigos veem</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="modal-actions left">
        <button className="btn primary" disabled={!name.trim() || name === me.displayName} onClick={() => void save()}>Salvar nome</button>
        {note && <span className="muted">{note}</span>}
      </div>
      <div className="field">
        <span className="field-label">Usuário</span>
        <div className="version">@{me.username}</div>
      </div>
      <div className="modal-actions left">
        <button className="btn danger" onClick={() => { onClose(); void logout(); }}>Sair da conta</button>
      </div>
    </>
  );
}

/** Recorta o centro da imagem em um quadrado de 256 px e devolve um JPEG pequeno. */
async function squarePhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não consegui abrir essa imagem'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const g = canvas.getContext('2d')!;
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    if (!blob) throw new Error('Não consegui preparar a foto');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
