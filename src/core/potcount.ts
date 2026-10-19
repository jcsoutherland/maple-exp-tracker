import type { Region } from './config';
import { frameSize, type FrameSource } from './imaging';

/**
 * Reads the item count printed on a quickslot slot (the white, black-outlined digits at its bottom-left) by template
 * matching: the game draws every digit with the same bitmap, so each position is compared with stored pictures of
 * 0–9. OCR engines can't read this font reliably (thin strokes, white on a white slot), but matching can.
 *
 * Everything works in a canonical slot of CW×CH pixels (a slot at 1080p), so any capture size reads the same.
 */
export const CW = 50, CH = 47;
/** a digit's template window, and how far each digit moves the next one along ("1" is narrow) */
export const TW = 11, TH = 14;
export const advance = (d: number, adv: number[] = ADVANCE) => adv[d] ?? 10;
/** where the first digit's window can start in the canonical slot */
const X0 = [0, 1, 2, 3], Y0 = [24, 25, 26, 27, 28];
/** a digit position matches when its correlation with a template is at least this (more for digits after the first) */
export const MIN_SCORE = 0.55, NEXT_SCORE = 0.65;

/**
 * A digit template: its mean grey picture (TW×TH, row by row) and a weight per pixel. The weight is high where the
 * digit looks the same in every sample (the white strokes, the black outline) and low where the background shows
 * through (the white slot for the first digit, the potion's picture for later ones), so a match only looks at the digit.
 */
export interface Glyph { mean: number[]; w: number[] }
/**
 * Templates per digit position (1st, 2nd, 3rd+): the font is drawn scaled up, so a digit lands on a different
 * sub-pixel phase (and over a different part of the slot or potion picture) depending on its position. Each position
 * has 10 digits; a digit never seen at a position uses the pooled template.
 */
export type Glyphs = Glyph[][];

/** The canonical picture of one slot (row by row, brightest channel), resampled from the frame. */
/** a canonical slot picture; `pad` = how many canonical px of the surroundings it includes on every side */
export type SlotPic = Float32Array & { pad?: number };

export function slotGrey(src: FrameSource, r: Region, i: number, cols: number, rows: number, scratch = document.createElement('canvas'), pad = 0): SlotPic {
  const { W, H } = frameSize(src);
  const sw = r.w * W / cols, sh = r.h * H / rows, sx = r.x * W + (i % cols) * sw, sy = r.y * H + Math.floor(i / cols) * sh;
  const pw = CW + 2 * pad, ph = CH + 2 * pad, mx = pad * sw / CW, my = pad * sh / CH;
  scratch.width = pw; scratch.height = ph;
  const g = scratch.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx - mx, sy - my, sw + 2 * mx, sh + 2 * my, 0, 0, pw, ph);
  const d = g.getImageData(0, 0, pw, ph).data, out: SlotPic = new Float32Array(pw * ph);
  // the brightest channel: white strokes, the white slot and any coloured potion picture are all bright in it, so only
  // the digits' black outline is dark (in plain brightness a blue or dark-red potion is as dark as the outline)
  for (let p = 0, q = 0; q < out.length; p += 4, q++) out[q] = Math.max(d[p], d[p + 1], d[p + 2]);
  out.pad = pad;
  return out;
}

/** The TW×TH window of a canonical slot at (x, y) (pixels outside the picture read as white, the slot's colour). */
export function windowAt(s: SlotPic, x: number, y: number): Float32Array {
  const pad = s.pad ?? 0, pw = CW + 2 * pad, ph = CH + 2 * pad, w = new Float32Array(TW * TH);
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const xx = x + i + pad, yy = y + j + pad;
    w[j * TW + i] = xx >= 0 && yy >= 0 && xx < pw && yy < ph ? s[yy * pw + xx] : 255;
  }
  return w;
}

/** Weighted normalised correlation of a window with a picture (1 = the same up to brightness and contrast). */
export function ncc(a: ArrayLike<number>, b: ArrayLike<number>, w?: ArrayLike<number>): number {
  let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k], v = w ? w[k] : 1;
    sw += v; sa += v * p; sb += v * q; saa += v * p * p; sbb += v * q * q; sab += v * p * q;
  }
  if (!sw) return 0;
  const va = saa - sa * sa / sw, vb = sbb - sb * sb / sw;
  return va > 0 && vb > 0 ? (sab - sa * sb / sw) / Math.sqrt(va * vb) : 0;
}

/** Best digit at (x, y) searching ±`r` px across and ±1 down, or null when nothing matches well enough. */
function bestDigit(s: Float32Array, x: number, y: number, set: Glyph[], r = 1, min = MIN_SCORE, ry = 1) {
  let best: { d: number; score: number; x: number; y: number } | null = null;
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -r; dx <= r; dx++) {
    const w = windowAt(s, x + dx, y + dy);
    for (let d = 0; d < 10; d++) {
      const sc = ncc(w, set[d].mean, set[d].w);
      if (!best || sc > best.score) best = { d, score: sc, x: x + dx, y: y + dy };
    }
  }
  return best && best.score >= min ? best : null;
}

