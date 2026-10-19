import type { Region } from './config';
import { frameSize, type FrameSource } from './imaging';

/**
 * Watches the count printed on one quickslot slot without reading it. Reading those tiny outlined digits proved
 * unreliable (they sit on every kind of potion picture, and no reader got them right everywhere), but noticing that
 * they changed is easy: the slot's picture stays put and only the digits move. Each potion drunk changes its slot's
 * count, at the moment the HP / MP gauge rises, so the tracker pairs the two (Tracker.onSlotChange): the change says
 * which potion, the rise says it really was drunk (and how many).
 */

/** the slot is resampled to this many px (about a slot at 1080p), whatever the capture size */
export const SW = 50, SH = 47;
/** the count's strip: the slot's lower part, where the digits are drawn */
const STRIP_Y0 = 20;
/** a pixel has changed when its brightness moved this much; a count changed when at least this many pixels did */
const PIX_DIFF = 60, MIN_PIXELS = 12;
/** a new picture must hold for this many reads in a row (a cursor or tooltip passing over is not a change) */
const HOLD = 2;

/** The lower strip of slot `i` (row by row, brightest channel), resampled to SW px wide. */
export function slotStrip(src: FrameSource, r: Region, i: number, cols: number, rows: number, scratch = document.createElement('canvas')): Float32Array {
  const { W, H } = frameSize(src);
  const sw = r.w * W / cols, sh = r.h * H / rows, sx = r.x * W + (i % cols) * sw, sy = r.y * H + Math.floor(i / cols) * sh;
  scratch.width = SW; scratch.height = SH;
  const g = scratch.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, SW, SH);
  const d = g.getImageData(0, STRIP_Y0, SW, SH - STRIP_Y0).data, out = new Float32Array(SW * (SH - STRIP_Y0));
  // the brightest channel: the white digits and their black outline differ most in it on any potion colour
  for (let p = 0, q = 0; q < out.length; p += 4, q++) out[q] = Math.max(d[p], d[p + 1], d[p + 2]);
  return out;
}

/** How many pixels differ clearly between two strips. */
export function changedPixels(a: Float32Array, b: Float32Array): number {
  let n = 0;
  for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) >= PIX_DIFF) n++;
  return n;
}

export class SlotWatch {
  /** the settled picture of the slot */
  private base: Float32Array | null = null;
  private cand: Float32Array | null = null;
  private candAt = 0;
  private candN = 0;
  /** when the slot was last read */
  at = 0;
  /** changes seen this session (for the Potions tab) */
  changes = 0;

  /** Feed one read; returns when the count changed (the first read that showed it), or null. */
  feed(strip: Float32Array, now: number): number | null {
    this.at = now;
    if (!this.base) { this.base = strip; return null; }
    if (changedPixels(strip, this.base) < MIN_PIXELS) { this.cand = null; this.candN = 0; return null; }
    if (this.cand && changedPixels(strip, this.cand) < MIN_PIXELS) {
      if (++this.candN < HOLD) return null;
      this.base = this.cand; this.cand = null; this.candN = 0; this.changes++;
      return this.candAt;
    }
    this.cand = strip; this.candAt = now; this.candN = 1;
    return null;
  }

  /** Has it been read lately (the slot is being watched)? */
  live(now: number) { return !!this.base && now - this.at < 5000; }
}
