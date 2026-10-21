import type { SavedSession } from '../core/session';

/**
 * What the website and the desktop app exchange besides the overlay's numbers (see desktopLink.ts): finished
 * sessions from the app's tracker go into the website's History, and the website's Setup goes to the app's tracker
 * so it reads the game the same way.
 */

/** the storage both sides keep their data in (localStorage; a stand-in in tests) */
export type KeyStore = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
/** Setup as raw storage entries: key → stored JSON */
export type SetupBundle = Record<string, string>;

/** settings, character, characters' looks and goals, and every UI ratio's boxes (met.regions, met.regions.ideal, …) */
const isSetupKey = (k: string) => k === 'met.settings' || k === 'met.identity' || k === 'met.chars' || k === 'met.regions' || k.startsWith('met.regions.');

/** History pictures of the characters stay behind: the app draws its own, and they are the bulk of the data */
function withoutThumbs(chars: string) {
  try {
    const c = JSON.parse(chars) as Record<string, { thumb?: string }>;
    for (const v of Object.values(c)) delete v.thumb;
    return JSON.stringify(c);
  } catch { return chars; }
}

/** The website's Setup, ready to send to the app. */
export function setupBundle(store: KeyStore): SetupBundle {
  const out: SetupBundle = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i), v = k == null ? null : store.getItem(k);
    if (k == null || v == null || !isSetupKey(k)) continue;
    out[k] = k === 'met.chars' ? withoutThumbs(v) : v;
  }
  return out;
}

/** Take the website's Setup as this side's own: its entries replace ours, and boxes it doesn't have (reset there) go. */
export function applySetupBundle(store: KeyStore, bundle: SetupBundle) {
  const ours: string[] = [];
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k != null && isSetupKey(k)) ours.push(k); }
  for (const k of ours) if (!(k in bundle)) store.removeItem(k);
  for (const [k, v] of Object.entries(bundle)) if (isSetupKey(k)) store.setItem(k, v);
}

/** History with the app's sessions added: each session once (by id), oldest first. */
export function mergeSessions(history: SavedSession[], incoming: SavedSession[]) {
  const have = new Set(history.map(s => s.id));
  const added = incoming.filter(s => !have.has(s.id) && (have.add(s.id), true));
  const list = added.length ? [...history, ...added].sort((a, b) => a.start - b.start) : history;
  return { list, added };
}

/** an auto-pause time set on the overlay while the app tracked, not yet passed to the website */
export interface PendingIdle { value: number; at: number }
/**
 * The auto-pause time the website should take from the app, or null to keep its own. Only when both changed it while
 * apart does the website win; otherwise the overlay's change carries over.
 */
export function resolveIdle(pending: PendingIdle | null, webChangedAt: number | undefined, lastSyncAt: number) {
  if (!pending) return null;
  if ((webChangedAt ?? 0) > lastSyncAt) return null;
  return pending.value;
}
