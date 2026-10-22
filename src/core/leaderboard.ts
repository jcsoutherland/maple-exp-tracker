import type { SavedSession } from './session';

/**
 * The monster leaderboard: each character's estimated kills per monster over all their sessions. The tracker can't see
 * kills, so EXP is credited to a monster only when it's fairly clear which one you were fighting, and kills are that
 * EXP ÷ the monster's base EXP (never fewer than the etc drops it gave). Kept apart from History, so clearing History
 * doesn't erase it; stored per session, so nothing is ever counted twice.
 */

/** one monster in one session: EXP and mesos credited to it, time spent fighting it (ms, also per map), etc drops from it */
export interface MobKills { exp: number; ms: number; drops: number; mesos?: number; maps: Record<string, number> }
/** `v`: the counting rule it was worked out with (sessions from an older rule are worked out again) */
export interface SessionKills { start: number; end: number; mobs: Record<string, MobKills>; v?: number }
/** the counting rule: raise it whenever the estimate changes, so past sessions are re-checked */
const RULE = 3;
export interface CharBoard { sessions: Record<string, SessionKills>; clearedAt?: number }
export type Board = Record<string, CharBoard>;

/** what the monster data says about a map */
export interface MobLookup {
  /** does this monster live on this map? */
  livesOn(mob: string, map: string): boolean;
  /** the map's only regular monster (null when there are several, or none known) */
  soleMob(map: string): string | null;
  /** the EXP one kill of this monster gives (null when unknown) */
  baseExp(mob: string): number | null;
}

/**
 * A finished session's kills: as credited while it ran, or, for sessions from before that, estimated from its EXP
 * per map. A map's EXP goes to the monsters living there whose etc drops came that session, split as if each of them
 * drops alike (kills in proportion to drops); with none of them, to the map's only regular monster; else to nobody.
 */
export function sessionKills(s: SavedSession, lookup: MobLookup): SessionKills {
  const out: SessionKills = { start: s.start, end: s.end, mobs: {}, v: RULE };
  const dropsOf = (mob: string) => s.mobs?.[mob]?.n ?? 0;
  if (s.kills) {
    for (const [mob, k] of Object.entries(s.kills)) out.mobs[mob] = { exp: k.exp, ms: k.ms, mesos: k.mesos ?? 0, maps: { ...k.maps }, drops: dropsOf(mob) };
    return out;
  }
  for (const [map, exp] of Object.entries(s.maps)) {
    // a map's share of the session's time and mesos follows its share of the EXP
    const part = s.exp > 0 ? exp / s.exp : 0, ms = Math.round(s.activeMs * part), mesos = (s.mesos ?? 0) * part;
    for (const [mob, share] of mapShares(s, map, lookup)) {
      const k = out.mobs[mob] ??= { exp: 0, ms: 0, mesos: 0, drops: dropsOf(mob), maps: {} };
      k.exp += Math.round(exp * share); k.ms += Math.round(ms * share); k.mesos = (k.mesos ?? 0) + Math.round(mesos * share);
      k.maps[map] = (k.maps[map] ?? 0) + Math.round(ms * share);
    }
  }
  return out;
}

/** Who a map's EXP goes to, and what share each: monsters that dropped there by kills (∝ drops) × EXP per kill. */
function mapShares(s: SavedSession, map: string, lookup: MobLookup): [string, number][] {
  const weights = Object.entries(s.mobs ?? {})
    .map(([mob, d]) => [mob, lookup.livesOn(mob, map) ? d.n * (lookup.baseExp(mob) ?? 0) : 0] as [string, number])
    .filter(([, w]) => w > 0);
  const sum = weights.reduce((a, [, w]) => a + w, 0);
  if (sum > 0) return weights.map(([mob, w]) => [mob, w / sum]);
  const sole = lookup.soleMob(map);
  return sole ? [[sole, 1]] : [];
}

/**
 * History's sessions added to the board: each once (again only when the counting rule changed since), and none from
 * before a character's leaderboard was cleared.
 */
export function foldSessions(board: Board, sessions: SavedSession[], lookup: MobLookup): { board: Board; added: number } {
  let added = 0;
  const next: Board = { ...board };
  for (const s of sessions) {
    const cur = next[s.char] ?? { sessions: {} };
    if (cur.sessions[s.id]?.v === RULE || (cur.clearedAt != null && s.end <= cur.clearedAt)) continue;
    next[s.char] = { ...cur, sessions: { ...cur.sessions, [s.id]: sessionKills(s, lookup) } };
    added++;
  }
  return { board: next, added };
}

/** Start a character's leaderboard over: their sessions so far stay out of it. */
export function clearChar(board: Board, char: string, now = Date.now()): Board {
  return { ...board, [char]: { sessions: {}, clearedAt: now } };
}

/** Two leaderboards as one (an imported backup): each session once. */
export function mergeBoards(a: Board, b: Board): Board {
  const out: Board = { ...a };
  for (const [char, cb] of Object.entries(b)) {
    const cur = out[char] ?? { sessions: {} };
    const clearedAt = Math.max(cur.clearedAt ?? -Infinity, cb.clearedAt ?? -Infinity);
    const sessions = { ...cb.sessions, ...cur.sessions };
    out[char] = { sessions: Number.isFinite(clearedAt) ? Object.fromEntries(Object.entries(sessions).filter(([, k]) => k.end > clearedAt)) : sessions,
      ...(Number.isFinite(clearedAt) ? { clearedAt } : {}) };
  }
  return out;
}

export interface MobTotal { name: string; kills: number; exp: number; mesos: number; ms: number; drops: number; topMap: string | null; first: number; last: number }

/** A character's totals per monster; kills from the monster's base EXP (unknown monsters count their drops only). */
export function totals(cb: CharBoard | undefined, baseExp: (mob: string) => number | null): MobTotal[] {
  const byMob = new Map<string, MobTotal & { maps: Record<string, number> }>();
  for (const s of Object.values(cb?.sessions ?? {})) {
    for (const [name, k] of Object.entries(s.mobs)) {
      const t = byMob.get(name) ?? { name, kills: 0, exp: 0, mesos: 0, ms: 0, drops: 0, topMap: null, first: s.start, last: s.end, maps: {} };
      t.exp += k.exp; t.mesos += k.mesos ?? 0; t.ms += k.ms; t.drops += k.drops;
      t.first = Math.min(t.first, s.start); t.last = Math.max(t.last, s.end);
      for (const [map, ms] of Object.entries(k.maps)) t.maps[map] = (t.maps[map] ?? 0) + ms;
      byMob.set(name, t);
    }
  }
  return [...byMob.values()].map(({ maps, ...t }) => {
    const base = baseExp(t.name);
    return { ...t, kills: Math.max(base ? Math.round(t.exp / base) : 0, t.drops), topMap: Object.entries(maps).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  }).sort((a, b) => b.kills - a.kills);
}
