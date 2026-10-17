/** A screen region as fractions of the captured frame, plus its brightness threshold. */
export interface Region { x: number; y: number; w: number; h: number; thr: number }

export type RegionKey = 'map' | 'mapBar' | 'level' | 'cls' | 'name' | 'hp' | 'mp' | 'exp' | 'log';

/**
 * How each region is read.
 * - mode: luma = any bright pixel is text; white = only near-white pixels (drops coloured boxes)
 * - px: height in pixels the crop is upscaled to before OCR
 * - engine: which OCR model reads it (digits-only or general text)
 */
export interface RegionDef { label: string; color: string; engine: 'num' | 'text'; mode: 'luma' | 'white'; px: number }

export const REGION_DEFS: Record<RegionKey, RegionDef> = {
  map: { label: 'Map name', color: '#ff7ab8', engine: 'text', mode: 'luma', px: 45 },
  mapBar: { label: 'Map (minimap collapsed)', color: '#ff9e5e', engine: 'text', mode: 'luma', px: 45 },
  level: { label: 'Level', color: '#c08cff', engine: 'num', mode: 'white', px: 45 },
  cls: { label: 'Class', color: '#46c46e', engine: 'text', mode: 'luma', px: 45 },
  name: { label: 'Char name', color: '#ffd23f', engine: 'text', mode: 'luma', px: 45 },
  hp: { label: 'HP numbers', color: '#e5484d', engine: 'num', mode: 'luma', px: 30 },
  mp: { label: 'MP numbers', color: '#3e8ef7', engine: 'num', mode: 'luma', px: 30 },
  exp: { label: 'EXP numbers', color: '#e8e84a', engine: 'num', mode: 'luma', px: 30 },
  log: { label: 'Pickup log', color: '#b06fd8', engine: 'text', mode: 'luma', px: 0 },
};

/** Defaults measured on a native 1280x720 game window. Fractions, so they scale with the capture size. */
export const DEFAULT_REGIONS: Record<RegionKey, Region> = {
  map: { x: 0.0345, y: 0.0529, w: 0.1328, h: 0.0204, thr: 200 },
  // when the minimap is collapsed its title bar reads 'Street : Map' at the very top-left
  mapBar: { x: 0.003, y: 0.004, w: 0.16, h: 0.02, thr: 170 },
  level: { x: 0.2391, y: 0.9653, w: 0.0203, h: 0.0208, thr: 150 },
  cls: { x: 0.2672, y: 0.9569, w: 0.0391, h: 0.0167, thr: 140 },
  name: { x: 0.2672, y: 0.975, w: 0.0391, h: 0.0181, thr: 140 },
  hp: { x: 0.3781, y: 0.9569, w: 0.0492, h: 0.0181, thr: 140 },
  mp: { x: 0.4594, y: 0.9569, w: 0.0453, h: 0.0181, thr: 140 },
  exp: { x: 0.5469, y: 0.9569, w: 0.068, h: 0.0181, thr: 140 },
  log: { x: 0.8364, y: 0.6407, w: 0.1636, h: 0.1806, thr: 140 },
};

/**
 * Read cadence per task (ms). The pickup log is change-detected at a high rate and only OCR'd when a new line
 * appears; everything else is sampled on a timer. Map is also re-read every `mapExpStep` EXP.
 */
export interface Schedule { logWatchMs: number; logForceMs: number; barsMs: number; expMs: number; mapMs: number; mapExpStep: number }
export const DEFAULT_SCHEDULE: Schedule = { logWatchMs: 66, logForceMs: 1500, barsMs: 1000, expMs: 5000, mapMs: 10000, mapExpStep: 5000 };

export interface Settings {
  schedule: Schedule;
  /** HP/MP increases smaller than this are treated as natural regen, not potions. */
  hpMin: number;
  /** pause the session after this many seconds without EXP or loot (0 = never); it resumes when EXP moves again */
  idlePauseSec: number;
  mpMin: number;
  /** recovery items in the user's order; the first one is the Active potion used for counts and cost */
  hpOrder: string[];
  mpOrder: string[];
}
export const DEFAULT_SETTINGS: Settings = {
  schedule: DEFAULT_SCHEDULE, hpMin: 40, mpMin: 25, idlePauseSec: 20,
  hpOrder: ['Meat', 'Red Potion', 'Orange Potion', 'White Potion'],
  mpOrder: ['Lemon', 'Blue Potion', 'Mana Elixir'],
};

/** MapleStory Classic jobs by branch (Classic has no Pirates), for the class picker */
export const CLASS_GROUPS: [string, string[]][] = [
  ['Beginner', ['Beginner']],
  ['Warrior', ['Warrior', 'Fighter', 'Page', 'Spearman', 'Crusader', 'White Knight', 'Dragon Knight', 'Hero', 'Paladin', 'Dark Knight']],
  ['Magician', ['Magician', 'Wizard (Fire,Poison)', 'Wizard (Ice,Lightning)', 'Cleric', 'Mage (Fire,Poison)', 'Mage (Ice,Lightning)', 'Priest',
    'Arch Mage (Fire,Poison)', 'Arch Mage (Ice,Lightning)', 'Bishop']],
  ['Bowman', ['Bowman', 'Hunter', 'Crossbowman', 'Ranger', 'Sniper', 'Bowmaster', 'Marksman']],
  ['Thief', ['Thief', 'Assassin', 'Bandit', 'Hermit', 'Chief Bandit', 'Night Lord', 'Shadower']],
];
/** every job name the status bar can show (screen reading snaps to these) */
export const CLASSES = CLASS_GROUPS.flatMap(([, jobs]) => jobs);
