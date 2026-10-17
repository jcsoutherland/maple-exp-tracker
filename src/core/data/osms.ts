import { createStore, get, set } from 'idb-keyval';
import { sim } from '../util';

/**
 * Item / map reference data from OSMS Data Explorer (MapleStory Classic World datamine by @ohmi,
 * https://osmsdataexplorer.com). Fetched on first use and cached in IndexedDB on this device, so each file and icon
 * is downloaded once. Their data has no license, so we read it from their site rather than copying it into this repo.
 */
export const OSMS_BASE = 'https://osmsdataexplorer.com/data/current/';
const TTL = 7 * 864e5;
const store = createStore('maple-exp-tracker', 'osms');

export interface ItemRec { id: number; name: string; cat: string; price: number | null }
export interface MapRec { id: number; name: string; street: string }

let items: ItemRec[] | null = null;
let maps: MapRec[] | null = null;
let byName = new Map<string, ItemRec>();
let loading: Promise<void> | null = null;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await get<{ t: number; v: T }>(key, store).catch(() => undefined);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  try {
    const v = await fetcher();
    await set(key, { t: Date.now(), v }, store).catch(() => undefined);
    return v;
  } catch (e) {
    if (hit) return hit.v; // offline: stale data beats none
    throw e;
  }
}

interface RawItem { id: number; name: string; category?: string; stats?: { price?: number } }
interface RawMap { id: number; name: string; street_name?: string }

export function loadOsms(): Promise<void> {
  return (loading ??= (async () => {
    const [it, mp] = await Promise.all([
      cached('items', async () => {
        const d = await (await fetch(OSMS_BASE + 'items.json')).json() as { items: RawItem[] };
        return d.items.filter(i => i.name).map(i => ({ id: i.id, name: i.name, cat: i.category || '', price: i.stats?.price ?? null }));
      }),
      cached('maps', async () => {
        const d = await (await fetch(OSMS_BASE + 'maps.json')).json() as { regions: { maps: RawMap[] }[] };
        return d.regions.flatMap(r => r.maps).map(m => ({ id: m.id, name: m.name, street: m.street_name || '' }));
      }),
    ]);
    items = it; maps = mp;
    byName = new Map(it.map(i => [i.name.toLowerCase(), i]));
  })().catch(e => { loading = null; console.warn('OSMS data unavailable', e); }));
}

export const osmsReady = () => items !== null;
export const itemByName = (name: string) => byName.get(name.toLowerCase()) || null;

/** Snap an OCR'd item name to a real item. Handles names the game truncates ("Bubbling's Hug..."). */
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
  return best && bs >= 0.6 ? { name: best.name, id: best.id } : null;
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
      let blob = await get<Blob>(key, store).catch(() => undefined);
      if (!blob) {
        const res = await fetch(`${OSMS_BASE}images/items/${String(id).padStart(8, '0')}.png`);
        if (!res.ok) return null;
        blob = await res.blob();
        await set(key, blob, store).catch(() => undefined);
      }
      return URL.createObjectURL(blob);
    })().catch(() => null);
    iconUrls.set(id, p);
  }
  return p;
}
