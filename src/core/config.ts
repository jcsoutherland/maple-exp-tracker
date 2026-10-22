/** A screen region as fractions of the captured frame, plus its brightness threshold. */
export interface Region { x: number; y: number; w: number; h: number; thr: number }

export type RegionKey = 'map' | 'mapBar' | 'level' | 'cls' | 'name' | 'hp' | 'mp' | 'exp' | 'hpGauge' | 'mpGauge' | 'quickslot' | 'log';

/**
 * How each region is read.
 * - mode: luma = any bright pixel is text; white = only near-white pixels (drops coloured boxes)
 * - px: height in pixels the crop is upscaled to before OCR
 * - engine: which OCR model reads it (digits-only or general text)
 */
export interface RegionDef { label: string; color: string; engine: 'num' | 'text'; mode: 'luma' | 'white'; px: number; /** read by pixel colour, not OCR (no threshold) */ gauge?: true }

export const REGION_DEFS: Record<RegionKey, RegionDef> = {
  map: { label: 'Map name', color: '#ff7ab8', engine: 'text', mode: 'luma', px: 45 },
  mapBar: { label: 'Map (minimap collapsed)', color: '#ff9e5e', engine: 'text', mode: 'luma', px: 45 },
  level: { label: 'Level', color: '#c08cff', engine: 'num', mode: 'white', px: 45 },
  cls: { label: 'Class', color: '#46c46e', engine: 'text', mode: 'luma', px: 45 },
  name: { label: 'Char name', color: '#ffd23f', engine: 'text', mode: 'luma', px: 45 },
  hp: { label: 'HP numbers', color: '#e5484d', engine: 'num', mode: 'luma', px: 30 },
  mp: { label: 'MP numbers', color: '#3e8ef7', engine: 'num', mode: 'luma', px: 30 },
  exp: { label: 'EXP numbers', color: '#e8e84a', engine: 'num', mode: 'luma', px: 30 },
  // pixel-read gauges (no OCR): a thin strip through the middle of the red / blue bar
  hpGauge: { label: 'HP gauge', color: '#ff8a8a', engine: 'num', mode: 'luma', px: 0, gauge: true },
  mpGauge: { label: 'MP gauge', color: '#8ab8ff', engine: 'num', mode: 'luma', px: 0, gauge: true },
  // the 4×3 quickslot: the counts on the slots holding potions are read (template matching, no OCR)
  quickslot: { label: 'Quickslot (4×3)', color: '#7ee0c3', engine: 'num', mode: 'luma', px: 0, gauge: true },
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
  hpGauge: { x: 0.3688, y: 0.9833, w: 0.075, h: 0.0042, thr: 140 },
  mpGauge: { x: 0.4477, y: 0.9833, w: 0.0758, h: 0.0042, thr: 140 },
  // the expanded quickslot, right above the SHORT CUT button (measured on a 1080p recording)
  quickslot: { x: 0.6875, y: 0.7769, w: 0.1042, h: 0.1315, thr: 140 },
  log: { x: 0.8364, y: 0.6407, w: 0.1636, h: 0.1806, thr: 140 },
};

/**
 * The game's UI ratio setting. 'default' scales the HUD with the window (what DEFAULT_REGIONS were measured on);
 * 'ideal' draws it at its native size (as in a 1366×768 window) whatever the window size, pinned to the screen edges.
 */
export type UiRatio = 'default' | 'ideal';
/** the window size the HUD is laid out for: at this size both ratios look the same */
export const NATIVE_W = 1366, NATIVE_H = 768;
/** screen pixels per native HUD pixel */
export const hudScale = (ratio: UiRatio, H: number) => (ratio === 'ideal' ? 1 : H / NATIVE_H);
/** what each region stays pinned to when the HUD doesn't scale: the minimap top-left, the status bar (with the quickslot
 *  above it) bottom-centre, the pickup log bottom-right */
const ANCHOR: Record<RegionKey, 'tl' | 'bc' | 'br'> = {
  map: 'tl', mapBar: 'tl', level: 'bc', cls: 'bc', name: 'bc', hp: 'bc', mp: 'bc', exp: 'bc', hpGauge: 'bc', mpGauge: 'bc', quickslot: 'bc', log: 'br',
};

/** The default regions for a UI ratio and a W×H capture (as fractions of it). */
export function presetRegions(ratio: UiRatio, W = 1920, H = 1080): Record<RegionKey, Region> {
  const out = structuredClone(DEFAULT_REGIONS);
  if (ratio === 'default') return out;
  // the defaults scale with the window: lay them out on a native window, then keep each at that pixel size and distance
  // from its anchor on the real one
  for (const k of Object.keys(out) as RegionKey[]) {
    const r = out[k], a = ANCHOR[k], x = r.x * NATIVE_W, y = r.y * NATIVE_H;
    const px = a === 'tl' ? x : a === 'bc' ? W / 2 + x - NATIVE_W / 2 : W - NATIVE_W + x, py = a === 'tl' ? y : H - NATIVE_H + y;
    out[k] = { ...r, x: px / W, y: py / H, w: r.w * NATIVE_W / W, h: r.h * NATIVE_H / H };
  }
  return out;
}

/**
 * Read cadence per task (ms). The pickup log is change-detected at a high rate and only OCR'd when a new line
 * appears; everything else is sampled on a timer. Map is also re-read every `mapExpStep` EXP.
 */
export interface Schedule { logWatchMs: number; logForceMs: number; barsMs: number; gaugeMs: number; expMs: number; mapMs: number; mapExpStep: number }
export const DEFAULT_SCHEDULE: Schedule = { logWatchMs: 66, logForceMs: 1500, barsMs: 1000, gaugeMs: 100, expMs: 5000, mapMs: 10000, mapExpStep: 5000 };

