import { frameSize, type FrameSource } from './imaging';

/**
 * Finding and capturing the player's character from the game view.
 *
 * 1. Name tag: the player's name sits in a flat grey/black box (~14px tall at 720p) under the character. Candidates
 *    are found as runs of low-saturation pixels stacked into a box; each candidate is OCR'd once and the one whose
 *    text contains the character's name wins. After that the tag is followed frame to frame by pixel correlation
 *    (no OCR), searching near its last position.
 * 2. Sprite: the character is cropped from just above the tag. Over a session the camera and scenery move but the
 *    character stays the same relative to its tag, so pixels that agree across many crops are the character and the
 *    rest is background — that gives a cut-out without any segmentation model.
 */

export interface Box { x: number; y: number; w: number; h: number }

const lumaSat = (d: Uint8ClampedArray, i: number) => {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return [0.299 * r + 0.587 * g + 0.114 * b, Math.max(r, g, b) - Math.min(r, g, b)];
};

function grab(src: FrameSource, b: Box, scratch: HTMLCanvasElement) {
  scratch.width = b.w; scratch.height = b.h;
  const g = scratch.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return g.getImageData(0, 0, b.w, b.h);
}

/** Boxes in the game view that look like name tags (flat, low-saturation, tag-height, with contrasting text inside). */
export function findTagCandidates(src: FrameSource, scratch = document.createElement('canvas'), max = 10): Box[] {
  const { W, H } = frameSize(src), f = H / 720;
  const top = Math.round(H * 0.06), area: Box = { x: 0, y: top, w: W, h: Math.round(H * 0.88) - top };
  const d = grab(src, area, scratch).data;
  const minW = 22 * f, maxW = 180 * f, minH = 10 * f, maxH = 19 * f;
  type Open = { x0: number; x1: number; y0: number; last: number };
  let open: Open[] = [];
  const found: Box[] = [];
  // grey = low saturation (box fill and its text are both grey); precomputed once per scan
  const grey = new Uint8Array(area.w * area.h);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    grey[p] = (r > g ? (r > b ? r : b) : g > b ? g : b) - (r < g ? (r < b ? r : b) : g < b ? g : b) < 45 ? 1 : 0;
  }
  for (let y = 0; y < area.h; y++) {
    const next: Open[] = [], row = y * area.w;
    let x = 0;
    while (x < area.w) {
      if (!grey[row + x]) { x++; continue; }
      let e = x;
      while (e + 1 < area.w && grey[row + e + 1]) e++;
      const len = e - x + 1;
      if (len >= minW && len <= maxW) {
        const o = open.find(o => Math.abs(o.x0 - x) <= 3 && Math.abs(o.x1 - e) <= 3);
        next.push(o ? { ...o, last: y } : { x0: x, x1: e, y0: y, last: y });
      }
      x = e + 1;
    }
    for (const o of open) if (!next.some(n => n.y0 === o.y0 && n.x0 === o.x0)) {
      const h = o.last - o.y0 + 1;
      if (h >= minH && h <= maxH) found.push({ x: o.x0, y: o.y0 + top, w: o.x1 - o.x0 + 1, h });
    }
    open = next;
  }
  // keep boxes with text-like contrast inside (some pixels far from the box's median brightness)
  const scored = found.map(b => {
    const px = grab(src, b, scratch).data, L: number[] = [];
    for (let i = 0; i < px.length; i += 4) L.push(lumaSat(px, i)[0]);
    const med = [...L].sort((a, c) => a - c)[L.length >> 1];
    const textish = L.filter(v => Math.abs(v - med) > 60).length / L.length;
    return { b, score: textish >= 0.06 && textish <= 0.5 ? 1 - Math.abs(textish - 0.22) : -1 };
  }).filter(s => s.score > 0);
  return scored.sort((a, c) => c.score - a.score).slice(0, max).map(s => s.b);
}

