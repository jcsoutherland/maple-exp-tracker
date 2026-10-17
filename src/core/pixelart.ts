/**
 * Pixel-art avatar: one cut-out frame of the character becomes a chunky sprite (downscaled, small palette, dark
 * outline), and short pre-rendered animations are generated in code — a breathing idle loop and a class attack
 * (bow shot, sword slash, wand cast, throwing star, gunshot, punch). No external services or image models.
 */

export type Family = 'bow' | 'sword' | 'wand' | 'stars' | 'gun' | 'fist';
export type Facing = 'left' | 'right';
type RGBA = [number, number, number, number];

const BOW = ['bowman', 'hunter', 'ranger', 'bowmaster', 'crossbow', 'sniper', 'marksman', 'archer'];
const SWORD = ['warrior', 'fighter', 'page', 'spearman', 'crusader', 'knight', 'hero', 'paladin', 'dark knight'];
const WAND = ['magician', 'wizard', 'mage', 'cleric', 'priest', 'bishop', 'arch mage'];
const STARS = ['thief', 'assassin', 'hermit', 'night lord', 'bandit', 'shadower'];
const GUN = ['gunslinger', 'outlaw', 'corsair'];
const FIST = ['pirate', 'brawler', 'marauder', 'buccaneer'];

/** Animation family for a job name (Beginner and unknown jobs punch). */
export function classFamily(cls: string): Family {
  const c = (cls || '').toLowerCase();
  const has = (l: string[]) => l.some(k => c.includes(k));
  return has(BOW) ? 'bow' : has(GUN) ? 'gun' : has(WAND) ? 'wand' : has(STARS) ? 'stars' : has(SWORD) ? 'sword' : has(FIST) ? 'fist' : 'fist';
}

// ---------- pixelize ----------

/** Turn a cut-out (alpha = character) into pixel art `targetH` pixels tall. */
export function pixelize(cut: ImageData, targetH = 48, colors = 14): ImageData {
  const { width: W, height: H, data: d } = cut;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return new ImageData(1, 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sc = targetH / bh, ow = Math.max(1, Math.round(bw * sc)), oh = targetH;
  // box-filter downscale weighted by alpha; a pixel is solid when ≥45% covered
  const px: (RGBA | null)[] = new Array(ow * oh).fill(null);
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    const sx0 = x0 + ox / sc, sx1 = x0 + (ox + 1) / sc, sy0 = y0 + oy / sc, sy1 = y0 + (oy + 1) / sc;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4, al = d[i + 3] / 255;
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++;
    }
    if (n && a / n >= 0.45) px[oy * ow + ox] = saturate([r / a, g / a, b / a, 255], 1.18);
  }
  // reduce to a small palette (median cut), then drop lone pixels
  const pal = medianCut(px.filter((p): p is RGBA => !!p), colors);
  for (let i = 0; i < px.length; i++) if (px[i]) px[i] = nearest(px[i]!, pal);
  for (let pass = 0; pass < 2; pass++) {
    const keep = px.slice();
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      if (!px[y * ow + x]) continue;
      let nb = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < ow && yy < oh && px[yy * ow + xx]) nb++; }
      if (nb < 2) keep[y * ow + x] = null;
    }
    px.splice(0, px.length, ...keep);
  }
  // 1px dark outline around the silhouette, like a game sprite
  const out = new ImageData(ow + 2, oh + 2), o = out.data, OW = ow + 2;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < ow && y < oh ? px[y * ow + x] : null);
  for (let y = -1; y <= oh; y++) for (let x = -1; x <= ow; x++) {
    const i = ((y + 1) * OW + (x + 1)) * 4, p = at(x, y);
    if (p) { o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2]; o[i + 3] = 255; continue; }
    let dark: RGBA | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = at(x + dx, y + dy);
      if (q && (!dark || lum(q) < lum(dark))) dark = q;
    }
    if (dark) { o[i] = dark[0] * 0.3; o[i + 1] = dark[1] * 0.3; o[i + 2] = dark[2] * 0.3; o[i + 3] = 255; }
  }
  return out;
}

const lum = (p: RGBA) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
function saturate(p: RGBA, k: number): RGBA {
  const l = lum(p), c = (v: number) => Math.max(0, Math.min(255, l + (v - l) * k));
  return [c(p[0]), c(p[1]), c(p[2]), p[3]];
}
function medianCut(cols: RGBA[], n: number): RGBA[] {
  if (!cols.length) return [[0, 0, 0, 255]];
  let boxes = [cols];
  while (boxes.length < n) {
    let bi = -1, br = 0, bc = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); }
        if (hi - lo > br) { br = hi - lo; bi = i; bc = c; }
      }
    });
    if (bi < 0 || br < 8) break;
    const b = boxes[bi].sort((p, q) => p[bc] - q[bc]), m = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, m), b.slice(m));
  }
  return boxes.map(b => {
    const s = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length), 255] as RGBA;
  });
}
function nearest(p: RGBA, pal: RGBA[]): RGBA {
  let best = pal[0], bd = Infinity;
  for (const q of pal) { const d = (p[0] - q[0]) ** 2 * 0.3 + (p[1] - q[1]) ** 2 * 0.59 + (p[2] - q[2]) ** 2 * 0.11; if (d < bd) { bd = d; best = q; } }
  return best;
}