/**
 * Read the count on one canonical slot: find the first digit near the slot's bottom-left, then follow the digits to
 * the right. null when no count is readable (empty slot, cursor over it, a window in the way).
 */
export function readCount(s: Float32Array, glyphs: Glyphs, adv: number[] = ADVANCE, wide = false): { value: number; score: number; x: number; y: number; digits: number } | null {
  if (wide) {
    // the box may be off: gather the strong digit spots across a much larger part of the slot (coarsely, one per
    // neighbourhood) and read a whole count from each; the longest, best read starts at the real first digit (the
    // single best-matching spot is often a later digit, and starting there loses the digits before it)
    const spots: NonNullable<ReturnType<typeof bestDigit>>[] = [];
    for (let y = WIDE_Y[0]; y <= WIDE_Y[1]; y += 2) for (let x = WIDE_X[0]; x <= WIDE_X[1]; x += 2) {
      // a pixel off, these small sharp digits match poorly: let near misses in here, the refine below re-checks them
      const b = bestDigit(s, x, y, glyphs[0], 0, COARSE_SCORE, 0);
      if (b) spots.push(b);
    }
    spots.sort((a, b) => b.score - a.score);
    const picked: typeof spots = [];
    for (const p of spots) if (picked.length < 12 && picked.every(q => Math.abs(q.x - p.x) > 3 || Math.abs(q.y - p.y) > 3)) picked.push(p);
    let best: ReturnType<typeof follow> = null;
    for (const p of picked) {
      const f = bestDigit(s, p.x, p.y, glyphs[0]), r = f ? follow(s, f, glyphs, adv) : null;
      if (r && (!best || r.digits > best.digits || (r.digits === best.digits && r.score > best.score))) best = r;
    }
    return best;
  }
  let first: ReturnType<typeof bestDigit> = null;
  for (const y of Y0) for (const x of X0) {
    const b = bestDigit(s, x, y, glyphs[0]);
    if (b && (!first || b.score > first.score)) first = b;
  }
  return first ? follow(s, first, glyphs, adv) : null;
}

/** From a first digit, follow the count's digits to the right. */
function follow(s: Float32Array, first: { d: number; score: number; x: number; y: number }, glyphs: Glyphs, adv: number[]) {
  if (first.d === 0) return null; // counts never start with 0
  const digits = [first.d];
  let x = first.x + advance(first.d, adv), y = first.y, min = first.score;
  while (digits.length < 4) {
    const b = bestDigit(s, x, y, glyphs[Math.min(digits.length, glyphs.length - 1)], 1, NEXT_SCORE);
    if (!b) break;
    digits.push(b.d); min = Math.min(min, b.score);
    x = b.x + advance(b.d, adv); y = b.y;
  }
  return { value: +digits.join(''), score: min, x: first.x, y: first.y, digits: digits.length };
}

/** where a wide search looks for the first digit (canonical px): up to ~0.4 slot either way of the usual spot */
const WIDE_X = [-20, 22], WIDE_Y = [6, 46], COARSE_SCORE = 0.3;
/** box sizes tried around the drawn one: coarse steps, then the neighbours of the best */
const FIT_SCALES = [1, 0.96, 1.04, 0.92, 1.08, 0.88, 1.12], FIT_PAD = 22;

/**
 * Fit the quickslot box to the slots really on screen. A hand-drawn box is rarely exact, and the reader follows a 1080p
 * slot's geometry: 4% too big, or a quarter slot off, is enough to lose digits. So this tries box sizes around the
 * drawn one (kept centred) and, at each, looks for every potion's count across a wide part of its slot; the size that
 * reads the most digits best wins, moved so the digits sit where the reader expects them. null when nothing reads.
 */
