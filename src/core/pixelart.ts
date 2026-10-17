/**
 * Pixel-art explorer avatars, drawn in code (original art, no external assets): one look per job branch —
 * Warrior, Magician, Bowman, Thief, Beginner. Head, headgear and torso are hand-authored pixel sprites; arms and legs
 * are 2px limbs on a small skeleton, so poses can be keyframed. Everything (body, weapons, effects) is drawn on one
 * native pixel grid and only ever enlarged by whole-number zoom, like a real sprite.
 */

export type Look = 'warrior' | 'magician' | 'bowman' | 'thief' | 'beginner';
type RGBA = [number, number, number, number];
type Pal = Record<string, RGBA>;

const BRANCH: [Look, string[]][] = [
  ['bowman', ['bowman', 'archer', 'hunter', 'ranger', 'bowmaster', 'crossbow', 'sniper', 'marksman']],
  ['magician', ['magician', 'wizard', 'mage', 'cleric', 'priest', 'bishop']],
  ['thief', ['thief', 'rogue', 'assassin', 'hermit', 'night lord', 'bandit', 'shadower']],
  ['warrior', ['warrior', 'swordman', 'swordsman', 'fighter', 'page', 'spearman', 'crusader', 'knight', 'hero', 'paladin']],
];

/** Job branch for a job name (Beginner / unknown → the beginner look). */
export function classLook(cls: string): Look {
  const c = (cls || '').toLowerCase();
  return BRANCH.find(([, keys]) => keys.some(k => c.includes(k)))?.[0] ?? 'beginner';
}

// ---------- canvas on the native pixel grid ----------

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
  /** Draw an authored sprite: one string per row, one palette letter per pixel ('.' = empty). */
  sprite(rows: string[], pal: Pal, x: number, y: number) {
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const c = pal[row[i]]; if (c) this.px(x + i, y + j, c); } });
  }
  /** Square brush of `size` stamped along a pixel line (size 2 = a 2px limb, size 4 = its outline). */
  brush(x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const o = -Math.floor((size - 2) / 2), n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + (x1 - x0) * k / n), y = Math.round(y0 + (y1 - y0) * k / n);
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) this.px(x + o + dx, y + o + dy, c);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) this.px(x0 + Math.round((x1 - x0) * k / n), y0 + Math.round((y1 - y0) * k / n), c);
  }
}

const rgb = (hex: string, a = 255): RGBA => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), a];
const shade = (c: RGBA, k: number): RGBA => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), c[3]];
const rad = (deg: number) => (deg * Math.PI) / 180;
const INK = rgb('#24182a'), WHITE = rgb('#ffffff');

// ---------- authored sprites (all facing left) ----------

// 20×19 head: hair on top and at the back (right), face front-left, eyes, ear.
const HEAD = [
  '......oooooooo......',
  '....ooLLLLhhhhoo....',
  '...oLLLhhhhhhhhho...',
  '..oLLhhhhhhhhhhhHo..',
  '.oLhhhhhhhhhhhhhHHo.',
  '.ohhhhhhhhhhhhhhhHo.',
  'ohhhhhhhhhhhhhhhhHHo',
  'ohhhhhhhhhhhhhhhhHHo',
  'ohhhhshhhhhshhhhhHHo',
  'ohhsssshhhsssshhhHHo',
  'ohsssssssssssssohHHo',
  'osseessssseessosoHHo',
  'osseEsssssEessosoHHo',
  'osswEsssssEwssSsoHo.',
  'osssssssssssssSoHHo.',
  '.osssssssmmssSSoHo..',
  '.oSssssssssssSoo....',
  '..ooSSsssssSSoo.....',
  '....ooooooooo.......',
];

const FACE: Pal = { o: INK, s: rgb('#ffdcbc'), S: rgb('#eab48e'), e: rgb('#2a1e36'), E: rgb('#4f63c4'), w: WHITE, m: rgb('#c0605a') };

interface LookDef {
  hair: [string, string, string]; // base, shadow, light
  hat: { rows: string[]; pal: Pal; dx: number; dy: number } | null;
  torso: { rows: string[]; pal: Pal };
  sleeve: RGBA; pants: RGBA; shoe: RGBA;
}

