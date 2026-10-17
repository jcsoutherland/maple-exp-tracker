import { CLASSES, MAX_LEVEL } from './config';
import { sim } from './util';

/** "1284/1303" → [1284, 1303]. Strips junk leading digits (e.g. "[" read as 1) while cur > max. */
export function parsePair(t: string): [number, number] | null {
  const m = (t || '').replace(/[^\d/]/g, '').match(/(\d+)\/(\d+)/);
  if (!m) return null;
  let cur = +m[1];
  const max = +m[2];
  if (!max || max > 99999) return null;
  let s = m[1];
  while (cur > max && s.length > 1) { s = s.slice(1); cur = +s; }
  return cur <= max ? [cur, max] : null;
}

export interface ExpReading { exp: number; pct: number }

/** "124,816[57.63%]" → { exp: 124816, pct: 57.63 } */
export function parseExp(t: string): ExpReading | null {
  const sp = (t || '').match(/(\d[\d,.]*)\s+(\d{1,2}[.,]\d{1,2})\s*%/); // a dropped "[" becomes a space
  const s = (t || '').replace(/\s/g, '');
  const m = sp || s.match(/([\d,.]+?)\[(\d{1,3}[.,]\d{1,2})/) || s.match(/([\d,.]+?)[[(1l|]?(\d{1,2}[.,]\d{2})%/);
  if (!m) return null;
  const exp = parseInt(m[1].replace(/\D/g, ''), 10), pct = parseFloat(m[2].replace(',', '.'));
  return isFinite(exp) && pct >= 0 && pct < 100 ? { exp, pct } : null;
}

export const parseLevel = (t: string) => {
  const n = parseInt((t || '').replace(/\D/g, ''), 10);
  return n >= 1 && n <= MAX_LEVEL ? n : null;
};

/** Map names are words; reject OCR noise from minimap art (e.g. "l- - I") when the minimap has no title. */
export function cleanMap(t: string): string | null {
  const s = (t || '').split('\n').map(l => l.replace(/[^A-Za-z0-9' :\-&]/g, '').replace(/\s+/g, ' ').trim()).sort((a, b) => b.length - a.length)[0] || '';
  const letters = (s.match(/[A-Za-z]/g) || []).length, longWord = s.split(' ').some(w => /^[A-Za-z']{4,}$/.test(w));
  return s.length >= 5 && longWord && letters / s.replace(/ /g, '').length >= 0.7 ? s : null;
}

export function cleanName(t: string): string | null {
  const w = (t || '').replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).sort((a, b) => b.length - a.length)[0] || '';
  return w.length >= 3 ? w : null;
}

export function matchClass(t: string): string | null {
  t = (t || '').trim();
  if (t.length < 3) return null;
  let best: string | null = null, bs = 0;
  for (const c of CLASSES) { const s = sim(t, c); if (s > bs) { bs = s; best = c; } }
  return bs >= 0.6 ? best : null;
}

/** "(+N)" at the end of a pickup-log line. OCR often reads "+" as 1/4/t ("(141" for (+41)) and drops or garbles ")". */
export function lineAmount(text: string): number {
  const m = (text || '').match(/\(([^()]{1,9})\)?\W*$/) || (text || '').match(/(\+\s*\d{1,7})\W{0,3}$/);
  if (!m) return 0;
  let s = m[1].trim();
  const plus = /^[+]/.test(s);
  s = s.replace(/^[+]\s*/, '');
  let d = s.replace(/[^\d]/g, '');
  if (!plus && d.length >= 2 && /^[14t]/i.test(s)) d = d.slice(1);
  const n = parseInt(d, 10);
  return n > 0 && n < 1e7 ? n : 0;
}

export type LineKind = 'item' | 'meso' | 'exp';

/** Classify a pickup-log line by shape, since individual words are often mangled ("Yn Ave gala resins"). */
export function lineKind(text: string): LineKind | null {
  const L = text.toLowerCase();
  if (/ea[rmn]{1,2}e?d|\bearn|\((etc|use|equip|setup|cash|ete|eto|elc)\b/.test(L)) return 'item';
  const letters = L.replace(/\([^()]*\)?\W*$/, '').replace(/[^a-z]/g, '');
  if (letters.length < 6) return null;
  const sm = sim(letters, 'youhavegainedmesos'), se = sim(letters, 'youreceivedexp');
  if (Math.max(sm, se) < 0.4) return null;
  return sm >= se ? 'meso' : 'exp';
}

/** 0 = unusable, 1 = recognised kind, 2 = kind plus amount (or an item). Used to pick between two OCR attempts. */
export const lineQuality = (t: string) => {
  const k = lineKind(t);
  return k ? 1 + (k === 'item' || lineAmount(t) > 0 ? 1 : 0) : 0;
};

/** "Stirge Wing x1 earned. (Etc)" → { name: "Stirge Wing", qty: 1, cat: "Etc" } */
export function parseItemLine(l: string): { name: string; qty: number; cat: string } | null {
  const m = l.match(/^[^A-Za-z]*(.+?)\s+\S{0,3}\s*ea[rmn]{1,2}e?d/i) || l.match(/^[^A-Za-z]*(.+?)\s+[x×X]\s*\d/);
  if (!m) return null;
  const name = m[1].replace(/\s+[x×X«]?[\dIl!|]{1,3}$/, '').replace(/[^A-Za-z0-9' -]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return null;
  const qty = parseInt((l.match(/[x×X]\s*(\d{1,4})\b/) || [])[1] || '1', 10) || 1;
  const cat = (l.match(/\((equip|use|etc|setup|cash)/i) || [])[1] || '';
  return { name, qty, cat };
}

/**
 * New log lines push older ones up one slot. Given previous and current lines (bottom-up, normalised),
 * return how many of the current bottom lines are new.
 */
export function countNewLines(prev: string[], cur: string[]): number {
  if (!prev.length) return cur.length;
  for (let sh = 0; sh <= cur.length; sh++) {
    const n = Math.min(3, cur.length - sh, prev.length);
    if (n <= 0) break;
    let ok = 0;
    for (let k = 0; k < n; k++) if (sim(cur[sh + k], prev[k]) >= 0.6) ok++;
    if (ok >= Math.ceil(n * 0.67)) return sh;
  }
  // no alignment: count only lines unlike anything seen last time (avoids double counting after a noisy read)
  let sh = 0;
  while (sh < cur.length && !prev.some(p => sim(p, cur[sh]) >= 0.6)) sh++;
  return sh;
}
