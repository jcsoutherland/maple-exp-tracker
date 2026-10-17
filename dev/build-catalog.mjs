// Builds src/core/avatar/catalog.ts: the lookup table for the character generator, so a look is made instantly and
// consistently for a job and level. Stored: ids, names, required levels and scores only (no images).
//  - gear: per job branch, gender and slot, an upgrade ladder: items (by required level) that beat everything below
//    them on the job's stat score (bowman DEX, thief LUK + DEX/2, warrior STR, magician INT; defence breaks ties)
//  - weapons: per weapon type, a ladder by attack (magic attack for wands/staves)
//  - hair / faces: a pool per gender for the random part of a look
// Stats and job/gender limits come from OSMS (MapleStory Classic); items are drawn with their GMS v83 id (matched by
// name, since Classic's ids differ) and every item kept has sprite data on maplestory.io.
//   node dev/build-catalog.mjs
import fs from 'node:fs';

const API = 'https://maplestory.io/api/GMS/83';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function json(url, tries = 5) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return await r.json();
    } catch (e) { if (k >= tries) throw e; await sleep(2000 * k); }
  }
}
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const actCache = new Map();
/** action → frame count for an item, or null when maplestory.io has no sprites for it */
async function actions(id) {
  if (actCache.has(id)) return actCache.get(id);
  await sleep(120); // be gentle
  const d = await json(`${API}/item/${id}`).catch(() => null);
  const a = d?.frameBooks ? Object.fromEntries(Object.entries(d.frameBooks).map(([k, v]) => [k, v.frames.length])) : null;
  actCache.set(id, a && Object.keys(a).length ? a : null);
  return actCache.get(id);
}

/** GM / developer items carry impossible stats (999 everything); real gear never comes close */
const plausible = it => { const t = it.stats, v = k => Number(t[k]) || 0; return ['incSTR', 'incDEX', 'incINT', 'incLUK'].every(k => v(k) <= 40) && v('incPDD') <= 250 && v('incPAD') <= 150 && v('incMAD') <= 200; };
// MapleStory Classic numbers items differently from the GMS v83 data maplestory.io draws (Classic 1060043 "Green
// Legolier Pants" is GMS "Dark Brown Stealer Pants"), so each Classic item is matched to its GMS id by name and drawn
// with that id; its stats and job/gender limits still come from Classic.
const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
const gmsByName = new Map();
for (const q of ['Armor', 'Accessory', 'One-Handed%20Weapon', 'Two-Handed%20Weapon'])
  for (const x of await json(`${API}/item?categoryFilter=${q}`)) if (!x.isCash) {
    const k = norm(x.name); if (!gmsByName.has(k)) gmsByName.set(k, []); gmsByName.get(k).push(x.id);
  }
const gmsId = it => { const c = gmsByName.get(norm(it.name)) || []; return c.find(id => Math.floor(id / 10000) === Math.floor(it.id / 10000)) ?? c[0] ?? null; };
const all = (await json('https://osmsdataexplorer.com/data/current/items.json')).items.filter(i => i.category === 'Equipment' && i.stats && plausible(i));
const osms = all.map(i => ({ ...i, gms: gmsId(i) })).filter(i => i.gms);
console.log('classic equips', all.length, 'matched to GMS by name', osms.length);

const JOB_BIT = { warrior: 1, magician: 2, bowman: 4, thief: 8 };
const BRANCHES = ['warrior', 'magician', 'bowman', 'thief', 'beginner'];
const n = v => Number(v) || 0;
/** can this job branch wear it? (reqJob is a bitmask; 0 = everyone; beginners only wear everyone-gear) */
const wears = (it, b) => { const j = n(it.stats.reqJob); return j === 0 || (b !== 'beginner' && (j & JOB_BIT[b]) !== 0); };
const fitsGender = (it, g) => !it.gender || it.gender === (g ? 'female' : 'male');
/** how good an item is for a job: its main stat(s), then defence as a tie-breaker */
function score(it, b) {
  const s = it.stats, STR = n(s.incSTR), DEX = n(s.incDEX), INT = n(s.incINT), LUK = n(s.incLUK);
  const main = b === 'bowman' ? DEX + STR * 0.25 : b === 'thief' ? LUK + DEX * 0.5 : b === 'warrior' ? STR + DEX * 0.25 : b === 'magician' ? INT + LUK * 0.25 : (STR + DEX + INT + LUK) * 0.25;
  return main * 10 + n(s.incPDD) * 0.05 + n(s.incMDD) * 0.02 + n(s.incMHP) * 0.01;
}

