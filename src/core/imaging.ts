import type { Region, RegionDef } from './config';
import type { OcrChar } from './ocr/engine';

/** Anything we can crop from: the live <video>, a canvas, or an ImageBitmap. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

export function frameSize(src: FrameSource) {
  if (src instanceof HTMLVideoElement) return { W: src.videoWidth, H: src.videoHeight };
  return { W: src.width, H: src.height };
}

const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;
const fnv = (h: number, v: number) => Math.imul(h ^ v, 16777619);

/**
 * Crop a status-bar region, upscale it so the text is ~def.px tall, and binarise it to black text on white
 * (Tesseract's preferred input). `hash` changes only when the binarised text changes, so unchanged regions skip OCR.
 */
export function prepRegion(src: FrameSource, r: Region, def: RegionDef, out = document.createElement('canvas')) {
  const { W, H } = frameSize(src), pad = 8;
  const sc = Math.max(2, Math.min(8, def.px / (r.h * H)));
  const sx = r.x * W, sy = r.y * H, sw = Math.max(1, r.w * W), sh = Math.max(1, r.h * H);
  out.width = Math.round(sw * sc) + pad * 2;
  out.height = Math.round(sh * sc) + pad * 2;
  const g = ctx2d(out);
  g.fillStyle = '#000';
  g.fillRect(0, 0, out.width, out.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, sx, sy, sw, sh, pad, pad, out.width - pad * 2, out.height - pad * 2);
  const im = g.getImageData(0, 0, out.width, out.height), d = im.data;
  let hash = 2166136261, ink = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const on = def.mode === 'luma' ? 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > r.thr : Math.min(d[i], d[i + 1], d[i + 2]) > r.thr;
    const v = on ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    if (on) ink++;
    if ((p & 7) === 0) hash = fnv(hash, v);
  }
  g.putImageData(im, 0, 0);
  return { canvas: out, hash: hash >>> 0, ink };
}

/**
 * "Zoom and enhance" for small UI text (the status-bar name): a smooth `scale`× upscale, then an Otsu threshold so
 * the gaps between thin letters survive ("nn" no longer merges into "rii"). Dark text on white, padded, plus the ink
 * mask for glyph checks.
 */
export function enhanceText(src: FrameSource, r: Region, scale = 6, out = document.createElement('canvas')) {
  const { W, H } = frameSize(src), pad = 12;
  const sw = Math.max(1, Math.round(r.w * W)), sh = Math.max(1, Math.round(r.h * H));
  const w = sw * scale + pad * 2, h = sh * scale + pad * 2;
  out.width = w; out.height = h;
  const g = ctx2d(out);
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, r.x * W, r.y * H, sw, sh, pad, pad, sw * scale, sh * scale);
  const im = g.getImageData(0, 0, w, h), d = im.data, L = new Uint8Array(w * h), hist = new Array(256).fill(0);
  for (let i = 0; i < L.length; i++) { L[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]); hist[L[i]]++; }
  // Otsu: the threshold that best splits text from background
  let sum = 0, sB = 0, wB = 0, best = -1, thr = r.thr;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = L.length - wB; if (!wF) break;
    sB += i * hist[i];
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; thr = i; }
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < L.length; i++) { const on = L[i] > thr; mask[i] = on ? 1 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = on ? 0 : 255; }
  g.putImageData(im, 0, 0);
  return { canvas: out, mask, w, h };
}

/**
 * OCR often swaps i and l in this pixel font ("Flynny" → "Fiynny"). Each i/l/| the OCR reports is checked against
 * the ink inside its box: one unbroken stroke reaching the height of the tallest letters is "l"; a shorter or dotted
 * (vertically split) stroke is "i". Returns the corrected text.
 */