export interface Settings {
  schedule: Schedule;
  /** HP/MP increases smaller than this are treated as natural regen, not potions. */
  hpMin: number;
  /** pause the session after this many seconds without EXP or loot (0 = never); it resumes when EXP moves again */
  idlePauseSec: number;
  /** settings format, for one-time migrations of changed defaults */
  v?: number;
  mpMin: number;
  /** recovery items in the user's order; the first one is the Active potion used for counts and cost */
  hpOrder: string[];
  mpOrder: string[];
  /** potions placed on the in-game quickslot (4×3, row by row; null = empty slot) */
  hotbar: (string | null)[];
  /** the game's UI ratio setting; each ratio keeps its own regions */
  uiRatio: UiRatio;
  /** follow the in-game quickslot by itself: potions recognised by their icons are placed, moved and removed */
  autoHotbar: boolean;
  /** which features run (see FEATURES); a feature switched off stops its screen reading and leaves the dashboard */
  features: Partial<Record<Feature, boolean>>;
  /** when the auto-pause time was last changed here (the desktop app's change gives way to a newer one) */
  idleChangedAt?: number;
}

/**
 * The features that can be switched off (Setup tab), for a lighter tracker. Each screen reading stops only when every
 * feature it serves is off: the EXP bar serves the EXP features, the map name serves EXP by map, monsters, kills and
 * drops, the pickup log serves mesos and drops, and the HP/MP numbers and quickslot serve potions.
 */
export const FEATURES = {
  expGain: { label: 'Total EXP gain', reads: 'EXP bar' },
  expRate: { label: 'EXP / hr', reads: 'EXP bar' },
  expLost: { label: 'EXP lost', reads: 'EXP bar' },
  levelGoal: { label: 'Level goal', reads: 'EXP bar' },
  kills: { label: 'Kills estimate', reads: 'EXP bar, map name' },
  monsters: { label: 'Monster information', reads: 'map name' },
  graphs: { label: 'Rate graphs', reads: 'EXP bar' },
  expByMap: { label: 'EXP by map', reads: 'EXP bar, map name' },
  mesos: { label: 'Meso tracking', reads: 'pickup log' },
  drops: { label: 'Drop tracking', reads: 'pickup log, map name' },
  potions: { label: 'Potion tracking', reads: 'HP/MP numbers, quickslot' },
  activity: { label: 'Activity log', reads: '' },
  leaderboard: { label: 'Killcount', reads: '' },
} as const;
export type Feature = keyof typeof FEATURES;
/** Is this feature on? (all are, unless switched off) */
export const featureOn = (s: Pick<Settings, 'features'>, f: Feature) => s.features?.[f] !== false;
/** Is any of these features on? */
export const anyOn = (s: Pick<Settings, 'features'>, ...fs: Feature[]) => fs.some(f => featureOn(s, f));
/** the features the EXP bar is read for */
export const EXP_FEATURES = ['expGain', 'expRate', 'expLost', 'levelGoal', 'kills', 'graphs', 'expByMap'] as const;
/** Auto-pause needs to see fighting (EXP coming in or loot in the pickup log): impossible with both readings off. */
export const canAutoPause = (s: Pick<Settings, 'features'>) => anyOn(s, ...EXP_FEATURES, 'mesos', 'drops');
export const AUTO_PAUSE_OFF_WHY = "Auto-pause is off: it watches for EXP and loot to tell fighting from idling, and every EXP feature plus meso and drop tracking are switched off (Setup → Features).";
export const DEFAULT_SETTINGS: Settings = {
  v: 3, schedule: DEFAULT_SCHEDULE, hpMin: 40, mpMin: 25, idlePauseSec: 45, uiRatio: 'ideal',
  hpOrder: ['Meat', 'Red Potion', 'Orange Potion', 'White Potion'],
  mpOrder: ['Lemon', 'Blue Potion', 'Mana Elixir'],
  hotbar: new Array(12).fill(null), autoHotbar: true, features: {},
};

/**
 * MapleStory Classic jobs (max level 100, so up to 3rd job) with the level each advancement is made at, grouped by
 * branch and listed path by path (Hunter → Ranger, Crossbowman → Sniper, …). Classic has no Pirates.
 */
export const CLASS_GROUPS: [string, [string, number][]][] = [
  ['Beginner', [['Beginner', 1]]],
  ['Warrior', [['Warrior', 10], ['Fighter', 30], ['Crusader', 70], ['Page', 30], ['White Knight', 70], ['Spearman', 30], ['Dragon Knight', 70]]],
  ['Magician', [['Magician', 8], ['Wizard (Fire,Poison)', 30], ['Mage (Fire,Poison)', 70], ['Wizard (Ice,Lightning)', 30], ['Mage (Ice,Lightning)', 70],
    ['Cleric', 30], ['Priest', 70]]],
  ['Bowman', [['Bowman', 10], ['Hunter', 30], ['Ranger', 70], ['Crossbowman', 30], ['Sniper', 70]]],
  ['Thief', [['Thief', 10], ['Assassin', 30], ['Hermit', 70], ['Bandit', 30], ['Chief Bandit', 70]]],
];
export const CLASSES = CLASS_GROUPS.flatMap(([, jobs]) => jobs.map(([j]) => j));
/** current level cap */
export const MAX_LEVEL = 100;
/** the in-game quickslot grid */
export const HOTBAR_COLS = 4, HOTBAR_ROWS = 3;