/** upgrade ladder: walking up by required level, keep each (drawable) item that beats the best so far */
async function ladder(items, value) {
  const out = [];
  let best = -Infinity;
  for (const it of items.slice().sort((a, c) => n(a.stats.reqLevel) - n(c.stats.reqLevel) || value(c) - value(a))) {
    const v = value(it);
    if (v <= best && out.length) continue;
    if (!(await actions(it.gms))) continue;
    out.push([it.gms, it.name, n(it.stats.reqLevel), Math.round(v * 10) / 10]);
    best = v;
  }
  return out;
}

const SLOTS = { Hat: 'Hat', Top: 'Top', Bottom: 'Bottom', Overall: 'Overall', Shoes: 'Shoes', Glove: 'Glove', Cape: 'Cape', Earrings: 'Earring' };
const gear = {};
for (const b of BRANCHES) {
  gear[b] = {};
  for (const g of [0, 1]) {
    const key = g ? 'f' : 'm';
    gear[b][key] = {};
    for (const [slot, sub] of Object.entries(SLOTS)) {
      const pool = osms.filter(it => it.sub_category === sub && wears(it, b) && fitsGender(it, g));
      gear[b][key][slot] = await ladder(pool, it => score(it, b));
    }
    console.log(b, key, Object.entries(gear[b][key]).map(([s, l]) => `${s}:${l.length}`).join(' '));
  }
}

// weapon type from the id range (as in the game data)
const TYPE = { 130: 'One-Handed Sword', 131: 'One-Handed Axe', 132: 'One-Handed Blunt Weapon', 133: 'Dagger', 137: 'Wand', 138: 'Staff',
  140: 'Two-Handed Sword', 141: 'Two-Handed Axe', 142: 'Two-Handed Blunt', 143: 'Spear', 144: 'Pole Arm', 145: 'Bow', 146: 'Crossbow', 147: 'Claw' };
const weapons = {};
for (const [pre, type] of Object.entries(TYPE)) {
  const magic = type === 'Wand' || type === 'Staff';
  const pool = osms.filter(it => Math.floor(it.gms / 10000) === +pre);
  const lad = await ladder(pool, it => (magic ? n(it.stats.incMAD) : n(it.stats.incPAD)) + n(it.stats.incINT) * 0.5 + n(it.stats.incSTR) * 0.2 + n(it.stats.incDEX) * 0.2 + n(it.stats.incLUK) * 0.2);
  weapons[type] = [];
  for (const [id, name, lv] of lad) weapons[type].push([id, name, lv, await actions(id)]);
  console.log(type, weapons[type].map(w => w[2]).join(','));
}

// hair and faces: random part of a look (maplestory.io lists; ids encode gender)
const list = async q => (await json(`${API}/item?${q}`)).map(x => x.id);
async function pool(ids, lo, count) {
  const out = [];
  for (const id of shuffle(ids.filter(id => Math.floor(id / 1000) === lo))) {
    if (out.length >= count) break;
    if (await actions(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}
const [hairIds, faceIds] = await Promise.all([list('subCategoryFilter=Hair'), list('subCategoryFilter=Face')]);
const hair = { m: await pool(hairIds, 30, 24), f: await pool(hairIds, 31, 24) };
const face = { m: await pool(faceIds, 20, 20), f: await pool(faceIds, 21, 20) };
console.log('hair', hair.m.length, hair.f.length, 'face', face.m.length, face.f.length);

const fmt = v => JSON.stringify(v).replace(/\]\],"/g, ']],\n      "').replace(/\}\},"/g, '}},\n  "').replace(/\},"([mf])"/g, '},\n    "$1"');
const ts = `// Generated by dev/build-catalog.mjs — do not edit by hand.
// Lookup table for the character generator (ids/names/levels/scores only, no images). Stats and job/gender limits
// from OSMS (MapleStory Classic); ids are the GMS v83 ids maplestory.io draws (matched by name); all are drawable.

/** [id, name, required level, score for the job] — an upgrade ladder: each beats everything below its level */
export type LadderRow = [number, string, number, number];
/** [id, name, required level, animations (action → frame count)] — ladder by attack */
export type WeaponRow = [number, string, number, Record<string, number>];

/** branch → gender → slot → ladder */
export const GEAR: Record<string, Record<'m' | 'f', Record<string, LadderRow[]>>> = ${fmt(gear)};

export const WEAPONS: Record<string, WeaponRow[]> = ${JSON.stringify(weapons).replace(/\]\],"/g, ']],\n  "')};

export const HAIR: Record<'m' | 'f', number[]> = ${JSON.stringify(hair)};

export const FACE: Record<'m' | 'f', number[]> = ${JSON.stringify(face)};
`;
fs.writeFileSync('src/core/avatar/catalog.ts', ts);
console.log('wrote src/core/avatar/catalog.ts', ts.length, 'bytes');
