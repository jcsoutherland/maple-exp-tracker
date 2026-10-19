import { logLineCanvas, type LogScan } from './imaging';

/**
 * Pickup-log snapshots. Spotting a new log line costs ~3 ms but reading it takes 100–300 ms, and in a party the log
 * scrolls faster than that. So a line is copied out of the frame the moment it appears (its text-likeness rows only:
 * ~11 KB) and read later from a short queue; nothing is lost while the reader is busy. Snapshots are dropped once
 * read, or after a few seconds / beyond a small cap, so memory stays tiny.
 */
export interface LineSnap {
  /** text-likeness rows of the line, from the normal and the high-contrast scan */
  lo: Float32Array;
  hi: Float32Array | null;
  W: number; h: number; f: number;
  t: number;
  /** yellow text: an EXP line, skipped without reading */
  yellow?: boolean;
  /** the line's raw RGBA pixels (W × rgbH, with a small margin above and below), which the neural reader reads best */
  rgb?: Uint8ClampedArray | null;
  rgbH?: number;
  /** the raw pixels' top-left on the screen, and screen pixels per native HUD pixel */
  ox?: number; oy?: number; k?: number;
}

export function snapLine(lo: LogScan, hi: LogScan | null, [a, z]: [number, number], t: number, yellow = false): LineSnap {
  // the raw pixels keep ~2px (at 720p) of margin above and below: the neural reader likes a little room around the text
  const m = Math.round(2 * lo.f), ra = Math.max(0, a - m), rz = Math.min(lo.H, z + m);
  return { lo: lo.sc.slice(a * lo.W, z * lo.W), hi: hi ? hi.sc.slice(a * hi.W, z * hi.W) : null, W: lo.W, h: z - a, f: lo.f, t, yellow,
    rgb: yellow || !lo.rgba ? null : lo.rgba.slice(ra * lo.W * 4, rz * lo.W * 4), rgbH: rz - ra,
    ox: lo.X, oy: lo.Y == null ? undefined : lo.Y + ra, k: lo.k };
}

/** The snapshot's original pixels as a canvas, optionally only columns x0..x1 (fractions of its width). */
export function snapRaw(s: LineSnap, x0 = 0, x1 = 1): HTMLCanvasElement | null {
  const h = s.rgbH ?? s.h;
  if (!s.rgb || !h) return null;
  const full = document.createElement('canvas');
  full.width = s.W; full.height = h;
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.rgb), s.W, h), 0, 0);
  if (x0 <= 0 && x1 >= 1) return full;
  const a = Math.floor(x0 * s.W), b = Math.max(a + 4, Math.ceil(x1 * s.W)), c = document.createElement('canvas');
  c.width = b - a; c.height = h;
  c.getContext('2d')!.drawImage(full, a, 0, b - a, h, 0, 0, b - a, h);
  return c;
}

/**
 * The line's text alone, as black on white, by its drop shadow: the game draws every log glyph with a darker copy one
 * pixel down-right, so a text pixel is bright and clearly brighter than the pixel below / down-right of it. That holds
 * on any background, which plain colour reading can't manage on bright maps (white text on sand or sky). Upscaled 3×
 * with a white margin for the reader. Takes snapRaw's output (pixels at their on-screen size).
 */
export function shadowText(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width, h = src.height, d = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) L[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  const ink = document.createElement('canvas'); ink.width = w; ink.height = h;
  const g = ink.getContext('2d')!, im = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, below = y + 1 < h ? Math.min(L[p + w], x + 1 < w ? L[p + w + 1] : 255) : 255;
    const on = L[p] > SHADOW_MIN_L && L[p] - below > SHADOW_STEP;
    const o = p * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = on ? 0 : 255; im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const z = 3, m = 6, out = document.createElement('canvas'); out.width = w * z + 2 * m; out.height = h * z + 2 * m;
  const og = out.getContext('2d')!; og.fillStyle = '#fff'; og.fillRect(0, 0, out.width, out.height);
  og.imageSmoothingEnabled = false; og.drawImage(ink, m, m, w * z, h * z);
  return out;
}
/** a glyph pixel is at least this bright, and this much brighter than its shadow pixel */
const SHADOW_MIN_L = 150, SHADOW_STEP = 45;

/** How much text a snapshot holds (ink pixels), and a hash of its ink pattern: equal hashes read the same. */
export function snapInk(s: LineSnap): { ink: number; hash: number } {
  let ink = 0, h = 2166136261;
  for (let i = 0; i < s.lo.length; i++) { const on = s.lo[i] > 0 ? 1 : 0; ink += on; h = Math.imul(h ^ on, 16777619); }
  return { ink, hash: h >>> 0 };
}

/** Where a snapshot's text starts and ends across the line, as fractions of the log width (null = no text). */
/** A column holds strong text pixels (≥ 2): faint scenery behind the log would otherwise count as text. */
const strongCol = (s: LineSnap, x: number) => { let n = 0; for (let y = 0; y < s.h; y++) if (s.lo[y * s.W + x] > 40 && ++n >= 2) return true; return false; };

export function snapExtent(s: LineSnap): { x0: number; x1: number } | null {
  const { W } = s, col = (x: number) => strongCol(s, x);
  let x0 = 0, x1 = W - 1;
  while (x0 < W && !col(x0)) x0++;
  while (x1 > x0 && !col(x1)) x1--;
  return x0 < W ? { x0: x0 / W, x1: x1 / W } : null;
}

