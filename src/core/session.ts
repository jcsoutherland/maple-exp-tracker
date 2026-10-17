import type { Settings } from './config';
import { potionByName, potionsUsed, restoreOf } from './potions';
import { fmtHM, fmtN } from './util';

export type EventType = 'meso' | 'drop' | 'level' | 'death' | 'map' | 'info';
export interface SessionEvent { t: number; type: EventType; text: string }
export interface Drop { qty: number; cat: string; id?: number }

/** HP or MP flow: total lost, total recovered by pot-sized jumps, and each jump's size (to count potions). */
export interface Flow { used: number; rec: number; jumps: number[]; max: number | null }

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
  hp: Flow;
  mp: Flow;
  /** [minute, cumulative exp, cumulative mesos] sampled every ~30 s */
  timeline: [number, number, number][];
  events: SessionEvent[];
}

export interface PotUse { name: string; id?: number; count: number; cost: number }

/** A finished session as stored in history. */
export interface SavedSession extends Omit<Session, 'resumeAt' | 'paused' | 'events'> {
  end: number;
  potCost: number;
  potDetail: Partial<Record<'hp' | 'mp', PotUse>>;
}

const flow = (): Flow => ({ used: 0, rec: 0, jumps: [], max: null });

export function newSession(char: string, cls: string, level: number | null, now = Date.now()): Session {
  return {
    id: now, char: char || 'Unknown', cls, levelStart: level, level, levelUps: 0, start: now, end: null, activeMs: 0, resumeAt: now, paused: false,
    exp: 0, expLost: 0, deaths: 0, mesos: 0, maps: {}, drops: {}, hp: flow(), mp: flow(), timeline: [[0, 0, 0]], events: [],
  };
}

export const elapsed = (s: Session | null, now = Date.now()) => (s ? s.activeMs + (s.paused ? 0 : now - s.resumeAt) : 0);

/** Potions consumed with the Active HP / MP potion (first in each order) and what they cost at the shop. */
export function potCost(s: Pick<Session, 'hp' | 'mp'>, set: Settings) {
  const detail: SavedSession['potDetail'] = {};
  let total = 0;
  for (const k of ['hp', 'mp'] as const) {
    const p = potionByName((k === 'hp' ? set.hpOrder : set.mpOrder)[0] ?? '');
    if (!p) continue;
    const f = s[k], r = restoreOf(p, k, f.max);
    // sessions saved before jump tracking only have the recovered total
    const count = f.jumps ? potionsUsed(f.jumps, r) : r ? Math.ceil(f.rec / r) : 0;
    detail[k] = { name: p.name, id: p.id, count, cost: count * p.shopPrice };
    total += count * p.shopPrice;
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
