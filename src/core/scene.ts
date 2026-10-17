import type { MapRec } from './data/osms';

/**
 * Pixel-art backdrops for the character (original art, drawn in code), one per kind of place: Henesys fields,
 * Ellinia forest, Perion cliffs, Kerning city, the subway, Lith Harbor, dungeons, Maple Island, and a neutral one
 * when the map is unknown. Drawn at native resolution (SCENE_W × SCENE_H), the same pixel scale as the character.
 */
export type Theme = 'field' | 'forest' | 'cliffs' | 'city' | 'subway' | 'harbor' | 'cave' | 'island' | 'plain';
export const SCENE_W = 212, SCENE_H = 126;
/** the row the character's feet stand on */
export const GROUND_Y = 113;

/** Pick the backdrop for a map from its region emblem, street and name. */
export function themeFor(m: MapRec | null): Theme {
  if (!m) return 'plain';
  const t = `${m.street} ${m.name}`.toLowerCase();
  if (/subway|line \d|transfer area|construction site/.test(t)) return 'subway';
  if (/dungeon|cave|tunnel|sleepywood|hollow|deep|swamp of despair/.test(t) || m.mark === 'Dungeon' || m.mark === 'ForgottenHollow') return 'cave';
  switch (m.mark) {
    case 'Henesys': return 'field';
    case 'Ellinia': return 'forest';
    case 'Perion': return 'cliffs';
    case 'KerningCity': return 'city';
    case 'Rith': return 'harbor';
    case 'MushroomVillage': case 'SouthPerry': case 'Amherst': return 'island';
    default: return m.region === 'Maple Island' ? 'island' : 'plain';
  }
}

type C = [number, number, number];
const hex = (h: string): C => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: C, b: C, t: number): C => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const W = SCENE_W, G = GROUND_Y;

class Painter {
  img = new ImageData(SCENE_W, SCENE_H);
  private seed = 7;
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  px(x: number, y: number, c: C) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H) return;
    const i = (y * SCENE_W + x) * 4, d = this.img.data;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  /** blend a colour over what's there (for light) */
  tint(x: number, y: number, c: C, a: number) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H) return;
    const i = (y * SCENE_W + x) * 4, d = this.img.data;
    d[i] += (c[0] - d[i]) * a; d[i + 1] += (c[1] - d[i + 1]) * a; d[i + 2] += (c[2] - d[i + 2]) * a;
  }
  rect(x: number, y: number, w: number, h: number, c: C) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  /** vertical gradient in a few hard bands (pixel-art banding rather than a smooth blend) */
  sky(top: string, bottom: string, y0 = 0, y1 = G, bands = 7) {
    const a = hex(top), b = hex(bottom), h = y1 - y0;
    for (let y = y0; y < y1; y++) { const t = Math.floor(((y - y0) / h) * bands) / (bands - 1); for (let x = 0; x < W; x++) this.px(x, y, mix(a, b, t)); }
  }
  /** a ridge line from summed sines; everything below it down to `y1` is filled */
  ridge(base: number, amp: number, freq: number, phase: number, c: C, y1 = G) {
    for (let x = 0; x < W; x++) {
      const top = Math.round(base - amp * (Math.sin(x * freq + phase) * 0.6 + Math.sin(x * freq * 2.3 + phase * 1.7) * 0.4));
      for (let y = top; y < y1; y++) this.px(x, y, c);
    }
  }
  cloud(x: number, y: number, w: number) {
    const Wc: C = [255, 255, 255], S: C = [214, 230, 246];
    this.rect(x + 2, y, w - 4, 2, Wc); this.rect(x, y + 2, w, 3, Wc); this.rect(x + 1, y + 5, w - 2, 1, S);
    this.rect(x + Math.round(w * 0.3), y - 2, Math.round(w * 0.35), 2, Wc);
  }
  /** ground: a top edge colour, then a fill with speckles */
  ground(edge: string, fill: string, speck: string) {
    const e = hex(edge), f = hex(fill), s = hex(speck);
    this.rect(0, G, W, 2, e);
    this.rect(0, G + 2, W, SCENE_H - G - 2, f);
    for (let k = 0; k < 80; k++) this.px(this.rnd() * W, G + 3 + this.rnd() * (SCENE_H - G - 3), s);
  }
}

