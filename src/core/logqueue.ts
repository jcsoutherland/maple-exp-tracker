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
}

export function snapLine(lo: LogScan, hi: LogScan | null, [a, z]: [number, number], t: number, yellow = false): LineSnap {
  return { lo: lo.sc.slice(a * lo.W, z * lo.W), hi: hi ? hi.sc.slice(a * hi.W, z * hi.W) : null, W: lo.W, h: z - a, f: lo.f, t, yellow };
}

/** How much text a snapshot holds (ink pixels), and a hash of its ink pattern: equal hashes read the same. */
export function snapInk(s: LineSnap): { ink: number; hash: number } {
  let ink = 0, h = 2166136261;
  for (let i = 0; i < s.lo.length; i++) { const on = s.lo[i] > 0 ? 1 : 0; ink += on; h = Math.imul(h ^ on, 16777619); }
  return { ink, hash: h >>> 0 };
}

/** Where a snapshot's text starts and ends across the line, as fractions of the log width (null = no text). */
export function snapExtent(s: LineSnap): { x0: number; x1: number } | null {
  // strong text pixels only (≥ 2 per column): faint scenery behind the log would otherwise stretch every line
  const { W, h, lo } = s, col = (x: number) => { let n = 0; for (let y = 0; y < h; y++) if (lo[y * W + x] > 40 && ++n >= 2) return true; return false; };
  let x0 = 0, x1 = W - 1;
  while (x0 < W && !col(x0)) x0++;
  while (x1 > x0 && !col(x1)) x1--;
  return x0 < W ? { x0: x0 / W, x1: x1 / W } : null;
}

/**
 * Tells real pickup-log lines from things moving behind the log (players, monsters, scenery), which the line watcher
 * also sees as "new lines" and which used to swamp the OCR readers in a party. Log lines are right-aligned and long:
 * a snapshot must span ≥ 30% of the log's width, and once the right edge of real lines is known (learned from lines that
 * read correctly), end within 1.2% of it (every line ends on the same pixel; a monster behind the log doesn't).
 */
export class LineShapeFilter {
  private edges: number[] = [];
  /** the learned right edge (median of real lines' ends), once there are enough */
  get edge() { if (this.edges.length < 5) return null; const e = [...this.edges].sort((a, b) => a - b); return e[e.length >> 1]; }
  isJunk(s: LineSnap): boolean {
    const x = snapExtent(s);
    if (!x || x.x1 - x.x0 < 0.3) return true;
    const e = this.edge;
    return e != null && Math.abs(x.x1 - e) > 0.012;
  }
  /** Remember where a line that read as a real log line ends. */
  learn(s: LineSnap) {
    const x = snapExtent(s);
    if (!x) return;
    this.edges.push(x.x1);
    if (this.edges.length > 30) this.edges.shift();
  }
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
