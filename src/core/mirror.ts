/**
 * The data mirror. A weekly GitHub Action (dev/mirror-data.mjs) downloads the item / map / monster lists, item icons
 * and monster images, and publishes them next to the app on GitHub Pages. The app reads them from there, so OSMS sees a
 * few requests a week in total however many people use the tracker; it only goes to the original site for a file the
 * mirror doesn't have yet. (Character frames come from maplestory.io's CDN; see avatar/msio.ts.)
 */
export const MIRROR = `${import.meta.env?.BASE_URL ?? '/'}data/`;

/** The first of these URLs that answers OK (the mirror first, then the original source), or null. */
export async function fetchFirst(urls: string[], init?: RequestInit): Promise<Response | null> {
  for (const u of urls) {
    try {
      const res = await fetch(u, init);
      // a static host answers a missing file with its HTML page: only the expected kind of file counts
      if (res.ok && !(res.headers.get('content-type') || '').startsWith('text/html')) return res;
    } catch { /* try the next one */ }
  }
  return null;
}
