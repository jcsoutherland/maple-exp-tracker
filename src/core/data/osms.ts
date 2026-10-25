import { cached, getBlob, setBlob } from './cache';
import { fetchFirst, MIRROR } from '../mirror';
import { sim } from '../util';

/**
 * Item / map / monster reference data from OSMS Data Explorer (MapleStory Classic World datamine by @ohmi,
 * https://osmsdataexplorer.com). Read from our weekly mirror next to the app (see mirror.ts), falling back to their
 * site only for a file the mirror doesn't have, and cached in IndexedDB on this device (lists refreshed at most weekly).
 * Nothing from their data is committed to this repository.
 */
export const OSMS_BASE = 'https://osmsdataexplorer.com/data/current/';
/** how long the cached item / map / monster lists are used before they're downloaded again */
const LIST_TTL = 7 * 864e5;
export interface ItemRec { id: number; name: string; cat: string; price: number | null; desc: string }
export interface MapRec { id: number; name: string; street: string }

/** A monster: EXP per kill, the maps it lives on, and its image hashes (animated idle + still). */
export interface MobRec { id: number; name: string; level: number; exp: number; boss: boolean; maps: string[]; anim: string | null; still: string | null;
  /** elements it's weak to (Fire, Holy, …) */
  weak?: string[] }

let items: ItemRec[] | null = null;
let maps: MapRec[] | null = null;
let mobs: MobRec[] = [];
/** the monster list has loaded or failed (either way, nothing more to wait for) */
let mobsDone = false;
let byName = new Map<string, ItemRec>();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export interface RawItem { id: number; name: string; category?: string; stats?: { price?: number }; description?: string }
export interface RawMap { id: number; name: string; street_name?: string }
export interface RawMob { id: number; name: string; level: number; exp: number; is_boss?: boolean; maps?: { name: string }[]; gifs?: { stand?: string }; gif?: string; thumbnail?: string; elements?: Record<string, string> }

// The app's shape of each OSMS list (only the fields it uses). The mirror stores exactly this, so both read the same.
/** items: descriptions only where they're used (recovery amounts of consumables, the monster an etc item comes from) */
export const shapeItems = (d: { items: RawItem[] }): ItemRec[] => d.items.filter(i => i.name).map(i => ({ id: i.id, name: i.name, cat: i.category || '',
  price: i.stats?.price ?? null, desc: i.category === 'Consumable' || i.category === 'Etc' ? i.description || '' : '' }));
export const shapeMaps = (d: { regions: { maps: RawMap[] }[] }): MapRec[] => d.regions.flatMap(r => r.maps).map(m => ({ id: m.id, name: m.name.trim(), street: (m.street_name || '').trim() }));
export const shapeMobs = (d: { monsters: RawMob[] }): MobRec[] => d.monsters.map(m => ({ id: m.id, name: m.name.trim(), level: m.level, exp: m.exp, boss: !!m.is_boss,
  maps: (m.maps || []).map(x => x.name.trim()), anim: m.gifs?.stand || m.gif || null, still: m.thumbnail || null,
  weak: Object.entries(m.elements || {}).filter(([, v]) => /weak/i.test(v)).map(([k]) => k) }));

/** One list: the mirror's copy (already in the app's shape), else the original file, shaped here. */
async function list<T, R>(file: string, shape: (raw: R) => T[]): Promise<T[]> {
  const m = await fetchFirst([MIRROR + 'osms/' + file]);
  if (m) return await m.json() as T[];
  const r = await fetch(OSMS_BASE + file);
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  return shape(await r.json() as R);
}

