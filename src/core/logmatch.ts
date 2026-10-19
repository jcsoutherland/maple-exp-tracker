import FONT from './data/logfont.json';
import type { LineSnap } from './logqueue';

/**
 * Reads pickup-log lines by matching the game's own font instead of OCR.
 *
 * The game draws the log in Arial 12 px through Windows GDI without antialiasing, with a 1 px black shadow down-right,
 * on its native HUD grid (1366×768; at the Default UI ratio that grid is then scaled up with the window). Lines are
 * right-aligned on the ")" and GDI doesn't kern, so any message is just glyphs placed at their advances
 * (dev/build-log-glyphs.ps1 renders them into data/logfont.json).
 *
 * A line is read the way it's built: the fixed words first ("You have gained mesos (+", " earned. (Etc)"), which also
 * say how many digits there are (each digit is 7 px wide, so the words only line up for one count), then each digit
 * cell against 0–9, and for items the name against a short candidate list. Text pixels are found by their shadow, so
 * this works on bright maps where colour-based OCR fails. Anything not confidently matched returns null and goes to OCR.
 */

interface RawGlyph { adv: number; x: number; y: number; rows: string }
/** cell rows that can hold ink (relative to the text cell's top) */
const ROW0 = 3, ROWS = 12;
/** per glyph, over its advance box (adv × ROWS): 0 = background, 1 = text pixel that shows (its shadow pixel isn't
 *  ink), 2 = text pixel whose shadow falls on its own ink (shows only as "not brighter than its shadow": don't care) */
interface Glyph { adv: number; role: Uint8Array; n: number }

const GLYPHS = new Map<string, Glyph>();
for (const [ch, g] of Object.entries((FONT as { glyphs: Record<string, RawGlyph> }).glyphs)) {
  const rows = g.rows ? g.rows.split(' ') : [], ink = (x: number, y: number) => rows[y]?.[x] === '#';
  const role = new Uint8Array(g.adv * ROWS);
  let n = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < g.adv; c++) {
    const gx = c - g.x, gy = r + ROW0 - g.y;
    if (!ink(gx, gy)) continue;
    role[r * g.adv + c] = ink(gx + 1, gy + 1) ? 2 : 1;
    if (role[r * g.adv + c] === 1) n++;
  }
  GLYPHS.set(ch, { adv: g.adv, role, n });
}
const RIGHT = (() => { // ")" ink right edge relative to its pen
  const g = (FONT as { glyphs: Record<string, RawGlyph> }).glyphs[')'];
  return g.x + g.rows.split(' ')[0].length - 1;
})();
export const knownText = (s: string) => [...s].every(c => GLYPHS.has(c));

/** A log line on the HUD's native pixel grid: luminance and text mask (1 = brighter than its shadow pixel). */
export interface NativeStrip { w: number; h: number; L: Float32Array; M: Uint8Array; /** the strip's first native column / row */ u0: number; v0: number }

/**
 * Samples a screen-resolution RGBA strip onto the native HUD grid and marks the text pixels.
 * (X, Y) is the strip's top-left on the screen and k the screen pixels per native pixel; native pixel u covers screen
 * pixels [u·k, (u+1)·k), so it's sampled at its centre.
 */
export function nativeStrip(rgba: ArrayLike<number>, W: number, H: number, X: number, Y: number, k: number): NativeStrip {
  const u0 = Math.ceil(X / k - 0.5), u1 = Math.floor((X + W) / k - 0.5), v0 = Math.ceil(Y / k - 0.5), v1 = Math.floor((Y + H) / k - 0.5);
  const w = Math.max(0, u1 - u0), h = Math.max(0, v1 - v0), L = new Float32Array(w * h), M = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) {
    const sy = Math.min(H - 1, Math.max(0, Math.floor((v0 + v + 0.5) * k) - Y));
    for (let u = 0; u < w; u++) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor((u0 + u + 0.5) * k) - X)), i = (sy * W + sx) * 4;
      L[v * w + u] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  for (let v = 0; v < h - 1; v++) for (let u = 0; u < w - 1; u++) {
    const l = L[v * w + u];
    if (l > 90 && l - L[(v + 1) * w + u + 1] > 28) M[v * w + u] = 1;
  }
  return { w, h, L, M, u0, v0 };
}