const LOOKS: Record<Look, LookDef> = {
  warrior: {
    hair: ['#4a4250', '#2e2934', '#6e6577'],
    hat: { // steel helmet with brow band, nose guard and cheek guard
      dx: -1, dy: -2, pal: { o: INK, g: rgb('#a9b0bf'), G: rgb('#dfe4ee'), d: rgb('#6f7688'), b: rgb('#8a6a3c') },
      rows: [
        '......oooooooooo......',
        '....ooGGGggggggdoo....',
        '...oGGGgggggggggddo...',
        '..oGGgggggggggggggdo..',
        '.oGGgggggggggggggggdo.',
        '.oGggggggggggggggggdo.',
        'oGgggggggggggggggggddo',
        'oggggggggggggggggggddo',
        'obbbbbbbbbbbbbbbbbbbbo',
        'oooooooogoooooooggddo.',
        '.......ogo.....oggddo.',
        '.......ogo.....ogddo..',
        '........o......oddo...',
        '................oo....',
      ],
    },
    torso: {
      pal: { o: INK, g: rgb('#a9b0bf'), G: rgb('#dfe4ee'), d: rgb('#6f7688'), r: rgb('#c8393f'), R: rgb('#8e2228'), b: rgb('#6b4a2a'), y: rgb('#f2c14e') },
      rows: [
        '..oooooo..',
        '.oGgrrgdo.',
        'oGggrrggdo',
        'oGgrrrrgdo',
        'oggrRrrgdo',
        'oggrRrrgdo',
        'obbbybbbbo',
        'oddrRrrddo',
        'oooooooooo',
      ],
    },
    sleeve: rgb('#a9b0bf'), pants: rgb('#55566a'), shoe: rgb('#6b4a2a'),
  },
  magician: {
    hair: ['#f3cd6e', '#c99a45', '#fff0b0'],
    hat: { // tall pointed hat leaning back, gold band, wide brim
      dx: -2, dy: -9, pal: { o: INK, p: rgb('#5b3f8c'), P: rgb('#7d5fb5'), k: rgb('#3d2963'), y: rgb('#f2c14e') },
      rows: [
        '................oo......',
        '...............oPko.....',
        '..............oPpko.....',
        '.............oPppko.....',
        '............oPpppko.....',
        '...........oPppppko.....',
        '..........oPPpppppko....',
        '.........oPPppppppko....',
        '........oPPpppppppko....',
        '.......oPPppppppppko....',
        '......oPPpppppppppPko...',
        '.....oyyyyyyyyyyyyyyyo..',
        '.....okkkkkkkkkkkkkkko..',
        '.ooPPPPpppppppppppppppoo',
        'oPPPppppppppppppppppppko',
        '.oooooooooooooooooooooo.',
      ],
    },
    torso: { // robe down to the ankles
      pal: { o: INK, u: rgb('#4560c8'), U: rgb('#7590ea'), k: rgb('#2c3c8a'), y: rgb('#f2c14e'), b: rgb('#6b4a2a') },
      rows: [
        '...oooooo...',
        '..oUuyyuko..',
        '.oUuuyyuuko.',
        '.oUuuyyuuko.',
        '.oUuuyyuuko.',
        '.obbbbybbbo.',
        '.oUuuyyuuko.',
        'oUuuuyyuuuko',
        'oUuuuyyuuuko',
        'oUuuuyyuuuko',
        'okkkkyykkkko',
        'oooooooooooo',
      ],
    },
    sleeve: rgb('#4560c8'), pants: rgb('#2c3c8a'), shoe: rgb('#5a3d70'),
  },
  bowman: {
    hair: ['#cf7a3c', '#96512a', '#f0aa66'],
    hat: { // feathered cap
      dx: -1, dy: -4, pal: { o: INK, c: rgb('#6f8f3a'), C: rgb('#9cbc5a'), k: rgb('#4a6326'), r: rgb('#d8483e'), R: rgb('#ff8a70') },
      rows: [
        '..................oo..',
        '.................orRo.',
        '................orRo..',
        '.......ooooooo.orRo...',
        '.....ooCCCcccccoRo....',
        '...ooCCcccccccccko....',
        '..oCCccccccccccccko...',
        '.oCccccccccccccccko...',
        'okkkkkkkkkkkkkkkkkkoo.',
        '.ooooooooooooooooooo..',
      ],
    },
    torso: {
      pal: { o: INK, y: rgb('#e0b04a'), Y: rgb('#f6d27a'), t: rgb('#a87a2a'), c: rgb('#6f8f3a'), b: rgb('#6b4a2a'), g: rgb('#f2c14e') },
      rows: [
        '..oooooo..',
        '.oYccccto.',
        'oYyyccyyto',
        'oYyyyyyyto',
        'oYyyyyyyto',
        'oYyyyyyyto',
        'obbbgbbbbo',
        'otttttttto',
        'oooooooooo',
      ],
    },
    sleeve: rgb('#e0b04a'), pants: rgb('#7a5530'), shoe: rgb('#4e3420'),
  },
  thief: {
    hair: ['#5a3a30', '#3a241e', '#80584a'],
    hat: { // bandana knotted at the back
      dx: -1, dy: -1, pal: { o: INK, n: rgb('#3a3d5c'), N: rgb('#5d6290'), w: rgb('#e8e8f0') },
      rows: [
        '.....oooooooooo........',
        '...ooNNNnnnnnnnoo......',
        '..oNNnnnnnnnnnnnno.....',
        '.oNnnnnnnnnnnnnnnno....',
        '.onnnnnnnnnnnnnnnnno...',
        'onnnnnnnnnnnnnnnnnnoo..',
        'owwwwwwwwwwwwwwwwnnnnoo',
        'oooooooooooooooonnnnno.',
        '...............onnnno..',
        '...............onnno...',
        '................ooo....',
      ],
    },
    torso: {
      pal: { o: INK, n: rgb('#3a3d5c'), N: rgb('#5d6290'), a: rgb('#8a8fa8'), v: rgb('#8e44ad'), V: rgb('#b56ad6'), b: rgb('#2a2a3a'), y: rgb('#c0c4d4') },
      rows: [
        '..oooooo..',
        '.oVvvvvvo.',
        'oNvvvvvvno',
        'oNnnvnnnno',
        'oNnaannnno',
        'oNnaannnno',
        'obbbybbbbo',
        'onnnnnnnno',
        'oooooooooo',
      ],
    },
    sleeve: rgb('#6a6f9e'), pants: rgb('#2c2e46'), shoe: rgb('#1e1e2a'),
  },
  beginner: {
    hair: ['#7a4a2e', '#55301c', '#a06a46'],
    hat: null,
    torso: {
      pal: { o: INK, w: rgb('#f4f4f4'), W: rgb('#ffffff'), g: rgb('#c9ccd6'), b: rgb('#3e5fa8'), B: rgb('#2c447a') },
      rows: [
        '..oooooo..',
        '.oWwwwwgo.',
        'oWwwwwwwgo',
        'oWwwwwwwgo',
        'oWwwwwwwgo',
        'oWwwwwwwgo',
        'obbbbbbbBo',
        'obbbbbbbBo',
        'oooooooooo',
      ],
    },
    sleeve: rgb('#f4f4f4'), pants: rgb('#3e5fa8'), shoe: rgb('#5a3a24'),
  },
};

