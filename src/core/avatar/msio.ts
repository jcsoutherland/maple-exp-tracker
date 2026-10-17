import { getBlob, setBlob } from '../data/cache';
import { classLook, type Look as Branch } from '../pixelart';
import { FACE, GEAR, HAIR, WEAPONS, type GearRow } from './catalog';

/**
 * Real MapleStory character sprites from maplestory.io (the same renderer meowdb's character builder uses).
 * A look is rolled instantly from a small built-in catalog of item ids (catalog.ts); its idle and weapon-attack
 * frames are then requested one at a time, gently, and kept in IndexedDB on this device forever, so each is fetched
 * only once. Sprites are game assets: they are fetched at runtime and never copied into this repository.
 */
const API = 'https://maplestory.io/api';
/** bump when the look format or rules change, so older saved looks are re-rolled */
export const LOOK_V = 2;

export interface CharLook {
  v: number;
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

const JOB_NAME: Record<Branch, string> = { warrior: 'Warrior', magician: 'Magician', bowman: 'Bowman', thief: 'Thief', beginner: 'Beginner' };

/** The weapon type a job fights with (by 2nd/3rd/4th job name where it matters). */
function weaponType(cls: string, branch: Branch): string {
  const c = cls.toLowerCase();
  switch (branch) {
    case 'bowman': return /crossbow|sniper|marksman/.test(c) ? 'Crossbow' : 'Bow';
    case 'thief': return /bandit|shadower/.test(c) ? 'Dagger' : 'Claw';
    case 'magician': return 'Wand';
    case 'warrior':
      if (/spear|dragon knight|dark knight/.test(c)) return 'Spear';
      if (/page|white knight|paladin/.test(c)) return 'One-Handed Blunt Weapon';
      if (/fighter|crusader|hero/.test(c)) return 'Two-Handed Sword';
      return 'One-Handed Sword';
    default: return 'One-Handed Sword';
  }
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

const rand = <T,>(a: T[]): T | undefined => a[Math.floor(Math.random() * a.length)];

/**
 * Roll a random look for a job and level, instantly (no network): skin, hair, face and gear from the catalog that the
 * job and gender can wear (preferring gear at or below the level), and the job's weapon for that level.
 */
export function rollLook(cls: string, level: number | null): CharLook {
  const branch = classLook(cls), lv = level || 1, gender: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  const wears = (r: GearRow) => (r[3] === 2 || r[3] === gender) && (r[4].split('|').includes(JOB_NAME[branch]) || r[4].includes('Beginner'));
  const pick = (slot: string) => {
    const ok = (GEAR[slot] || []).filter(wears), fit = ok.filter(r => r[2] <= lv);
    return rand(fit.length ? fit : ok)?.[0] ?? null;
  };
  const items: number[] = [];
  const add = (id: number | null) => { if (id) items.push(id); };
  if (Math.random() < 0.85) add(pick('Hat'));
  const overall = Math.random() < 0.5 ? pick('Overall') : null;
  if (overall) add(overall); else { add(pick('Top')); add(pick('Bottom')); }
  add(pick('Shoes')); add(pick('Glove'));
  if (Math.random() < 0.5) add(pick('Earrings'));

  // the job's weapon: the best one of its type the character's level allows
  const type = weaponType(cls, branch), ladder = WEAPONS[type] || [];
  const w = [...ladder].reverse().find(r => r[2] <= lv) ?? ladder[0] ?? null;
  if (w) items.push(w[0]);
  const acts = w?.[3] ?? {};
  const attack = (ATTACKS[type] || ['swingO1']).find(a => acts[a]) ?? Object.keys(acts).find(a => /^(swing|stab|shoot)/.test(a)) ?? 'swingO1';
  const stand = acts.stand2 ? 'stand2' : 'stand1';
  const g = gender ? 'f' : 'm';
  return {
    v: LOOK_V, branch, gender, skin: rand([0, 1, 2, 3, 4])!, hair: rand(HAIR[g])?.[0] ?? 30030, face: rand(FACE[g])?.[0] ?? 20000,
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