export function fixIL(chars: OcrChar[], e: { mask: Uint8Array; w: number; h: number }): string {
  const { mask, w, h } = e;
  const inkRows = (c: OcrChar) => {
    const rows: boolean[] = [];
    for (let y = 0; y < h; y++) {
      let on = false;
      for (let x = Math.max(0, c.x0); x <= Math.min(w - 1, c.x1) && !on; x++) on = !!mask[y * w + x];
      rows.push(on);
    }
    return rows;
  };
  const letters = chars.filter(c => /[A-Za-z0-9]/.test(c.c));
  if (letters.length < 2) return chars.map(c => c.c).join('');
  const tops = letters.map(c => inkRows(c).indexOf(true)).filter(t => t >= 0);
  const ascender = Math.min(...tops), xTop = tops.slice().sort((p, q) => p - q)[tops.length >> 1];
  return chars.map((c, i) => {
    if (!'il|'.includes(c.c)) return c.c;
    // OCR boxes can overlap the next letter: only look between the neighbours' boxes
    const x0 = Math.max(c.x0, (chars[i - 1]?.x1 ?? -1) + 1), x1 = Math.min(c.x1, (chars[i + 1]?.x0 ?? w) - 1);
    const rows = inkRows(x1 >= x0 ? { ...c, x0, x1 } : c), top = rows.indexOf(true), bottom = rows.lastIndexOf(true);
    if (top < 0) return c.c;
    for (let y = top; y <= bottom; y++) if (!rows[y]) return 'i'; // dotted
    return top <= ascender + (xTop - ascender) * 0.35 ? 'l' : 'i';
  }).join('');
}

/** Cheap pixel signature of a region (16-level luma on a coarse grid): detects "did this change" without OCR. */
export function regionSignature(src: FrameSource, r: Region, scratch = document.createElement('canvas')): number {
  const { W, H } = frameSize(src);
  scratch.width = 48; scratch.height = 8;
  const g = ctx2d(scratch);
  g.drawImage(src, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, 48, 8);
  const d = g.getImageData(0, 0, 48, 8).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) h = fnv(h, (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) >> 4);
  return h >>> 0;
}

export interface LogScan {
  W: number; H: number; f: number;
  /** per-pixel "text-likeness" score (0 = background) */
  sc: Float32Array;
  /** line slots [top, bottom) bottom-up: slots[0] is the newest line */
  slots: [number, number][];
}

/**
 * The pickup log is ~9px semi-transparent text over the game scene. Score each pixel as "bright, greyish and brighter
 * than its neighbourhood", then cut line slots on the log's fixed 13px (at 720p) grid counted up from the newest line.
 */
export function logScan(src: FrameSource, r: Region, thr: number, scratch = document.createElement('canvas')): LogScan {
  const { W: W0, H: H0 } = frameSize(src), f = H0 / 720;
  const X = Math.round(r.x * W0), Y = Math.round(r.y * H0), W = Math.max(8, Math.round(r.w * W0)), H = Math.max(8, Math.round(r.h * H0));
  scratch.width = W; scratch.height = H;
  const g = ctx2d(scratch);
  g.drawImage(src, X, Y, W, H, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, n = W * H, L = new Float32Array(n), SA = new Uint8Array(n);
  const W1 = W + 1, I = new Float64Array(W1 * (H + 1)), R = Math.max(2, Math.round(4 * f));
  for (let p = 0; p < n; p++) {
    const a = d[p * 4], b = d[p * 4 + 1], c = d[p * 4 + 2];
    L[p] = 0.299 * a + 0.587 * b + 0.114 * c;
    SA[p] = Math.max(a, b, c) - Math.min(a, b, c);
  }
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += L[y * W + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s; } }
  const sc = new Float32Array(n), rows = new Uint16Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (L[p] <= thr) continue;
    const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    const mean = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
    const v = (L[p] - mean) * (SA[p] < 45 ? 1 : 0.3);
    if (v > 0) { sc[p] = v; if (v > 15) rows[y]++; }
  }
  // newest line = lowest band of text rows; slots stack upward from it
  let bottom = -1;
  for (let y = H - 1, run = 0; y >= 0; y--) {
    if (rows[y] >= 4) { if (bottom < 0) bottom = y + 1; run++; if (run >= Math.max(4, Math.round(5 * f))) break; }
    else if (bottom >= 0) { bottom = -1; run = 0; }
  }
  const slots: [number, number][] = [];
  if (bottom > 0) {
    bottom = Math.min(H, bottom + 2);
    const P = Math.round(13 * f);
    for (let k = 0; k < 6; k++) {
      const z = bottom - k * P, a = z - P - 1;
      if (a < 0) break;
      let ink = 0;
      for (let y = a; y < z; y++) if (rows[y] >= 4) ink++;
      if (ink >= 3) slots.push([Math.max(0, a), Math.min(H, z + 1)]);
    }
  }
  return { W, H, f, sc, slots };
}

