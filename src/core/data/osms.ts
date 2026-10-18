import { cached, getBlob, setBlob } from './cache';
import { sim } from '../util';

/**
 * Item / map reference data from OSMS Data Explorer (MapleStory Classic World datamine by @ohmi,
 * https://osmsdataexplorer.com). Fetched on first use and cached in IndexedDB on this device, so each file and icon
 * is downloaded once. Their data has no license, so we read it from their site rather than copying it into this repo.
 */
export const OSMS_BASE = 'https://osmsdataexplorer.com/data/current/';
export interface ItemRec { id: number; name: string; cat: string; price: number | null; desc: string }
export interface MapRec { id: number; name: string; street: string }

/** A monster: EXP per kill, the maps it lives on, and its image hashes (animated idle + still). */
export interface MobRec { id: number; name: string; level: number; exp: number; boss: boolean; maps: string[]; anim: string | null; still: string | null }

let items: ItemRec[] | null = null;
let maps: MapRec[] | null = null;
let mobs: MobRec[] = [];
let byName = new Map<string, ItemRec>();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

interface RawItem { id: number; name: string; category?: string; stats?: { price?: number }; description?: string }
interface RawMap { id: number; name: string; street_name?: string }
interface RawMob { id: number; name: string; level: number; exp: number; is_boss?: boolean; maps?: { name: string }[]; gifs?: { stand?: string }; gif?: string; thumbnail?: string }

export function loadOsms(): Promise<void> {
  return (loading ??= (async () => {
    // monsters are a nice-to-have: without them the app works as before
    cached('mobs-v1', async () => {
      const d = await (await fetch(OSMS_BASE + 'monsters.json')).json() as { monsters: RawMob[] };
      return d.monsters.map(m => ({ id: m.id, name: m.name.trim(), level: m.level, exp: m.exp, boss: !!m.is_boss,
        maps: (m.maps || []).map(x => x.name.trim()), anim: m.gifs?.stand || m.gif || null, still: m.thumbnail || null }));
    }).then(m => { mobs = m; listeners.forEach(l => l()); }).catch(e => console.warn('OSMS monsters unavailable', e));
    const [it, mp] = await Promise.all([
      cached('items-v2', async () => {
        const d = await (await fetch(OSMS_BASE + 'items.json')).json() as { items: RawItem[] };
        return d.items.filter(i => i.name).map(i => ({ id: i.id, name: i.name, cat: i.category || '', price: i.stats?.price ?? null, desc: i.description || '' }));
      }),
      cached('maps-v3', async () => {
        const d = await (await fetch(OSMS_BASE + 'maps.json')).json() as { regions: { maps: RawMap[] }[] };
        return d.regions.flatMap(r => r.maps).map(m => ({ id: m.id, name: m.name.trim(), street: (m.street_name || '').trim() }));
      }),
    ]);
    items = it; maps = mp;
    // first record wins for duplicated names (e.g. two "Red Potion" ids)
    byName = new Map();
    for (const i of it) if (!byName.has(i.name.toLowerCase())) byName.set(i.name.toLowerCase(), i);
    listeners.forEach(l => l());
  })().catch(e => { loading = null; console.warn('OSMS data unavailable', e); }));
}

export const osmsReady = () => items !== null;

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
  const hits = mobs.filter(m => new RegExp(`\\b${m.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(desc))
    .sort((a, b) => b.name.length - a.name.length);
  return hits.find(m => map && m.maps.includes(map)) ?? hits[0] ?? null;
}
export const mobByName = (name: string) => mobs.find(m => m.name === name) ?? null;

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
        const res = await fetch(`https://osmsdataexplorer.com/data/images/monsters/${hash}.${ext}`);
        if (!res.ok) return null;
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
        const res = await fetch(`${OSMS_BASE}images/items/${String(id).padStart(8, '0')}.png`);
        if (!res.ok) return null;
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
 * Player-market price lookups. Neither site deep-links by game item id (meowdb uses its own ids, meso.watch only has
 * an on-page filter), so meowdb goes through a site search that lands on the item page, and meso.watch opens with the
 * name copied for its filter box.
 */
export const meowdbUrl = (name: string) => `https://www.google.com/search?q=${encodeURIComponent(`site:meowdb.com/msclassic/item-db "${name}"`)}&btnI=1`;
export const MESO_WATCH_URL = 'https://meso.watch/';