function paint(theme: Theme): ImageData {
  const p = new Painter();
  switch (theme) {
    case 'field': { // Henesys: blue sky, clouds, rolling green hills, mushroom houses in the distance
      p.sky('#7cc4f4', '#d4f0ff');
      p.cloud(14, 18, 22); p.cloud(84, 10, 30); p.cloud(160, 24, 22);
      p.ridge(G - 30, 7, 0.045, 1, hex('#8fd07a'));
      p.ridge(G - 18, 5, 0.065, 3, hex('#6cbc5c'));
      for (const x of [28, 182]) { // mushroom houses
        const y = G - 31;
        p.rect(x - 4, y + 4, 9, 7, hex('#f2e2c0')); p.rect(x - 7, y, 15, 4, hex('#e8743c')); p.rect(x - 5, y - 2, 11, 2, hex('#e8743c'));
        p.px(x - 3, y + 1, hex('#ffffff')); p.px(x + 3, y, hex('#ffffff')); p.rect(x - 1, y + 7, 2, 4, hex('#8a5a34'));
      }
      p.ground('#5aa84a', '#a8744a', '#8e5e38');
      break;
    }
    case 'island': { // Maple Island: bright sky, sea on the horizon, grass
      p.sky('#8fd4ff', '#e6f8ff');
      p.cloud(22, 20, 24); p.cloud(120, 12, 28); p.cloud(176, 28, 20);
      p.rect(0, G - 28, W, 28, hex('#4aa8e0'));
      for (let k = 0; k < 60; k++) p.rect(p.rnd() * W, G - 26 + p.rnd() * 22, 3, 1, hex('#bfe8ff'));
      p.ridge(G - 8, 4, 0.06, 2, hex('#7ccc68'));
      p.ground('#5aa84a', '#c89a64', '#ad8250');
      break;
    }
    case 'forest': { // Ellinia: deep green, tall trunks, canopy, light shafts
      p.sky('#3e7a5a', '#a6d8a0');
      for (let x = 4; x < W; x += 22) p.rect(x, 24, 5, G - 24, hex('#4e6a44')); // far trunks
      for (let k = 0; k < 5; k++) { const x = 6 + k * 44; for (let y = 0; y < G; y++) for (let w = 0; w < 6; w++) p.tint(x + Math.floor(y / 5) + w, y, hex('#f4ffd0'), w === 0 || w === 5 ? 0.1 : 0.2); }
      for (const x of [14, 66, 150, 196]) { p.rect(x, 0, 9, G, hex('#6e4a2c')); p.rect(x + 1, 0, 2, G, hex('#8e6440')); }
      for (let x = 0; x < W; x++) { const h = 16 + Math.round(5 * Math.sin(x * 0.15) + 3 * Math.sin(x * 0.41)); p.rect(x, 0, 1, h, hex('#2e6a3c')); p.px(x, h, hex('#4e9a54')); }
      p.ground('#4e9a54', '#5a4030', '#3e2c20');
      break;
    }
    case 'cliffs': { // Perion: warm sky, red rock mesas, dry ground
      p.sky('#f4b46c', '#fde8c0');
      p.ridge(G - 44, 14, 0.035, 2, hex('#c86a44'));
      p.ridge(G - 24, 9, 0.055, 5, hex('#a8503a'));
      for (let k = 0; k < 40; k++) p.rect(p.rnd() * W, G - 34 + p.rnd() * 32, 2, 1, hex('#8e3e2c'));
      p.ground('#d8a060', '#b0784a', '#946238');
      break;
    }
    case 'city': { // Kerning City: dusk, building silhouettes with lit windows
      p.sky('#3a2e5c', '#e88a74');
      for (let x = 0; x < W;) {
        const w = 12 + Math.floor(p.rnd() * 14), h = 26 + Math.floor(p.rnd() * 44), top = G - h;
        p.rect(x, top, w, h, hex('#2a2440'));
        for (let wy = top + 3; wy < G - 4; wy += 5) for (let wx = x + 2; wx < x + w - 2; wx += 4) if (p.rnd() < 0.45) p.rect(wx, wy, 2, 2, hex('#ffd86a'));
        x += w + 1;
      }
      p.ground('#6a6a7a', '#44445a', '#36364a');
      break;
    }
    case 'subway': { // tiled wall, a pipe, signs, rails
      p.rect(0, 0, W, G, hex('#4a5060'));
      for (let y = 0; y < G; y += 8) for (let x = (y / 8) % 2 ? 0 : 6; x < W; x += 12) p.rect(x, y, 11, 7, hex('#5a6072'));
      p.rect(0, 22, W, 4, hex('#7a7f8c')); p.rect(0, 23, W, 1, hex('#a0a4ae'));
      for (let x = 14; x < W; x += 50) { p.rect(x, 44, 28, 15, hex('#f0e6a8')); p.rect(x + 2, 46, 24, 11, hex('#3a3a48')); }
      p.ground('#8a8a96', '#2e2e38', '#4a4a56');
      p.rect(0, G + 7, W, 1, hex('#b0b0bc'));
      break;
    }
    case 'harbor': { // Lith Harbor: sky, sea, wooden dock
      p.sky('#6cb8f0', '#d8f2ff');
      p.cloud(30, 16, 26); p.cloud(140, 24, 22);
      p.rect(0, G - 34, W, 34, hex('#2e7cc0'));
      for (let k = 0; k < 70; k++) p.rect(p.rnd() * W, G - 32 + p.rnd() * 30, 4, 1, hex('#8ccaf4'));
      for (let x = 10; x < W; x += 30) p.rect(x, G - 22, 3, 22, hex('#6e4a2c'));
      p.rect(0, G, W, SCENE_H - G, hex('#9a6a40'));
      for (let x = 0; x < W; x += 10) p.rect(x, G, 1, SCENE_H - G, hex('#7a5030'));
      p.rect(0, G, W, 1, hex('#c08a58'));
      break;
    }
    case 'cave': { // dungeon: dark rock, stalactites, glowing mushrooms
      p.sky('#1a1622', '#3a2e34');
      for (let x = 0; x < W; x += 7) { const h = 4 + Math.floor(p.rnd() * 16); for (let y = 0; y < h; y++) p.rect(x + Math.floor(y / 4), y, Math.max(1, 5 - Math.floor(y / 3)), 1, hex('#2e2630')); }
      p.ridge(G - 22, 9, 0.06, 1, hex('#2a2228'));
      for (const x of [22, 70, 150, 192]) { p.rect(x, G - 4, 2, 4, hex('#d8d0c0')); p.rect(x - 2, G - 7, 6, 3, hex('#7ae0c8')); p.px(x - 1, G - 6, hex('#e0fff8')); }
      p.ground('#4a3e44', '#2a2228', '#3a3036');
      break;
    }
    default: { // unknown map: a calm gradient with a few stars
      p.sky('#232838', '#3a4258');
      for (let k = 0; k < 34; k++) p.px(p.rnd() * W, p.rnd() * (G - 30), hex('#9aa4c0'));
      p.ground('#4a5068', '#2e3344', '#3a4054');
    }
  }
  return p.img;
}

const cache = new Map<Theme, ImageData>();
/** The backdrop for a theme (painted once, then cached). */
export function sceneImage(theme: Theme): ImageData {
  let im = cache.get(theme);
  if (!im) { im = paint(theme); cache.set(theme, im); }
  return im;
}
