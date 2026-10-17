import { cached, getBlob, setBlob } from './cache';
import { sim } from '../util';

/**
 * Item / map reference data from OSMS Data Explorer (MapleStory Classic World datamine by @ohmi,
 * https://osmsdataexplorer.com). Fetched on first use and cached in IndexedDB on this device, so each file and icon
 * is downloaded once. Their data has no license, so we read it from their site rather than copying it into this repo.
 */
export const OSMS_BASE = 'https://osmsdataexplorer.com/data/current/';
export interface ItemRec { id: number; name: string; cat: string; price: number | null; desc: string }
/** a map; `mark` is its region emblem (e.g. 'Henesys', 'KerningCity'), used to theme the character scene */
export interface MapRec { id: number; name: string; street: string; region: string; mark: string }

let items: ItemRec[] | null = null;
let maps: MapRec[] | null = null;
let byName = new Map<string, ItemRec>();
let itemIds = new Set<number>();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

interface RawItem { id: number; name: string; category?: string; stats?: { price?: number }; description?: string }
interface RawMap { id: number; name: string; street_name?: string; region?: string; map_mark?: string }

export function loadOsms(): Promise<void> {
  return (loading ??= (async () => {
    const [it, mp] = await Promise.all([
      cached('items-v2', async () => {
        const d = await (await fetch(OSMS_BASE + 'items.json')).json() as { items: RawItem[] };
        return d.items.filter(i => i.name).map(i => ({ id: i.id, name: i.name, cat: i.category || '', price: i.stats?.price ?? null, desc: i.description || '' }));
      }),
      cached('maps-v3', async () => {
        const d = await (await fetch(OSMS_BASE + 'maps.json')).json() as { regions: { maps: RawMap[] }[] };
        return d.regions.flatMap(r => r.maps).map(m => ({ id: m.id, name: m.name.trim(), street: (m.street_name || '').trim(), region: m.region || '', mark: m.map_mark || '' }));
      }),
    ]);
    items = it; maps = mp;
    // first record wins for duplicated names (e.g. two "Red Potion" ids)
    itemIds = new Set(it.map(i => i.id));
    byName = new Map();
    for (const i of it) if (!byName.has(i.name.toLowerCase())) byName.set(i.name.toLowerCase(), i);
    listeners.forEach(l => l());
  })().catch(e => { loading = null; console.warn('OSMS data unavailable', e); }));
}

export const osmsReady = () => items !== null;
/** The map record for an exact map name (as canonMap returns it). */
export const mapRecord = (name: string) => maps?.find(m => m.name === name) ?? null;
/** Is this item id in MapleStory Classic (per OSMS)? Unknown (list not loaded) counts as yes. */
export const inClassic = (id: number) => !items || itemIds.has(id);
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