// ---------- skeleton & poses ----------

/**
 * One frame of the skeleton. Arm angles in degrees: 0 = straight ahead (facing direction), 90 = down, -90 = up,
 * 180 = behind; the first number is the upper arm, the second the elbow bend added for the forearm. Legs: degrees
 * from vertical, positive = forward. `dx` shifts the upper body forward (+) / back (−), `bob` down (+).
 */
interface Pose { fa: [number, number]; ba: [number, number]; fl: number; bl: number; dx: number; bob: number }
const P = (fs: number, fe: number, bs: number, be: number, o: Partial<Pose> = {}): Pose =>
  ({ fa: [fs, fe], ba: [bs, be], fl: 6, bl: -6, dx: 0, bob: 0, ...o });

/** Where the hands ended up (top-left pixel of the 2×2 hand) and the forearm angles; the front shoulder. */
interface Hands { fx: number; fy: number; fa: number; bx: number; by: number; ba: number; sx: number; sy: number }
type Held = (f: Frame, h: Hands, layer: 'back' | 'front') => void;

export interface Animations { look: Look; idle: ImageData[]; attack: ImageData[]; w: number; h: number; idleMs: number; attackMs: number }

const W = 78, H = 54, CX = 50, GROUND = 50; // feet stand on row GROUND-1; room on the left for projectiles
const L1 = 4, L2 = 3; // upper arm, forearm (px)
const dir = -1; // all sprites face left, like Maple characters by default