/** A tag box as dark text on white, upscaled for OCR. Text polarity is picked automatically (minority class = text). */
export function tagOcrCanvas(src: FrameSource, box: Box): HTMLCanvasElement {
  // the detected box hugs the fill and can clip the first/last letter: pad it, and upscale smoothly before thresholding
  const { W, H } = frameSize(src), f = H / 720, px0 = Math.round(4 * f), py0 = Math.round(2 * f);
  const b0 = { x: Math.max(0, box.x - px0), y: Math.max(0, box.y - py0), w: 0, h: 0 };
  b0.w = Math.min(W, box.x + box.w + px0) - b0.x; b0.h = Math.min(H, box.y + box.h + py0) - b0.y;
  const sc = 4, pad = 8, up = document.createElement('canvas');
  up.width = b0.w * sc; up.height = b0.h * sc;
  const ug = up.getContext('2d', { willReadFrequently: true })!;
  ug.imageSmoothingEnabled = true;
  ug.drawImage(src, b0.x, b0.y, b0.w, b0.h, 0, 0, up.width, up.height);
  const b = { w: up.width, h: up.height }, d = ug.getImageData(0, 0, b.w, b.h).data, L = new Float32Array(b.w * b.h);
  for (let p = 0; p < L.length; p++) L[p] = lumaSat(d, p * 4)[0];
  // Otsu threshold
  const hist = new Array(256).fill(0);
  L.forEach(v => hist[Math.min(255, Math.max(0, Math.round(v)))]++);
  let sum = 0, sumB = 0, wB = 0, best = 0, thr = 128;
  hist.forEach((c, i) => (sum += i * c));
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = L.length - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  const bright = L.filter(v => v > thr).length, textBright = bright < L.length / 2;
  const out = document.createElement('canvas');
  out.width = b.w + pad * 2; out.height = b.h + pad * 2;
  const g = out.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
  const im = g.getImageData(pad, pad, b.w, b.h);
  for (let p = 0; p < L.length; p++) {
    const ink = textBright ? L[p] > thr : L[p] <= thr, v = ink ? 0 : 255;
    im.data[p * 4] = im.data[p * 4 + 1] = im.data[p * 4 + 2] = v; im.data[p * 4 + 3] = 255;
  }
  g.putImageData(im, pad, pad);
  return out;
}

/** Follows a known tag by luma correlation in a window around its last position. */
export class TagTracker {
  private tpl: Float32Array;
  /** correlation of the last search (for diagnostics) */
  lastCorr = 0;
  constructor(public box: Box, src: FrameSource, private scratch = document.createElement('canvas')) {
    this.tpl = TagTracker.luma(grab(src, box, scratch));
  }
  private static luma(im: ImageData) {
    const o = new Float32Array(im.width * im.height);
    for (let p = 0; p < o.length; p++) o[p] = lumaSat(im.data, p * 4)[0];
    return o;
  }
  /** Search the whole game view (after a map change or losing the character). Slower; call every few seconds. */
  locateAnywhere(src: FrameSource, minCorr = 0.65): Box | null {
    const { W, H } = frameSize(src);
    return this.search(src, { x: 0, y: Math.round(H * 0.06), w: W, h: Math.round(H * 0.82) }, minCorr, 3);
  }

  /** New box if found with correlation ≥ minCorr, else null (character off screen, map change, window covering…). */
  locate(src: FrameSource, minCorr = 0.6): Box | null {
    const { W, H } = frameSize(src), f = H / 720, b = this.box;
    const rx = Math.round(140 * f), ry = Math.round(70 * f);
    const win: Box = { x: Math.max(0, b.x - rx), y: Math.max(0, b.y - ry), w: 0, h: 0 };
    win.w = Math.min(W, b.x + b.w + rx) - win.x; win.h = Math.min(H, b.y + b.h + ry) - win.y;
    return this.search(src, win, minCorr, 3);
  }

  private search(src: FrameSource, win: Box, minCorr: number, step: number): Box | null {
    const b = this.box;
    if (win.w < b.w || win.h < b.h) return null;
    const L = TagTracker.luma(grab(src, win, this.scratch)), t = this.tpl, n = t.length;
    let tm = 0; for (let i = 0; i < n; i++) tm += t[i];
    tm /= n;
    let tv = 0; for (let i = 0; i < n; i++) tv += (t[i] - tm) ** 2;
    const corr = (ox: number, oy: number) => {
      let m = 0;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) m += L[(oy + y) * win.w + ox + x];
      m /= n;
      let cov = 0, v = 0;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const a = L[(oy + y) * win.w + ox + x] - m, c = t[y * b.w + x] - tm;
        cov += a * c; v += a * a;
      }
      return v > 0 && tv > 0 ? cov / Math.sqrt(v * tv) : 0;
    };
    // coarse pass then refine around the best
    let best = { c: -1, x: 0, y: 0 };
    for (let oy = 0; oy <= win.h - b.h; oy += step) for (let ox = 0; ox <= win.w - b.w; ox += step) {
      const c = corr(ox, oy); if (c > best.c) best = { c, x: ox, y: oy };
    }
    for (let oy = Math.max(0, best.y - step); oy <= Math.min(win.h - b.h, best.y + step); oy++)
      for (let ox = Math.max(0, best.x - step); ox <= Math.min(win.w - b.w, best.x + step); ox++) {
        const c = corr(ox, oy); if (c > best.c) best = { c, x: ox, y: oy };
      }
    this.lastCorr = best.c;
    if (best.c < minCorr) return null;
    this.box = { ...b, x: win.x + best.x, y: win.y + best.y };
    // the tag box is semi-transparent: on a confident match, blend in the current look so the template follows the scenery
    if (best.c >= 0.8) for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++)
      t[y * b.w + x] = 0.85 * t[y * b.w + x] + 0.15 * L[(best.y + y) * win.w + best.x + x];
    return this.box;
  }
}

