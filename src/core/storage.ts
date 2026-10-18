import type { CharLook } from './avatar/msio';
import { DEFAULT_REGIONS, DEFAULT_SETTINGS, type Region, type RegionKey, type Settings } from './config';
import type { SavedSession, Session } from './session';

/** localStorage helpers; every access is guarded (private windows and blocked storage throw). */
function read<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) as T; } catch { return d; }
}
function write(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage write failed', k, e); }
}

const K = { settings: 'met.settings', regions: 'met.regions', sessions: 'met.sessions', chars: 'met.chars', active: 'met.active' };

export const loadSettings = (): Settings => {
  const s = read<Partial<Settings>>(K.settings, {});
  // v2: the auto-pause default went from 20 s to 45 s (a value still at the old default follows it)
  if ((s.v ?? 1) < 2 && s.idlePauseSec === 20) s.idlePauseSec = 45;
  return { ...DEFAULT_SETTINGS, ...s, v: DEFAULT_SETTINGS.v, schedule: { ...DEFAULT_SETTINGS.schedule, ...s.schedule } };
};
export const saveSettings = (s: Settings) => write(K.settings, s);

export const loadRegions = (): Record<RegionKey, Region> => ({ ...structuredClone(DEFAULT_REGIONS), ...read(K.regions, {}) });
export const saveRegions = (r: Record<RegionKey, Region>) => write(K.regions, r);

export const loadSessions = () => read<SavedSession[]>(K.sessions, []);
export const saveSessions = (s: SavedSession[]) => write(K.sessions, s);

export interface CharInfo {
  cls?: string; level?: number | null; last?: number;
  /** randomly rolled appearance (rendered with real Maple sprites) */
  look?: CharLook;
  /** small still of that look for History */
  thumb?: string;
}
/** pictures earlier versions captured from the screen; no longer used, and they take up storage */
const LEGACY_CHAR_KEYS = ['snap', 'sprite', 'pixel', 'facing', 'pixelV'];
export const loadChars = () => {
  const c = read<Record<string, CharInfo>>(K.chars, {});
  let dirty = false;
  for (const v of Object.values(c)) for (const k of LEGACY_CHAR_KEYS) if (k in v) { delete (v as Record<string, unknown>)[k]; dirty = true; }
  if (dirty) write(K.chars, c);
  return c;
};
export const saveChars = (c: Record<string, CharInfo>) => write(K.chars, c);

/** In-progress session, saved periodically so a closed tab or crash doesn't lose it. */
export const loadActive = () => read<Session | null>(K.active, null);
export const saveActive = (s: Session | null) => (s ? write(K.active, s) : localStorage.removeItem(K.active));

/** The character name/class/level the user last typed or confirmed (never overwritten by OCR). */
export interface SavedIdentity { name: string; cls: string; level: number | null; nameTyped?: boolean; gender?: 0 | 1 }
export const loadIdentity = () => read<SavedIdentity | null>('met.identity', null);
export const saveIdentity = (i: SavedIdentity) => write('met.identity', i);
