import { createStore, get, set } from 'idb-keyval';
import { sim } from '../util';

/**
 * Item / map reference data from OSMS Data Explorer (MapleStory Classic World datamine by @ohmi,
 * https://osmsdataexplorer.com). Fetched on first use and cached in IndexedDB on this device, so each file and icon
 * is downloaded once. Their data has no license, so we read it from their site rather than copying it into this repo.
 */
export const OSMS_BASE = 'https://osmsdataexplorer.com/data/current/';
const TTL = 7 * 864e5;
let storeRef: ReturnType<typeof createStore> | null = null;
// opened lazily so importing this module never touches IndexedDB (unit tests run in Node)
const db = () => (storeRef ??= createStore('maple-exp-tracker', 'osms'));

export interface ItemRec { id: number; name: string; cat: string; price: number | null; desc: string }
export interface MapRec { id: number; name: string; street: string }

let items: ItemRec[] | null = null;
let maps: MapRec[] | null = null;
let monsters: string[] = [];
let byName = new Map<string, ItemRec>();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await get<{ t: number; v: T }>(key, db()).catch(() => undefined);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  try {
    const v = await fetcher();
    await set(key, { t: Date.now(), v }, db()).catch(() => undefined);
    return v;
  } catch (e) {
    if (hit) return hit.v; // offline: stale data beats none
    throw e;
  }
}

interface RawItem { id: number; name: string; category?: string; stats?: { price?: number }; description?: string }
interface RawMap { id: number; name: string; street_name?: string }

export function loadOsms(): Promise<void> {
  return (loading ??= (async () => {
    const [it, mp, mo] = await Promise.all([
      cached('items-v2', async () => {
        const d = await (await fetch(OSMS_BASE + 'items.json')).json() as { items: RawItem[] };
        return d.items.filter(i => i.name).map(i => ({ id: i.id, name: i.name, cat: i.category || '', price: i.stats?.price ?? null, desc: i.description || '' }));
      }),
      cached('maps', async () => {
        const d = await (await fetch(OSMS_BASE + 'maps.json')).json() as { regions: { maps: RawMap[] }[] };
        return d.regions.flatMap(r => r.maps).map(m => ({ id: m.id, name: m.name, street: m.street_name || '' }));
      }),
      cached('monsters', async () => {
        const d = await (await fetch(OSMS_BASE + 'monsters.json')).json() as { monsters: { name: string }[] };
        return [...new Set(d.monsters.map(m => m.name).filter(Boolean))];
      }).catch(() => [] as string[]),
    ]);
    items = it; maps = mp; monsters = mo;
    // first record wins for duplicated names (e.g. two "Red Potion" ids)
    byName = new Map();
    for (const i of it) if (!byName.has(i.name.toLowerCase())) byName.set(i.name.toLowerCase(), i);
    listeners.forEach(l => l());
  })().catch(e => { loading = null; console.warn('OSMS data unavailable', e); }));
}

export const osmsReady = () => items !== null;
export const onOsmsLoaded = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const itemByName = (name: string) => byName.get(name.toLowerCase()) || null;
export const allItems = () => items ?? [];
/** Monster names (to tell a monster's label apart from the player's name tag). */
export const monsterNames = () => monsters;

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

/** Snap an OCR'd map name to a real map name. */
export function canonMap(raw: string): string | null {
  if (!maps) return null;
  let best: string | null = null, bs = 0;
  for (const m of maps) { const s = sim(m.name, raw); if (s > bs) { bs = s; best = m.name; } }
  return bs >= 0.7 ? best : null;
}

const iconUrls = new Map<number, Promise<string | null>>();
/** Object URL for an item icon; fetched from OSMS once, then served from IndexedDB. */
export function itemIcon(id: number): Promise<string | null> {
  let p = iconUrls.get(id);
  if (!p) {
    p = (async () => {
      const key = 'icon:' + id;
      let blob = await get<Blob>(key, db()).catch(() => undefined);
      if (!blob) {
        const res = await fetch(`${OSMS_BASE}images/items/${String(id).padStart(8, '0')}.png`);
        if (!res.ok) return null;
        blob = await res.blob();
        await set(key, blob, db()).catch(() => undefined);
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
