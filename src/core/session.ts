import type { Settings } from './config';
import { potionByName, potionsUsed, restoreOf } from './potions';
import { fmtHM, fmtN } from './util';

export type EventType = 'meso' | 'drop' | 'level' | 'death' | 'map' | 'info';
export interface SessionEvent { t: number; type: EventType; text: string }
export interface Drop { qty: number; cat: string; id?: number }

/**
 * HP or MP flow: total lost, total recovered by pot-sized jumps, and each jump's size. `jumps` are potions seen on the
 * gauge (counted as the Active potion); `counted` are potions read off the hotbar counts, by item name (exact).
 */
export interface Flow { used: number; rec: number; jumps: number[]; counted?: Record<string, number>; byPot?: Record<string, number[]>; max: number | null }

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
  /** monsters fought, from their etc drops: drops counted and when the last one came (session ms) */
  mobs?: Record<string, { n: number; last: number }>;
  /** EXP credited to a monster while it was clearly the one being fought, the time that took (ms), and per map */
  kills?: Record<string, { exp: number; ms: number; maps: Record<string, number> }>;
  hp: Flow;
  mp: Flow;
  /** [minute, cumulative exp, cumulative mesos] sampled every ~30 s */
  timeline: [number, number, number][];
  events: SessionEvent[];
}

export interface PotUse { name: string; id?: number; count: number; cost: number; kind?: 'hp' | 'mp' }

/** A finished session as stored in history. */
export interface SavedSession extends Omit<Session, 'resumeAt' | 'paused' | 'events'> {
  end: number;
  potCost: number;
  /** per stat (sessions before per-item counts only have this) */
  potDetail: Partial<Record<'hp' | 'mp', PotUse>>;
  /** per item, most used first */
  potItems?: PotUse[];
  /** moved into the History archive (grouped by day) */
  archived?: boolean;
}

const flow = (): Flow => ({ used: 0, rec: 0, jumps: [], max: null });

export function newSession(char: string, cls: string, level: number | null, now = Date.now()): Session {
  return {
    id: now, char: char || 'Unknown', cls, levelStart: level, level, levelUps: 0, start: now, end: null, activeMs: 0, resumeAt: now, paused: false,
    exp: 0, expLost: 0, deaths: 0, mesos: 0, maps: {}, drops: {}, hp: flow(), mp: flow(), timeline: [[0, 0, 0]], events: [],
  };
}

export const elapsed = (s: Session | null, now = Date.now()) => (s ? s.activeMs + (s.paused ? 0 : now - s.resumeAt) : 0);

/**
 * Potions consumed and what they cost at the shop, per item and per stat. Only potions on the hotbar count: mostly
 * from their slot counts (exact), and a gauge rise the counts didn't explain goes to the hotbar potion of that stat
 * whose restore amount fits it best (Red's +100 and Orange's +250 are easy to tell apart).
 */
export function potCost(s: Pick<Session, 'hp' | 'mp'>, set: Settings) {
  const detail: SavedSession['potDetail'] = {}, items: PotUse[] = [];
  let total = 0;
  for (const k of ['hp', 'mp'] as const) {
    const f = s[k];
    const onBar = [...new Set(set.hotbar.filter((n): n is string => !!n))].map(n => potionByName(n))
      .filter((p): p is NonNullable<typeof p> => !!p && (k === 'hp' ? !!(p.hp || p.hpPct) : !!(p.mp || p.mpPct)));
    let kc = 0, kcost = 0;
    const add = (name: string, count: number) => {
      const p = potionByName(name);
      if (!p || !count) return;
      const it = items.find(i => i.name === p.name && i.kind === k) ?? (items.push({ name: p.name, id: p.id, count: 0, cost: 0, kind: k }), items[items.length - 1]);
      it.count += count; it.cost += count * p.shopPrice;
      kc += count; kcost += count * p.shopPrice;
    };
    if (onBar.length) {
      const rest = onBar.map(p => ({ p, r: restoreOf(p, k, f.max) }));
      // each rise to the potion it's closest to in size (by ratio, so a +90 is a Red Potion, not a fraction of Orange)
      const by = new Map<string, number[]>();
      for (const j of f.jumps ?? []) {
        const best = rest.reduce((a, b) => (Math.abs(Math.log(j / (b.r || 1))) < Math.abs(Math.log(j / (a.r || 1))) ? b : a));
        (by.get(best.p.name) ?? by.set(best.p.name, []).get(best.p.name)!).push(j);
      }
      for (const { p, r } of rest) add(p.name, potionsUsed(by.get(p.name) ?? [], r));
    }
    for (const [name, n] of Object.entries(f.counted ?? {})) add(name, n);
    for (const [name, j] of Object.entries(f.byPot ?? {})) { // sessions from the short-lived slot-change version
      const p = potionByName(name);
      if (p) add(name, potionsUsed(j, restoreOf(p, k, f.max)));
    }
    const top = items.filter(i => i.kind === k).sort((a, b) => b.count - a.count)[0];
    if (top) detail[k] = { name: top.name, id: top.id, count: kc, cost: kcost, kind: k };
    total += kcost;
  }
  return { total, detail, items: items.sort((a, b) => b.cost - a.cost) };
}

/** Only maps with at least this much EXP are kept when a session is saved. */
export const MAP_MIN_EXP = 1000;

export function finalize(s: Session, set: Settings, now = Date.now()): SavedSession {
  const activeMs = elapsed(s, now);
  const maps: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.maps)) if (v >= MAP_MIN_EXP) maps[k] = v;
  const pc = potCost(s, set);
  const { resumeAt: _r, paused: _p, events: _e, ...rest } = s;
  return { ...rest, end: now, activeMs, maps, potCost: pc.total, potDetail: pc.detail, potItems: pc.items };
}

export function summaryText(x: SavedSession): string {
  const hr = x.activeMs > 60000 ? x.exp / (x.activeMs / 3.6e6) : 0;
  const maps = Object.entries(x.maps).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmtN(v)}`).join(' · ');
  const lv = `Lv ${x.levelStart ?? '?'}${x.level && x.level !== x.levelStart ? '→' + x.level : ''}`;
  return `${x.cls || '?'} → ${lv} → ${fmtN(x.exp)} EXP → ${fmtN(hr)} EXP/hr → ${maps || 'no maps ≥1k'} | ${fmtHM(x.activeMs)} · ${fmtN(x.mesos)} mesos · pots ${fmtN(x.potCost)}` +
    (x.expLost ? ` · EXP lost -${fmtN(x.expLost)} (${x.deaths} deaths)` : '');
}
