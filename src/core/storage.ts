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
  return { ...DEFAULT_SETTINGS, ...s, schedule: { ...DEFAULT_SETTINGS.schedule, ...s.schedule } };
};
export const saveSettings = (s: Settings) => write(K.settings, s);

export const loadRegions = (): Record<RegionKey, Region> => ({ ...structuredClone(DEFAULT_REGIONS), ...read(K.regions, {}) });
export const saveRegions = (r: Record<RegionKey, Region>) => write(K.regions, r);

export const loadSessions = () => read<SavedSession[]>(K.sessions, []);
export const saveSessions = (s: SavedSession[]) => write(K.sessions, s);

export interface CharInfo {
  cls?: string; level?: number | null; last?: number;
  /** picture shown in History (taken automatically at session start) */
  snap?: string;
  /** short animation loops captured during the last session */
  sprite?: { idle: string[]; attack: string[]; cutout: boolean };
  /** pixel-art avatar (PNG data URL) made from one idle frame, and which way it faces */
  pixel?: string;
  facing?: 'left' | 'right';
  /** avatar format version */
  pixelV?: number;
}
export const loadChars = () => read<Record<string, CharInfo>>(K.chars, {});
export const saveChars = (c: Record<string, CharInfo>) => write(K.chars, c);

/** In-progress session, saved periodically so a closed tab or crash doesn't lose it. */
export const loadActive = () => read<Session | null>(K.active, null);
export const saveActive = (s: Session | null) => (s ? write(K.active, s) : localStorage.removeItem(K.active));

/** The character name/class/level the user last typed or confirmed (never overwritten by OCR). */
export const loadIdentity = () => read<{ name: string; cls: string; level: number | null } | null>('met.identity', null);
export const saveIdentity = (i: { name: string; cls: string; level: number | null }) => write('met.identity', i);
