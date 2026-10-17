import { cached, getBlob, setBlob } from '../data/cache';
import { inClassic } from '../data/osms';
import { classLook, type Look as Branch } from '../pixelart';

/**
 * Real MapleStory character sprites from maplestory.io (the same renderer meowdb's character builder uses).
 * A random class-appropriate look is rolled once per character; its idle and weapon-attack frames are requested
 * one at a time, gently, and every frame is kept in IndexedDB on this device forever, so each is fetched only once.
 * Sprites are game assets: they are fetched at runtime and never copied into this repository.
 */
const API = 'https://maplestory.io/api';
const VER = 'GMS/83';
const DAY = 864e5;

export interface CharLook {
  v: 1;
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

// ---------- item lists (fetched once, kept 30 days) ----------

/** [id, subCategory, required jobs, required level, gender (0 m, 1 f, 2 any), cash] */
type Row = [number, string, string[], number, number, boolean];
interface RawListItem { id: number; requiredJobs?: string[] | null; requiredLevel?: number | null; requiredGender?: number; isCash?: boolean; typeInfo?: { subCategory?: string } }

/** GET JSON, retrying a few times: the API often times out under load. */
async function getJson<T>(url: string, tries = 4): Promise<T> {
  for (let k = 1; ; k++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json() as T;
    } catch (e) {
      if (k >= tries) throw e;
      await new Promise(r => setTimeout(r, 2000 * k));
    } finally { clearTimeout(timer); }
  }
}

const list = (q: string) => cached<Row[]>('msio-list:' + q, async () => {
  const d = await getJson<RawListItem[]>(`${API}/${VER}/item?${q}`);
  return d.map(x => [x.id, x.typeInfo?.subCategory || '', x.requiredJobs || [], x.requiredLevel || 0, x.requiredGender ?? 2, !!x.isCash] as Row);
}, 30 * DAY);

/**
 * The animations an item has sprites for (action → frame count), kept 30 days. Empty when maplestory.io has no
 * sprite data for the item: the renderer then silently leaves it off, so such items are never picked.
 */
const itemActions = (id: number) => cached<Record<string, number>>('msio-actions:' + id, async () => {
  const d = await getJson<{ frameBooks?: Record<string, { frames: unknown[] }> } | null>(`${API}/${VER}/item/${id}`);
  return Object.fromEntries(Object.entries(d?.frameBooks || {}).map(([k, v]) => [k, v.frames.length]));
}, 30 * DAY);

// ---------- rolling a look ----------

const JOB_NAME: Record<Branch, string> = { warrior: 'Warrior', magician: 'Magician', bowman: 'Bowman', thief: 'Thief', beginner: 'Beginner' };

/** Weapon types a job uses (by 2nd/3rd/4th job name where it matters). */
function weaponTypes(cls: string, branch: Branch): string[] {
  const c = cls.toLowerCase();
  switch (branch) {
    case 'bowman': return /crossbow|sniper|marksman/.test(c) ? ['Crossbow'] : ['Bow'];
    case 'thief': return /bandit|shadower/.test(c) ? ['Dagger'] : ['Claw'];
    case 'magician': return ['Wand', 'Staff'];
    case 'warrior':
      if (/spear|dragon knight|dark knight/.test(c)) return ['Spear', 'Pole Arm'];
      if (/page|white knight|paladin/.test(c)) return ['One-Handed Blunt Weapon', 'Two-Handed Blunt', 'One-Handed Sword', 'Two-Handed Sword'];
      return ['One-Handed Sword', 'Two-Handed Sword', 'One-Handed Axe', 'Two-Handed Axe'];
    default: return ['One-Handed Sword', 'One-Handed Axe', 'One-Handed Blunt Weapon', 'Dagger'];
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
const shuffle = <T,>(a: T[]): T[] => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

/** First of these ids (in order) that the renderer can draw, with its animations; tries at most `max`. */
async function firstDrawable(ids: number[], max = 8): Promise<{ id: number; acts: Record<string, number> } | null> {
  for (const id of ids.slice(0, max)) {
    const acts = await itemActions(id).catch(() => null);
    if (acts && Object.keys(acts).length) return { id, acts };
  }
  return null;
}

/** Roll a random look for a job and level: skin, hair, face and class-legal gear (MapleStory Classic items only). */
export async function rollLook(cls: string, level: number | null): Promise<CharLook> {
  const branch = classLook(cls), lv = level || 1, gender: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  const [armor, one, two, hair, face] = await Promise.all([
    list('categoryFilter=Armor'), list('categoryFilter=One-Handed%20Weapon'), list('categoryFilter=Two-Handed%20Weapon'),
    list('subCategoryFilter=Hair'), list('subCategoryFilter=Face'),
  ]);
  const usable = (r: Row) => !r[5] && (r[4] === 2 || r[4] === gender) && r[3] <= lv && inClassic(r[0])
    && (r[2].includes(JOB_NAME[branch]) || r[2].includes('Beginner'));
  /** usable items of these types in random order, gear close to the character's level first */
  const candidates = (rows: Row[], subs: string[]) => {
    const ok = rows.filter(r => subs.includes(r[1]) && usable(r));
    return [...shuffle(ok.filter(r => r[3] >= lv - 30)), ...shuffle(ok.filter(r => r[3] < lv - 30))].map(r => r[0]);
  };
  const pick = async (rows: Row[], subs: string[]) => (await firstDrawable(candidates(rows, subs)))?.id ?? null;

  const weaponRows = [...one, ...two];
  const w = await firstDrawable(candidates(weaponRows, weaponTypes(cls, branch)));
  const items: number[] = [];
  if (Math.random() < 0.85) { const h = await pick(armor, ['Hat']); if (h) items.push(h); }
  const overall = Math.random() < 0.5 ? await pick(armor, ['Overall']) : null;
  if (overall) items.push(overall);
  else for (const s of ['Top', 'Bottom']) { const it = await pick(armor, [s]); if (it) items.push(it); }
  for (const s of ['Shoes', 'Glove']) { const it = await pick(armor, [s]); if (it) items.push(it); }
  if (Math.random() < 0.3) { const c = await pick(armor, ['Cape']); if (c) items.push(c); }
  if (w) items.push(w.id);

  // hair / face: the game's ids encode gender (30xxx/20xxx male, 31xxx/21xxx female) and colour (last digit / hundreds)
  const hairId = (await firstDrawable(shuffle(hair.filter(r => Math.floor(r[0] / 1000) === 30 + gender).map(r => r[0]))))?.id ?? (gender ? 31000 : 30030);
  const faceId = (await firstDrawable(shuffle(face.filter(r => Math.floor(r[0] / 1000) === 20 + gender).map(r => r[0]))))?.id ?? (gender ? 21000 : 20000);

  // the weapon decides the stance and the attack animation (two-handers stand and swing differently)
  const acts = w?.acts ?? {}, sub = w ? weaponRows.find(r => r[0] === w.id)?.[1] ?? '' : '';
  const attack = (ATTACKS[sub] || ['swingO1']).find(a => acts[a]) ?? Object.keys(acts).find(a => /^(swing|stab|shoot)/.test(a)) ?? 'swingO1';
  const stand = acts.stand2 ? 'stand2' : 'stand1';
  return {
    v: 1, branch, gender, skin: rand([0, 1, 2, 3, 4])!, hair: hairId, face: faceId, items, weapon: w?.id ?? null,
    stand, standFrames: acts[stand] || 3, attack, attackFrames: acts[attack] || 3, shot: SHOT[sub] ?? null,
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
