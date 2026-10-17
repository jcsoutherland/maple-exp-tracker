import type { Settings } from './config';
import { fmtHM, fmtN } from './util';

export type EventType = 'meso' | 'drop' | 'level' | 'death' | 'map' | 'info';
export interface SessionEvent { t: number; type: EventType; text: string }
export interface Drop { qty: number; cat: string; id?: number }

export interface Session {
  id: number;
  char: string;
  cls: string;
  levelStart: number | null;
  level: number | null;
  levelUps: number;
  start: number;
  end: number | null;
  /** active (unpaused) time accumulated before `resumeAt` */
  activeMs: number;
  resumeAt: number;
  paused: boolean;
  exp: number;
  /** EXP lost to deaths (bar went backwards); tracked separately from gains */
  expLost: number;
  deaths: number;
  mesos: number;
  maps: Record<string, number>;
  drops: Record<string, Drop>;
  hp: { used: number; rec: number };
  mp: { used: number; rec: number };
  /** [minute, cumulative exp] */
  timeline: [number, number][];
  events: SessionEvent[];
}

/** A finished session as stored in history. */
export interface SavedSession extends Omit<Session, 'resumeAt' | 'paused' | 'events'> {
  end: number;
  potCost: number;
  potDetail: Partial<Record<'hp' | 'mp', { name: string; count: number; cost: number }>>;
}

export function newSession(char: string, cls: string, level: number | null, now = Date.now()): Session {
  return {
    id: now, char: char || 'Unknown', cls, levelStart: level, level, levelUps: 0, start: now, end: null, activeMs: 0, resumeAt: now, paused: false,
    exp: 0, expLost: 0, deaths: 0, mesos: 0, maps: {}, drops: {}, hp: { used: 0, rec: 0 }, mp: { used: 0, rec: 0 }, timeline: [[0, 0]], events: [],
  };
}

export const elapsed = (s: Session | null, now = Date.now()) => (s ? s.activeMs + (s.paused ? 0 : now - s.resumeAt) : 0);

export function potCost(s: Pick<Session, 'hp' | 'mp'>, set: Settings) {
  const detail: SavedSession['potDetail'] = {};
  let total = 0;
  for (const k of ['hp', 'mp'] as const) {
    const amt = set.potBasis === 'used' ? s[k].used : s[k].rec;
    const main = set.pots.find(p => p.id === (k === 'hp' ? set.mainHp : set.mainMp));
    if (main && main.amt > 0) {
      const count = Math.ceil(amt / main.amt);
      detail[k] = { name: main.name, count, cost: count * main.price };
      total += count * main.price;
    }
  }
  return { total, detail };
}

/** Only maps with at least this much EXP are kept when a session is saved. */
export const MAP_MIN_EXP = 1000;

export function finalize(s: Session, set: Settings, now = Date.now()): SavedSession {
  const activeMs = elapsed(s, now);
  const maps: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.maps)) if (v >= MAP_MIN_EXP) maps[k] = v;
  const pc = potCost(s, set);
  const { resumeAt: _r, paused: _p, events: _e, ...rest } = s;
  return { ...rest, end: now, activeMs, maps, potCost: pc.total, potDetail: pc.detail };
}

export function summaryText(x: SavedSession): string {
  const hr = x.activeMs > 60000 ? x.exp / (x.activeMs / 3.6e6) : 0;
  const maps = Object.entries(x.maps).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmtN(v)}`).join(' · ');
  const lv = `Lv ${x.levelStart ?? '?'}${x.level && x.level !== x.levelStart ? '→' + x.level : ''}`;
  return `${x.cls || '?'} → ${lv} → ${fmtN(x.exp)} EXP → ${fmtN(hr)} EXP/hr → ${maps || 'no maps ≥1k'} | ${fmtHM(x.activeMs)} · ${fmtN(x.mesos)} mesos · pots ${fmtN(x.potCost)}` +
    (x.expLost ? ` · EXP lost -${fmtN(x.expLost)} (${x.deaths} deaths)` : '');
}
