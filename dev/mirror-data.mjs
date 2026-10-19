// Builds the data mirror published next to the app (see src/core/mirror.ts), so the fan sites see a few requests every three weeks
// in total instead of a download per user:
//   node dev/mirror-data.mjs [outDir=public/data]
//   MIRROR_BUDGET_MIN=30   stop downloading images after this many minutes (the rest come next run; default: no limit)
//   MIRROR_FORCE_LISTS=1   refresh the lists even if they're less than three weeks old
//   MIRROR_ONLY=drops      only the monster drop tables
// Lists are refreshed at most every three weeks (the game rarely changes); images (item icons, monster images) are only downloaded when the mirror doesn't
// have them yet, gently (~4 requests/s). The output is git-ignored: it's published, never committed.
// Character frames are not mirrored: maplestory.io renders a new look in ~30 s but serves one it has drawn before from
// its CDN in milliseconds, and the app's fixed pool of looks keeps everyone on the same few, so their cache does the job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'public/data'));
const budgetMs = (+process.env.MIRROR_BUDGET_MIN || 0) * 60_000 || Infinity;
const t0 = Date.now(), REFRESH = 21 * 864e5, GAP_MS = 250; // one request every 250 ms at most
const HEADERS = { 'User-Agent': 'MSClassicTrainingTracker-mirror (every 3 weeks; github.com/jcsoutherland/maple-exp-tracker)' };
const OSMS = 'https://osmsdataexplorer.com/data/';

// the app's own code: list shapes, the look pool and frame URLs, so the mirror holds exactly what the app asks for
const bundle = await esbuild.build({
  stdin: {
    contents: `export { shapeItems, shapeMaps, shapeMobs } from './src/core/data/osms';
`,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  define: { 'import.meta.env': '{"BASE_URL":"/"}' },
});
const tmp = path.join(os.tmpdir(), `mirror-lib-${process.pid}.mjs`);
fs.writeFileSync(tmp, bundle.outputFiles[0].text);
const lib = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp);