// ---------- drawing helpers ----------

class Frame {
  img: ImageData;
  constructor(public w: number, public h: number) { this.img = new ImageData(w, h); }
  px(x: number, y: number, c: RGBA) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || c[3] <= 0) return;
    const i = (y * this.w + x) * 4, d = this.img.data, a = c[3] / 255;
    d[i] = d[i] * (1 - a) + c[0] * a; d[i + 1] = d[i + 1] * (1 - a) + c[1] * a; d[i + 2] = d[i + 2] * (1 - a) + c[2] * a;
    d[i + 3] = Math.max(d[i + 3], c[3]);
  }
  /** Copy a sprite in. `bob` lowers the top 60% by that many pixels while the feet stay put (breathing). */
  blit(src: ImageData, ox: number, oy: number, flip: boolean, bob = 0) {
    const split = Math.round(src.height * 0.6);
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      const sx = flip ? src.width - 1 - x : x, i = (y * src.width + sx) * 4, s = src.data;
      if (s[i + 3] > 0) this.px(ox + x, oy + y + (y < split ? bob : 0), [s[i], s[i + 1], s[i + 2], s[i + 3]]);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) this.px(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, c);
  }
  shadow(cx: number, y: number, rx: number) {
    for (let x = -rx; x <= rx; x++) for (let dy = 0; dy < 2; dy++) {
      const f = 1 - (x * x) / (rx * rx);
      if (f > 0) this.px(cx + x, y + dy, [0, 0, 0, Math.round(90 * f)]);
    }
  }
}

const WHITE: RGBA = [255, 255, 255, 255], DARK: RGBA = [24, 22, 30, 255];

// ---------- animations ----------

export interface Animations { idle: ImageData[]; attack: ImageData[]; w: number; h: number }

/**
 * Pre-render the loops. `facing` is the way the character looks in the source picture; attacks go that way.
 * Maple characters face left by default.
 */
export function buildAnimations(base: ImageData, family: Family, facing: Facing = 'left'): Animations {
  const reach = Math.max(30, Math.round(base.width * 1.1));
  const W = base.width + reach * 2, H = base.height + 8, dir = facing === 'left' ? -1 : 1;
  const cx0 = Math.round((W - base.width) / 2), cy0 = H - base.height - 3;
  const hand = { x: cx0 + (dir < 0 ? 3 : base.width - 3), y: cy0 + Math.round(base.height * 0.5) };

  const idle: ImageData[] = [];
  const bob = [0, 0, 0, 1, 1, 1, 1, 0];
  for (const b of bob) {
    const f = new Frame(W, H);
    f.shadow(cx0 + base.width / 2, H - 3, Math.round(base.width * 0.38) + (b ? 1 : 0));
    f.blit(base, cx0, cy0, false, b);
    idle.push(f.img);
  }

  const attack: ImageData[] = [];
  const N = 9, lean = [-1, -1, 2, 2, 1, 1, 0, 0, 0];
  for (let k = 0; k < N; k++) {
    const f = new Frame(W, H), dx = lean[k] * dir;
    f.shadow(cx0 + base.width / 2 + dx, H - 3, Math.round(base.width * 0.38));
    f.blit(base, cx0 + dx, cy0, false);
    const t = k - 2; // effect clock: 0 = release
    const hx = hand.x + dx, hy = hand.y, travel = (reach + base.width * 0.3) / 6;
    switch (family) {
      case 'bow': arrow(f, k, t, hx, hy, dir, travel); break;
      case 'sword': slash(f, t, hx, hy, dir, base.height); break;
      case 'wand': cast(f, k, t, hx, hy, dir, travel); break;
      case 'stars': star(f, t, hx, hy, dir, travel); break;
      case 'gun': bullet(f, t, hx, hy, dir, travel); break;
      default: punch(f, t, hx, hy, dir);
    }
    attack.push(f.img);
  }
  return { idle, attack, w: W, h: H };
}

function arrow(f: Frame, k: number, t: number, hx: number, hy: number, dir: number, travel: number) {
  if (k < 2) { f.line(hx, hy - 6, hx, hy + 6, [150, 105, 60, 255]); f.line(hx - dir * 3, hy, hx, hy, WHITE); return; } // drawn bow
  if (t === 0) for (let i = -2; i <= 2; i++) f.px(hx + dir * 2, hy + i, [255, 250, 200, 220]); // twang flash
  const x = hx + dir * (6 + t * travel);
  f.line(x - dir * 10, hy, x, hy, [139, 94, 52, 255]);
  f.px(x + dir, hy, [200, 200, 210, 255]); f.px(x, hy - 1, [170, 170, 180, 255]); f.px(x, hy + 1, [170, 170, 180, 255]);
  f.px(x - dir * 10, hy - 1, WHITE); f.px(x - dir * 10, hy + 1, WHITE); f.px(x - dir * 11, hy - 1, WHITE); f.px(x - dir * 11, hy + 1, WHITE);
  for (let i = 1; i <= 3; i++) f.px(x - dir * (11 + i * 2), hy, [255, 255, 255, 110 - i * 30]); // trail
}