/** Signature of the text pixels inside one slot: same value = same line, so its OCR result can be reused. */
export function slotSignature(s: LogScan, [a, z]: [number, number]): number {
  let k = 2166136261;
  for (let y = a; y < z; y++) for (let x = 0; x < s.W; x++) if (s.sc[y * s.W + x] > 15) k = fnv(k, (y - a) * s.W + x);
  return k >>> 0;
}

/**
 * Dissimilarity (1 - correlation) between slot `i` of scan `a` and slot `j` of scan `b`.
 * Correlation of the text scores is unaffected by a line fading out (all its pixels dim together), which a fixed
 * threshold is not. The slot grid's anchor jitters by a few pixels between frames, so search up to ~half a line
 * pitch vertically (a neighbouring line is a full pitch away).
 */
export function slotDiff(a: LogScan, i: number, b: LogScan, j: number): number {
  if (a.W !== b.W) return 1;
  const [a0, a1] = a.slots[i], [b0, b1] = b.slots[j], h = Math.min(a1 - a0, b1 - b0), D = Math.round(6 * a.f);
  let best = 1;
  for (let dy = -D; dy <= D; dy++) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 1; y < h - 1; y++) {
      const ya = a0 + y, yb = b0 + y + dy;
      if (yb < 0 || yb >= b.H) continue;
      for (let x = 0; x < a.W; x++) {
        const p = a.sc[ya * a.W + x], q = b.sc[yb * b.W + x];
        n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
      }
    }
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    if (n && va > 0 && vb > 0) best = Math.min(best, 1 - (sab - sa * sb / n) / Math.sqrt(va * vb));
  }
  return best;
}

/**
 * How many new lines arrived between two scans. New lines push the older ones up one slot each, so find the shift
 * that best lines up the previous slots with the current ones, comparing text pixels rather than OCR text
 * (pixels are stable between frames; OCR output is not).
 */
export function newLineCount(prev: LogScan | null, cur: LogScan, maxDiff = 0.35): { count: number; aligned: boolean } {
  const C = cur.slots.length, P = prev?.slots.length ?? 0;
  if (!C) return { count: 0, aligned: true };
  if (!prev || !P) return { count: C, aligned: false };
  let best = -1, bestD = 1;
  for (let s = 0; s < C; s++) {
    const n = Math.min(3, C - s, P);
    let d = 0;
    for (let k = 0; k < n; k++) d += slotDiff(prev, k, cur, k + s);
    d /= n;
    // identical repeated lines make several shifts look equal: prefer the one that explains a grown log
    if (d < bestD - 0.02 || (Math.abs(d - bestD) <= 0.02 && s === C - P)) { if (d < bestD) bestD = d; best = s; }
  }
  if (best >= 0 && bestD <= maxDiff) return { count: best, aligned: true };
  // nothing lines up (burst of lines, or the scene changed a lot): count the bottom slots that match no previous slot.
  // This is a guess, so callers should also check the OCR text against recently counted lines.
  let s = 0;
  while (s < C && ![...Array(P).keys()].some(k => slotDiff(prev, k, cur, s) <= maxDiff)) s++;
  return { count: s, aligned: false };
}

/** One log line as dark text on white, upscaled ~4x (what the OCR engine sees). */
export function logLineCanvas(s: LogScan, [a, z]: [number, number]): HTMLCanvasElement {
  const w = s.W, h = Math.max(1, z - a), k = 4 / s.f, t = document.createElement('canvas');
  t.width = w; t.height = h;
  const tg = t.getContext('2d')!, id = tg.createImageData(w, h);
  for (let y = a; y < z; y++) for (let x = 0; x < w; x++) {
    const v = 255 - Math.min(255, s.sc[y * w + x] * 4), q = ((y - a) * w + x) * 4;
    id.data[q] = id.data[q + 1] = id.data[q + 2] = v; id.data[q + 3] = 255;
  }
  tg.putImageData(id, 0, 0);
  const c = document.createElement('canvas');
  c.width = Math.round(w * k) + 40; c.height = Math.round(h * k) + 40;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(t, 20, 20, c.width - 40, c.height - 40);
  return c;
}

/** Whole log region as the scorer sees it (for the Setup preview). */
export function logPreviewCanvas(s: LogScan): HTMLCanvasElement {
  return logLineCanvas({ ...s, f: s.f * 2 }, [0, s.H]);
}
