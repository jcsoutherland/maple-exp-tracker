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
export function slotGrey(src: FrameSource, r: Region, i: number, cols: number, rows: number, scratch = document.createElement('canvas')): Float32Array {
  const { W, H } = frameSize(src);
  const sw = r.w * W / cols, sh = r.h * H / rows, sx = r.x * W + (i % cols) * sw, sy = r.y * H + Math.floor(i / cols) * sh;
  scratch.width = CW; scratch.height = CH;
  const g = scratch.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, CW, CH);
  const d = g.getImageData(0, 0, CW, CH).data, out = new Float32Array(CW * CH);
  // the brightest channel: white strokes, the white slot and any coloured potion picture are all bright in it, so only
  // the digits' black outline is dark (in plain brightness a blue or dark-red potion is as dark as the outline)
  for (let p = 0, q = 0; q < out.length; p += 4, q++) out[q] = Math.max(d[p], d[p + 1], d[p + 2]);
  return out;
}

/** The TW×TH window of a canonical slot at (x, y) (pixels outside read as white, the slot's colour). */
export function windowAt(s: Float32Array, x: number, y: number): Float32Array {
  const w = new Float32Array(TW * TH);
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const xx = x + i, yy = y + j;
    w[j * TW + i] = xx >= 0 && yy >= 0 && xx < CW && yy < CH ? s[yy * CW + xx] : 255;
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
function bestDigit(s: Float32Array, x: number, y: number, set: Glyph[], r = 1, min = MIN_SCORE) {
  let best: { d: number; score: number; x: number; y: number } | null = null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -r; dx <= r; dx++) {
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
export function readCount(s: Float32Array, glyphs: Glyphs, adv: number[] = ADVANCE): { value: number; score: number } | null {
  let first: ReturnType<typeof bestDigit> = null;
  for (const y of Y0) for (const x of X0) {
    const b = bestDigit(s, x, y, glyphs[0]);
    if (b && (!first || b.score > first.score)) first = b;
  }
  if (!first || first.d === 0) return null; // counts never start with 0
  const digits = [first.d];
  let x = first.x + advance(first.d, adv), y = first.y, min = first.score;
  while (digits.length < 4) {
    const b = bestDigit(s, x, y, glyphs[Math.min(digits.length, glyphs.length - 1)], 1, NEXT_SCORE);
    if (!b) break;
    digits.push(b.d); min = Math.min(min, b.score);
    x = b.x + advance(b.d, adv); y = b.y;
  }
  return { value: +digits.join(''), score: min };
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
  feed(r: { value: number; score: number } | null, now: number, statMoved: boolean): { used: number; rejected?: number; from?: number } {
    if (!r || r.score < TRUST) return { used: 0 };
    this.at = now;
    if (r.value === this.val) { this.cand = null; this.n = 0; return { used: 0 }; }
    if (r.value !== this.cand) { this.cand = r.value; this.n = 1; return { used: 0 }; }
    if (++this.n < CONFIRM) return { used: 0 };
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
 * Digit templates, generated by dev/build-glyphs.mjs from labelled frames of a 1080p party recording (all 144 labelled
 * counts read right). One string per digit per position: base64 of TW×TH mean grey levels then TW×TH weights ×100.
 */
const RAW = [
  // position 1
  'm9NiX11KR0ZUjbJ1vktUcWNcXW5agE2LUWDV09PV0o9SJjujok9XUVFPrqk+Esm/EWQ5JRq9ylMJv8AVmYFLIcHMTwm/wBqmr3koxMt/Cby/G6u4hCnFyLMKur4brLmFKsXFPwq5vhiXo3AlvsNHDra8E4+3hR6zxE0QsbcRXIJpGKnFKhmBsUVFRkVEg6Q0NStjwsrIx8NlMGRcESBkZGRkZGRkZC0fZGQzJShJZGRkUWRkZGRkZGRkZGRkWWRkZGRkZGRhPWRAJGQqZGRkKTgQZC4hZBBXZGQvMxJkLiBkFCFkZDQyZGQoH2QXIWRkNixYZCgeZBchZGQ2Jx9kJR5kGiFkZC8lZGQnJ2RkZEFkKCdkZCsmZGQaI2QrLWRkZEAzMjExOGQZT2RkZGRkZGRkZGQ=', // 0
  'r3I7rnRAT3CRioKgbyN5TldJVIF1c5VZLT+qvVdFhZCwOWizyeXCTTWWloEzSIqOrrdHM6iaZ1UwNRyBtkgvjJVfysmVLYS4RQ95nYLO06svgrZFN41xZsrmvkOBtERYm3VTvdm4PoCwRFaupmeBjGwggLBEM4WBVmlnSx1+rkQfWlQyZ2BIIHqrRiBYUSpbVkEieZU5JDdRhBgQXRcsZGQ5UmRkERBkFmQqZDVCTkYNIFBVGzAaRTZOKGQnZGRkJBZkNGRJQSQeTRYqFD8aUSMORzhkCTASGB0kHRgfJmEJMBJkHS0UDxUfSQkvEzImHz8NRkonCS0UDhMkFg0+ZDcJKBYMGS8TGiRZZAkpGB9QRkVkZGRkCigaWi80ZGRkZGQMJhlkICNkZGRkZAtkK2RkZBQ=', // 1
  'kWlYWldUW+7+/vZeUVRRUFFXjNf++D2Uzs7Nzso1gtbrwYE5ODk9Rrd4QIKOgGdoazwM+HgGVSqW+/r3oA36dwdod7fs4uKUJOF0KN+VsqdYXXabZHqmxpd8XlZVdqpSs/ezhEdR2deNJd7146MwfaRJS1FrsLGWaHF8bA4OIFZMRUFP6YlHSEhIR0giEEnS08HKy8vKy1sPSWRkZGRkZGRkZGRkZGQaGBgZH0dkZGRkZGRkZGRkZGRXZGRkZGRkZGRkZGQRPWQoLDZNZGRkZAlkZGRkZGRkZGRkC2RkZGRkZGRkZGRkZGRkZGRkZGRkZBFkZGQTFGQfMWRkCmRkZGRkZGRkZGQLZGRkZGRkZGRkXhM+ZGRkZGRkZGRkZGRaNissLS0qZGRGZGRkZGRkZGRkZGQ=', // 2
  'vEQvUionJis6VWe0ODd+k5SRj1tISo5UaJ6uvb+8mnNHPnSIaUc/QUSUnlQdNTsvdkwWGpKsWmhbOA9eNxIXkqhas6d1H0IzNTR/j2TLt40ihaO6t35qk7/KtzRHVXFyh4tufJOZVUUvJRx6lVcvLkZefX1iNX+WWCFcbVJFRTUlfJNZOFZyjINzcXR6ZkZXNU6Orr67u3xPPhRkLGRkZGRkZGRkD2RkR2RkYlpJZGQ4ZGRkZGRkZFIxZGQbZBlVZGRkKGQSSGRkKyFkZGQQKQtdQmRkJGRkZA8pCxYQM0NkZGRkHzoWFA5VYRgnZGRVZDYPFWQkQmRONUJVZBwzVRlMZGRkEjMMZGRkZGRcMiQSKwtkJVI5ZGRkZBQwDGQ/VGRkZGRkX2QoZGRkI2RkZGQrJmQ=', // 3
  '3DdH32JbVTgxQFXblWlsj1w4kkc2R+Tbr1eEamzeYkVI4t7cpVF4wettREPh27VcoYJw5GpDRd6VfXyaRCraXUJMultmqj8iHdBaOkNXi5BXGBMY0FMsJR6tzKyol5jgtXclFW6fr7u2vPbTfSoTITA0OjhB2m47FE5GQz4+GxjRSSg1ZFlaVVUmJdNQKUdeUU9KTSUeqUAqRyJkZFhkZGRSZGRkFmRkZGRkZGRkZGQhHGRkZGRkKUQiZBwYOGRkZEJkJSBkGRZkZFdkZD4rIGQZPk1kZGQcGjIeZDtkZDQ+HGQQLRtkZCpFZElhZA8xGGRLFx9kZEdBGUcwUWQ6MGRkZGRkZC0XZGRkZGRkZBtkHFBkZGRkZGRkED8aZGRkZGRkZGQSPhlkZGRkZGRkZBtkHGQ=', // 4
  'TkdDREJCRkdHRk8mGStSVE9UTlFQVm0NOtfd3N7e3t7eYQc43Ko/TE9PVF1aBzbbgAMFBQcXOFwEONukMC8wMSk5ZQUt0uvq7Orry1aQFmtzdn59eXyOn3M6228RDxEPBzPTUzTh15gtrsSPM85TE0tOc25wbDcxzlQLJ05OTiUfDzbMWhIrrKE+Ozc2QaBpHC40gdTR0dC3VWRkZGRkZGRkZGRkZGRkKSomKyUmJSwwZChkZGRkZGRkZCdkIWQRZGRkZGRkI2QeZBBkZGRkZGQgZB1kZCIgHx5kZDtkMGRkZGRkZDJkZGReZGRkZGRkZGRkHFtkZGRkZGQpZDEpRDRkQy4WDi1kKmRkZDsnN19kKmQvZGIqZGRkZGQvZEJkZGRkPDcyKjpkZGRkZGRkZGRkNmQ=', // 5
  'nYjpqj5CQUQ9wv+eknhwmZeWhAi2/5lUWX62truXCMHtdSGpkzc2OSsJz7hGpGs8AwMAHJ7uoTH9n3+IiIV6fPGsLf7dxtLSzaQ5tYYs/GhMUlFKR7VcKiz7MBxyijAW+jcvLPw0LrvZShj7NT4s/DMkn6M1G/s2JTD8NBE4NhYd+zodLYxudXR2dmqGOzomH4Syrq+xjiVJXmRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 6
  'LCI7QUNCQkJDQX0pmJuXmJaXlpUcUCe/ta6wsa7E+DYpED44MjMzMWXvUAVpW5iemwNjrWCjbqCK4v/6BJz3BsfInYTJ2cQ5jb8h0dKdibR8QsB4PrPwz52RqFII/G4J/v7OnZtzU1atXTni4K2doyxY0DVHf6GZb4asFFT5DkORhH5VW1hhdoo8Yoh2dVYwF4h1JHeGf21qW2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRNZGRkZGRkZGRkZD9kZGRkZGRkZGRkPGRkZGRkZGRkZGRKZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 7
  'VmJ4cVVEPjpAXYg2QFhXf3puamxiU1kmT2id1NXU07lxRxFhw21KVldTd7s+B2HtYRw2OiJd5T4FXedfEzI2IlvmUglJ0HQkKi0lVcqcIVltp6ipq6aIZ3Acm3hppqekp7d5PwlT1lkfLiMJT9ZCDlXcX0tuVw1L3EISWNNfKjcuEk/WRhs7notPT05MVJZbKzA3kMXIysaeSGRkTzRCZGRkZGRkZGRGSlFCKSQlZGQ3ZGRkZGRkZGQzZCVkWmQrZGRkZGRkH2QdZA1kZGRkN2QcZBhkDWRkYWQyZDRkK2QYZGRkZCZkZGQ+ZGRkZGRkZEpkZBNkZBQVExUpZCRkJ2QSZGFkZCpkImQhZBAuDhVkK2QnZCZkEWRJZGQyZEJkZGRkPTIuKjZkZGRkZGRkZGRkLWQ=', // 8
  'wcc8S1g+Pzo8bpewtTRhf395dHNHYcpyWHigy8rNyJpjpiGYk11JRktHqJGXBquhTnI2HhiuqZ8GpZxQr5taIbGphwWlmlCYt3smtKlNB6SbTzpRPyCwok1rWJSlcHl5bqmYU6WAZJTQ0M7F+qhDe4dPPEZFQkaymj1bSTIYDA0PFJmWT0sqMVlXWllWanZnQChFmcfHyMJ5RhIcFBlkZGRkZGRkCw8hZGRWMCgoZGQ2ImRkZGRkZGQfZGRkGGQpZGRkZCdkZGQKNA4bZGRkC2RkZAlADwtTZGQMZGRkCUUPETBkXw1kN2QJSA5kZGRkDGRIFTZkZBciJSIKV2QLEWQ5ZGRkSWQeSBVHZGRkZGRkFEJBLGRkZGRkZGQNZGRBXWQmLjQxOTA9ZFlkVixkZGRkFWQ=', // 9
  // position 2
  'ffoBGD8pLisycJJQ+ANOmJuenZ1AXSm3UYaytLS5sWxWBzvLgTNCMzY41IZwB/t8B6MtBgn8lbUI+3oL/KpDCfyTrgj7eA3/9JcL/JKmCPx3DP/9qgr7jKQL+XUL//2sDPuFhw37dQ/n6Y8R+YFWDvd7D5eUVhTzg0UT7nYSNjQkF+aJUCWEf35+f356kFRgRypytra2tq0/L2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 0
  'yXoxw3pBVn6gjYC5ehqNVkw4X451bqpkIzDAszROlJm+NXzFw+2yJzqsooMtVKCZw68fOMSpYlYsNxygsR80oqNa8OqpK6KyGwyKsIn+/McuoLEcQaV5af/9wC6hsBxtuoNV8O+7K6GrHWvJt2elqn4en6wfPYZ2R3d3UhmcqiEkZFgvb2lJGZenIiZrYC5fXUEbl5ceKjdVlyQNZBkjZGRDZGRkEw1kF2QmZDNMPTkMHE5kIipkQEJLKFQ1ZGRkJ2RWZGQ5NiEnUBckZDMuZBwLOSxkCSdkEyQjF2RkNUwJJ2RkHj8QZGRKOQkmZC5RGjJkZDo8CSRkDR8jEWRkZGQJIGQLKzwPZGRkZAohZBo+Sl5kZGRkCyBkTCopZGRkZGQNHmRfJCNkZGRkZAxXZGRkZBM=', // 1
  '9zAZgTxJUFN7o7H3KxE7MT9GVEV1le02V+Tn6OnlcE5qTqOOPkFHUFCwmTsIeItESwwEDdnSFhUZXvb0iA4M3MUI5dnn//XxsRXPvwz+/v7zfm6Ej3+Acf7+77YzIkfeYFK++PCaHuDwzxW1qQ6xZHKkY11aR5ONQE1LbqQVERdWSUpQEsGnKScqKSgoHAsVwO7Q29vb29mED2RkZGRkZGRkZGRkZGRkSjdEU2RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkUVxkZGRkZGRfZFFkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkNyZkMGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRTZGRkZGRkZGRkZGRYV1RYT2RkZGRkZGRkZGRkZGQ=', // 2
  '9jQMRxkcHyY6Ulj2MimYmZydmkc3R61qc7WytbeygFQxNqaZNTk4Nzy9rxcHST8JnWYFC9PQC3l5RAmKSQQL08oK6OaXBEc8Njatpy3/+6YMusDAuWNYsv78qwlnZWVjgnpkqK6EJjEtIBS3sg0zN05ncW9RFr24CxGHhDs9PS8btrMPLHaLgn+AfIGKaR5WOF66ubq3t1UrPmRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 3
  '9i477ldPSCgmO1T7pGVlj1MrnT0tS/74uUuCZ272WCtI/v7wq0p81PhTKkX//L1Yr4No+FIpR/uodn+iOw/3VSdPzGduvy4IGPhSHUVIo59LBwcc+EoNJA3O5Z+mo6X9u2EUC4K0rLavtv3MZgoJJTY0ODZB+GMfBVFOSEVJHhv3QQs3aWNbVlojIvhIC0teWVBLUB8ZxzgPTGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 4
  'TkdDREJCRkdHRk8mGStSVE9UTlFQVm0NOtfd3N7e3t7eYQc43Ko/TE9PVF1aBzbbgAMFBQcXOFwEONukMC8wMSk5ZQUt0uvq7Orry1aQFmtzdn59eXyOn3M6228RDxEPBzPTUzTh15gtrsSPM85TE0tOc25wbDcxzlQLJ05OTiUfDzbMWhIrrKE+Ozc2QaBpHC40gdTR0dC3VWRkZGRkZGRkZGRkZGRkKSomKyUmJSwwZChkZGRkZGRkZCdkIWQRZGRkZGRkI2QeZBBkZGRkZGQgZB1kZCIgHx5kZDtkMGRkZGRkZDJkZGReZGRkZGRkZGRkHFtkZGRkZGQpZDEpRDRkQy4WDi1kKmRkZDsnN19kKmQvZGIqZGRkZGQvZEJkZGRkPDcyKjpkZGRkZGRkZGRkNmQ=', // 5
  'gnvColxSRUM+j7x0dXd0g4iKey6Pq4BJX3aXmsexXLmuZSKHgGNiRjgmm4FEamRhNS8DE2GZezmbg6uSbmplZqV/P5ui0tbX1r59tnFZmlyGcVlZV5twXEmaOmlpWCMVmj50N5s9cpaSbFPBPHs3nD1qhntUQag7azqdPl1JLiAhnD1lOF1Xhn5lY1xsQl86IWCAobm7p2dtVmRkLGQ+WGRkZB4SK2NkZFlkZGQlMQxPZGRkTjhkXwtCEkpkNWQfHGRkWhsbTxhkMB0VZGQWCzdFCTEqZDMsMjUOJ1cIEmRkZGRkEWNkJglBFxtkZGRYZB9VCUUNJSBkZAlXEEkJSREXECgQDmQVTAlSECAhKS8MZBBTCVUOJWRkZAlkD2QkZGRkZFhhO2Q0ZGRAIGRkZGQSJWQ=', // 6
  'MSY7QEFAQUFCQXcriZCTk5KSkZEmVCyrqLG1tbPF80tAFjk2NTc3NWLbViBkVI+SkAldnWGeb5aB2u7oDpPfGca3lHu6z749h7ItzcKdgKx6SLZ0Savgv5iMrVoQ62kg7+S/kpN9X1adW0TYzqOSlDJYvjtSe5uadX6dG1LgGlOIeXxYWFNfcYQ/aIFsak80Gn9sMXh9eGhlWGRkZGRkZGRkZGRkZElkZGRkZGRkZGRkJ1JkZGRkZGQkHWRkZGRkZGRkKWQXZGRkZGRkZDpkZGRiZGQ1MGRkHCBkMGRkRGRkZGRcQ2QhZGRkZGRWZGRkNCFkZGRkZCJkHSkYImRkZFVkQWRkVCs4XURkZC1kZGRkZGRkQmRkGUY4ZGRkZGRkZGRkZGRkZGRkZGRkZFpkZGRkZGQ=', // 7
  'VmJ4cVVEPjpAXYg2QFhXf3puamxiU1kmT2id1NXU07lxRxFhw21KVldTd7s+B2HtYRw2OiJd5T4FXedfEzI2IlvmUglJ0HQkKi0lVcqcIVltp6ipq6aIZ3Acm3hppqekp7d5PwlT1lkfLiMJT9ZCDlXcX0tuVw1L3EISWNNfKjcuEk/WRhs7notPT05MVJZbKzA3kMXIysaeSGRkTzRCZGRkZGRkZGRGSlFCKSQlZGQ3ZGRkZGRkZGQzZCVkWmQrZGRkZGRkH2QdZA1kZGRkN2QcZBhkDWRkYWQyZDRkK2QYZGRkZCZkZGQ+ZGRkZGRkZEpkZBNkZBQVExUpZCRkJ2QSZGFkZCpkImQhZBAuDhVkK2QnZCZkEWRJZGQyZEJkZGRkPTIuKjZkZGRkZGRkZGRkLWQ=', // 8
  '//gCFz8pLi0xcJD/+AdOmJuenZ1BXe2eVIiztLS4sWtWuCvNhDRDNDk30oahCPx8CKQuBQn7lawJ+3sL/bdMC/yUhgf7ewzX3XcM/JIqCvp9CUpOLgz7iS+ke4empqWjmvt8PvVBcLe4ubSn/HgltGhDODk7ODvteh2CMhoPDw8QGOGFOmsPQoR9fn55kFVeWxBhwLe5ua5AMmRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 9
  // position 3+
  'srarlHRiWlpvosuRk4BZVDkqLUttmWdqUUTu6urq66lPPTyFumNmaGRgkcMYG6TxGDVDPSiO8gkKk/UdTmNSM5X2CAqT9SNje2M9mvZiCYz1J2yFaEGc9r8JivYnboZoP5v2CAiH9R9cb1k0kvU8D4bsF4nRqSWE9FMOgugReL2cGXvzDxB+1xsbHBobeuEUKCxXytjW1NSCMWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ5ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 0
  'U1ZgZmA+ND1efIpMRz80Mn2ELFN0hEk1TXJd39EmTm9+RSN23cr81CNLbHpHHj5pZ9fUIEdodlA8Lx8Vx9gcQ2NxR1RPNBzL1hg+XGklRkw1GcjTFThUWhOYuo0RwtAOL0ROCYqshA3DywtOamcEJS4mEcHFEYKqiTUxMywWvL8MNkY6SkFEOhW8wg0XHR5LQEI3EJCXDzdGRGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 1
  'VFZWSzYuKSg0UXFKRTk2paKfnqFuREYyS329vr26uI1tRCB60kZJSURCi9BHG0ZwKS4vKBaN9VA6NztHRkA3G5D1RVVYVlNFNy1BmcskSVRSRCkbHr+gTxaavZgnbKWiiUgkC4iljVaQt7BaSFgFKTBTwmA6PYOlizkOV5xdJBAROk48TBCB63p7fHt6fGhMDWDPs7m6t7e4nGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 2
  'U19wZ0o6NDM7WoE9Q09OiYR7en1mT1YuU3SnzM3MyatuSxlpxmFLVFJLf8JGETRyMh81NR1s6UskJBoPFywsHGrqVDc6UDojNC4rZchtPF9MJW+wtK6KWU1yzIINOYeNkal/LGTAqWkzLyoLYNwpHjpOkpd/bQ9a4j8PQn1TVUI4ElrdTBtEnYleXVtdYY5ZLzI/m8TDw8KQPmRkVj1bZGRkZGRkZGReWUxILScrZGRiZGRkZGRkZGQ8ZD9kZGQpZGRkZGRkOGRkZCZkZGRkPmQ2ZGRkZGRkZGQyZGNfZFkrZGRkZCZkIWRkZGQbZGRkZGQ7HGRkZGQiFxgvZDkmRzAzZGRkZDNkLmRkZEUuFhtkM2REZFYnZGRkZGQ9ZGRkZGRkRDw6NUdkZGRkZGRkZGRkMmQ=', // 3
  'VmWFlJeYlIVoVVs2THqOjYh3XXhmMGBGfpKKeGFkk8NIVT53hXhkYantxTtKNY9xV32Xhd/GO0ozoW9zcrFJiMk6WyA+QpeiOAyEyjidEkGQbk0FB3/GLXYJTemzV1ZRl+Z7SAczwNbX19P58cdEChI3RkRERKPJYEEcKxwJCAkPc7oqRyZWTjo3NRx5vy9bLEdCPUA2EmOvMGRkYEpfZFBARlZkZGRkP1RZTUxkZGRMZGQrMTtkZBA5PTFkZC0oRGQ+ZC9kMGQnNT9kZGRkMWQpZA8lZC4aIwo4ZEdkZGQuE1JkCTpdZGQmKVwkZGQKMGRkZB5kZBYUFw1kZB9kWGRLWllIZGQsI2RkZGRkZGQlNjUuZGRkZGRkZA0nZEJkZGRkZGRkDCpkZGRkZGRkZGQaHGQ=', // 4
  'TkdDREJCRkdHRk8mGStSVE9UTlFQVm0NOtfd3N7e3t7eYQc43Ko/TE9PVF1aBzbbgAMFBQcXOFwEONukMC8wMSk5ZQUt0uvq7Orry1aQFmtzdn59eXyOn3M6228RDxEPBzPTUzTh15gtrsSPM85TE0tOc25wbDcxzlQLJ05OTiUfDzbMWhIrrKE+Ozc2QaBpHC40gdTR0dC3VWRkZGRkZGRkZGRkZGRkKSomKyUmJSwwZChkZGRkZGRkZCdkIWQRZGRkZGRkI2QeZBBkZGRkZGQgZB1kZCIgHx5kZDtkMGRkZGRkZDJkZGReZGRkZGRkZGRkHFtkZGRkZGQpZDEpRDRkQy4WDi1kKmRkZDsnN19kKmQvZGIqZGRkZGQvZEJkZGRkPDcyKjpkZGRkZGRkZGRkNmQ=', // 5
  'WWmIlYlpS0FAQ1g2S3V6Y3F3bWhTLls4Z2hncdnX261PTiNUZKWkWktSTi9DE1mZgnIHBQYZQUYIWuyhR0NHRjM7WgdL5N3f5OTkuVGdCEreoGZwb3SNp3UHSdxcDBAVCEncSQpL2V0poKprRtZHDEzUYUCDeS1C1EgPTc9jIy8lD0LRSBY0n4xLRkZETJdYJCs1j8jKzMqiSGRkWkZQMGNkZGRkZGRXOElkSjErZGRPZDotZC9kZGQcQSZkVmQyIGRkZGRkIGRkZGQRZGRkZGQdZCRkXiMcGx5kZDVkHWRkZGRkZChkZGQdZBBkZGRkZGRkZB9kD2RkZGQlZCJkIGQPZCYTDCtkImQlZBElIF5kKWQlZCZkEWRkZGQyZDdkZGRkUTs0MEdkZGRkZGRkZGRkI1s=', // 6
  'VUA1Nzc2NTY5PUY3Fz9xb21tbnFydVYPRMrV1dTOzO30QxAiTltZU0lDf+w8I0k0QDowHmh1fUI3m2pcW0gnrcM4UzNKfo9eUUyJsUGgOW1rd2pVoGthQ3Fo1ZdPaELReBtLPFXMwFomSZuNO1k4HmNcMWKkV3CgozolUEMec9M/Jm5uQjJKRVlblEoXFRlVNjQkj4I3QUE/QGRkZGRkZGRkZGRkZGRXJCEhISMmKCs2ZEJkZGRkZGRkZClkZGRkZGRkZDZkKWRkZGRkZGQcUmQnZBdkZGRkZA1kZFFWSmQaZFFkEydVZERkZDkVZEJkNmRkGGRkZApkRAxkZDQoRz4hZCdkE2RkMmQaHlAXZGBkZGQ1ZGRkZBNkJ2Q5IEhkZGRQLS05ZGRkZGRkZEcbZGRkZGQ=', // 7
  'VmJ4cVVEPjpAXYg2QFhXf3puamxiU1kmT2id1NXU07lxRxFhw21KVldTd7s+B2HtYRw2OiJd5T4FXedfEzI2IlvmUglJ0HQkKi0lVcqcIVltp6ipq6aIZ3Acm3hppqekp7d5PwlT1lkfLiMJT9ZCDlXcX0tuVw1L3EISWNNfKjcuEk/WRhs7notPT05MVJZbKzA3kMXIysaeSGRkTzRCZGRkZGRkZGRGSlFCKSQlZGQ3ZGRkZGRkZGQzZCVkWmQrZGRkZGRkH2QdZA1kZGRkN2QcZBhkDWRkYWQyZDRkK2QYZGRkZCZkZGQ+ZGRkZGRkZEpkZBNkZBQVExUpZCRkJ2QSZGFkZCpkImQhZBAuDhVkK2QnZCZkEWRJZGQyZEJkZGRkPTIuKjZkZGRkZGRkZGRkLWQ=', // 8
  'U26lqIZjXlNQaqIhPIWEU001KylSaIoiXlt+9PLy8u97hRA3r6dTZmlkXqSEAhjizRhGTDMhzYYAC9fLIWd0SSrPiQEJ08ondIJWMdGMAwnTzR9XXkYq0IUEGKyjDygsHhTKeBXzTVb7+vz8+P16FL9kQ15YVVpI03cUdF0qBggNDhezdRBbEg0SGRYYJrJ1DlESUuXf4uXgamRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ=', // 9
];
const decode = (b64: string): Glyph => {
  const b = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), n = TW * TH;
  return { mean: Array.from(b.subarray(0, n)), w: Array.from(b.subarray(n, 2 * n), v => v / 100) };
};
export const GLYPHS: Glyphs = [0, 1, 2].map(ps => RAW.slice(ps * 10, ps * 10 + 10).map(decode));
