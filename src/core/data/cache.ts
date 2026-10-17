import { createStore, get, set } from 'idb-keyval';

/**
 * On-device cache (IndexedDB) for reference data and images fetched from third-party sites, so each file is
 * downloaded once. Nothing fetched this way is ever copied into the repository.
 */
let storeRef: ReturnType<typeof createStore> | null = null;
// opened lazily so importing this module never touches IndexedDB (unit tests run in Node)
export const db = () => (storeRef ??= createStore('maple-exp-tracker', 'osms'));

const WEEK = 7 * 864e5;

/** Return the cached value if fresher than `ttl`, else fetch and store it (stale data is used when offline). */
export async function cached<T>(key: string, fetcher: () => Promise<T>, ttl = WEEK): Promise<T> {
  const hit = await get<{ t: number; v: T }>(key, db()).catch(() => undefined);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const v = await fetcher();
    await set(key, { t: Date.now(), v }, db()).catch(() => undefined);
    return v;
  } catch (e) {
    if (hit) return hit.v;
    throw e;
  }
}

export const getBlob = (key: string) => get<Blob>(key, db()).catch(() => undefined);
export const setBlob = (key: string, b: Blob) => set(key, b, db()).catch(() => undefined);
