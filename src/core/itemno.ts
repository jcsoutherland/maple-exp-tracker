import type { Region } from './config';
import SPRITES from './data/itemno.json';
import { frameSize, type FrameSource } from './imaging';

/**
 * Reads a quickslot count with the game's own digit pictures (UI.wz Basic.img/ItemNo 0–9, decoded by
 * dev/build-itemno.mjs): white strokes with a black outline, drawn unscaled at the Ideal UI ratio. There every digit on
 * screen is an exact copy of its sprite, so a match is near perfect and 0 / 8 or 9 / 0 can't be confused the way the
 * templates learned from Default-ratio video can. It cross-checks potcount.ts (see crossRead), as the font matcher does
 * for the pickup log.
 */

interface Sprite { w: number; h: number; v: number[]; a: number[] }
const DIGITS = SPRITES as Sprite[];
/** each sprite's opaque pixels: offsets and brightness */
const PTS = DIGITS.map(s => {
  const p: { x: number; y: number; v: number }[] = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.a[y * s.w + x] >= 128) p.push({ x, y, v: s.v[y * s.w + x] });
  return p;
});
const SH = DIGITS[0].h;

/** a digit matches at this correlation or better; a whole count needs every digit to */
export const SPRITE_MIN = 0.75;
/** how far each digit's left edge is from the previous one's right edge (the outlines may touch or overlap) */
const GAP = [-2, -1, 0, 1];

interface Pic { g: Float32Array; w: number; h: number }

/** The slot cell plus a margin, at the HUD's native size (1 px = 1 game px), brightest channel. */
function nativeCell(src: FrameSource, r: Region, i: number, cols: number, rows: number, scale: number, scratch: HTMLCanvasElement, M = 3): Pic {
  const { W, H } = frameSize(src), cw = r.w * W / cols, ch = r.h * H / rows;
  const fx = r.x * W + (i % cols) * cw, fy = r.y * H + Math.floor(i / cols) * ch;
  // whole pixels: at the Ideal ratio (scale 1) the digits are copied 1:1, so no resampling blurs their 1-px strokes
  const x0 = Math.round(fx - M * scale), y0 = Math.round(fy - M * scale);
  const w = Math.round(cw / scale) + 2 * M, h = Math.round(ch / scale) + 2 * M;
  scratch.width = w; scratch.height = h;
  const g = scratch.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = scale !== 1; g.imageSmoothingQuality = 'high';
  g.drawImage(src, x0, y0, w * scale, h * scale, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let p = 0, q = 0; q < out.length; p += 4, q++) out[q] = Math.max(d[p], d[p + 1], d[p + 2]);
  return { g: out, w, h };
}

/** Correlation of digit `d`'s sprite with the picture at (x, y), over the sprite's opaque pixels. */
function score(pic: Pic, d: number, x: number, y: number) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (const p of PTS[d]) {
    const X = x + p.x, Y = y + p.y;
    if (X < 0 || Y < 0 || X >= pic.w || Y >= pic.h) return -1;
    const a = p.v, b = pic.g[Y * pic.w + X];
    n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : 0;
}

function bestAt(pic: Pic, xs: number[], ys: number[]) {
  let best: { d: number; s: number; x: number; y: number } | null = null;
  for (const y of ys) for (const x of xs) for (let d = 0; d < 10; d++) {
    const s = score(pic, d, x, y);
    if (!best || s > best.s) best = { d, s, x, y };
  }
  return best;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

/** The count on one slot read with the game's sprites, or null. `scale` = screen px per game px (hudScale). */
export function readSlotSprite(src: FrameSource, r: Region, i: number, cols: number, rows: number, scale = 1, scratch = document.createElement('canvas')) {
  const M = 8, pic = nativeCell(src, r, i, cols, rows, scale, scratch, M);
  // the count sits at the slot's bottom-left: its first digit within a few px of the left edge, its bottom near the
  // slot's bottom
  const ch = pic.h - 2 * M;
  const first = bestAt(pic, range(M - 6, M + 12), range(M + ch - SH - 9, M + ch - SH + 5));
  if (!first || first.s < SPRITE_MIN) return null;
  // the best spot can be a later digit (the box a few px off): take in any digits just left of it too
  let left = first, min = first.s;
  const digits = [first.d];
  while (digits.length < 4) {
    let b: ReturnType<typeof bestAt> = null;
    for (let d = 0; d < 10; d++) for (const g of GAP) {
      const x = left.x - g - DIGITS[d].w, s = score(pic, d, x, left.y);
      if (!b || s > b.s) b = { d, s, x, y: left.y };
    }
    if (!b || b.s < SPRITE_MIN) break;
    digits.unshift(b.d); min = Math.min(min, b.s); left = b;
  }
  if (digits[0] === 0) return null; // counts never start with 0
  let x = first.x + DIGITS[first.d].w;
  while (digits.length < 4) {
    const b = bestAt(pic, GAP.map(g => x + g), [first.y]);
    if (!b || b.s < SPRITE_MIN) break;
    digits.push(b.d); min = Math.min(min, b.s);
    x = b.x + DIGITS[b.d].w;
  }
  return { value: +digits.join(''), score: min, digits: digits.length };
}

type Read = { value: number; score: number } | null;
/**
 * One count from two readers: the learned templates (potcount.ts) and the game's sprites. Agreeing, it's certain.
 * Disagreeing, the sprites win where they're exact (the Ideal ratio, `exact`) and match well; otherwise the templates,
 * which were learned from scaled (Default-ratio) video. Either alone stands as it is.
 */
export function crossRead(tpl: Read, spr: Read, exact: boolean): Read {
  if (!spr) return tpl;
  if (!tpl) return exact && spr.score >= 0.85 ? spr : null;
  if (tpl.value === spr.value) return { value: tpl.value, score: Math.max(tpl.score, spr.score) };
  return exact && spr.score >= 0.85 ? spr : tpl;
}