/** how well glyph `g` explains the mask in its advance box at pen x (cell top y) */
type Acc = { hit: number; n: number; extra: number; l: number };
function charScore(s: NativeStrip, g: Glyph, x: number, y: number, acc: Acc) {
  for (let r = 0; r < ROWS; r++) {
    const Y = y + ROW0 + r;
    if (Y < 0 || Y >= s.h) { for (let c = 0; c < g.adv; c++) if (g.role[r * g.adv + c] === 1) acc.n++; continue; }
    for (let c = 0; c < g.adv; c++) {
      const X = x + c, m = X >= 0 && X < s.w ? s.M[Y * s.w + X] : 0, role = g.role[r * g.adv + c];
      if (role === 1) { acc.n++; if (m) { acc.hit++; acc.l += s.L[Y * s.w + X]; } } else if (role === 0 && m) acc.extra++;
    }
  }
}
const score = (a: Acc) => (a.n ? a.hit / (a.n + a.extra) : 0);

/** pens (left to right) of `text` laid out so its last glyph's advance box ends where a ")" ending at `xr` would */
function layout(text: string, xr: number): number[] {
  const pens = new Array<number>(text.length);
  let pen = xr - RIGHT + GLYPHS.get(')')!.adv; // pen position just after the closing ")"
  for (let i = text.length - 1; i >= 0; i--) { pen -= GLYPHS.get(text[i])!.adv; pens[i] = pen; }
  return pens;
}
function fixedScore(s: NativeStrip, text: string, pens: number[], y: number, skip: (i: number) => boolean) {
  const acc: Acc = { hit: 0, n: 0, extra: 0, l: 0 };
  for (let i = 0; i < text.length; i++) if (!skip(i)) charScore(s, GLYPHS.get(text[i])!, pens[i], y, acc);
  return acc;
}

/** the best digit for each '#' cell, with the runner-up's score (a close second means the cell is covered or faded) */
function readDigits(s: NativeStrip, text: string, pens: number[], y: number) {
  const out: { d: string; best: number; second: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '#') continue;
    const sc = '0123456789'.split('').map(d => { const a: Acc = { hit: 0, n: 0, extra: 0, l: 0 }; charScore(s, GLYPHS.get(d)!, pens[i], y, a); return { d, v: score(a) }; }).sort((a, b) => b.v - a.v);
    out.push({ d: sc[0].d, best: sc[0].v, second: sc[1].v });
  }
  return out;
}

export type MatchKind = 'meso' | 'exp' | 'item';
export interface LineMatch {
  kind: MatchKind; text: string;
  /** fixed words' score (0–1) */ score: number;
  /** where it was found in the strip: the text cell's top row and the ")" ink's right column */ y: number; xr: number;
  /** mean brightness of its text pixels (lines fade out) */ lum: number;
}
export interface NameLists { /** names expected here (the map's monsters' drops); tried first */ likely: string[]; /** every item, filtered by width */ all: string[] }

const AMOUNT_LINES: [MatchKind, string][] = [['meso', 'You have gained mesos (+'], ['exp', 'You received EXP (+'], ['exp', 'Bonus EXP for PARTY (+']];
const TABS = ['Etc', 'Use', 'Setup', 'Equip', 'Cash'];
/** acceptance: fixed words, each digit (and its lead over the runner-up), item names */
export const MATCH_MIN = { fixed: 0.35, near: 0.6, digit: 0.55, digitLead: 0.12, name: 0.6, nameLead: 0.1 };
/** the fixed characters either side of the digits that must show (a player or effect may hide the rest of the line) */
const NEAR = 8;

/**
 * Read one log line from its native strip. `edge` is where the lines' ")" ends (native x in the strip), when known;
 * otherwise it's found from the ink. Returns null unless every part matches confidently.
 */
