import type { SavedSession } from './session';

/**
 * The monster leaderboard: each character's estimated kills per monster over all their sessions. The tracker can't see
 * kills, so EXP is credited to a monster only when it's fairly clear which one you were fighting, and kills are that
 * EXP ÷ the monster's base EXP (never fewer than the etc drops it gave). Kept apart from History, so clearing History
 * doesn't erase it; stored per session, so nothing is ever counted twice.
 */

/** one monster in one session: EXP credited to it, time spent fighting it (ms, also per map), etc drops from it */
export interface MobKills { exp: number; ms: number; drops: number; maps: Record<string, number> }
export interface SessionKills { start: number; end: number; mobs: Record<string, MobKills> }
export interface CharBoard { sessions: Record<string, SessionKills>; clearedAt?: number }
export type Board = Record<string, CharBoard>;

/** what the monster data says about a map */
export interface MobLookup {
  /** does this monster live on this map? */
  livesOn(mob: string, map: string): boolean;
  /** the map's only regular monster (null when there are several, or none known) */
  soleMob(map: string): string | null;
}

/**
 * A finished session's kills: as credited while it ran, or, for sessions from before that, estimated from its EXP
 * per map. A map counts only when one monster clearly goes with it: the one monster whose etc drops came that session
 * and lives there, or else the map's only regular monster.
 */
export function sessionKills(s: SavedSession, lookup: MobLookup): SessionKills {
  const out: SessionKills = { start: s.start, end: s.end, mobs: {} };
  const dropsOf = (mob: string) => s.mobs?.[mob]?.n ?? 0;
  if (s.kills) {
    for (const [mob, k] of Object.entries(s.kills)) out.mobs[mob] = { exp: k.exp, ms: k.ms, maps: { ...k.maps }, drops: dropsOf(mob) };
    return out;
  }
  const dropped = Object.keys(s.mobs ?? {});
  for (const [map, exp] of Object.entries(s.maps)) {
    const here = dropped.filter(m => lookup.livesOn(m, map));
    const mob = here.length === 1 ? here[0] : here.length === 0 ? lookup.soleMob(map) : null;
    if (!mob) continue;
    const ms = s.exp > 0 ? Math.round(s.activeMs * exp / s.exp) : 0;
    const k = out.mobs[mob] ??= { exp: 0, ms: 0, drops: dropsOf(mob), maps: {} };
    k.exp += exp; k.ms += ms; k.maps[map] = (k.maps[map] ?? 0) + ms;
  }
  return out;
}

/** History's sessions added to the board: each once, and none from before a character's leaderboard was cleared. */
export function foldSessions(board: Board, sessions: SavedSession[], lookup: MobLookup): { board: Board; added: number } {
  let added = 0;
  const next: Board = { ...board };
  for (const s of sessions) {
    const cur = next[s.char] ?? { sessions: {} };
    if (cur.sessions[s.id] || (cur.clearedAt != null && s.end <= cur.clearedAt)) continue;
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

export interface MobTotal { name: string; kills: number; exp: number; ms: number; drops: number; topMap: string | null; first: number; last: number }

/** A character's totals per monster; kills from the monster's base EXP (unknown monsters count their drops only). */
export function totals(cb: CharBoard | undefined, baseExp: (mob: string) => number | null): MobTotal[] {
  const byMob = new Map<string, MobTotal & { maps: Record<string, number> }>();
  for (const s of Object.values(cb?.sessions ?? {})) {
    for (const [name, k] of Object.entries(s.mobs)) {
      const t = byMob.get(name) ?? { name, kills: 0, exp: 0, ms: 0, drops: 0, topMap: null, first: s.start, last: s.end, maps: {} };
      t.exp += k.exp; t.ms += k.ms; t.drops += k.drops;
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