/** The area above the tag where the character stands (centre x given, since a tag can merge with a monster label). */
export function spriteBox(src: FrameSource, cx: number, tagTop: number): Box | null {
  const { W, H } = frameSize(src), f = H / 720, w = Math.round(120 * f), h = Math.round(100 * f);
  const b = { x: Math.round(cx - w / 2), y: tagTop - h - 1, w, h };
  return b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H ? b : null;
}

export interface SpriteFrame { data: ImageData; t: number; active: boolean }

/**
 * Collects crops of the character and learns a foreground mask: a pixel belongs to the character when it agrees with
 * the per-pixel median across crops taken at different places and times. Until the scenery has varied enough the mask
 * is not trusted and frames are shown with a soft vignette instead.
 */
export class SpriteLearner {
  private samples: ImageData[] = [];
  private lastSamplePos: { x: number; y: number; t: number } | null = null;
  idle: SpriteFrame[] = [];
  attack: SpriteFrame[] = [];
  /** share of pixels judged foreground in the last learning pass (diagnostics) */
  lastShare = 0;
  w = 0;
  h = 0;

  /** Add one crop. `screenPos` is where the tag was (for sampling variety); `active` = gaining EXP/loot right now. */
  add(data: ImageData, screenPos: { x: number; y: number }, active: boolean, now = Date.now()) {
    if (data.width !== this.w || data.height !== this.h) { this.samples = []; this.idle = []; this.attack = []; this.fgP = this.bgP = null; this.w = data.width; this.h = data.height; }
    const list = active ? this.attack : this.idle;
    list.push({ data, t: now, active });
    if (list.length > 8) list.shift();
    // mask samples: spread out in time or position so the background differs between them
    const lp = this.lastSamplePos;
    if (!lp || now - lp.t > 4000 || Math.hypot(screenPos.x - lp.x, screenPos.y - lp.y) > 24) {
      this.samples.push(data);
      if (this.samples.length > 40) this.samples.splice(1, 1); // keep the oldest for variety
      this.lastSamplePos = { ...screenPos, t: now };
      if (this.samples.length >= 8 && this.samples.length % 4 === 0) this.learn();
    }
  }

  get maskReady() { return !!this.fgP; }
  get sampleCount() { return this.samples.length; }