export function fitQuickslot(src: FrameSource, r: Region, slots: number[], cols: number, rows: number, glyphs: Glyphs = GLYPHS, scratch?: HTMLCanvasElement) {
  if (!glyphs.length || !slots.length) return null;
  const at = (s: number): Region => ({ ...r, w: r.w * s, h: r.h * s, x: r.x + r.w * (1 - s) / 2, y: r.y + r.h * (1 - s) / 2 });
  const med = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const midX = (X0[0] + X0[X0.length - 1]) / 2, midY = (Y0[0] + Y0[Y0.length - 1]) / 2;
  // a box is judged by what the reader will actually get from it: the plain (narrow) reads of every potion. Only clean
  // matches count, since at a wrong size the digits still half-match (≈0.7) and can even read as a longer number.
  const judge = (reg: Region) => {
    const reads = slots.map(i => readCount(slotGrey(src, reg, i, cols, rows, scratch), glyphs));
    return { reg, reads, score: reads.reduce((a, x) => a + (x ? x.digits * Math.max(0, x.score - 0.6) : 0), 0) };
  };
  const tryScale = (s: number) => {
    // find the counts with a wide search (and a margin around each slot: with the box off, a count can start just
    // outside its slot's cell), then try the box as is and moved so they land where the reader looks for them
    const reg = at(s), wide = slots.map(i => readCount(slotGrey(src, reg, i, cols, rows, scratch, FIT_PAD), glyphs, ADVANCE, true))
      .filter((x): x is NonNullable<typeof x> => !!x && x.score >= MIN_SCORE + 0.1);
    let best = { ...judge(reg), s };
    if (wide.length) {
      const dx = med(wide.map(x => x.x)) - midX, dy = med(wide.map(x => x.y)) - midY;
      const moved = judge({ ...reg, x: reg.x + dx / CW * reg.w / cols, y: reg.y + dy / CH * reg.h / rows });
      if (moved.score > best.score + 1e-6) best = { ...moved, s };
    }
    return best;
  };
  let best = FIT_SCALES.map(tryScale).reduce((a, b) => (b.score > a.score + 1e-6 ? b : a));
  for (const step of [0.02, 0.01]) {
    const c = best.s;
    for (const s of [c - step, c + step]) { const t = tryScale(s); if (t.score > best.score + 1e-6) best = t; }
  }
  const got = best.reads.filter(x => !!x && x.score >= MIN_SCORE + 0.1).length;
  return got ? { region: best.reg, scale: best.s, reads: got } : null;
}

/** a read must match at least this well to be trusted; this many matching reads in a row accept a new count */
const TRUST = 0.6, CONFIRM = 3;
/** more potions than this between two accepted counts (~1 s apart) can't be drunk: it's a misread */
export const MAX_STEP = 3;

/**
 * Turns one slot's count reads into potions used. A misread can repeat (the same wrong digit several reads in a row),
 * so a new count needs CONFIRM matching reads, and a drop only counts when it's small (≤ MAX_STEP); a drop of 2–3 also
 * needs the potion's stat to have moved on its gauge just before (a rise, or the flash of a change).
 * A rise is a pickup. Anything else just moves the baseline, counting nothing.
 */
export class SlotCounter {
  val: number | null = null;
  /** when a trusted read last came in */
  at = 0;
  private cand: number | null = null;
  private n = 0;
  /** Feed one read; returns the potions used (0 when none) and, for a drop that was rejected, its size. */
  feed(r: { value: number; score: number } | null, now: number, statMoved: boolean, pictureChanged = true): { used: number; rejected?: number; from?: number } {
    if (!r || r.score < TRUST) return { used: 0 };
    this.at = now;
    if (r.value === this.val) { this.cand = null; this.n = 0; return { used: 0 }; }
    if (r.value !== this.cand) { this.cand = r.value; this.n = 1; return { used: 0 }; }
    if (++this.n < CONFIRM) return { used: 0 };
    // a count only changes when the slot's picture does (slotwatch.ts): a new number on an unchanged slot is a misread,
    // however steadily it repeats. Held much longer than that, it only moves the baseline, so a missed change can't
    // freeze the count.
    if (this.val != null && !pictureChanged) {
      if (this.n < CONFIRM * 4) return { used: 0 };
      this.val = r.value; this.cand = null; this.n = 0;
      return { used: 0 };
    }
    const from = this.val, d = from == null ? 0 : from - r.value;
    this.val = r.value; this.cand = null; this.n = 0;
    // one potion is believable on its own (drunk at nearly full MP / HP the bar may not visibly move); more need the bar
    if (d === 1 || (d >= 2 && d <= MAX_STEP && statMoved)) return { used: d };
    return d > 0 ? { used: 0, rejected: d, from: from! } : { used: 0 };
  }
}

/** Read the count of slot `i` of the quickslot region straight from a frame. */
export function readSlotCount(src: FrameSource, r: Region, i: number, cols: number, rows: number, glyphs: Glyphs = GLYPHS, scratch?: HTMLCanvasElement) {
  return glyphs.length ? readCount(slotGrey(src, r, i, cols, rows, scratch), glyphs) : null;
}

/** How far each digit moves the next one along, in canonical pixels (generated with GLYPHS). */
export const ADVANCE: number[] = [10,5,10,10,10,10,10,10,10,10];

/**
 * Digit templates, generated by dev/build-glyphs.mjs from labelled frames of two 1080p recordings (a party, and a bright beach
 * map with White Potion), checked on held-out frames. One string per digit per position: base64 of TW×TH mean grey levels then TW×TH weights ×100.
 */