export function matchLine(s: NativeStrip, names: NameLists, edge: number | null = null, dbg?: (info: object) => void, rows?: number[]): LineMatch | null {
  if (s.w < 40 || s.h < ROWS) return null;
  let ink = 0;
  for (let i = 0; i < s.M.length; i++) ink += s.M[i];
  if (ink < 25) return null; // (almost) nothing there
  // right edge candidates: the learned edge, and the rightmost inked column
  let xr0 = -1;
  for (let x = s.w - 1; x >= 0 && xr0 < 0; x--) { let n = 0; for (let y = 0; y < s.h; y++) n += s.M[y * s.w + x]; if (n >= 2) xr0 = x; }
  const xrs = new Set<number>();
  for (const e of [edge, xr0 >= 0 ? xr0 : null]) if (e != null) for (let d = -1; d <= 1; d++) xrs.add(Math.round(e) + d);
  if (!xrs.size) return null;
  const ys: number[] = rows ? [...rows] : [];
  if (!rows) for (let y = -ROW0 - 1; y + ROW0 + ROWS <= s.h + 1; y++) ys.push(y);

  // hypotheses: fixed words with '#' digit cells, laid out from the right
  type Hyp = { kind: MatchKind; text: string; digitsFrom: number };
  const hyps: Hyp[] = [];
  for (const [kind, pre] of AMOUNT_LINES) for (let k = 1; k <= 6; k++) hyps.push({ kind, text: pre + '#'.repeat(k) + ')', digitsFrom: pre.length });
  for (const tab of TABS) for (let k = 1; k <= 3; k++) { const t = ' x' + '#'.repeat(k) + ' earned. (' + tab + ')'; hyps.push({ kind: 'item', text: t, digitsFrom: 2 }); }

  let best: { h: Hyp; xr: number; y: number; v: number; pens: number[] } | null = null;
  for (const xr of xrs) for (const y of ys) for (const h of hyps) {
    const pens = layout(h.text.replace(/#/g, '0'), xr), v = score(fixedScore(s, h.text, pens, y, i => h.text[i] === '#'));
    if (!best || v > best.v) best = { h, xr, y, v, pens };
  }
  if (!best || best.v < MATCH_MIN.fixed) return null;
  const { h, y, xr, pens, v } = best, d0 = h.text.indexOf('#'), d1 = h.text.lastIndexOf('#');
  // the words around the digits must show clearly, whatever covers the rest
  const near = score(fixedScore(s, h.text, pens, y, i => h.text[i] === '#' || i < d0 - NEAR || i > d1 + NEAR));
  dbg?.({ kind: h.kind, text: h.text, v, near });
  if (near < MATCH_MIN.near) return null;
  const digits = readDigits(s, h.text, pens, y);
  dbg?.({ digits });
  if (digits.some(d => d.best < MATCH_MIN.digit || d.best - d.second < MATCH_MIN.digitLead)) return null;
  const n = digits.map(d => d.d).join('');
  if (n.length > 1 && n[0] === '0') return null;
  const filled = h.text.replace(/#+/, n), fx = fixedScore(s, h.text, pens, y, i => h.text[i] === '#'), lum = fx.hit ? fx.l / fx.hit : 0;
  if (h.kind !== 'item') return { kind: h.kind, text: filled, score: v, y, xr, lum };

  // item: the name ends where " x" starts
  const name = readName(s, names, pens[0], y);
  return name ? { kind: 'item', text: name + filled, score: v, y, xr, lum } : null;
}

/** How well a closing ")" with its ink ending at column `xr` shows on any of the given cell rows: every log line ends in one. */
export function parenScore(s: NativeStrip, xr: number, rows: number[]): number {
  const g = GLYPHS.get(')')!;
  return Math.max(0, ...rows.map(y => { const a: Acc = { hit: 0, n: 0, extra: 0, l: 0 }; charScore(s, g, xr - RIGHT, y, a); return score(a); }));
}

/** the item name whose glyphs, ending at pen `end`, best explain the mask */
function readName(s: NativeStrip, names: NameLists, end: number, y: number): string | null {
  // the line's leftmost ink (for the width filter over all items)
  let left = -1;
  for (let x = 0; x < end && left < 0; x++) for (let r = 0; r < ROWS; r++) { const Y = y + ROW0 + r; if (Y >= 0 && Y < s.h && s.M[Y * s.w + x]) { left = x; break; } }
  const width = (t: string) => [...t].reduce((a, c) => a + GLYPHS.get(c)!.adv, 0);
  const rank = (list: string[]) => list.filter(knownText).map(t => {
    const pens: number[] = []; let pen = end;
    for (let i = t.length - 1; i >= 0; i--) { pen -= GLYPHS.get(t[i])!.adv; pens[i] = pen; }
    return { t, v: score(fixedScore(s, t, pens, y, () => false)) };
  }).sort((a, b) => b.v - a.v);
  const pick = (r: { t: string; v: number }[]) => (r.length && r[0].v >= MATCH_MIN.name && r[0].v - (r[1]?.v ?? 0) >= MATCH_MIN.nameLead ? r[0].t : null);
  const likely = pick(rank([...new Set(names.likely)]));
  if (likely) return likely;
  if (left < 0) return null; // can't tell the name's width: only the expected names are tried
  return pick(rank([...new Set(names.all)].filter(t => knownText(t) && Math.abs(end - width(t) - left) <= 3)));
}

/**
 * Read a pickup-log snapshot (null when it can't be read confidently: then OCR reads it). `edge` is the learned right
 * edge of real lines as a fraction of the snapshot's width (LineShapeFilter.edge), when known.
 */
export function matchSnap(s: LineSnap, names: NameLists, edge: number | null = null): LineMatch | null {
  if (!s.rgb || !s.rgbH || s.ox == null || s.oy == null || !s.k) return null;
  const strip = nativeStrip(s.rgb, s.W, s.rgbH, s.ox, s.oy, s.k);
  const e = edge == null ? null : Math.floor((s.ox + edge * s.W + 0.5) / s.k) - strip.u0;
  return matchLine(strip, names, e);
}
