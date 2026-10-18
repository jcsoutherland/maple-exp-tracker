import { getBlob, setBlob } from '../data/cache';
import { FACE, GEAR, HAIR, WEAPONS, type LadderRow, type WeaponRow } from './catalog';

/**
 * Real MapleStory character sprites from maplestory.io (the same renderer meowdb's character builder uses).
 * A look is one of a fixed pool of skin / hair / face combinations per gender, wearing the best gear for the job at the
 * current level (catalog.ts). maplestory.io renders a combination it hasn't drawn before in ~30 s but serves one it has
 * drawn from its CDN in milliseconds; with everyone on the same small pool, nearly every request is such a cache hit.
 * Frames are then kept in IndexedDB on this device forever. Sprites are game assets: never copied into this repository.
 */
const API = 'https://maplestory.io/api';
/** bump when the look format or rules change, so older saved looks are re-rolled */
export const LOOK_V = 5;
/** looks per gender: a small fixed pool shared by everyone, so the renderer's cache already has nearly every frame */
export const LOOK_POOL = 10;

export interface CharLook {
  v: number;
  /** which look of the pool (skin / hair / face) */
  variant: number;
  branch: Branch;
  gender: 0 | 1;
  skin: number;
  hair: number;
  face: number;
  /** equipment ids, weapon included */
  items: number[];
  weapon: number | null;
  stand: string;
  standFrames: number;
  /** attack action for the weapon (e.g. 'shoot1' for bows, 'swingT1' for two-handed swords) */
  attack: string;
  attackFrames: number;
  /** projectile drawn on top of the attack: arrow, throwing star, magic orb */
  shot: 'arrow' | 'star' | 'orb' | null;
}

// ---------- rolling a look ----------

export type Branch = 'warrior' | 'magician' | 'bowman' | 'thief' | 'beginner';
const BRANCHES: [Branch, string[]][] = [
  ['bowman', ['bowman', 'archer', 'hunter', 'ranger', 'bowmaster', 'crossbow', 'sniper', 'marksman']],
  ['magician', ['magician', 'wizard', 'mage', 'cleric', 'priest', 'bishop']],
  ['thief', ['thief', 'rogue', 'assassin', 'hermit', 'night lord', 'bandit', 'shadower']],
  ['warrior', ['warrior', 'swordman', 'swordsman', 'fighter', 'page', 'spearman', 'crusader', 'knight', 'hero', 'paladin']],
];
/** Job branch for a job name (Beginner / unknown → beginner). */
export function classLook(cls: string): Branch {
  const c = (cls || '').toLowerCase();
  return BRANCHES.find(([, keys]) => keys.some(k => c.includes(k)))?.[0] ?? 'beginner';
}


/** Weapon types a job fights with, preferred first (by 2nd/3rd/4th job name where it matters). */
function weaponTypes(cls: string, branch: Branch): string[] {
  const c = cls.toLowerCase();
  switch (branch) {
    case 'bowman': return /crossbow|sniper|marksman/.test(c) ? ['Crossbow'] : ['Bow'];
    case 'thief': return /bandit|shadower/.test(c) ? ['Dagger'] : ['Claw'];
    case 'magician': return ['Wand', 'Staff'];
    case 'warrior':
      if (/spear|dragon knight|dark knight/.test(c)) return ['Spear', 'Pole Arm'];
      if (/page|white knight|paladin/.test(c)) return ['One-Handed Blunt Weapon', 'Two-Handed Blunt', 'One-Handed Sword'];
      if (/fighter|crusader|hero/.test(c)) return ['Two-Handed Sword', 'Two-Handed Axe', 'One-Handed Sword', 'One-Handed Axe'];
      return ['One-Handed Sword', 'One-Handed Axe', 'One-Handed Blunt Weapon'];
    default: return ['One-Handed Sword'];
  }
}

/** The job's weapon for a level: the strongest allowed weapon of its preferred type, unless another of its types has a
 *  higher-tier one (some weapons have no sprites on maplestory.io, which leaves gaps in a type's ladder). */