const RAW = [
  // position 1
  'gcSRjl9IRjE+dLxVsX5bdXRvcHxndDh9blzAyMjJyJRUHC+Ir09MSkdHibUsDZfRG1VZSSiH2ToHkdIegKiBN4naOQeR0h+GyKI6i9pbB4/RIIrOqjuL134IjdEgjc+rPYvVLQiM0B98u5Y0h9QzC4rPHmyviSSC1DgNiMscRGlWGHzVIRptolFVVVVUe5soOD5PrsLAv71yLDBTDA9kZGReSERkIDQOZGQ2KCtRZGQ/UUJkSWRkZGRkZGRkLmRkZGRkZCBkO2QRKGQvNSJkDj4TZBIlZBIdElMOOxVkEiVkEiAeYw06IGQSJGQTIiBgDjMRZBIiZBQjIFcOLSVkEiNkGCEiZA4qZGQTKWQrZFxkECxkZBUnZD8bJ2QTMmRkZEZANzk3O2QjUmRkZGJkZGRkZGQ=',
  'n4Hqrz9Aof77Y0SMOmZ1kwWR9Wp8mGdkWp/5BF2vU5OwQtrT6foEFErMUTQfaWqb+gUCJfs1MUlKDF36BwIm+zJDkZcOXfkJAif7LTyhpw1c+gkCJvstPZ2jDFr7CQIm+y5DnaYNV/oJAiX7LzucqA5V+QkDJfs2HoCpEFD3CgUq+jMQY58PUvcLG0KEaHhCgQ5Fwwk8aCGAsWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'kWlYWldUW+7+/vZeUVRRUFFXjNf++D2Uzs7Nzso1gtbrwYE5ODk9Rrd4QIKOgGdoazwM+HgGVSqW+/r3oA36dwdod7fs4uKUJOF0KN+VsqdYXXabZHqmxpd8XlZVdqpSs/ezhEdR2deNJd7146MwfaRJS1FrsLGWaHF8bA4OIFZMRUFP6YlHSEhIR0giEEnS08HKy8vKy1sPSWRkZGRkZGRkZGRkZGQaGBgZH0dkZGRkZGRkZGRkZGRXZGRkZGRkZGRkZGQRPWQoLDZNZGRkZAlkZGRkZGRkZGRkC2RkZGRkZGRkZGRkZGRkZGRkZGRkZBFkZGQTFGQfMWRkCmRkZGRkZGRkZGQLZGRkZGRkZGRkXhM+ZGRkZGRkZGRkZGRaNissLS0qZGRGZGRkZGRkZGRkZGQ=',
  'oIlHQUNDP1T6/v6LQneYl5eWf2vW/WdoorSurLKbUYbGQtlWNDQzMzvKQVsdaRhJnp1ME/otNEhJDDWNiDEX+Co3kJUXC0xELUTTS2WgpBpNvru6r0mZy6apGjBrX2B9lW+ebms7NDQvByn0ND4hK2F8en8nH/swGSmvTj4+QBod+zgXL45xeHd1d2aFPDQlJYG1s66zjCZNW2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  '3E9f3nVxalNQV1vJknqIl21SmUdHYNLLrGiZe3TQW1ly6cjIr2aGvMptZW7xxKN4pntx4WBXcO+Qb3KYTTnbR0x2zllYmjg0N75ARW9ui3NKNCUhtzo3VD6ppX2pkJDbpXhMQHSOmb67we3Mjk49KCwwOjlFxV5BPGxANjs8HR6+Mi1VcVZVWForLMM4MWlTTU1LTignoy8sYCojJFo8NjghIUpPE1w1LGREJmRkYFIZGGQfTkxOHmQbHVsRG2QpZDcUNhEcZA8fMT1kV1VkGR1kHi9cP2QZNGQaH2RkTxdkFSgNYxgdIDoeZBYsZAtkFhYRHQ0bHR81Hl8gEA8qEhtkZGRkZCQMD2RkZGRkZBFkHA8dZGRkZGRkDmQZGWRkZGRkZGQQZBgiZGRkZGRkZBlkHj4=',
  'KiA4QkNCQUFBQHsemJiXmJeXl5UgRTD9zbC5t7e3tBdBLvteMzk2NTU8BFYs+SkEBAICGKCcxDH8oYSHiIV4e+P+QtzUzM/RzaQ2m9plT1BOT05LRrVDY5ZZXl5tiy8U+yg7bFqIoa/ZSRb7LTQgI2+QlKM2GfsxHCqtSzg4ORkc+zkWM4xyeHd5eWmFPDUoJYWzs7K1jiVMW2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'nYjpqj5CQUQ9wv+eknhwmZeWhAi2/5lUWX62truXCMHtdSGpkzc2OSsJz7hGpGs8AwMAHJ7uoTH9n3+IiIV6fPGsLf7dxtLSzaQ5tYYs/GhMUlFKR7VcKiz7MBxyijAW+jcvLPw0LrvZShj7NT4s/DMkn6M1G/s2JTD8NBE4NhYd+zodLYxudXR2dmqGOzomH4Syrq+xjiVJXmRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'KSw+QkNCQkNDSaZbmZmXl5eXlWsYhma6sq+wsbHdtyNXITs2NTIzPJ22LxlicZucYh+BgnOfTpap7/uYLceFRdyHkp3S0Y1QrHth4ZSSmKZjea5kesvwr5WXkDRt2EF+/ve1mYlnVXmYR4bi1pmbcjGQkTZijp6PZ5FwHKObFmyKgXRRWVpnfmpGdn91bVElPYxNQn6DdmxmWGRkZGRkZGRkZGQeK2RkZGRkZGRAZA8cZGRkZGRkZBtkGmRkZGRkZGQkI2RkZGRkZCNkZDxkZClkZGRkDEM+CRxkDWRkZGQlZGQYHGQNZGRkZCZkZCBkZBRkZGRkC1g4CGRkJGRkZGRcZGQTZGQTZC9kIxxkZGRkZDBkH2QSDWRDZGRkYWRkZGRkZGRkZGRkZE1kSGRkZGRkZGQ=',
  'ilBAQUFARuX+/vZAZpmWlpaVY73+9leMsa6vr6xXg6iszXcyNDUxN8p6LTb6bxifnnEM+n4CCPpxE4qITwz5ewZTy3ouQ0EyOch7QJ1Ikru5ury7RIfCrY6DYWFgYm2Ge3qu7m4KMi0WFOlwGp/2ahGCfkAS9G0Pce9kEEFAJxbqbw9YgHd2d3l2c4xSMVEfbrGws6+mOkReVGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkLmRkZGRkZGRkZGQLZGRkZGRkZGRkZAlkZGRkZGRkZGRkCWRkZGRkZGRkZGQMZGRkZGRkZGRkZBpkZGRkZGRkZGRkMWRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'kHtpbWlpcvf++MdxNgsKBwoYs/bulBaW7u7s7egRiveWrINJRUNJVKN5UWr3bwhDQhMN9XcKY/psGfbznw35eAlu+Wwa/vyoC/p1DKH6bgmAgjUM+nQKqeR5BwYGBQ35bAuqE5j8/Pz8/PpnEaRfW11VVVRa9mkMZG8jCAkJChPpcA02GQsPDxAQF9ptE0AQfNvT1dPLPTtRUGRkZGRkZGRkZGQnZGRkZGRkZGRkZAlkZGRkZGRkZGRkCWRkZGRkZGRkZGQLZGRkZGRkZGRkZBBkZGRkZGRkZGRkCWRkZGRkZGRkZGQJZGRkZGRkZGRkZA1kZGRkZGRkZGRkCWRkZGRkZGRkZGQJZGRkZGRkZGRkZBdkZGRkZGRkZGRkL2RkZGRkZGRkZGQzZGRkZGRkZGRkZGQ=',
  // position 2
  'Ys2AiVE3OhcfVrIvxH1bipmbmppjWxqKgGyjsrK0sYhYBieKqEI7NzQ4haw4BI+9HmpnUSiCyVoFkLwen9SgOoLIWAWQux2d+co4gchXBZC7HJ791DeBxFUHj7kcof7VPIHBRQiPuR+Q6701gb8uCI28IlqadCOAwCYMi7kjIzQpFnzCLCBjgXN7eXp5fG80QklJm7Sysa9nKVM+CAlkZGRkZGRaNC4JZGRkZGRkZGRkPTlkZGRkZGRkZGRkHlhkZGRkZBRcKmQLH2QmJhZkCDEQZAseZA5JDjQILxJkCx1kDWQyPggvFGQLHWQNZEo9CCkVZAscZA5kTTcJJB9kCxxkEWQ/XwkiUmQLH2QiZGRkCiNkZA0cZGRkZGQLJ2RkZGRkZGRkZGRkQWRkTGRkZGRkTWQ=',
  'y3YxxXU/VXyci3+8dhqKWU03X4x0bapkJjPDsTNOkZa5NX7Fw+6vJjynn4ErU52WxqwfP7+kYlgxNxulrh45oaFb7+qnKaewGxCKroj+/MUspa4bSKF4b//9viylrBx0uYJW8O65KaaoHHHJtGOkqXsepKgeQYV1R3d3URmgpx8nY1gxb2lIGJukIShpXi9fXEAbmZMdLDdUkiUNZBoiZGRFZGRkEw1kGGQoZDZMPzwNHUtkIytkQ0BIJVk3ZGRkJ2RWZGQ7NyMnTRglZCYrYB0MNC5kCSdkEyYkGGRkN04JKGRkH0IRZGRLOwomZCVIGytkZDw/CSRkDSElEmRkZGQJIWQLLTwPZGRkZAohZBpBTmNkZGRkCyBkSCwsZGRkZGQNH2ReJSRkZGRkZA1SZGRkZBM=',
  '9zAZgT1JUFR7orH3KxE6MT5GVEZ1le02VuTn6OnlcU5qTqOOPkFHUFCwmTwIeItESwwEDdnTGBUZXvb0hw4N3MYK5tnn//XysRXPwA7+/v7zfm6EjoCBcv7/8LcyIkfeYFK/+fCbHuHw0Ba1qQ+yZHKkY11aR5SNP01LbqQVERdWSkpQEsGnKScqKSgoGwwVwO/Q29vb29mED2RkZGRkZGRkZGRkZGRkTTlGVmRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkVF9kZGRkZGRhZFNkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkOSdkMWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRVZGRkZGRkZGRkZGRaWVZaUWRkZGRkZGRkZGRkZGQ=',
  '9jYQXCUrMThOaHL2MyB8eYGEiEpIXsFaasbDxsjEf1RHPqWbPT4/QEa6risHXFAIhFEFDdXXG1haMwqnYAML1M8Y7OqTAzouJyq5tjT/+qcKp7Ozq29qqv78qQuKkI+MeXOJwMOUHSclGhO3tBZCQVFjbmpOF8C6EBFtdkVKSjgat7MQJo+VZWJiYWaSehtSN2HDw8TBv1oqOWRkZGRkZGRkZGRGZGRkPy49TGRkZFlkZGRkZGRkZGRkX2RkZGRkZGRkZGRkZGRkZE5kZGRkZGQrMGRkNlxkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkJxoaHGRkIlVkZGRkZGRkZGRkZGRkZGRkZGRkZGRkRmRkZGRkZGRkZGROZDo5OD9EZGRkZGRkZGRkZGRkZGQ=',
  '9i8/71xXUjMxR2D7mWN1jVYylj82Vf73s0WPamX1XjJQ/v3wqkt91PhYME3//MRio4N1+FYwUPy0enCuQxD3WS1X0mZsxjMIF/hWJE1TnZpTBwcb+E0ULg3N34qPjJX8sVgaDI6/tsC6wP3SdA8JKDo4OzlH+GkhB0pGPzw/Gxr3PwoybWZeWV0jIfdHDExeWFBLTx8bzToOS2RkZGRkZGRkZGRkZGRkTWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRWZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQsJydYZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'hhIgikRLU1ZbY3sKBRsjIzE1OD5KUgzI8PHu8vLy8+xKCdLdQFVaXmNuZ04N07oEBQoQGi1MbgjUswkCCg4YN2aGDdb68/f39/JtW4Z+ent+g4qQmrOTbPZLCAQEBQkS2vQ++v38/Pz88xPIyi9oUHq+usGjFb29FQ8jP0pOTz4YvLQPF8mqGRcZGiKmoxVHNm/d4N7f2WgqLWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  '9y9H+EVJVVtujaf5U0+6RTA7TkJtkPvwnB7z8vPxmGOK94Bsv2pWXnZHZo60ZHK1CQoRHj94nBDNsAwFCg4bRXqeCND89/f39/N1ZI4K0/d7i4iOlrGWbQrTsgcJCQcS3/E+DNa3Evr88xLIyy0RyrEWscuiF8O8FRXGrhZOVD0bv7QNFriiHBoYGSOnphBBNW3a3dra1GYoK2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'cBEccDM0OjxBS14KNlFVV1xgYWlcQAm11tXV1tbT99I6Big9ODs/Pjvj3D10ZmBdZSIKbJeIUfn6+fr1dBLzYzdf/v7+/edtIetcNnj8/P72b3iYdSRK1f7+/vUMhfMKNoG87+3n1C2G1hmuryGspnlKrH1LToyDQXx1OBntehVtZlpbb1s+RLtjG1JOSEdgH1K/Oys3Rz9AP2RkZGRkZGRkZGRkZCcjIyUqLi8+ZGRkRGRkZGRkXWRkZGRkZGRkZGRkZGRkTDItKjxkZEhkTGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZF9kZGRkZGRkZGRkZEhkGGRkZFVkZFhkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZDtkZGRkZGRkZGRkZGRkZGRkZGQ=',
  '9zgNTh4iKTJCVV/2OSeVlZmcnE88UbNlbrm4t7q7hVZAObapODw2OEG/ti0L1bwKl18DDdTbIwzVvgiHSgEK09AfK7CjLEEyLzKvrTqxWWm4urq8tmdet2t6fWxram5sgHZxEb2pDSQpIBS3rRAUxLIVX3BSGbyzChfBqRg5QTMdtK4OJXSHeXZ4dnuJZxpIM1u6uLm3uFMmOGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRdXFpgZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  '+osINCskKi85YHL6jBp6mp6goHE9U8qAZKGys7a4mWBHb3y6Vzk7NTyHwFFLf9k7XXMXCH3oU1B+2DyU4YknfORQQXvXO3PYuDl64U0ceNM6JUpDG3bcRm+Of5elpaSextJBnp1Omra4tqvPzjprjFU/ODo6OYXHOFBaJxMODw8UbMFAVTshZ4B7e31/dTJgMiqVubW1tnkxNWQOZGRkZGRkZGRkZA5kVGRkZGRUZGRkZGRkZGRkZGRkZB8ZZFBkZGRkGWQ6FgxkJhZEZGQMZCYTDGQpCWRLZA1kIyEMZCgPZGQrDWQjZA1kJWRkZGQOZCQnZGRkZGRkZFNhLxIVZF1kZGRkY08rIWFkZGRkZGQeZCY9Y2RkZGRkZBdkImRHZGRkZGRkZGRkZGBkO2RkZGQ5ZGQ=',
  // position 3+
  'srarlHRiWlpvosuRk4BZVDkqLUttmWdqUUTu6urq66lPPTyFumNmaGRgkcMYG6TxGDVDPSiO8gkKk/UdTmNSM5X2CAqT9SNje2M9mvZiCYz1J2yFaEGc9r8JivYnboZoP5v2CAiH9R9cb1k0kvU8D4bsF4nRqSWE9FMOgugReL2cGXvzDxB+1xsbHBobeuEUKCxXytjW1NSCMWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ5ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'U1ZgZmA+ND1efIpMRz80Mn2ELFN0hEk1TXJd39EmTm9+RSN23cr81CNLbHpHHj5pZ9fUIEdodlA8Lx8Vx9gcQ2NxR1RPNBzL1hg+XGklRkw1GcjTFThUWhOYuo0RwtAOL0ROCYqshA3DywtOamcEJS4mEcHFEYKqiTUxMywWvL8MNkY6SkFEOhW8wg0XHR5LQEI3EJCXDzdGRGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'VFZWSzYuKSg0UXFKRTk2paKfnqFuREYyS329vr26uI1tRCB60kZJSURCi9BHG0ZwKS4vKBaN9VA6NztHRkA3G5D1RVVYVlNFNy1BmcskSVRSRCkbHr+gTxaavZgnbKWiiUgkC4iljVaQt7BaSFgFKTBTwmA6PYOlizkOV5xdJBAROk48TBCB63p7fHt6fGhMDWDPs7m6t7e4nGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
  'U19wZ0o6NDM7WoE9Q09OiYR7en1mT1YuU3SnzM3MyatuSxlpxmFLVFJLf8JGETRyMh81NR1s6UskJBoPFywsHGrqVDc6UDojNC4rZchtPF9MJW+wtK6KWU1yzIINOYeNkal/LGTAqWkzLyoLYNwpHjpOkpd/bQ9a4j8PQn1TVUI4ElrdTBtEnYleXVtdYY5ZLzI/m8TDw8KQPmRkVj1bZGRkZGRkZGReWUxILScrZGRiZGRkZGRkZGQ8ZD9kZGQpZGRkZGRkOGRkZCZkZGRkPmQ2ZGRkZGRkZGQyZGNfZFkrZGRkZCZkIWRkZGQbZGRkZGQ7HGRkZGQiFxgvZDkmRzAzZGRkZDNkLmRkZEUuFhtkM2REZFYnZGRkZGQ9ZGRkZGRkRDw6NUdkZGRkZGRkZGRkMmQ=',
  'mqKuraupqq2lekJHf7CyrKqloWNsdGFZl7yzrJdpWLvCtj1bu7Oed0qx7rzTMFGyrGhhooS6vNMzVHdfbKCMHZa+yzgdJUiuhR4Lmb+6VQs1r3ooBQyVusJCCFfwmX6BhtbTzyoISLvBwcO83ffOKAcZNzw7OkKdysotGTIvIyEjD4myfSc3UExBQTQSkbc4LUJFQ0JDNBN7mBslMUZkZGRcNWRkZC8jMkVSUCtkZFZkZE0rNDEyZGQ1JGRkZCgmJkRdUGQbMGQcJxhdT2RUJxs0ZA5kZGQxZGQPHC9kZGRkOERkZBAcGSRkMmRkZGRkEBgiZGQQZBMeHEBkJzJkZBRWZGRkZGRkLmRkZGRkZGRkFzIoZGRkZGRkZGQRFWRkZGRkZGRkZBIXZGRkZGRkZGRkEyk=',
  'vc2NMjcyNDc4ODhXqIIMd4yMjYyNjGyFVQzl7Lm8v7/A1GkWC/GyNTo9PT35XAUJ8Y8DBAQFC/hbAwnyzXZ4eXp49lUHNcPb0dTV1s3yRzOxTFFUVVVYWPNFQPafRQtVYDwM90ofvLdtJ3yGWQ72UAs7OEZLNjQoD/VXCg6HaSoSEBETlEEbHYKIbW5tbW07Ojc6Kmi1tra2ryonZGRkZGRkZGRkZCNFZGRkXmRdY2A3ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRMR0ZGYGRkZGRkZGRkZGRkZGRkY2RkZGRkZGRkZGRkZGRkZF5kZGRkZGRkZGRkSENkZGRkZGRkZGRkZGRkZGRkXWRkZGRkZGRkZGRkZGRkZGRkIWRkZGRkZGRkZGQ=',
  'WWmIlYlpS0FAQ1g2S3V6Y3F3bWhTLls4Z2hncdnX261PTiNUZKWkWktSTi9DE1mZgnIHBQYZQUYIWuyhR0NHRjM7WgdL5N3f5OTkuVGdCEreoGZwb3SNp3UHSdxcDBAVCEncSQpL2V0poKprRtZHDEzUYUCDeS1C1EgPTc9jIy8lD0LRSBY0n4xLRkZETJdYJCs1j8jKzMqiSGRkWkZQMGNkZGRkZGRXOElkSjErZGRPZDotZC9kZGQcQSZkVmQyIGRkZGRkIGRkZGQRZGRkZGQdZCRkXiMcGx5kZDVkHWRkZGRkZChkZGQdZBBkZGRkZGRkZB9kD2RkZGQlZCJkIGQPZCYTDCtkImQlZBElIF5kKWQlZCZkEWRkZGQyZDdkZGRkUTs0MEdkZGRkZGRkZGRkI1s=',
  'VUA1Nzc2NTY5PUY3Fz9xb21tbnFydVYPRMrV1dTOzO30QxAiTltZU0lDf+w8I0k0QDowHmh1fUI3m2pcW0gnrcM4UzNKfo9eUUyJsUGgOW1rd2pVoGthQ3Fo1ZdPaELReBtLPFXMwFomSZuNO1k4HmNcMWKkV3CgozolUEMec9M/Jm5uQjJKRVlblEoXFRlVNjQkj4I3QUE/QGRkZGRkZGRkZGRkZGRXJCEhISMmKCs2ZEJkZGRkZGRkZClkZGRkZGRkZDZkKWRkZGRkZGQcUmQnZBdkZGRkZA1kZFFWSmQaZFFkEydVZERkZDkVZEJkNmRkGGRkZApkRAxkZDQoRz4hZCdkE2RkMmQaHlAXZGBkZGQ1ZGRkZBNkJ2Q5IEhkZGRQLS05ZGRkZGRkZEcbZGRkZGQ=',
  'VmJ4cVVEPjpAXYg2QFhXf3puamxiU1kmT2id1NXU07lxRxFhw21KVldTd7s+B2HtYRw2OiJd5T4FXedfEzI2IlvmUglJ0HQkKi0lVcqcIVltp6ipq6aIZ3Acm3hppqekp7d5PwlT1lkfLiMJT9ZCDlXcX0tuVw1L3EISWNNfKjcuEk/WRhs7notPT05MVJZbKzA3kMXIysaeSGRkTzRCZGRkZGRkZGRGSlFCKSQlZGQ3ZGRkZGRkZGQzZCVkWmQrZGRkZGRkH2QdZA1kZGRkN2QcZBhkDWRkYWQyZDRkK2QYZGRkZCZkZGQ+ZGRkZGRkZEpkZBNkZBQVExUpZCRkJ2QSZGFkZCpkImQhZBAuDhVkK2QnZCZkEWRJZGQyZEJkZGRkPTIuKjZkZGRkZGRkZGRkLWQ=',
  'U26lqIZjXlNQaqIhPIWEU001KylSaIoiXlt+9PLy8u97hRA3r6dTZmlkXqSEAhjizRhGTDMhzYYAC9fLIWd0SSrPiQEJ08ondIJWMdGMAwnTzR9XXkYq0IUEGKyjDygsHhTKeBXzTVb7+vz8+P16FL9kQ15YVVpI03cUdF0qBggNDhezdRBbEg0SGRYYJrJ1DlESUuXf4uXgamRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=',
];
const decode = (b64: string): Glyph => {
  const b = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), n = TW * TH;
  return { mean: Array.from(b.subarray(0, n)), w: Array.from(b.subarray(n, 2 * n), v => v / 100) };
};
export const GLYPHS: Glyphs = [0, 1, 2].map(ps => RAW.slice(ps * 10, ps * 10 + 10).map(decode));
