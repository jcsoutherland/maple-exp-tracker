import { describe, expect, it } from 'vitest';
import FONT from './data/logfont.json';
import { matchLine, nativeStrip, type NameLists } from './logmatch';

/**
 * Synthetic pickup-log lines, drawn the way the game draws them: GDI Arial 12 glyphs at their advances, right-aligned,
 * with a 1 px black shadow down-right, on the native HUD grid, then scaled to the screen by k (nearest neighbour).
 */
const G = (FONT as { glyphs: Record<string, { adv: number; x: number; y: number; rows: string }> }).glyphs;
interface Opts {
  k?: number; X?: number; Y?: number;
  bg?: (x: number, y: number) => [number, number, number];
  color?: [number, number, number]; alpha?: number;
  /** native-pixel boxes [x0, y0, x1, y1) painted over the text (a player or a skill effect) */
  cover?: [number, number, number, number][];
}
const NW = 240, NH = 20, XR = 232, TOP = 3; // native strip size, the ")" ink edge, the text cell's top
function drawLine(text: string, o: Opts = {}) {
  const { k = 1, X = 0, Y = 0, color = [251, 249, 246], alpha = 1 } = o, bg = o.bg ?? (() => [40, 44, 52]);
  const ink = new Uint8Array(NW * NH);
  const right = G[')'].x + G[')'].rows.split(' ')[0].length - 1;
  let pen = XR - right + G[')'].adv;
  for (let i = text.length - 1; i >= 0; i--) {
    const g = G[text[i]]; pen -= g.adv;
    if (g.rows) g.rows.split(' ').forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') ink[(TOP + g.y + y) * NW + pen + g.x + x] = 1; }));
  }
  const nat = new Float32Array(NW * NH * 3);
  for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
    let px = bg(x, y);
    if (y > 0 && x > 0 && ink[(y - 1) * NW + x - 1]) px = px.map(v => v * (1 - alpha)) as typeof px; // shadow
    if (ink[y * NW + x]) px = px.map((v, i) => v * (1 - alpha) + color[i] * alpha) as typeof px;
    if (o.cover?.some(([a, b, c, d]) => x >= a && x < c && y >= b && y < d)) px = [(x * 37) % 255, (y * 91) % 255, 200];
    nat.set(px, (y * NW + x) * 3);
  }
  // to the screen like a GPU's nearest-neighbour scaling: screen pixel x shows native pixel floor((x + 0.5) / k)
  const u0 = Math.ceil(X / k - 0.5), v0 = Math.ceil(Y / k - 0.5), W = Math.floor(NW * k), H = Math.floor(NH * k), rgba = new Uint8ClampedArray(W * H * 4);
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    const u = Math.min(NW - 1, Math.max(0, Math.floor((X + sx + 0.5) / k) - u0)), v = Math.min(NH - 1, Math.max(0, Math.floor((Y + sy + 0.5) / k) - v0)), i = (v * NW + u) * 3;
    rgba.set([nat[i], nat[i + 1], nat[i + 2], 255], (sy * W + sx) * 4);
  }
  return nativeStrip(rgba, W, H, X, Y, k);
}
const names: NameLists = { likely: ['Tablecloth', 'Jr. Necki Skin', 'White Potion'], all: ['Tablecloth', 'Jr. Necki Skin', 'White Potion', 'Red Potion', 'Orange Potion', 'Blue Potion', 'Snail Shell', 'Leather', "Pig's Ribbon"] };
const read = (text: string, o: Opts = {}, n = names) => matchLine(drawLine(text, o), n, null, process.env.DBG ? i => console.log(text, JSON.stringify(i)) : undefined)?.text ?? null;
const bright = (x: number, y: number): [number, number, number] => { const v = 205 + ((x * 13 + y * 7) % 40); return [v, v, v - 5]; };

describe('pickup-log template matcher', () => {
  it('reads meso, EXP and party lines at native size (Ideal ratio)', () => {
    for (const t of ['You have gained mesos (+9)', 'You have gained mesos (+25)', 'You have gained mesos (+1234)']) expect(read(t)).toBe(t);
    expect(matchLine(drawLine('You received EXP (+21)'), names)).toMatchObject({ kind: 'exp', text: 'You received EXP (+21)' });
    expect(matchLine(drawLine('Bonus EXP for PARTY (+6)', { color: [255, 238, 102] }), names)?.kind).toBe('exp');
  });
  it('reads item lines: the tab, the count and the name from the candidates', () => {
    expect(read('Tablecloth x1 earned. (Etc)')).toBe('Tablecloth x1 earned. (Etc)');
    expect(read('White Potion x12 earned. (Use)')).toBe('White Potion x12 earned. (Use)');
    // not expected on this map, but a known item of the right width
    expect(read('Snail Shell x1 earned. (Etc)')).toBe('Snail Shell x1 earned. (Etc)');
    // unknown everywhere: left to OCR
    expect(read('Mystery Box x1 earned. (Etc)')).toBeNull();
  });
  it('reads white text on a bright background by its shadow', () => {
    expect(read('You have gained mesos (+28)', { bg: bright })).toBe('You have gained mesos (+28)');
    expect(read('Jr. Necki Skin x1 earned. (Etc)', { bg: bright })).toBe('Jr. Necki Skin x1 earned. (Etc)');
  });
  it('reads fading lines', () => {
    expect(read('You have gained mesos (+10)', { alpha: 0.6 })).toBe('You have gained mesos (+10)');
  });
  it('reads the Default ratio, scaled up with the window (1080p: ×1.40625), at the log\'s screen position', () => {
    const k = 1080 / 768;
    expect(read('You have gained mesos (+307)', { k, X: 1606, Y: 840 })).toBe('You have gained mesos (+307)');
    expect(read('Tablecloth x1 earned. (Etc)', { k, X: 1606, Y: 860, bg: bright })).toBe('Tablecloth x1 earned. (Etc)');
  });
  it('reads a partly covered line while its digits show, and gives up when they don\'t', () => {
    expect(read('You have gained mesos (+9)', { cover: [[70, 0, 140, 20]] })).toBe('You have gained mesos (+9)');
    expect(read('You have gained mesos (+9)', { cover: [[218, 0, 228, 20]] })).toBeNull();
  });
  it('rejects things that are not log lines', () => {
    const noise = drawLine('', { bg: (x, y) => { const v = ((x * 7919 + y * 104729) % 251); return [v, v, v]; } });
    expect(matchLine(noise, names)).toBeNull();
    expect(matchLine(drawLine(''), names)).toBeNull();
  });
});

describe('item names', () => {
  it('prefers the right-width item over an expected name that only ends like it', () => {
    const n = { likely: ['Iron Arrows for Bows'], all: ['Arrows for Bows', 'Iron Arrows for Bows'] };
    expect(read('Arrows for Bows x27 earned. (Use)', {}, n)).toBe('Arrows for Bows x27 earned. (Use)');
  });
});
describe('item names next to a window border', () => {
  it('a border left of the line does not make it a longer name', () => {
    const n = { likely: ['Iron Arrows for Bows'], all: ['Arrows for Bows', 'Iron Arrows for Bows'] };
    const border = (x: number): [number, number, number] => (x >= 46 && x <= 47 ? [230, 230, 230] : [40, 44, 52]);
    expect(read('Arrows for Bows x27 earned. (Use)', { bg: border }, n)).toBe('Arrows for Bows x27 earned. (Use)');
  });
});