/**
 * Tells real pickup-log lines from things moving behind the log (players, monsters, scenery), which the line watcher
 * also sees as "new lines" and which used to swamp the OCR readers in a party. Log lines are right-aligned and long:
 * a snapshot must span ≥ 30% of the log's width, and once the right edge of real lines is known (learned from lines that
 * read correctly), have text right at that edge (every line ends on the same pixel with its ")"; a monster standing in
 * the middle of the log doesn't). Clutter beyond the edge (a ladder, an HP bar) doesn't matter.
 */
export class LineShapeFilter {
  private edges: number[] = [];
  /** the learned right edge (median of real lines' ends, a fraction of the width), once there are enough */
  get edge() { if (this.edges.length < 5) return null; const e = [...this.edges].sort((a, b) => a - b); return e[e.length >> 1]; }
  isJunk(s: LineSnap): boolean {
    const x = snapExtent(s);
    if (!x || x.x1 - x.x0 < 0.3) return true;
    const e = this.edge;
    if (e == null) return false;
    const a = Math.max(0, Math.floor((e - 0.025) * s.W)), b = Math.min(s.W - 1, Math.ceil((e + 0.012) * s.W));
    for (let c = a; c <= b; c++) if (strongCol(s, c)) return false;
    return true;
  }
  /** Remember where a line that read as a real log line ends. */
  learn(s: LineSnap) {
    const x = snapExtent(s);
    if (!x) return;
    this.edges.push(x.x1);
    if (this.edges.length > 30) this.edges.shift();
  }
}

/**
 * Where the pickup log's newest line sits (its bottom row in the log region). It never moves, but per-frame detection
 * jitters by a few pixels (letters like y, p and ")" reach lower) and is now and then fooled by something below the
 * log. So the anchor is learned from many frames: the main cluster of detections, taken at its lower end (so letters
 * that reach lower still fit). Learned again when the region or the capture size changes.
 */
export class LogAnchor {
  private seen: number[] = [];
  private size = '';
  value: number | null = null;
  add(b: number | undefined, size: string) {
    if (size !== this.size) { this.seen = []; this.value = null; this.size = size; }
    if (b == null || b <= 0) return;
    this.seen.push(b);
    if (this.seen.length > 300) this.seen.shift();
    if (this.seen.length >= 30 && this.seen.length % 10 === 0) this.value = anchorOf(this.seen);
  }
}

/** The anchor from a set of detections: the most common value's cluster (±6 px), at its 90th percentile. */
export function anchorOf(v: number[]): number {
  const count = new Map<number, number>();
  for (const x of v) count.set(x, (count.get(x) || 0) + 1);
  const mode = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const near = v.filter(x => Math.abs(x - mode) <= 6).sort((a, b) => a - b);
  return near[Math.min(near.length - 1, Math.floor(near.length * 0.9))];
}

/** The OCR image of a snapshot (high-contrast version on request). */
export function snapCanvas(s: LineSnap, high = false): HTMLCanvasElement {
  const sc = high && s.hi ? s.hi : s.lo;
  return logLineCanvas({ W: s.W, H: s.h, f: s.f, sc, slots: [] }, [0, s.h]);
}

/** The line's ink mask from its first to its last text column (null when there's hardly any text). */
function shape(s: LineSnap) {
  const { W, h, lo } = s, col = (x: number) => { let n = 0; for (let y = 0; y < h; y++) if (lo[y * W + x] > 0) n++; return n; };
  let x0 = 0, x1 = W - 1;
  while (x0 < W && col(x0) < 1) x0++;
  while (x1 > x0 && col(x1) < 1) x1--;
  const w = x1 - x0 + 1;
  if (w < 20 * s.f) return null;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = lo[y * W + x0 + x] > 0 ? 1 : 0;
  return { m, w, h, f: s.f };
}
type Shape = NonNullable<ReturnType<typeof shape>>;

/**
 * Skips EXP lines without reading them (the EXP bar already counts EXP exactly). EXP lines all share the same words —
 * only the number at the end changes — so their ink outline is nearly identical. The shape is learned from lines the
 * OCR has read (EXP and not), and a line is skipped only when it matches a known EXP line clearly better than any
 * known meso / item line.
 */
export class ExpLineFilter {
  private exp: Shape[] = [];
  private other: Shape[] = [];

  /** overlap of two line shapes, ignoring the last ~24px (where the amount differs) */
  private static similar(a: Shape, b: Shape): number {
    if (a.h !== b.h || Math.abs(a.w - b.w) > 24 * a.f) return 0;
    const w = Math.min(a.w, b.w) - Math.round(24 * a.f);
    if (w < 16) return 0;
    let both = 0, any = 0;
    for (let y = 0; y < a.h; y++) for (let x = 0; x < w; x++) {
      const p = a.m[y * a.w + x], q = b.m[y * b.w + x];
      if (p && q) both++;
      if (p || q) any++;
    }
    return any ? both / any : 0;
  }

  isExp(s: LineSnap): boolean {
    const sh = shape(s);
    if (!sh || !this.exp.length) return false;
    const e = Math.max(...this.exp.map(p => ExpLineFilter.similar(sh, p)));
    const o = this.other.length ? Math.max(...this.other.map(p => ExpLineFilter.similar(sh, p))) : 0;
    return e >= 0.7 && e >= o + 0.1;
  }

  /** Remember what a read line turned out to be. */
  learn(s: LineSnap, isExp: boolean) {
    const sh = shape(s);
    if (!sh) return;
    const list = isExp ? this.exp : this.other;
    list.push(sh);
    if (list.length > 8) list.shift();
  }
}
