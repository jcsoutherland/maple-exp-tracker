import { describe, expect, it } from 'vitest';
import { clearChar, foldSessions, mergeBoards, sessionKills, totals, type MobLookup } from './leaderboard';
import type { SavedSession } from './session';

/** Kerning: the subway has Jr. Necki and Stirge, the swamp only Ligator */
const LIVES: Record<string, string[]> = { 'Jr. Necki': ['Subway'], Stirge: ['Subway'], Ligator: ['Swamp'] };
const lookup: MobLookup = {
  livesOn: (mob, map) => LIVES[mob]?.includes(map) ?? false,
  soleMob: map => { const here = Object.keys(LIVES).filter(m => LIVES[m].includes(map)); return here.length === 1 ? here[0] : null; },
};
const BASE: Record<string, number> = { 'Jr. Necki': 50, Stirge: 40, Ligator: 60 };
const baseExp = (m: string) => BASE[m] ?? null;

const session = (id: number, p: Partial<SavedSession> = {}) => ({
  id, char: 'Flynny', start: id, end: id + 3_600_000, activeMs: 3_600_000, exp: 0, maps: {}, ...p,
}) as SavedSession;

describe('estimating a session\'s kills', () => {
  it('credits a map\'s EXP to the monster whose etc drops came from it', () => {
    const k = sessionKills(session(1, { exp: 10000, maps: { Subway: 10000 }, mobs: { 'Jr. Necki': { n: 30, last: 0 } } }), lookup);
    expect(k.mobs['Jr. Necki'].exp).toBe(10000);
  });
  it('credits nothing on a map where it can\'t tell which monster it was', () => {
    const k = sessionKills(session(1, { exp: 10000, maps: { Subway: 10000 } }), lookup);
    expect(k.mobs).toEqual({});
  });
  it('credits a map with only one kind of monster even without drops', () => {
    const k = sessionKills(session(1, { exp: 6000, maps: { Swamp: 6000 } }), lookup);
    expect(k.mobs.Ligator.exp).toBe(6000);
  });
  it('splits an old session\'s time by each map\'s share of the EXP', () => {
    const k = sessionKills(session(1, { exp: 8000, maps: { Swamp: 2000, Subway: 6000 }, mobs: { 'Jr. Necki': { n: 1, last: 0 } } }), lookup);
    expect(k.mobs.Ligator.ms).toBe(900_000);
  });
  it('uses what was credited while the session ran, when it has that', () => {
    const k = sessionKills(session(1, { exp: 5000, maps: { Subway: 5000 }, kills: { Stirge: { exp: 1200, ms: 60_000, maps: { Subway: 60_000 } } } }), lookup);
    expect(k.mobs.Stirge.exp).toBe(1200);
  });
});

describe('the leaderboard', () => {
  const s1 = session(1, { exp: 10000, maps: { Subway: 10000 }, mobs: { 'Jr. Necki': { n: 30, last: 0 } } });
  it('counts each session once', () => {
    const once = foldSessions({}, [s1], lookup).board;
    expect(foldSessions(once, [s1], lookup).added).toBe(0);
  });
  it('isn\'t refilled from History after it was cleared', () => {
    const cleared = clearChar(foldSessions({}, [s1], lookup).board, 'Flynny', s1.end + 1);
    expect(foldSessions(cleared, [s1], lookup).added).toBe(0);
  });
  it('keeps counting sessions that end after it was cleared', () => {
    const cleared = clearChar({}, 'Flynny', s1.end + 1);
    expect(foldSessions(cleared, [session(s1.end + 10, { exp: 600, maps: { Swamp: 600 } })], lookup).added).toBe(1);
  });
  it('merges an imported backup without counting a session twice', () => {
    const board = foldSessions({}, [s1], lookup).board;
    expect(totals(mergeBoards(board, board).Flynny, baseExp)[0].kills).toBe(200);
  });
  it('works out kills from the monster\'s base EXP', () => {
    expect(totals(foldSessions({}, [s1], lookup).board.Flynny, baseExp)[0].kills).toBe(200);
  });
  it('never shows fewer kills than the etc drops collected', () => {
    const s = session(2, { exp: 500, maps: { Subway: 500 }, mobs: { 'Jr. Necki': { n: 40, last: 0 } } });
    expect(totals(foldSessions({}, [s], lookup).board.Flynny, baseExp)[0].kills).toBe(40);
  });
  it('names the map where most time was spent on a monster', () => {
    const s = session(3, { kills: { Stirge: { exp: 4000, ms: 90_000, maps: { Subway: 60_000, Tunnel: 30_000 } } } });
    expect(totals(foldSessions({}, [s], lookup).board.Flynny, baseExp)[0].topMap).toBe('Subway');
  });
});
