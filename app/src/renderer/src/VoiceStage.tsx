import { useEffect, useRef, useState } from 'react';
import { leaveVoice, setVoiceFlags, setVolume, setWatching, type Channel, type Group, type State } from './store';
import { canShareScreen, captureSources, screenStreamOf, startShare, stopShare, type Quality } from './voice';
import { Avatar, Back, Icon, IconButton } from './ui';
import { SoundBoard, SoundUpload, voiceGroup } from './Sounds';
import { openProfile } from './Profile';

const isScreen = (t: string) => t.startsWith('screen');

/**
 * Botões de "Transmitir tela" e "Sons" da sala de voz. Ficam no painel de voz do canto
 * inferior esquerdo; no celular, na barra de baixo da sala.
 */
export function VoiceActions({ s }: { s: State }) {
  const [picker, setPicker] = useState(false);
  const [board, setBoard] = useState(false);
  const [upload, setUpload] = useState<'group' | 'user' | null>(null);
  const [error, setError] = useState('');
  // Navegador de celular não deixa capturar a tela; só o app Android (ou o computador) consegue.
  const canShare = canShareScreen();
  const group = voiceGroup(s);

  return (
    <>
      {error && <div className="error small">{error}</div>}
      <div className="voice-actions">
        {canShare && (s.sharing ? (
          <button className="act on" title="Parar de transmitir a tela" onClick={() => void stopShare()}>
            <Icon name="screen" /> <span className="ellipsis">Parar</span>
          </button>
        ) : (
          <button className="act" title="Transmitir a tela" disabled={!s.sfu} onClick={() => { setError(''); setPicker(true); }}>
            <Icon name="screen" /> <span className="ellipsis">Tela</span>
          </button>
        ))}
        <button className={`act${board ? ' open' : ''}`} title="Mesa de som" onClick={() => setBoard(!board)}>
          <Icon name="sound" /> <span className="ellipsis">Sons</span>
        </button>
        {board && <SoundBoard s={s} onClose={() => setBoard(false)} onUpload={setUpload} />}
      </div>
      {picker && <SharePicker onClose={() => setPicker(false)} onError={setError} />}
      {upload && <SoundUpload s={s} scope={upload} groupId={group?.id ?? null} onClose={() => setUpload(null)} />}
    </>
  );
}

