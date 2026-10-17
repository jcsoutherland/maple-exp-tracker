/**
 * Pixel-art avatar: one cut-out frame of the character becomes a crisp sprite (upscaled, palette-reduced, dark
 * outline), rigged as a puppet — head and torso from the capture, arms and legs drawn as jointed limbs in the
 * character's own colours — and short pre-rendered loops are generated in code: idle, and a class attack (bow shot,
 * sword slash, wand cast, throwing stars, gunshots, punches). No external services or image models.
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

/**
 * Turn a cut-out (alpha = character) into a crisp sprite: cropped, upscaled `scale`× with smoothing (keeping every
 * detail of the capture rather than squeezing it to a fixed size), reduced to a palette, with a dark outline.
 */
export function pixelize(cut: ImageData, scale = 2, colors = 32): ImageData {
  const { width: W, height: H, data: d } = cut;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return new ImageData(1, 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, ow = Math.round(bw * scale), oh = Math.round(bh * scale);
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  src.getContext('2d')!.putImageData(cut, 0, 0);
  const big = document.createElement('canvas');
  big.width = ow; big.height = oh;
  const g = big.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, x0, y0, bw, bh, 0, 0, ow, oh);
  const s = g.getImageData(0, 0, ow, oh).data;
  const px: (RGBA | null)[] = new Array(ow * oh).fill(null);
  for (let i = 0; i < ow * oh; i++) if (s[i * 4 + 3] >= 128) px[i] = saturate([s[i * 4], s[i * 4 + 1], s[i * 4 + 2], 255], 1.12);
  // reduce to a palette (median cut), then drop lone pixels
  const pal = medianCut(px.filter((p): p is RGBA => !!p), colors);
  for (let i = 0; i < px.length; i++) if (px[i]) px[i] = nearest(px[i]!, pal);
  const keep = px.slice();
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    if (!px[y * ow + x]) continue;
    let nb = 0;
    for (const [dx, dy] of N4) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < ow && yy < oh && px[yy * ow + xx]) nb++; }
    if (nb < 2) keep[y * ow + x] = null;
  }
  // 1px dark outline around the silhouette, like a game sprite
  const out = new ImageData(ow + 2, oh + 2), o = out.data, OW = ow + 2;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < ow && y < oh ? keep[y * ow + x] : null);
  for (let y = -1; y <= oh; y++) for (let x = -1; x <= ow; x++) {
    const i = ((y + 1) * OW + (x + 1)) * 4, p = at(x, y);
    if (p) { o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2]; o[i + 3] = 255; continue; }
    let dark: RGBA | null = null;
    for (const [dx, dy] of N4) {
      const q = at(x + dx, y + dy);
      if (q && (!dark || lum(q) < lum(dark))) dark = q;
    }
    if (dark) { o[i] = dark[0] * 0.3; o[i + 1] = dark[1] * 0.3; o[i + 2] = dark[2] * 0.3; o[i + 3] = 255; }
  }
  return out;
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const skinLike = (p: RGBA) => p[0] > 170 && p[1] > 120 && p[0] >= p[1] && p[1] >= p[2] && p[0] - p[2] > 25;
const lum = (p: RGBA) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const shade = (p: RGBA, k: number): RGBA => [Math.round(p[0] * k), Math.round(p[1] * k), Math.round(p[2] * k), p[3]];
function saturate(p: RGBA, k: number): RGBA {
  const l = lum(p), c = (v: number) => Math.max(0, Math.min(255, l + (v - l) * k));
  return [c(p[0]), c(p[1]), c(p[2]), p[3]];
}
function medianCut(cols: RGBA[], n: number): RGBA[] {
  if (!cols.length) return [[0, 0, 0, 255]];
  const boxes = [cols];
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
    if (bi < 0 || br < 6) break;
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

// ---------- rig ----------

/**
 * Where the parts are in the sprite. Maple characters are chibi — a big head on a small body — so the neck is where
 * the silhouette narrows below the widest (head) rows. Below it: torso, then legs.
 */
interface Rig {
  neck: number; legTop: number;
  cx: number; half: number; headW: number; bodyH: number;
  shirt: RGBA; skin: RGBA; pants: RGBA; shoe: RGBA;
}

function makeRig(b: ImageData): Rig {
  const { width: W, height: H, data: d } = b;
  const solid = (x: number, y: number) => d[(y * W + x) * 4 + 3] > 0;
  const span: [number, number][] = [];
  let top = -1, bottom = -1;
  for (let y = 0; y < H; y++) {
    let lo = W, hi = -1;
    for (let x = 0; x < W; x++) if (solid(x, y)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    span.push([lo, hi]);
    if (hi >= 0) { if (top < 0) top = y; bottom = y; }
  }
  const h = Math.max(1, bottom - top + 1), wid = (y: number) => Math.max(0, span[y][1] - span[y][0] + 1);
  let headW = 0, widest = top;
  for (let y = top; y < top + h * 0.6; y++) if (wid(y) > headW) { headW = wid(y); widest = y; }
  let neck = Math.round(top + h * 0.58);
  for (let y = widest; y < top + h * 0.82; y++) if (y > top + h * 0.4 && wid(y) < headW * 0.72) { neck = y; break; }
  const bodyH = Math.max(4, bottom - neck + 1), legTop = neck + Math.round(bodyH * 0.6);
  let sx = 0, n = 0;
  for (let y = neck; y < legTop; y++) for (let x = 0; x < W; x++) if (solid(x, y)) { sx += x; n++; }
  const cx = n ? Math.round(sx / n) : W >> 1, half = Math.max(3, Math.round(headW * 0.19));
  // most common colour of a region (ignoring outline pixels), optionally filtered
  const mode = (x0: number, x1: number, y0: number, y1: number, ok: (p: RGBA) => boolean = () => true): RGBA | null => {
    const tally = new Map<number, number>();
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const i = (y * W + x) * 4;
      if (!d[i + 3]) continue;
      const p: RGBA = [d[i], d[i + 1], d[i + 2], 255];
      if (lum(p) < 45 || !ok(p)) continue;
      const key = (p[0] << 16) | (p[1] << 8) | p[2];
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    let best = -1, bn = 0;
    tally.forEach((v, key) => { if (v > bn) { bn = v; best = key; } });
    return best < 0 ? null : [best >> 16, (best >> 8) & 255, best & 255, 255];
  };
  const shirt = mode(cx - half, cx + half + 1, neck + 1, legTop, p => !skinLike(p)) ?? [200, 60, 60, 255];
  const pants = mode(0, W, legTop, bottom + 1, p => !skinLike(p)) ?? shade(shirt, 0.7);
  return {
    neck, legTop, cx, half, headW, bodyH, shirt, pants,
    skin: mode(0, W, Math.round(top + h * 0.3), neck + 2, skinLike) ?? [250, 214, 178, 255],
    shoe: shade(pants, 0.5),
  };
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
  /** Copy the part of a sprite inside rows [y0,y1) and columns [x0,x1), offset by (ox,oy). */
  blit(src: ImageData, ox: number, oy: number, y0 = 0, y1 = src.height, x0 = 0, x1 = src.width) {
    const s = src.data;
    for (let y = Math.max(0, y0); y < Math.min(src.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(src.width, x1); x++) {
      const i = (y * src.width + x) * 4;
      if (s[i + 3] > 0) this.px(ox + x, oy + y, [s[i], s[i + 1], s[i + 2], s[i + 3]]);
    }
  }
  disc(cx: number, cy: number, r: number, c: RGBA) {
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= r * r + r * 0.6) this.px(cx + dx, cy + dy, c);
  }
  /** A line `w` pixels thick with round caps. */
  stroke(x0: number, y0: number, x1: number, y1: number, w: number, c: RGBA) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
      if (w <= 1) this.px(x, y, c); else this.disc(Math.round(x), Math.round(y), (w - 1) / 2, c);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA) { this.stroke(x0, y0, x1, y1, 1, c); }
  shadow(cx: number, y: number, rx: number) {
    for (let x = -rx; x <= rx; x++) for (let dy = 0; dy < 2; dy++) {
      const f = 1 - (x * x) / (rx * rx);
      if (f > 0) this.px(cx + x, y + dy, [0, 0, 0, Math.round(90 * f)]);
    }
  }
}

const WHITE: RGBA = [255, 255, 255, 255], INK: RGBA = [28, 20, 30, 255];
const WOOD: RGBA = [150, 98, 52, 255], STEEL: RGBA = [214, 222, 236, 255], STEEL_D: RGBA = [130, 140, 160, 255];
const rad = (deg: number) => (deg * Math.PI) / 180;

// ---------- poses ----------

/**
 * One frame of the puppet. Arm angles are degrees: 0 = straight ahead (the way the character faces), 90 = down,
 * -90 = up, 180 = behind. The first number is the upper arm, the second the elbow bend added for the forearm.
 * Leg angles are degrees from vertical (positive = stepping forward).
 */
interface Pose { fa: [number, number]; ba: [number, number]; fl: number; bl: number; dx: number; bob: number }
const P = (fs: number, fe: number, bs: number, be: number, o: Partial<Pose> = {}): Pose =>
  ({ fa: [fs, fe], ba: [bs, be], fl: 10, bl: -10, dx: 0, bob: 0, ...o });

/** Hand positions and forearm angles of a drawn frame (front / back arm), plus the front shoulder. */
interface Hands { fx: number; fy: number; fa: number; bx: number; by: number; ba: number; sx: number; sy: number }
type Held = (f: Frame, h: Hands, layer: 'back' | 'front') => void;

// ---------- animations ----------

export interface Animations { idle: ImageData[]; attack: ImageData[]; w: number; h: number }

/**
 * Pre-render the loops. `facing` is the way the character looks in the source picture (Maple characters face left
 * by default); attacks go that way.
 */
export function buildAnimations(base: ImageData, family: Family, facing: Facing = 'left'): Animations {
  const R = makeRig(base), dir = facing === 'left' ? -1 : 1;
  const k = Math.max(1, base.height / 48); // effect scale
  const armL = Math.max(4, Math.round(R.bodyH * 0.42)), legL = Math.max(4, Math.round(R.bodyH * 0.46));
  const t = Math.max(3, Math.round(base.height * 0.05)) | 1; // limb thickness (odd, so it centres on the joint)
  const blade = Math.round(R.bodyH * 1.05), reach = Math.round(base.width * 0.5 + 8 * k);
  const head = Math.round(R.bodyH * 0.8); // room above for a raised sword
  const feet = R.legTop + legL;
  const W = base.width + reach * 2, H = head + feet + Math.round(3 * k) + 3;
  const ox = reach, oy = head, floor = oy + feet + 1;
  const skinD = shade(R.skin, 0.82), shirtD = shade(R.shirt, 0.72), pantsD = shade(R.pants, 0.72);
  const travel = (reach + base.width * 0.3) / 5;
  // the torso without the captured hands (skin below the neck becomes shirt): the drawn arms replace them
  const torso = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  for (let y = R.neck + 1; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    const i = (y * base.width + x) * 4, d = torso.data;
    if (d[i + 3] && skinLike([d[i], d[i + 1], d[i + 2], 255])) { d[i] = R.shirt[0]; d[i + 1] = R.shirt[1]; d[i + 2] = R.shirt[2]; }
  }

  const limb = (f: Frame, sx: number, sy: number, a1: number, a2: number, fill: RGBA, end: RGBA) => {
    const ex = sx + dir * armL * Math.cos(rad(a1)), ey = sy + armL * Math.sin(rad(a1));
    const hx = Math.round(ex + dir * armL * Math.cos(rad(a2))), hy = Math.round(ey + armL * Math.sin(rad(a2)));
    f.stroke(sx, sy, ex, ey, t + 2, INK); f.stroke(ex, ey, hx, hy, t + 2, INK); f.disc(hx, hy, (t + 1) / 2 + 1, INK);
    f.stroke(sx, sy, ex, ey, t, fill); f.stroke(ex, ey, hx, hy, t, fill); f.disc(hx, hy, (t + 1) / 2, end);
    return { hx, hy };
  };
  const leg = (f: Frame, hx: number, hy: number, a: number, fill: RGBA, shoe: RGBA) => {
    const fx = hx + dir * legL * Math.sin(rad(a)), fy = Math.min(floor - 1 - (t >> 1), hy + legL * Math.cos(rad(a)));
    f.stroke(hx, hy, fx, fy, t + 2, INK); f.stroke(fx, fy, fx + dir * (t - 1), fy, t + 2, INK);
    f.stroke(hx, hy, fx, fy, t, fill); f.stroke(fx, fy, fx + dir * (t - 1), fy, t, shoe);
  };

  /** Draw the character in a pose; `held` draws what's in the hands. Returns the hand positions for effects. */
  const draw = (f: Frame, q: Pose, held: Held): Hands => {
    const bx = ox + q.dx, by = oy + q.bob, cx = bx + R.cx;
    const shY = by + R.neck + Math.round(t * 0.6);
    const fsx = cx + dir * (R.half - 1), bsx = cx - dir * (R.half - 1);
    f.shadow(cx, floor - 1, Math.round(R.headW * 0.42));
    const b = limb(f, bsx, shY, q.ba[0], q.ba[0] + q.ba[1], shirtD, skinD);
    const hipY = oy + R.legTop - 1, hipX = Math.max(1, Math.round(R.half * 0.5));
    leg(f, cx - dir * hipX, hipY, q.bl, pantsD, shade(R.shoe, 0.8));
    leg(f, cx + dir * hipX, hipY, q.fl, R.pants, R.shoe);
    f.blit(torso, bx, by, R.neck - 1, R.legTop + 1, R.cx - R.half, R.cx + R.half + 1);
    f.blit(base, bx, by, 0, R.neck); // head
    const h: Hands = { fx: 0, fy: 0, fa: q.fa[0] + q.fa[1], bx: b.hx, by: b.hy, ba: q.ba[0] + q.ba[1], sx: fsx, sy: shY };
    held(f, h, 'back');
    const fr = limb(f, fsx, shY, q.fa[0], q.fa[0] + q.fa[1], R.shirt, R.skin);
    h.fx = fr.hx; h.fy = fr.hy;
    held(f, h, 'front');
    return h;
  };

  // ----- things held in the hands -----
  const at = (x: number, y: number, a: number, d: number) => [x + dir * d * Math.cos(rad(a)), y + d * Math.sin(rad(a))] as const;
  const bowR = Math.round(armL * 1.25);
  const bow = (f: Frame, x: number, y: number, pull: readonly [number, number] | null) => {
    const pts: [number, number][] = [];
    for (let th = -75; th <= 75; th += 5) pts.push([x - dir * bowR + dir * bowR * Math.cos(rad(th)), y + bowR * Math.sin(rad(th))]);
    const [tx, ty] = pts[0], [ux, uy] = pts[pts.length - 1];
    const [px, py] = pull ?? [(tx + ux) / 2, y];
    f.line(tx, ty, px, py, [235, 235, 235, 255]); f.line(px, py, ux, uy, [235, 235, 235, 255]);
    for (let i = 1; i < pts.length; i++) f.stroke(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 3, INK);
    for (let i = 1; i < pts.length; i++) f.stroke(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 1, WOOD);
  };
  const arrowAt = (f: Frame, x: number, y: number, len: number) => {
    f.line(x, y, x + dir * len, y, [120, 82, 44, 255]);
    f.px(x + dir * (len + 1), y, STEEL); f.px(x + dir * len, y - 1, STEEL_D); f.px(x + dir * len, y + 1, STEEL_D);
    f.px(x, y - 1, WHITE); f.px(x, y + 1, WHITE); f.px(x + dir, y - 1, WHITE); f.px(x + dir, y + 1, WHITE);
  };
  const sword = (f: Frame, x: number, y: number, a: number) => {
    const [gx0, gy0] = at(x, y, a + 90, 2 * k), [gx1, gy1] = at(x, y, a - 90, 2 * k);
    const [tx, ty] = at(x, y, a, blade), [px, py] = at(x, y, a, -2 * k);
    f.stroke(x, y, tx, ty, 4, INK); f.stroke(x, y, tx, ty, 2, STEEL); f.line(x, y, tx, ty, [250, 252, 255, 255]);
    f.stroke(gx0, gy0, gx1, gy1, 3, INK); f.line(gx0, gy0, gx1, gy1, [220, 180, 70, 255]);
    f.stroke(x, y, px, py, 3, INK); f.line(x, y, px, py, [110, 70, 40, 255]);
  };
  const wand = (f: Frame, x: number, y: number, a: number, glow: number) => {
    const [tx, ty] = at(x, y, a, armL * 1.15), [bx, by] = at(x, y, a, -2);
    f.stroke(bx, by, tx, ty, 3, INK); f.line(bx, by, tx, ty, WOOD);
    f.disc(Math.round(tx), Math.round(ty), 1.5 + glow, [170, 130, 255, 255]); f.px(tx, ty, WHITE);
    return [tx, ty] as const;
  };
  const gun = (f: Frame, x: number, y: number, a: number) => {
    const [tx, ty] = at(x, y, a, 5 * k), [gx, gy] = at(x, y, a + 90, 3 * k);
    f.stroke(x, y, tx, ty, 4, INK); f.stroke(x, y, tx, ty, 2, [90, 95, 110, 255]);
    f.stroke(x, y, gx, gy, 3, INK); f.line(x, y, gx, gy, [80, 55, 35, 255]);
    return [tx, ty] as const;
  };
  const starAt = (f: Frame, x: number, y: number, spin: number, sz = 3 * k) => {
    x = Math.round(x); y = Math.round(y);
    for (let i = 0; i < 4; i++) { const a = rad(spin + i * 90); f.stroke(x, y, x + Math.cos(a) * sz, y + Math.sin(a) * sz, 3, INK); }
    for (let i = 0; i < 4; i++) { const a = rad(spin + i * 90); f.line(x, y, x + Math.cos(a) * sz, y + Math.sin(a) * sz, [215, 222, 238, 255]); }
    f.px(x, y, [90, 96, 112, 255]);
  };
  const spark = (f: Frame, x: number, y: number, c: RGBA, r = 1) => {
    f.px(x, y, WHITE);
    for (let i = 1; i <= r; i++) for (const [dx, dy] of N4) f.px(x + dx * i, y + dy * i, [c[0], c[1], c[2], 220 - i * 50]);
  };

  // ----- idle: breathing, arms swaying, weapon held -----
  const idleHeld: Held = (f, h, layer) => {
    if (family === 'bow' && layer === 'back') bow(f, h.bx, h.by, null);
    if (layer !== 'front') return;
    if (family === 'sword') sword(f, h.fx, h.fy, h.fa);
    if (family === 'wand') wand(f, h.fx, h.fy, h.fa, 0);
    if (family === 'gun') gun(f, h.fx, h.fy, h.fa);
  };
  const idle: ImageData[] = [];
  for (let i = 0; i < 8; i++) {
    const ph = Math.sin((i / 8) * Math.PI * 2), f = new Frame(W, H);
    const bob = i >= 2 && i <= 5 ? 1 : 0;
    const q = family === 'fist' ? P(35 + ph * 6, -105, 45 - ph * 6, -110, { bob })
      : family === 'bow' ? P(82 - ph * 5, -25, 70 + ph * 4, -40, { bob })
      : P(80 - ph * 5, -30, 98 + ph * 5, -12, { bob });
    draw(f, q, idleHeld);
    idle.push(f.img);
  }

  // ----- attack: keyframed poses + effects -----
  let poses: Pose[] = [];
  let held: (i: number) => Held = () => idleHeld;
  let fx: (f: Frame, h: Hands, i: number) => void = () => undefined;
  const stance = { fl: 20, bl: -18 };
  const shots: { at: number; x: number; y: number }[] = []; // projectile release points, recorded while drawing
  const flying = (i: number, draw1: (x: number, y: number, n: number) => void) => {
    for (const s of shots) if (i > s.at) draw1(s.x + dir * travel * (i - s.at), s.y, i - s.at);
  };

  switch (family) {
    case 'bow': {
      // back hand holds the bow out front; front hand draws the string to the chest, lets go, follows through
      poses = [P(70, -40, 45, 0, stance), P(35, -140, 22, 0, stance), P(25, -165, 18, 0, { ...stance, dx: -dir }), P(22, -170, 18, 0, { ...stance, dx: -dir }),
        P(165, 20, 18, 0, stance), P(150, 30, 18, 0, stance), P(130, 10, 22, 0, stance), P(110, -10, 35, 0), P(90, -20, 60, -20)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        const drawn = i >= 1 && i <= 3;
        bow(f, h.bx, h.by, drawn ? [h.fx, h.fy] : null);
        if (drawn) arrowAt(f, h.fx, h.fy, Math.abs(h.bx - h.fx) + 4 * k);
        if (i === 3) spark(f, h.bx + dir * 5 * k, h.by, [255, 240, 160, 255], 2);
        if (i === 4) { shots.push({ at: 4, x: h.bx + dir * 2 * k, y: h.by }); for (let y = -2; y <= 2; y++) f.px(h.bx - dir * 2, h.by + y * k, [255, 250, 200, 200]); }
      };
      fx = (f, _h, i) => flying(i, (x, y, n) => { arrowAt(f, x - dir * 10 * k, y, 10 * k); for (let j = 1; j <= 3; j++) f.px(x - dir * (11 * k + j * 2), y, [255, 255, 255, 130 - j * 35 - n * 5]); });
      break;
    }
    case 'sword': {
      // raise overhead, step in and swing down in front
      poses = [P(95, -30, 100, -10), P(-100, -20, 115, -20, { dx: -dir }), P(-135, -15, 125, -30, { dx: -dir }), P(-55, 0, 95, -20, { dx: dir, fl: 30, bl: -15 }),
        P(15, 0, 85, -10, { dx: 2 * dir, fl: 34, bl: -22 }), P(60, 0, 90, -10, { dx: 2 * dir, fl: 34, bl: -22 }), P(80, -10, 95, -10, { dx: dir, fl: 25 }), P(90, -20, 100, -10), P(95, -30, 100, -10)];
      held = () => (f, h, layer) => { if (layer === 'front') sword(f, h.fx, h.fy, h.fa); };
      const prev = poses.map((q, i) => (i ? poses[i - 1].fa[0] + poses[i - 1].fa[1] : q.fa[0] + q.fa[1]));
      fx = (f, h, i) => {
        if (i < 3 || i > 5) return;
        const r = armL * 2 + blade * 0.85, al = [255, 200, 110][i - 3];
        for (let a = prev[i]; a <= h.fa; a += 2) {
          for (const [dr, c, m] of [[0, WHITE, 1], [1, [170, 220, 255, 255], 0.8], [2, [110, 170, 255, 255], 0.5]] as [number, RGBA, number][]) {
            const [x, y] = at(h.sx, h.sy, a, r - dr);
            f.px(x, y, [c[0], c[1], c[2], Math.round(al * m)]);
          }
        }
      };
      break;
    }
    case 'wand': {
      // raise the wand while sparkles gather, then thrust and launch an orb
      poses = [P(90, -30, 100, -12), P(-45, -20, 65, -60), P(-70, -15, 55, -70), P(-80, -10, 55, -70, { bob: -1 }),
        P(-8, 0, 80, -40, { dx: dir, fl: 22 }), P(0, 0, 85, -30, { dx: dir, fl: 22 }), P(10, -10, 90, -20), P(50, -20, 95, -15), P(80, -30, 98, -12)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        const [tx, ty] = wand(f, h.fx, h.fy, h.fa, i >= 2 && i <= 4 ? 1 : 0);
        if (i >= 1 && i <= 3) for (let j = 0; j < 4; j++) { const a = rad(i * 50 + j * 90), r = (8 - i * 1.5) * k; spark(f, tx + Math.cos(a) * r, ty + Math.sin(a) * r, [255, 235, 140, 255]); }
        if (i === 4) shots.push({ at: 4, x: tx, y: ty });
      };
      fx = (f, _h, i) => flying(i, (x, y) => {
        const r = 3.4 * k;
        for (let dy = -Math.ceil(r); dy <= r; dy++) for (let dx = -Math.ceil(r); dx <= r; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= r) f.px(x + dx, y + dy, d < r * 0.45 ? [240, 232, 255, 255] : [140, 110, 255, Math.round(255 - (d / r) * 140)]);
        }
        for (let j = 1; j <= 4; j++) f.px(x - dir * (r + j * 3), y + (j % 2 ? -1 : 1) * k, [190, 160, 255, 210 - j * 40]);
      });
      break;
    }
    case 'stars': {
      // wind up behind the head and throw, then a second star from the other hand
      poses = [P(90, -30, 100, -15), P(160, -50, 95, -20, { dx: -dir }), P(195, -80, 90, -20, { dx: -dir }), P(-15, 0, 100, -20, { dx: dir, fl: 26 }),
        P(15, 0, 160, -60, { dx: dir, fl: 26 }), P(45, -10, -10, 0, { dx: dir, fl: 26 }), P(70, -20, 30, -10), P(85, -30, 75, -15), P(90, -30, 100, -15)];
      held = i => (f, h, layer) => {
        if (layer === 'front' && (i === 1 || i === 2)) starAt(f, h.fx, h.fy, i * 45, 2 * k);
        if (layer === 'front' && i === 3) shots.push({ at: 3, x: h.fx, y: h.fy });
        if (layer === 'back' && i === 4) starAt(f, h.bx, h.by, 20, 2 * k);
        if (layer === 'front' && i === 5) shots.push({ at: 5, x: h.bx, y: h.by });
      };
      fx = (f, _h, i) => flying(i, (x, y, n) => { starAt(f, x, y, n * 45); for (let j = 1; j <= 3; j++) f.px(x - dir * (4 * k + j * 3), y, [255, 255, 255, 120 - j * 35]); });
      break;
    }
    case 'gun': {
      // aim, two shots with recoil
      poses = [P(90, -30, 100, -12), P(20, -10, 95, -15), P(0, 0, 95, -15), P(-22, 0, 100, -15, { dx: -dir }), P(-6, 0, 98, -15),
        P(0, 0, 98, -15), P(-22, 0, 100, -15, { dx: -dir }), P(30, -10, 98, -15), P(85, -30, 100, -12)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        const [tx, ty] = gun(f, h.fx, h.fy, h.fa);
        if (i === 3 || i === 6) {
          for (const [dx, dy] of [[1, 0], [2, 0], [3, 0], [2, -1], [2, 1], [4, 0]]) f.px(tx + dir * dx * k, ty + dy * k, [255, 190, 70, 255]);
          shots.push({ at: i, x: tx, y: ty });
        }
      };
      fx = (f, _h, i) => flying(i, (x, y) => { f.stroke(x - dir * 2 * k, y, x, y, 2, [255, 225, 90, 255]); for (let j = 1; j <= 4; j++) f.px(x - dir * (2 * k + j * 2), y, [255, 240, 200, 130 - j * 30]); });
      break;
    }
    default: {
      // guard up: jab, cross, jab
      poses = [P(35, -105, 45, -110), P(15, -50, 45, -110, { dx: dir }), P(0, 0, 50, -110, { dx: 2 * dir, fl: 26 }), P(25, -90, 40, -100, { dx: dir }),
        P(40, -100, 0, 0, { dx: 2 * dir, fl: 26 }), P(40, -105, 30, -90, { dx: dir }), P(-10, -20, 45, -110, { dx: 2 * dir, fl: 26 }), P(30, -100, 45, -110), P(35, -105, 45, -110)];
      held = () => () => undefined;
      fx = (f, h, i) => {
        const hit = i === 2 || i === 6 ? [h.fx, h.fy] : i === 4 ? [h.bx, h.by] : null;
        if (!hit) return;
        const cx = hit[0] + dir * 4 * k, r = 2.5 * k;
        for (let j = 0; j < 8; j++) { const a = rad(j * 45); f.line(cx + Math.cos(a) * r, hit[1] + Math.sin(a) * r, cx + Math.cos(a) * (r + 2.5 * k), hit[1] + Math.sin(a) * (r + 2.5 * k), [255, 245, 200, 230]); }
      };
    }
  }
  const attack = poses.map((q, i) => {
    const f = new Frame(W, H);
    fx(f, draw(f, q, held(i)), i);
    return f.img;
  });
  return { idle, attack, w: W, h: H };
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