function slash(f: Frame, t: number, hx: number, hy: number, dir: number, h: number) {
  if (t < 0 || t > 3) return;
  const r = Math.round(h * 0.45), cx = hx + dir * 4, cy = hy - 2, a = [255, 230, 160, 90][t];
  // sweep from overhead to low in front
  const from = -100 + t * 25, to = -10 + t * 30;
  for (let deg = from; deg <= to; deg += 3) {
    const rad = (deg * Math.PI) / 180, x = cx + dir * Math.cos(rad) * r, y = cy + Math.sin(rad) * r;
    f.px(x, y, [255, 255, 255, a]);
    f.px(x - dir * Math.cos(rad), y - Math.sin(rad), [150, 210, 255, Math.round(a * 0.8)]);
    f.px(x - dir * 2 * Math.cos(rad), y - 2 * Math.sin(rad), [100, 160, 255, Math.round(a * 0.5)]);
  }
}

function cast(f: Frame, k: number, t: number, hx: number, hy: number, dir: number, travel: number) {
  const spark = (x: number, y: number, c: RGBA) => { f.px(x, y, c); f.px(x - 1, y, [c[0], c[1], c[2], 120]); f.px(x + 1, y, [c[0], c[1], c[2], 120]); f.px(x, y - 1, [c[0], c[1], c[2], 120]); f.px(x, y + 1, [c[0], c[1], c[2], 120]); };
  if (k < 3) { // gathering sparkles around the wand
    for (let i = 0; i < 4; i++) { const ang = (k * 40 + i * 90) * Math.PI / 180; spark(hx + Math.cos(ang) * (6 - k), hy - 8 + Math.sin(ang) * (6 - k), [255, 240, 140, 255]); }
    f.line(hx, hy, hx + dir * 3, hy - 7, [120, 80, 50, 255]); f.px(hx + dir * 3, hy - 8, [180, 140, 255, 255]); // wand + gem
    return;
  }
  const x = hx + dir * (4 + (t - 1) * travel), y = hy - 6;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const r = Math.hypot(dx, dy);
    if (r <= 3.2) f.px(x + dx, y + dy, r < 1.5 ? [235, 225, 255, 255] : [140, 110, 255, Math.round(255 - r * 45)]);
  }
  for (let i = 1; i <= 4; i++) f.px(x - dir * (3 + i * 3), y + ((i % 2) ? -1 : 1), [180, 150, 255, 200 - i * 40]);
}

function star(f: Frame, t: number, hx: number, hy: number, dir: number, travel: number) {
  if (t < 0) return;
  const x = Math.round(hx + dir * (5 + t * travel)), y = hy - 2;
  const plus = t % 2 === 0, S: RGBA = [215, 220, 235, 255], E: RGBA = [120, 125, 140, 255];
  const arms = plus ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 1], [-1, -1], [1, -1], [-1, 1]];
  f.px(x, y, DARK);
  for (const [ax, ay] of arms) { f.px(x + ax, y + ay, S); f.px(x + ax * 2, y + ay * 2, S); f.px(x + ax * 3, y + ay * 3, E); }
  for (let i = 1; i <= 3; i++) f.px(x - dir * (4 + i * 3), y, [255, 255, 255, 120 - i * 35]);
}

function bullet(f: Frame, t: number, hx: number, hy: number, dir: number, travel: number) {
  if (t === 0) for (const [dx, dy] of [[1, 0], [2, 0], [2, -1], [2, 1], [3, 0]]) f.px(hx + dir * dx, hy + dy, [255, 180, 60, 255]); // muzzle flash
  if (t < 1) return;
  const x = hx + dir * (4 + t * travel * 1.3);
  f.line(x - dir * 2, hy, x, hy, [255, 225, 90, 255]);
  for (let i = 1; i <= 4; i++) f.px(x - dir * (2 + i * 2), hy, [255, 240, 200, 130 - i * 30]);
}

function punch(f: Frame, t: number, hx: number, hy: number, dir: number) {
  if (t < 0 || t > 3) return;
  const cx = hx + dir * 7, a = [255, 220, 150, 80][t], r = 2 + t * 2;
  for (let i = 0; i < 8; i++) {
    const ang = (i * 45 * Math.PI) / 180;
    f.line(cx + Math.cos(ang) * r, hy + Math.sin(ang) * r, cx + Math.cos(ang) * (r + 2), hy + Math.sin(ang) * (r + 2), [255, 250, 220, a]);
  }
}

// ---------- encoding ----------

export function imageDataToUrl(im: ImageData): string {
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  c.getContext('2d')!.putImageData(im, 0, 0);
  return c.toDataURL('image/png');
}

export async function urlToImageData(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}