export function VoiceStage({ s, group, channel }: { s: State; group: Group; channel: Channel }) {
  const inRoom = s.myVoice?.channelId === channel.id;
  const parts = s.voice[channel.id] ?? [];
  const me = s.me!;
  const nameOf = (id: string) => group.members.find((m) => m.id === id)?.displayName ?? 'Alguém';
  const streamers = parts.filter((p) => p.tracks.some(isScreen));
  const v = s.myVoice;

  return (
    <>
      <header className="topbar"><Back /><Icon name="speaker" /> <h1>{channel.name}</h1></header>
      <div className="stage">
        {!inRoom && <div className="empty-hint center">Você não está nesta sala. Clique nela na lista ao lado para entrar.</div>}
        {inRoom && !s.sfu && <div className="error">O áudio ainda não foi ativado no servidor.</div>}
        {inRoom && s.micError && <div className="error">Não consegui abrir seu microfone. Você ouve os outros, mas eles não ouvem você.</div>}

        {streamers.length > 0 && (
          <div className="streams">
            {streamers.map((p) => (
              <StreamTile key={p.userId} s={s} userId={p.userId} name={nameOf(p.userId)} mine={p.userId === me.id} canWatch={inRoom} />
            ))}
          </div>
        )}

        <div className="tiles">
          {parts.map((p) => (
            <div className={`tile${s.speaking[p.userId] ? ' speaking' : ''}`} key={p.userId + (p.sessionId ?? '')}>
              <button className="tile-who" title="Ver perfil" onClick={() => openProfile(p.userId)}>
                <Avatar name={nameOf(p.userId)} id={p.userId} size={64} />
                <div className="tile-name">
                  <span className="ellipsis">{nameOf(p.userId)}</span>
                  {p.deafened ? <Icon name="earOff" size={15} /> : p.muted ? <Icon name="micOff" size={15} /> : null}
                </div>
              </button>
              {inRoom && p.userId !== me.id && (
                <input type="range" min={0} max={100} title="Volume desta pessoa" className="volume"
                  value={Math.round((s.volumes[p.userId] ?? 1) * 100)}
                  onChange={(e) => setVolume(p.userId, Number(e.target.value) / 100)} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* No computador estes controles ficam no painel de voz, à esquerda; esta barra é só do celular. */}
      {inRoom && v && (
        <div className="controls mobile-only">
          <button className={`ctl${v.muted ? ' off' : ''}`} title={v.muted ? 'Ativar microfone' : 'Mutar microfone'}
            onClick={() => void setVoiceFlags({ muted: !v.muted, deafened: v.muted ? false : v.deafened })}>
            <Icon name={v.muted ? 'micOff' : 'mic'} size={22} />
          </button>
          <button className={`ctl${v.deafened ? ' off' : ''}`} title={v.deafened ? 'Voltar a ouvir' : 'Silenciar áudio'}
            onClick={() => void setVoiceFlags({ deafened: !v.deafened })}>
            <Icon name={v.deafened ? 'earOff' : 'ear'} size={22} />
          </button>
          <VoiceActions s={s} />
          <button className="ctl hang" title="Sair da sala de voz" onClick={() => void leaveVoice()}><Icon name="hangup" size={22} /></button>
        </div>
      )}
    </>
  );
}

function StreamTile({ s, userId, name, mine, canWatch }: { s: State; userId: string; name: string; mine: boolean; canWatch: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const watching = mine || Boolean(s.watching[userId]);
  const stream = watching ? screenStreamOf(userId) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
    // mediaRev muda quando o vídeo chega ou sai
  }, [stream, s.mediaRev]);

  return (
    <div className="stream">
      {mine && !stream ? (
        <div className="stream-cover">
          <span className="live">AO VIVO</span>
          <b>Você está transmitindo a tela</b>
        </div>
      ) : watching ? (
        <video ref={ref} autoPlay playsInline muted onDoubleClick={(e) => void e.currentTarget.requestFullscreen()} />
      ) : (
        <div className="stream-cover">
          <span className="live">AO VIVO</span>
          <b>{name} está transmitindo</b>
          <button className="btn primary" disabled={!canWatch} onClick={() => setWatching(userId, true)}>Assistir</button>
        </div>
      )}
      {watching && (
        <div className="stream-bar">
          <span className="live">AO VIVO</span>
          <span className="grow ellipsis">{mine ? 'Sua transmissão' : name}</span>
          {!stream && <span className="muted">Carregando…</span>}
          <IconButton icon="expand" title="Tela cheia (ou dê dois cliques no vídeo)" onClick={() => void ref.current?.requestFullscreen()} />
          {!mine && <IconButton icon="x" title="Parar de assistir" onClick={() => setWatching(userId, false)} />}
        </div>
      )}
    </div>
  );
}

function SharePicker({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [sources, setSources] = useState<{ id: string; name: string; thumbnail: string }[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [quality, setQuality] = useState<Quality>('1080p30');
  const [audio, setAudio] = useState(true);
  const [busy, setBusy] = useState(false);
  const desktop = Boolean(window.concord?.capture);
  const android = Boolean(window.ConcordNative);

  useEffect(() => {
    const p = captureSources();
    if (!p) return setSources([]);
    void p.then((list) => {
      setSources(list);
      setSelected(list[0]?.id);
    }).catch(() => setSources([]));
  }, []);

  async function go() {
    setBusy(true);
    try {
      await startShare({ sourceId: selected, audio: audio && !android, quality });
      onClose();
    } catch (e) {
      const msg = (e as Error).name === 'NotAllowedError' ? 'Transmissão cancelada.' : (e as Error).message;
      onError(msg);
      onClose();
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal big">
        <h2>Transmitir tela</h2>
        {desktop && (
          <div className="sources">
            {sources === null && <div className="muted">Procurando telas e janelas…</div>}
            {sources?.map((src) => (
              <button key={src.id} className={`source${selected === src.id ? ' active' : ''}`} onClick={() => setSelected(src.id)}>
                <img src={src.thumbnail} alt="" />
                <span className="ellipsis">{src.name}</span>
              </button>
            ))}
          </div>
        )}
        {!desktop && !android && <p className="muted">O sistema vai perguntar qual tela ou janela você quer mostrar.</p>}
        {android && <p className="muted">O Android vai pedir permissão para gravar a tela. O som do celular ainda não é enviado, só a imagem.</p>}
        <div className="segmented">
          {(['720p30', '1080p30', '1080p60'] as Quality[]).map((q) => (
            <button key={q} className={quality === q ? 'active' : ''} onClick={() => setQuality(q)}>
              {q === '720p30' ? '720p · 30 fps' : q === '1080p30' ? '1080p · 30 fps' : '1080p · 60 fps'}
            </button>
          ))}
        </div>
        {!android && (
          <label className="check">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            <span>Enviar também o som do computador</span>
          </label>
        )}
        {audio && !android && <p className="muted small">O som do computador inclui a voz dos amigos no Concord, então quem assiste pode ouvir eco. Use fone e, se incomodar, desligue esta opção.</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || (desktop && !selected)} onClick={() => void go()}>Começar a transmitir</button>
        </div>
      </div>
    </div>
  );
}
