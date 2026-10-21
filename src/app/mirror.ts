import type { SavedSession, Session } from '../core/session';
import type { Tracker } from '../core/tracker';
import type { Identity } from './controller';

/** the tracker readings the dashboard shows */
export interface TrackerView {
  exp: number | null; pct: number | null; total: number | null; mapCur: string | null;
  hp: { cur: number | null; max: number | null }; mp: { cur: number | null; max: number | null };
}

/**
 * The app's tracker as the website shows it while the game is shared through Windows: everything the dashboard
 * reads, sent once a second through the app (see desktopLink.ts).
 */
export interface MirrorSnapshot {
  sess: Session | null;
  lastFinished: SavedSession | null;
  identity: Identity;
  tracker: TrackerView | null;
  /** [session ms, EXP] over the last 10 minutes, for the rates */
  recent: [number, number][];
  /** each quickslot slot's potion count */
  slots: (number | null)[];
  fighting: boolean;
  autoPaused: boolean;
  /** the game window is shared with the app */
  sharing: boolean;
}

export function trackerView(t: Tracker): TrackerView {
  return {
    exp: t.exp, pct: t.pct, total: t.total, mapCur: t.mapCur,
    hp: { cur: t.hp.cur, max: t.hp.max }, mp: { cur: t.mp.cur, max: t.mp.max },
  };
}

/** Show the app's readings on this page's own (idle) tracker. */
export function applyTrackerView(t: Tracker, v: TrackerView) {
  t.exp = v.exp; t.pct = v.pct; t.total = v.total; t.mapCur = v.mapCur;
  t.hp.cur = v.hp.cur; t.hp.max = v.hp.max; t.mp.cur = v.mp.cur; t.mp.max = v.mp.max;
}