const file = rel => path.join(out, rel);
const has = rel => fs.existsSync(file(rel));
const write = (rel, data) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), data); };
const manifestPath = file('manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

let last = 0;
async function get(url, kind) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  if (kind === 'image' && !(res.headers.get('content-type') || '').startsWith('image/')) throw new Error(`not an image: ${url}`);
  return kind === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

// ---------- lists (at most every three weeks) ----------
const listsFresh = manifest.listsAt && Date.now() - manifest.listsAt < REFRESH && has('osms/items.json') && !process.env.MIRROR_FORCE_LISTS;
if (!listsFresh) {
  const [items, maps, mobs] = [await get(OSMS + 'current/items.json', 'json'), await get(OSMS + 'current/maps.json', 'json'), await get(OSMS + 'current/monsters.json', 'json')];
  write('osms/items.json', JSON.stringify(lib.shapeItems(items)));
  write('osms/maps.json', JSON.stringify(lib.shapeMaps(maps)));
  write('osms/monsters.json', JSON.stringify(lib.shapeMobs(mobs)));
  manifest.listsAt = Date.now();
  console.log('lists refreshed');
} else console.log('lists are less than three weeks old: kept');
const items = JSON.parse(fs.readFileSync(file('osms/items.json'), 'utf8'));
const mobs = JSON.parse(fs.readFileSync(file('osms/monsters.json'), 'utf8'));

// ---------- meowdb item numbers (at most every three weeks, one page) ----------
// meowdb numbers its item pages its own way (Red Viper is item-db/669). Its A-Z page lists every item as a link, so one
// download every three weeks maps Classic item names to those pages and the app links straight to them. MEOWDB_FILE=<saved page>
// parses a saved copy instead of downloading.
const meowFresh = manifest.meowdbAt && Date.now() - manifest.meowdbAt < REFRESH && has('meowdb.json') && !process.env.MIRROR_FORCE_LISTS;
if (!meowFresh || process.env.MEOWDB_FILE) {
  try {
    const html = process.env.MEOWDB_FILE ? fs.readFileSync(process.env.MEOWDB_FILE, 'utf8') : (await get('https://meowdb.com/msclassic/item-db/all')).toString();
    const ent = s => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const classic = new Set(items.map(i => i.name.toLowerCase())), index = {};
    for (const m of html.matchAll(/href="\/msclassic\/item-db\/(\d+)">([^<]+)</g)) {
      const k = ent(m[2]).trim().toLowerCase(); // first page wins for a name that appears twice
      if (classic.has(k) && !(k in index)) index[k] = +m[1];
    }
    // a page layout change would parse to (almost) nothing: keep the previous index rather than publish an empty one
    if (Object.keys(index).length >= items.length / 2) { write('meowdb.json', JSON.stringify(index)); manifest.meowdbAt = Date.now(); console.log(`meowdb: ${Object.keys(index).length} item pages`); }
    else console.warn(`meowdb: only ${Object.keys(index).length} items parsed, kept the previous index`);
  } catch (e) { console.warn('meowdb index failed (links fall back to copy-and-open):', e.message); }
} else console.log('meowdb index is less than three weeks old: kept');

// ---------- monster drop tables from meowdb (at most every three weeks, one page per monster) ----------
// Each meowdb monster page lists what it drops ("MSEA reference drops", server-rendered). The pickup-log matcher
// (src/core/logmatch.ts) tries the current map's monsters' drops first when it reads an item name. MEOWDB_DIR=<folder>
// parses saved copies (monsters.html, monster-<n>.html) instead of downloading.
const dropsFresh = manifest.dropsAt && Date.now() - manifest.dropsAt < REFRESH && has('drops.json') && !process.env.MIRROR_FORCE_LISTS;
if (!dropsFresh || process.env.MEOWDB_DIR) {
  try {
    const dir = process.env.MEOWDB_DIR, ent = s => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const page = async (rel, saved) => (dir ? fs.readFileSync(path.join(dir, saved), 'utf8') : (await get(`https://meowdb.com/msclassic/${rel}`)).toString());
    // the monster list: one table row per monster, with its page link and its sprite's alt text (the name)
    const list = await page('monsters', 'monsters.html'), pages = new Map();
    for (const row of list.split('<tr').slice(1)) {
      const n = (row.match(/href="\/msclassic\/monsters\/(\d+)"/) || [])[1], name = (row.match(/alt="([^"]+)"/) || [])[1];
      if (n && name && !pages.has(ent(name))) pages.set(ent(name), +n);
    }
    const drops = {};
    for (const m of mobs) {
      const n = pages.get(m.name);
      if (!n) continue;
      try {
        const html = await page(`monsters/${n}`, `monster-${n}.html`), a = html.indexOf('MSEA reference drops');
        if (a < 0) continue;
        const b = html.indexOf('OSMLIB Reference', a), sec = html.slice(a, b < 0 ? undefined : b);
        const names = [...sec.matchAll(/href="\/msclassic\/item-db\/\d+"[^>]*>([\s\S]*?)<\/a>/g)]
          .map(x => ent(x[1].replace(/<[^>]+>/g, '|').split('|').map(s => s.trim()).filter(Boolean)[0] || '')).filter(Boolean);
        if (names.length) drops[m.name] = [...new Set(names)];
      } catch (e) { console.warn(`  drops for ${m.name} failed:`, e.message); }
    }
    // a page layout change would parse to (almost) nothing: keep the previous tables rather than publish empty ones
    if (Object.keys(drops).length >= mobs.length / 2) { write('drops.json', JSON.stringify(drops)); manifest.dropsAt = Date.now(); console.log(`drops: ${Object.keys(drops).length} monsters`); }
    else console.warn(`drops: only ${Object.keys(drops).length} monsters parsed, kept the previous tables`);
  } catch (e) { console.warn('drop tables failed (the log matcher falls back to all items):', e.message); }
} else console.log('drop tables are less than three weeks old: kept');
// MIRROR_ONLY=drops: just the drop tables (e.g. to try the log matcher locally), nothing else downloaded
if (process.env.MIRROR_ONLY === 'drops') { write('manifest.json', JSON.stringify(manifest, null, 1)); process.exit(0); }

// ---------- the PaddleOCR English line recogniser (Apache-2.0), once ----------
const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/';
for (const [rel, url] of [['models/en_rec.onnx', HF + 'rec.onnx'], ['models/en_dict.txt', HF + 'dict.txt']]) {
  if (has(rel)) continue;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) { console.warn('  model failed:', res.status, url); continue; }
  write(rel, Buffer.from(await res.arrayBuffer()));
  console.log('  model', rel);
}

// ---------- images, only the missing ones: monsters, then item icons ----------
const want = new Map(); // mirror path → source URL, in priority order
for (const m of mobs) {
  if (m.anim) want.set(`mobs/${m.anim}.webp`, `${OSMS}images/monsters/${m.anim}.webp`);
  if (m.still) want.set(`mobs/${m.still}.png`, `${OSMS}images/monsters/${m.still}.png`);
}
for (const it of items) { const f = `${String(it.id).padStart(8, '0')}.png`; want.set(`icons/${f}`, `${OSMS}current/images/items/${f}`); }
const missing = [...want].filter(([rel]) => !has(rel));
console.log(`images: ${want.size} wanted, ${missing.length} missing`);

let got = 0, failed = 0, stopped = false;
for (const [rel, url] of missing) {
  if (Date.now() - t0 > budgetMs) { stopped = true; break; }
  try { write(rel, await get(url, 'image')); got++; }
  catch (e) { failed++; if (failed <= 10) console.warn('  failed:', e.message); }
  if ((got + failed) % 500 === 0) console.log(`  ${got + failed}/${missing.length}…`);
}
const left = missing.length - got - failed;
Object.assign(manifest, {
  updatedAt: Date.now(),
  counts: { items: items.length, monsters: mobs.length, images: want.size, mirrored: want.size - left - failed },
});
write('manifest.json', JSON.stringify(manifest, null, 1));
console.log(`downloaded ${got}, failed ${failed}${stopped ? `, ${left} left for the next run (time budget)` : ''} in ${Math.round((Date.now() - t0) / 1000)} s`);