function build(look: Look): Animations {
  const L = LOOKS[look], skin = FACE.s;
  const headPal: Pal = { ...FACE, h: rgb(L.hair[0]), H: rgb(L.hair[1]), L: rgb(L.hair[2]) };
  const sleeveD = shade(L.sleeve, 0.78), skinD = shade(skin, 0.86), pantsD = shade(L.pants, 0.78), shoeD = shade(L.shoe, 0.8);
  const hipY = GROUND - 9, torsoTop = GROUND - 17, headTop = torsoTop - 17;

  const limb = (f: Frame, sx: number, sy: number, a1: number, a2: number, fill: RGBA, hand: RGBA) => {
    const ex = Math.round(sx + dir * L1 * Math.cos(rad(a1))), ey = Math.round(sy + L1 * Math.sin(rad(a1)));
    const hx = Math.round(ex + dir * L2 * Math.cos(rad(a2))), hy = Math.round(ey + L2 * Math.sin(rad(a2)));
    f.brush(sx, sy, ex, ey, 4, INK); f.brush(ex, ey, hx, hy, 4, INK);
    f.brush(sx, sy, ex, ey, 2, fill); f.brush(ex, ey, hx, hy, 2, fill);
    f.brush(hx, hy, hx, hy, 2, hand);
    return { hx, hy };
  };
  const leg = (f: Frame, hx: number, a: number, pants: RGBA, shoe: RGBA) => {
    const fx = Math.round(hx + dir * Math.sin(rad(a)) * 6), fy = Math.min(GROUND - 2, Math.round(hipY + Math.cos(rad(a)) * 6));
    f.brush(hx, hipY, fx, fy, 4, INK); f.brush(fx, fy, fx + dir, fy, 4, INK);
    f.brush(hx, hipY, fx, fy, 2, pants); f.brush(fx, fy, fx + dir, fy, 2, shoe);
  };

  /** Draw the character in a pose; `held` draws weapons. Returns hand positions for effects. */
  const draw = (f: Frame, q: Pose, held: Held): Hands => {
    const ox = CX + dir * q.dx, oy = q.bob;
    for (let x = -7; x <= 7; x++) f.px(CX + x, GROUND - 1, [0, 0, 0, Math.abs(x) > 5 ? 40 : 75]); // ground shadow
    const shY = torsoTop + 2 + oy, fsx = ox + dir * 3, bsx = ox - dir * 3;
    const b = limb(f, bsx, shY, q.ba[0], q.ba[0] + q.ba[1], sleeveD, skinD);
    leg(f, CX - dir * 2, q.bl, pantsD, shoeD);
    leg(f, CX + dir * 1, q.fl, L.pants, L.shoe);
    const tw = L.torso.rows[0].length;
    f.sprite(L.torso.rows, L.torso.pal, ox - (tw >> 1), torsoTop + oy);
    f.sprite(HEAD, headPal, ox - 10, headTop + oy);
    if (L.hat) f.sprite(L.hat.rows, L.hat.pal, ox - 10 + L.hat.dx, headTop + oy + L.hat.dy);
    const h: Hands = { fx: 0, fy: 0, fa: q.fa[0] + q.fa[1], bx: b.hx, by: b.hy, ba: q.ba[0] + q.ba[1], sx: fsx, sy: shY };
    held(f, h, 'back');
    f.brush(b.hx, b.hy, b.hx, b.hy, 2, skinD); // the back hand grips whatever it holds
    const fr = limb(f, fsx, shY, q.fa[0], q.fa[0] + q.fa[1], L.sleeve, skin);
    h.fx = fr.hx; h.fy = fr.hy;
    held(f, h, 'front');
    f.brush(h.fx, h.fy, h.fx, h.fy, 2, skin);
    return h;
  };

  // ----- weapons & effects (native pixels) -----
  const at = (x: number, y: number, a: number, d: number) => [x + dir * d * Math.cos(rad(a)), y + d * Math.sin(rad(a))] as const;
  const STEEL = rgb('#e4e9f2'), STEEL_D = rgb('#9aa3b5'), WOOD = rgb('#9a6634'), GOLD = rgb('#f2c14e');

  const sword = (f: Frame, x: number, y: number, a: number) => {
    const [tx, ty] = at(x + 0.5, y + 0.5, a, 11), [px, py] = at(x + 0.5, y + 0.5, a, -2);
    const [g0x, g0y] = at(x + 0.5, y + 0.5, a + 90, 2), [g1x, g1y] = at(x + 0.5, y + 0.5, a - 90, 2);
    f.brush(x, y, tx, ty, 3, INK); f.line(x, y, tx, ty, STEEL); f.px(tx, ty, WHITE);
    f.line(g0x, g0y, g1x, g1y, GOLD); f.line(x, y, px, py, rgb('#6b4a2a'));
  };
  const wand = (f: Frame, x: number, y: number, a: number, glow: boolean) => {
    const [tx, ty] = at(x + 0.5, y + 0.5, a, 7);
    f.brush(x, y, tx, ty, 3, INK); f.line(x, y, tx, ty, WOOD);
    f.brush(tx, ty, tx, ty, 4, INK); f.brush(tx, ty, tx, ty, 2, glow ? rgb('#e6d8ff') : rgb('#a77bff'));
    if (glow) f.px(tx, ty, WHITE);
    return [Math.round(tx), Math.round(ty)] as const;
  };
  /** Bow gripped by the hand at (x,y): a 13px arc, grip forward-most, tips curving back; string to `pull` (straight when relaxed). */
  const bow = (f: Frame, x: number, y: number, pull: readonly [number, number] | null) => {
    const back = [3, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 2, 3]; // how far each row of the limb curves back toward the archer
    const gx = x + (dir < 0 ? 0 : 1), pts = back.map((b, k) => [gx - dir * b, y + 1 + k - 6] as const), top = pts[0], bot = pts[pts.length - 1];
    const s = pull ?? [top[0], y + 1];
    for (const [px, py] of pts) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) f.px(px + dx, py + dy, INK);
    f.line(top[0], top[1], s[0], s[1], rgb('#f0f0f0')); f.line(s[0], s[1], bot[0], bot[1], rgb('#f0f0f0'));
    for (const [px, py] of pts) f.px(px, py, WOOD);
    f.px(top[0], top[1], GOLD); f.px(bot[0], bot[1], GOLD);
  };
  const arrow = (f: Frame, x: number, y: number) => { // tip at (x,y), pointing forward
    f.line(x - dir, y, x - dir * 7, y, rgb('#8a5a2c'));
    f.px(x, y, STEEL); f.px(x - dir, y - 1, STEEL_D); f.px(x - dir, y + 1, STEEL_D);
    f.px(x - dir * 7, y - 1, WHITE); f.px(x - dir * 8, y - 1, WHITE); f.px(x - dir * 7, y + 1, WHITE); f.px(x - dir * 8, y + 1, WHITE);
  };
  const star = (f: Frame, x: number, y: number, turn: number) => { // throwing star, alternating + and × as it spins
    const arms = turn % 2 ? [[1, 1], [-1, -1], [1, -1], [-1, 1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [ax, ay] of arms) for (let k = 0; k <= 2; k++) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) f.px(x + ax * k + dx, y + ay * k + dy, INK);
    for (const [ax, ay] of arms) { f.px(x + ax, y + ay, STEEL); f.px(x + ax * 2, y + ay * 2, STEEL_D); }
    f.px(x, y, rgb('#5a6070'));
  };
  const sparkle = (f: Frame, x: number, y: number, c: RGBA) => { f.px(x, y, WHITE); f.px(x - 1, y, c); f.px(x + 1, y, c); f.px(x, y - 1, c); f.px(x, y + 1, c); };
  const claw = (f: Frame, x: number, y: number) => { f.px(x + dir, y - 1, INK); f.px(x + dir * 2, y - 1, STEEL_D); f.px(x + dir * 2, y, STEEL); f.px(x + dir * 2, y + 1, STEEL); f.px(x + dir * 3, y, INK); f.px(x + dir * 3, y + 1, INK); };

  // ----- idle: 4 frames, slow breathing -----
  const idleHeld: Held = (f, h, layer) => {
    if (layer !== 'front') return;
    if (look === 'bowman') bow(f, h.fx, h.fy, null);
    if (look === 'warrior') sword(f, h.fx, h.fy, h.fa - 15);
    if (look === 'magician') wand(f, h.fx, h.fy, h.fa - 75, false);
    if (look === 'thief') claw(f, h.fx, h.fy);
  };
  const idlePose = (k: number) => {
    const sway = [0, 4, 8, 4][k], bob = k === 2 ? 1 : 0;
    if (look === 'beginner') return P(70 - sway, -20, 100 + sway, -10, { bob });
    if (look === 'bowman') return P(78 - sway, -8, 100 + sway, -10, { bob });
    if (look === 'magician') return P(65 - sway, -45, 100 + sway, -10, { bob });
    return P(75 - sway, -15, 100 + sway, -10, { bob });
  };
  const idle = [0, 1, 2, 3].map(k => { const f = new Frame(W, H); draw(f, idlePose(k), idleHeld); return f.img; });

  // ----- attack: 8 keyframes per class -----
  let poses: Pose[] = [];
  let held: (i: number) => Held = () => idleHeld;
  let fx: (f: Frame, h: Hands, i: number) => void = () => undefined;
  const shots: { at: number; x: number; y: number }[] = []; // projectile launch points, recorded while drawing
  const flying = (i: number, speed: number, drawOne: (x: number, y: number, n: number) => void) => {
    for (const s of shots) if (i > s.at) drawOne(Math.round(s.x + dir * speed * (i - s.at)), s.y, i - s.at);
  };
  const stance = { fl: 14, bl: -14 };

  switch (look) {
    case 'bowman': {
      // front arm raises the bow, the back hand draws the string to the chest, lets go and swings back
      poses = [P(50, -5, 100, -10, stance), P(28, 0, 45, -140, stance), P(25, 0, 35, -160, { ...stance, dx: -1 }), P(25, 0, 150, 10, stance),
        P(25, 0, 140, 10, stance), P(32, 0, 115, 0, stance), P(50, -5, 100, -10), P(68, -8, 100, -10)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        const drawn = i === 1 || i === 2;
        bow(f, h.fx, h.fy, drawn ? [h.bx, h.fy + 1] : null);
        if (drawn) arrow(f, h.fx + dir * 3, h.fy + 1);
        if (i === 3) { shots.push({ at: 3, x: h.fx + dir * 4, y: h.fy + 1 }); f.px(h.fx - dir * 3, h.fy - 5, WHITE); f.px(h.fx - dir * 3, h.fy + 7, WHITE); }
      };
      fx = (f, _h, i) => flying(i, 12, (x, y) => { arrow(f, x, y); f.px(x - dir * 10, y, rgb('#ffffff', 120)); f.px(x - dir * 12, y, rgb('#ffffff', 60)); });
      break;
    }
    case 'warrior': {
      // raise the sword behind the head, step in and swing down in front
      poses = [P(80, -20, 100, -10), P(-100, -10, 115, -20, { dx: -1 }), P(-135, 0, 120, -30, { dx: -1 }), P(-40, 0, 95, -20, { dx: 1, fl: 24, bl: -12 }),
        P(30, 0, 90, -10, { dx: 2, fl: 26, bl: -16 }), P(70, 0, 95, -10, { dx: 2, fl: 26, bl: -16 }), P(80, -10, 100, -10, { dx: 1, fl: 16 }), P(80, -20, 100, -10)];
      held = () => (f, h, layer) => { if (layer === 'front') sword(f, h.fx, h.fy, h.fa); };
      const prev = poses.map((q, i) => (i ? poses[i - 1].fa[0] + poses[i - 1].fa[1] : q.fa[0] + q.fa[1]));
      fx = (f, h, i) => {
        if (i < 3 || i > 5) return;
        const r = L1 + L2 + 10, alpha = [255, 200, 110][i - 3];
        for (let a = prev[i]; a <= h.fa; a += 3) {
          const [x, y] = at(h.sx, h.sy, a, r), [x2, y2] = at(h.sx, h.sy, a, r - 1), [x3, y3] = at(h.sx, h.sy, a, r - 2);
          f.px(x, y, rgb('#ffffff', alpha)); f.px(x2, y2, rgb('#bfe3ff', alpha)); f.px(x3, y3, rgb('#7ab8ff', Math.round(alpha * 0.6)));
        }
      };
      break;
    }
    case 'magician': {
      // raise the wand while sparkles gather, then thrust and launch an orb
      poses = [P(65, -45, 100, -10), P(-40, -30, 60, -60), P(-70, -20, 55, -70), P(-10, 0, 85, -40, { dx: 1, fl: 14 }),
        P(0, 0, 90, -30, { dx: 1, fl: 14 }), P(15, -10, 95, -20), P(45, -30, 100, -10), P(65, -45, 100, -10)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        const raised = i >= 1 && i <= 2, thrust = i >= 3 && i <= 5;
        const [tx, ty] = wand(f, h.fx, h.fy, raised ? h.fa - 10 : thrust ? h.fa : h.fa - 75, raised || i === 3);
        if (raised) for (let j = 0; j < 4; j++) { const a = rad(i * 45 + j * 90), r = 7 - i * 2; sparkle(f, tx + Math.round(Math.cos(a) * r), ty + Math.round(Math.sin(a) * r), rgb('#ffe680')); }
        if (i === 3) shots.push({ at: 3, x: tx, y: ty });
      };
      fx = (f, _h, i) => flying(i, 10, (x, y) => {
        f.sprite(['.ooo.', 'opPpo', 'oPWPo', 'opPpo', '.ooo.'], { o: rgb('#4a2a8c'), p: rgb('#8a5cf0'), P: rgb('#c4a8ff'), W: WHITE }, x - 2, y - 2);
        f.px(x - dir * 4, y - 1, rgb('#b89cff', 180)); f.px(x - dir * 6, y + 1, rgb('#b89cff', 110)); f.px(x - dir * 8, y, rgb('#b89cff', 60));
      });
      break;
    }
    case 'thief': {
      // wind up and throw a star, then a second one from the other hand
      poses = [P(75, -15, 100, -10), P(-140, -20, 100, -10, { dx: -1 }), P(-10, 0, 100, -10, { dx: 1, fl: 18 }), P(20, 0, 165, -40, { dx: 1, fl: 18 }),
        P(50, -10, -10, 0, { dx: 1, fl: 18 }), P(70, -15, 40, -10), P(75, -15, 80, -10), P(75, -15, 100, -10)];
      held = i => (f, h, layer) => {
        if (layer !== 'front') return;
        claw(f, h.fx, h.fy);
        if (i === 1) star(f, h.fx + dir * 2, h.fy - 2, 0);
        if (i === 3) star(f, h.bx + dir * 2, h.by - 2, 1);
        if (i === 2) shots.push({ at: 2, x: h.fx + dir * 3, y: h.fy });
        if (i === 4) shots.push({ at: 4, x: h.bx + dir * 3, y: h.by });
      };
      fx = (f, _h, i) => flying(i, 11, (x, y, n) => star(f, x, y, n));
      break;
    }
    default: {
      // guard up: jab, cross
      poses = [P(30, -110, 45, -115), P(0, 0, 45, -115, { dx: 1, fl: 14 }), P(30, -110, 45, -115), P(30, -110, 0, 0, { dx: 1, fl: 14 }),
        P(30, -110, 45, -115), P(30, -110, 45, -115), P(50, -60, 70, -40), P(70, -20, 100, -10)];
      held = () => () => undefined;
      fx = (f, h, i) => {
        const hit = i === 1 ? [h.fx, h.fy] : i === 3 ? [h.bx, h.by] : null;
        if (!hit) return;
        const x = hit[0] + dir * 3, y = hit[1];
        for (const [dx, dy] of [[0, -2], [0, 3], [-2, 0], [3, 0], [-2, -2], [3, -2], [-2, 3], [3, 3]]) f.px(x + dx, y + dy, rgb('#fff3b0'));
        f.px(x, y, WHITE); f.px(x + 1, y + 1, WHITE);
      };
    }
  }
  const attack = poses.map((q, i) => { const f = new Frame(W, H); fx(f, draw(f, q, held(i)), i); return f.img; });
  return { look, idle, attack, w: W, h: H, idleMs: 320, attackMs: 115 };
}

const cache = new Map<Look, Animations>();
/** The (cached) pixel-art loops for a job. */
export function classAvatar(cls: string): Animations {
  const look = classLook(cls);
  let a = cache.get(look);
  if (!a) { a = build(look); cache.set(look, a); }
  return a;
}

export function imageDataToUrl(im: ImageData): string {
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  c.getContext('2d')!.putImageData(im, 0, 0);
  return c.toDataURL('image/png');
}