function pickWeapon(types: string[], lv: number): { type: string; row: WeaponRow | null } {
  let best: { type: string; row: WeaponRow | null } = { type: types[0], row: null };
  for (const type of types) {
    const ladder = WEAPONS[type] || [], row = [...ladder].reverse().find(r => r[2] <= lv) ?? null;
    if (row && (!best.row || row[2] > best.row[2])) best = { type, row };
  }
  if (!best.row) { const l = WEAPONS[types[0]] || []; best = { type: types[0], row: l[0] ?? null }; } // too low for any: the first one
  return best;
}

/** Preferred attack animations per weapon type; the first one the weapon actually has is used. */
const ATTACKS: Record<string, string[]> = {
  Bow: ['shoot1'], Crossbow: ['shoot2', 'shoot1'], Claw: ['stabO1', 'swingO1'], Dagger: ['stabO1', 'swingO1'],
  Wand: ['swingO1', 'swingO2'], Staff: ['swingO1', 'swingO2'],
  'One-Handed Sword': ['swingO1', 'stabO1'], 'One-Handed Axe': ['swingO1'], 'One-Handed Blunt Weapon': ['swingO1'],
  'Two-Handed Sword': ['swingT1', 'swingT3'], 'Two-Handed Axe': ['swingT1', 'swingT3'], 'Two-Handed Blunt': ['swingT1', 'swingT3'],
  Spear: ['stabT1', 'swingP1'], 'Pole Arm': ['swingP1', 'stabT1'],
};
const SHOT: Record<string, CharLook['shot']> = { Bow: 'arrow', Crossbow: 'arrow', Claw: 'star', Wand: 'orb', Staff: 'orb' };

/** Skin, hair and face of look `variant` of the pool, spread across the catalog's hair and face lists. */
export function poolLook(gender: 0 | 1, variant: number) {
  const g = gender ? 'f' : 'm', v = ((variant % LOOK_POOL) + LOOK_POOL) % LOOK_POOL, H = HAIR[g], F = FACE[g];
  return { skin: v % 5, hair: H[Math.floor(v * H.length / LOOK_POOL)] ?? 30030, face: F[Math.floor(((v * 7) % LOOK_POOL) * F.length / LOOK_POOL)] ?? 20000 };
}
/** A random look of the pool, different from `not` when given. */
export const randomVariant = (not?: number) => {
  const r = Math.floor(Math.random() * (not == null ? LOOK_POOL : LOOK_POOL - 1));
  return not == null || r < not ? r : r + 1;
};

/**
 * Make a look for a job, level and gender, instantly (no network) and consistently: every equipped item is the best
 * one for the job at that level (the catalog's upgrade ladders, scored on the job's main stat), the weapon is the
 * job's strongest weapon type allowed at that level; skin, hair and face are look `variant` of the pool.
 */
export function rollLook(cls: string, level: number | null, gender: 0 | 1 = 0, variant = randomVariant()): CharLook {
  const branch = classLook(cls), lv = level || 1, g = gender ? 'f' : 'm', table = GEAR[branch]?.[g] ?? {};
  /** the best item of a slot the level allows */
  const best = (slot: string): LadderRow | null => [...(table[slot] || [])].reverse().find(r => r[2] <= lv) ?? null;
  const items: number[] = [];
  const add = (r: LadderRow | null) => { if (r) items.push(r[0]); };
  add(best('Hat'));
  // an overall when it beats the best top + bottom together
  const o = best('Overall'), t = best('Top'), bt = best('Bottom');
  if (o && o[3] >= (t?.[3] ?? 0) + (bt?.[3] ?? 0)) add(o); else { add(t); add(bt); }
  add(best('Shoes')); add(best('Glove')); add(best('Cape')); add(best('Earrings'));

  const { type, row: w } = pickWeapon(weaponTypes(cls, branch), lv);
  if (w) items.push(w[0]);
  const acts = w?.[3] ?? {};
  const attack = (ATTACKS[type] || ['swingO1']).find(a => acts[a]) ?? Object.keys(acts).find(a => /^(swing|stab|shoot)/.test(a)) ?? 'swingO1';
  const stand = acts.stand2 ? 'stand2' : 'stand1';
  return {
    v: LOOK_V, variant, branch, gender, ...poolLook(gender, variant),
    items, weapon: w?.[0] ?? null, stand, standFrames: acts[stand] || 3, attack, attackFrames: acts[attack] || 3, shot: SHOT[type] ?? null,
  };
}