export function loadOsms(): Promise<void> {
  return (loading ??= (async () => {
    // monsters are a nice-to-have: without them the app works as before
    cached('mobs-v3', () => list('monsters.json', shapeMobs), LIST_TTL).then(m => { mobs = m; }).catch(e => console.warn('OSMS monsters unavailable', e))
      .finally(() => { mobsDone = true; listeners.forEach(l => l()); });
    const [it, mp] = await Promise.all([
      cached('items-v3', () => list('items.json', shapeItems), LIST_TTL),
      cached('maps-v4', () => list('maps.json', shapeMaps), LIST_TTL),
    ]);
    items = it; maps = mp;
    // first record wins for duplicated names (e.g. two "Red Potion" ids)
    byName = new Map();
    for (const i of it) if (!byName.has(i.name.toLowerCase())) byName.set(i.name.toLowerCase(), i);
    listeners.forEach(l => l());
  })().catch(e => { loading = null; dataFailed = true; listeners.forEach(l => l()); console.warn('OSMS data unavailable', e); }));
}

export const osmsReady = () => items !== null;
let dataFailed = false;
/** the item / map lists have loaded or failed */
export const osmsSettled = () => items !== null || dataFailed;

export const mapsReady = () => maps !== null && maps.length > 0;
export const onOsmsLoaded = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const itemByName = (name: string) => byName.get(name.toLowerCase()) || null;
export const allItems = () => items ?? [];

/**
 * Snap an OCR'd item name to a real item. Handles names the game truncates ("Bubbling's Hug..."). Short names and
 * equipment need a near-exact match: garbled lines otherwise land on short equip names (a phantom "Sabre").
 */
export function canonItem(raw: string): { name: string; id: number } | null {
  if (!items) return null;
  const r = raw.toLowerCase().replace(/\.+$/, '');
  let best: ItemRec | null = null, bs = 0;
  for (const it of items) {
    const n = it.name.toLowerCase();
    let s = Math.abs(n.length - r.length) <= 6 ? sim(n, r) : 0;
    if (r.length >= 8 && n.length > r.length) s = Math.max(s, sim(n.slice(0, r.length), r) - 0.05);
    if (s > bs) { bs = s; best = it; }
  }
  if (!best) return null;
  const need = best.name.length <= 6 || best.cat === 'Equipment' ? 0.85 : 0.72;
  return bs >= need ? { name: best.name, id: best.id } : null;
}

const mapKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
let mapKeys: { name: string; key: string; full: string }[] = [];

/**
 * Snap an OCR'd map name to a real map name (null when it isn't one). Compared without punctuation or case, and
 * also against "street + name", since the minimap bar reads "Street : Map" and the colon is often lost.
 */
export function canonMap(raw: string): string | null {
  if (!maps) return null;
  if (mapKeys.length !== maps.length) mapKeys = maps.map(m => ({ name: m.name, key: mapKey(m.name), full: mapKey(m.street + m.name) }));
  const r = mapKey(raw);
  if (r.length < 3) return null;
  let best: string | null = null, bs = 0;
  for (const m of mapKeys) {
    const s = Math.max(sim(m.key, r), sim(m.full, r));
    if (s > bs) { bs = s; best = m.name; }
  }
  return bs >= (r.length <= 6 ? 0.85 : 0.75) ? best : null;
}

// ---------- monsters ----------

export const mobsReady = () => mobs.length > 0;
export const mobsSettled = () => mobsDone;
/** Monsters that live on a map (by its canonical name). */
export const mobsOnMap = (map: string | null) => (map ? mobs.filter(m => m.maps.includes(map)) : []);
/** Most EXP one kill can give on this map, or null when the map's monsters aren't known. */
export function maxMobExp(map: string | null): number | null {
  const on = mobsOnMap(map);
  return on.length ? Math.max(...on.map(m => m.exp)) : null;
}
/**
 * The monster an etc item comes from. Etc descriptions usually name it ("A tablecloth donned by a Jr. Wraith."):
 * the longest monster name in the description wins, preferring one that lives on the current map.
 */