  // colour models (4 bits per channel) of the character and of the background
  private fgP: Float32Array | null = null;
  private bgP: Float32Array | null = null;
  private cache = new WeakMap<SpriteFrame, ImageData>();
  private static bin = (d: Uint8ClampedArray, i: number) => ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);

  /**
   * Pixels that agree across views taken in different places are certainly the character; pixels that keep changing
   * are certainly background. Those two sets train a colour model, which then cuts out every frame on its own —
   * so turning around, attacking and walking animations all work.
   */
  private learn() {
    const n = this.samples.length, w = this.w, h = this.h, N = w * h;
    const agree = new Float32Array(N), vals = new Array<number>(n);
    for (let p = 0; p < N; p++) {
      const med = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < n; k++) vals[k] = this.samples[k].data[p * 4 + c];
        vals.sort((x, y) => x - y);
        med[c] = vals[n >> 1];
      }
      let a = 0;
      for (let k = 0; k < n; k++) {
        const d = this.samples[k].data, i = p * 4;
        if (Math.abs(d[i] - med[0]) + Math.abs(d[i + 1] - med[1]) + Math.abs(d[i + 2] - med[2]) < 60) a++;
      }
      agree[p] = a / n;
    }
    const fg = new Float32Array(4096), bg = new Float32Array(4096);
    let nf = 0, nb = 0;
    const x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8), yMax = Math.round(h * 0.93); // skip the ground strip
    for (let p = 0; p < N; p++) {
      const x = p % w, y = (p / w) | 0;
      const isFg = agree[p] >= 0.6 && x >= x0 && x < x1 && y < yMax, isBg = agree[p] <= 0.35;
      if (!isFg && !isBg) continue;
      for (const sm of this.samples) { const k = SpriteLearner.bin(sm.data, p * 4); if (isFg) { fg[k]++; nf++; } else { bg[k]++; nb++; } }
    }
    this.lastShare = nf / Math.max(1, nf + nb);
    if (nf < 200 * n * 0.1 || nb < 500) return; // not enough of either yet
    for (let k = 0; k < 4096; k++) { fg[k] = (fg[k] + 0.5) / nf; bg[k] = (bg[k] + 0.5) / nb; }
    this.fgP = fg; this.bgP = bg;
    this.cache = new WeakMap();
  }

  /** Per-frame alpha: colour classification, keep the shape standing above the tag, fill holes, feather. */
  private segment(fr: SpriteFrame): Float32Array | null {
    const { fgP, bgP } = this;
    if (!fgP || !bgP) return null;
    const d = fr.data.data, w = this.w, h = this.h, N = w * h, cls = new Uint8Array(N);
    for (let p = 0; p < N; p++) { const k = SpriteLearner.bin(d, p * 4); cls[p] = fgP[k] > 1.3 * bgP[k] ? 1 : 0; }
    // grow from character-coloured pixels in the centre (8-connected)
    const keep = new Uint8Array(N), st: number[] = [];
    for (let y = Math.round(h * 0.25); y < Math.round(h * 0.95); y++) for (let x = Math.round(w * 0.35); x < Math.round(w * 0.65); x++) {
      const p = y * w + x; if (cls[p]) { keep[p] = 1; st.push(p); }
    }
    while (st.length) {
      const p = st.pop()!, x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx; if (cls[q] && !keep[q]) { keep[q] = 1; st.push(q); }
      }
    }
    // fill holes: anything the border can't reach without crossing the character is inside it
    const outside = new Uint8Array(N);
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const p = y * w + x; if (!keep[p] && !outside[p]) { outside[p] = 1; st.push(p); } }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const p = y * w + x; if (!keep[p] && !outside[p]) { outside[p] = 1; st.push(p); } }
    while (st.length) {
      const p = st.pop()!, x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && !keep[q] && !outside[q]) { outside[q] = 1; st.push(q); }
    }
    let count = 0;
    const solid = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (!outside[p]) { solid[p] = 1; count++; }
    if (count / N > 0.7 || count / N < 0.03) return null; // segmentation failed for this frame
    // 1px grow + soft edge
    const a = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2 && m < 1; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !solid[yy * w + xx]) continue;
        const dist = Math.hypot(dx, dy);
        m = Math.max(m, dist <= 1 ? 1 : Math.max(0, 2.2 - dist));
      }
      a[y * w + x] = m;
    }
    return a;
  }

  /** Frame rendered with the cut-out, or a soft vignette while the colour model isn't ready / a frame fails. */
  render(fr: SpriteFrame): ImageData {
    const hit = this.cache.get(fr);
    if (hit) return hit;
    const out = new ImageData(new Uint8ClampedArray(fr.data.data), fr.data.width, fr.data.height), d = out.data, w = out.width, h = out.height;
    const mask = this.segment(fr);
    for (let p = 0; p < w * h; p++) {
      let a: number;
      if (mask) a = mask[p];
      else { const x = (p % w) / w - 0.5, y = ((p / w) | 0) / h - 0.55; a = Math.max(0, Math.min(1, 1.6 - Math.hypot(x * 1.6, y) * 3.2)); }
      d[p * 4 + 3] = Math.round(255 * a);
    }
    this.cache.set(fr, out);
    return out;
  }
}

/** ImageData → PNG data URL, nearest-neighbour scaled. */
export function toDataUrl(im: ImageData, scale = 1): string {
  const a = document.createElement('canvas');
  a.width = im.width; a.height = im.height;
  a.getContext('2d')!.putImageData(im, 0, 0);
  if (scale === 1) return a.toDataURL('image/png');
  const b = document.createElement('canvas');
  b.width = im.width * scale; b.height = im.height * scale;
  const g = b.getContext('2d')!;
  g.imageSmoothingEnabled = false; g.drawImage(a, 0, 0, b.width, b.height);
  return b.toDataURL('image/png');
}

export const grabBox = grab;