// ---------- frames ----------

/** Renderer URL for one frame. FeetCenter: the feet sit at the image's centre, so frames line up. */
export function frameUrl(l: CharLook, action: string, frame: number): string {
  const ids = [2000 + l.skin, 12000 + l.skin, l.hair, l.face, ...l.items];
  const parts = ids.map(id => JSON.stringify({ ItemId: id, Version: '83', Region: 'GMS' })).join(',');
  return `${API}/character/${encodeURIComponent(parts)}/${action}/${frame}?resize=1&renderMode=FeetCenter&bgColor=0,0,0,0`;
}

export interface SpriteSet { idle: (ImageBitmap | null)[]; attack: (ImageBitmap | null)[] }

const TIMEOUT = 240_000;
/** waits after a failed request: the renderer is often overloaded, so back off instead of hammering it */
const BACKOFF = [30_000, 90_000, 180_000, 300_000];

/**
 * Loads a look's frames: cached ones at once, missing ones from the renderer one request at a time, retrying with
 * back-off until all are in. `onChange` fires whenever a frame arrives.
 */
export class SpriteLoader {
  look: CharLook | null = null;
  frames: SpriteSet = { idle: [], attack: [] };
  failures = 0;
  private run = 0;

  get total() { return this.frames.idle.length + this.frames.attack.length; }
  get done() { return [...this.frames.idle, ...this.frames.attack].filter(Boolean).length; }
  get ready() { return this.total > 0 && this.done === this.total; }

  load(look: CharLook | null, onChange: () => void) {
    const run = ++this.run;
    this.look = look; this.failures = 0;
    this.frames = { idle: look ? new Array(look.standFrames).fill(null) : [], attack: look ? new Array(look.attackFrames).fill(null) : [] };
    onChange();
    if (look) this.loop(run, look, onChange).catch(e => console.warn('character frames', e));
  }

  private async loop(run: number, look: CharLook, onChange: () => void) {
    const jobs: [keyof SpriteSet, string, number][] = [
      ...this.frames.idle.map((_, i) => ['idle', look.stand, i] as [keyof SpriteSet, string, number]),
      ...this.frames.attack.map((_, i) => ['attack', look.attack, i] as [keyof SpriteSet, string, number]),
    ];
    // everything already on this device first
    for (const [set, action, i] of jobs) {
      const blob = await getBlob('msio:' + frameUrl(look, action, i));
      if (run !== this.run) return;
      if (blob) { this.frames[set][i] = await createImageBitmap(blob); onChange(); }
    }
    // then the missing frames, one request at a time
    while (run === this.run && !this.ready) {
      const k = jobs.findIndex(([set, , i]) => !this.frames[set][i]);
      const [set, action, i] = jobs[k];
      const url = frameUrl(look, action, i);
      const blob = await fetchFrame(url);
      if (run !== this.run) return;
      if (blob) {
        this.failures = 0;
        await setBlob('msio:' + url, blob);
        this.frames[set][i] = await createImageBitmap(blob);
        onChange();
      } else {
        this.failures++;
        onChange();
        await new Promise(r => setTimeout(r, BACKOFF[Math.min(this.failures - 1, BACKOFF.length - 1)]));
      }
    }
  }

  stop() { this.run++; }
}

async function fetchFrame(url: string): Promise<Blob | null> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return null;
    const b = await res.blob();
    return b.size > 100 ? b : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