export function mobForItem(itemName: string, map: string | null): MobRec | null {
  const it = itemByName(itemName), desc = it?.cat === 'Etc' ? it.desc.toLowerCase() : '';
  if (!desc || !mobs.length) return null;
  const hits = mobs.filter(m => nameRegex(m.name).test(desc)).sort((a, b) => b.name.length - a.name.length);
  return hits.find(m => map && m.maps.includes(map)) ?? hits[0] ?? null;
}
/** a monster's name as a whole word, for matching item descriptions (lower case) */
const nameRegex = (name: string) => new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
export const mobByName = (name: string) => mobs.find(m => m.name === name) ?? null;
/** the map's only regular monster (null when there are several, or none known) */
export function soleMob(map: string): string | null {
  const here = mobsOnMap(map).filter(m => !m.boss);
  return here.length === 1 ? here[0].name : null;
}
/** what the monster leaderboard needs to know about maps (see core/leaderboard.ts) */
export const mobLookup = { livesOn: (mob: string, map: string) => !!mobByName(mob)?.maps.includes(map), soleMob, baseExp: (mob: string) => mobByName(mob)?.exp ?? null };

const mobUrls = new Map<string, Promise<string | null>>();
/** Object URL for a monster's animated idle (or still) image; fetched from OSMS once, then from IndexedDB. */
export function mobImage(m: MobRec): Promise<string | null> {
  const [hash, ext] = m.anim ? [m.anim, 'webp'] : m.still ? [m.still, 'png'] : [null, ''];
  if (!hash) return Promise.resolve(null);
  let p = mobUrls.get(hash);
  if (!p) {
    p = (async () => {
      const key = 'mob:' + hash;
      let blob = await getBlob(key);
      if (!blob) {
        const res = await fetchFirst([`${MIRROR}mobs/${hash}.${ext}`, `https://osmsdataexplorer.com/data/images/monsters/${hash}.${ext}`]);
        if (!res) return null;
        blob = await res.blob();
        await setBlob(key, blob);
      }
      return URL.createObjectURL(blob);
    })().catch(() => null);
    mobUrls.set(hash, p);
  }
  return p;
}

const iconUrls = new Map<number, Promise<string | null>>();
/** Object URL for an item icon; fetched from OSMS once, then served from IndexedDB. */
export function itemIcon(id: number): Promise<string | null> {
  let p = iconUrls.get(id);
  if (!p) {
    p = (async () => {
      const key = 'icon:' + id;
      let blob = await getBlob(key);
      if (!blob) {
        const file = `${String(id).padStart(8, '0')}.png`;
        const res = await fetchFirst([`${MIRROR}icons/${file}`, `${OSMS_BASE}images/items/${file}`]);
        if (!res) return null;
        blob = await res.blob();
        await setBlob(key, blob);
      }
      return URL.createObjectURL(blob);
    })().catch(() => null);
    iconUrls.set(id, p);
  }
  return p;
}

/**
 * Item lookups on fan sites, as links only (no data is taken from them). Neither deep-links by game item id (meowdb
 * numbers items its own way and its search isn't part of the address; meso.watch only has an on-page filter), so both
 * open with the item name copied, ready to paste.
 */
export const MEOWDB_ITEMS_URL = 'https://meowdb.com/msclassic/item-db/all';

const dropsByMap = new Map<string, string[]>();
/**
 * Items the monsters on this map drop, as far as the item data says: etc items whose description names one of them
 * ("A tablecloth donned by a Jr. Wraith."). The pickup-log matcher tries these names first; empty when not known.
 */
export function dropsOnMap(map: string | null): string[] {
  if (!map || !items || !mobs.length) return [];
  let names = dropsByMap.get(map);
  if (!names) {
    const here = mobsOnMap(map).map(m => nameRegex(m.name));
    names = here.length ? items.filter(i => i.cat === 'Etc' && here.some(r => r.test(i.desc.toLowerCase()))).map(i => i.name) : [];
    dropsByMap.set(map, names);
  }
  return names;
}

export const MESO_WATCH_URL = 'https://meso.watch/';
/** Copy an item name for pasting into a fan site's search, with a toast saying where. */
export const copyItemName = (name: string, site: string, toast: (m: string) => void) =>
  navigator.clipboard?.writeText(name).then(() => toast(`“${name}” copied: paste it into ${site}'s search`), () => undefined);
