import { useState } from 'react';
import type { State, User } from './store';

export interface Badge {
  id: string;
  emoji: string;
  name: string;
  text: string;
}

/**
 * Selos que o admin pode dar às pessoas. O id é o que fica gravado no servidor:
 * pode acrescentar selos à vontade, mas não troque o id de um que já existe.
 */
export const BADGE_GROUPS: { title: string; badges: Badge[] }[] = [
  {
    title: 'Dinheiro',
    badges: [
      { id: 'devedor', emoji: '💸', name: 'Devedor', text: 'Deve e não nega. Paga quando puder.' },
      { id: 'caloteiro', emoji: '🧾', name: 'Caloteiro', text: 'Sumiu depois da vaquinha.' },
      { id: 'bom-pagador', emoji: '🤝', name: 'Bom pagador', text: 'O Pix cai antes de alguém cobrar.' },
      { id: 'agiota', emoji: '🦈', name: 'Agiota', text: 'Empresta, mas anota tudo.' },
      { id: 'mao-de-vaca', emoji: '🐄', name: 'Mão de vaca', text: 'Não abre a carteira nem pra skin.' },
      { id: 'patrocinador', emoji: '💰', name: 'Patrocinador', text: 'Banca a conta da galera.' },
    ],
  },
  {
    title: 'Jogando',
    badges: [
      { id: 'craque', emoji: '🏆', name: 'Craque', text: 'Joga muito. Respeita.' },
      { id: 'carregador', emoji: '🎒', name: 'Carregador', text: 'Leva o time nas costas.' },
      { id: 'mira', emoji: '🎯', name: 'Mira de aimbot', text: 'Não erra um tiro.' },
      { id: 'cerebro', emoji: '🧠', name: 'Cérebro', text: 'Faz a call certa.' },
      { id: 'sortudo', emoji: '🍀', name: 'Sortudo', text: 'Ganha sem saber como.' },
      { id: 'tryhard', emoji: '🥵', name: 'Tryhard', text: 'Leva partida casual como final de campeonato.' },
      { id: 'bagre', emoji: '🐟', name: 'Bagre', text: 'Joga mal e ainda reclama do time.' },
      { id: 'noob', emoji: '🐣', name: 'Noob', text: 'Ainda está aprendendo os botões.' },
      { id: 'cego', emoji: '🦯', name: 'Mira torta', text: 'Descarrega o pente e não acerta nada.' },
      { id: 'feeder', emoji: '🍔', name: 'Feeder', text: 'Alimenta o time inimigo.' },
      { id: 'camper', emoji: '⛺', name: 'Camper', text: 'Não sai do cantinho.' },
      { id: 'azarado', emoji: '🪦', name: 'Azarado', text: 'Primeiro a morrer, sempre.' },
    ],
  },
  {
    title: 'Comportamento',
    badges: [
      { id: 'tiltado', emoji: '🤬', name: 'Tiltado', text: 'Tilta em cinco minutos.' },
      { id: 'rage-quit', emoji: '🚪', name: 'Rage quit', text: 'Perdeu, saiu.' },
      { id: 'chorao', emoji: '😭', name: 'Chorão', text: 'A culpa é sempre do lag.' },
      { id: 'afk', emoji: '💤', name: 'AFK', text: 'Foi ali e nunca mais voltou.' },
      { id: 'atrasado', emoji: '⏰', name: 'Atrasado', text: '"Já tô entrando" há quarenta minutos.' },
      { id: 'fantasma', emoji: '👻', name: 'Fantasma', text: 'Aparece uma vez por mês.' },
      { id: 'tagarela', emoji: '🗣️', name: 'Tagarela', text: 'Não fecha a boca um segundo.' },
      { id: 'mudo', emoji: '🤐', name: 'Mudo', text: 'Está na sala, mas ninguém nunca ouviu.' },
      { id: 'mic-de-lata', emoji: '📢', name: 'Microfone de lata', text: 'Parece que fala de dentro de um balde.' },
      { id: 'internet-de-batata', emoji: '🥔', name: 'Internet de batata', text: 'Vive caindo e teleportando.' },
      { id: 'historia', emoji: '🤥', name: 'Contador de história', text: 'Jura que fez um clutch que ninguém viu.' },
      { id: 'palhaco', emoji: '🤡', name: 'Palhaço', text: 'O entretenimento do grupo.' },
    ],
  },
  {
    title: 'Turma',
    badges: [
      { id: 'fundador', emoji: '⭐', name: 'Fundador', text: 'Está aqui desde o primeiro dia.' },
      { id: 'vip', emoji: '👑', name: 'VIP', text: 'Tratamento especial.' },
      { id: 'veterano', emoji: '🧓', name: 'Veterano', text: 'Joga desde a lan house.' },
      { id: 'novato', emoji: '🌱', name: 'Novato', text: 'Chegou agora, vai com calma.' },
      { id: 'dj', emoji: '🎧', name: 'DJ', text: 'Dono da mesa de som.' },
      { id: 'coruja', emoji: '🦉', name: 'Coruja', text: 'Só aparece de madrugada.' },
      { id: 'casado', emoji: '💍', name: 'Casado', text: 'Precisa pedir permissão pra jogar.' },
      { id: 'cachaceiro', emoji: '🍺', name: 'Cachaceiro', text: 'Joga melhor depois de umas.' },
      { id: 'streamer', emoji: '📺', name: 'Streamer', text: 'Vive transmitindo a tela.' },
      { id: 'cozinheiro', emoji: '🍳', name: 'Cozinheiro', text: 'Sai no meio da partida pra fazer comida.' },
    ],
  },
];

const ADMIN_BADGE: Badge = { id: 'admin', emoji: '🛡️', name: 'Admin', text: 'Manda em tudo por aqui.' };
const BY_ID = new Map(BADGE_GROUPS.flatMap((g) => g.badges).map((b) => [b.id, b]));

/** Selos de uma pessoa, na ordem em que foram dados; o de admin vem primeiro. */
export function badgesOf(user: User | undefined): Badge[] {
  if (!user) return [];
  const out = user.admin ? [ADMIN_BADGE] : [];
  for (const id of user.badges ?? []) {
    const b = BY_ID.get(id);
    if (b) out.push(b);
  }
  return out;
}

export function findUser(s: State, id: string): User | undefined {
  if (s.me?.id === id) return s.me;
  for (const g of s.groups) {
    const m = g.members.find((u) => u.id === id);
    if (m) return m;
  }
  return s.friends.find((f) => f.user.id === id)?.user;
}

/** Fileira de selos ao lado do nome. Passar o cursor mostra o nome e a descrição. */
export function Badges({ user, max = 5 }: { user: User | undefined; max?: number }) {
  const [tip, setTip] = useState<{ badge: Badge; x: number; y: number } | null>(null);
  const list = badgesOf(user);
  if (list.length === 0) return null;
  const shown = list.slice(0, max);
  return (
    <span className="seals" onMouseLeave={() => setTip(null)}>
      {shown.map((b) => (
        <span className="seal" key={b.id} aria-label={`${b.name}: ${b.text}`}
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTip({ badge: b, x: r.left + r.width / 2, y: r.top });
          }}>
          {b.emoji}
        </span>
      ))}
      {list.length > max && <span className="seal more">+{list.length - max}</span>}
      {tip && (
        <span className="seal-tip" style={{ left: Math.min(Math.max(tip.x, 120), window.innerWidth - 120), top: tip.y }}>
          <b>{tip.badge.emoji} {tip.badge.name}</b>
          <span>{tip.badge.text}</span>
        </span>
      )}
    </span>
  );
}
