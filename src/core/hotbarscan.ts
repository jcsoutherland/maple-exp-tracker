import type { Region } from './config';
import { itemIcon } from './data/osms';
import { frameSize, type FrameSource } from './imaging';
import { allPotions } from './potions';

/**
 * Finds which potion sits in each quickslot slot by matching the slot against every recovery item's icon (the same
 * icons the site mirrors), so the Potions tab's hotbar can follow the game by itself: potions put on, moved or taken off
 * mid-session. It only ever proposes a new hotbar layout; counting reads whatever the hotbar says, unchanged.
 */

export interface IconTpl {
  name: string;
  /** the icon's opaque pixels outside the corners the game draws over: offsets and RGB */
  pts: { x: number; y: number; r: number; g: number; b: number }[];
  w: number; h: number;
}

/**
 * A slot holds a potion when its icon's shape matches this well (MIN_SHAPE: skills stay under 0.6) and,
 * with its colour cast counted in too (Red and Orange Potion are the same shape), clearly better than any other potion.
 */
const MIN_SHAPE = 0.65, MIN_SCORE = 0.5, MARGIN = 0.2;
/** an empty slot is a plain pale square that a pale icon (White Potion) fits by shape; a real icon's outline gives it
 *  far more contrast (potions 59+, empty slots about 26) */
const MIN_STD = 40;
/** how much a colour cast off from the icon's lowers its score */
const CAST_WEIGHT = 2;

/** The icons of every recovery item, at the HUD's scale (1 at Ideal ratio), with the overdrawn corners left out. */
export async function loadPotionIcons(scale = 1, smooth = scale !== 1): Promise<IconTpl[]> {
  const out: IconTpl[] = [], seen = new Set<string>();
  for (const p of [...allPotions('hp'), ...allPotions('mp')]) {
    if (!p.id || seen.has(p.name)) continue;
    seen.add(p.name);
    const url = await itemIcon(p.id);
    if (!url) continue;
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { continue; }
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale), c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = smooth; g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, pts: IconTpl['pts'] = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const k = (y * w + x) * 4;
      if (d[k + 3] >= 200) pts.push({ x, y, r: d[k], g: d[k + 1], b: d[k + 2] });
    }
    out.push({ name: p.name, pts, w, h });
  }
  return out;
}

/** The potion in each slot (null = none recognised: a skill, empty, or not sure). */
export function scanSlots(src: FrameSource, r: Region, cols: number, rows: number, icons: IconTpl[], scale = 1, scratch = document.createElement('canvas'), detail = false): (string | null)[] {
  const { W, H } = frameSize(src), cw = r.w * W / cols, ch = r.h * H / rows, M = Math.round(4 * scale);
  const out: (string | null)[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const x0 = r.x * W + (i % cols) * cw - M, y0 = r.y * H + Math.floor(i / cols) * ch - M;
    const w = Math.round(cw + 2 * M), h = Math.round(ch + 2 * M);
    scratch.width = w; scratch.height = h;
    const g = scratch.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, x0, y0, w, h, 0, 0, w, h);
    const s = g.getImageData(0, 0, w, h).data;
    const scores = new Map<string, { sc: number; shape: number; std: number }>();
    for (const ic of icons) {
      // the icon sits about centred in its slot: try it within a few pixels of that
      const cx = Math.round((w - ic.w) / 2), cy = Math.round((h - ic.h) / 2);
      let best = -1, shape = -1, std = 0;
      for (let oy = cy - M; oy <= cy + M; oy++) for (let ox = cx - M; ox <= cx + M; ox++) {
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, dr = 0, dg = 0, db = 0;
        for (const p of ic.pts) {
          const X = ox + p.x, Y = oy + p.y;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          // the key label (top-left) and the count (bottom-left) are drawn over the icon
          const sx = X - M, sy = Y - M;
          if ((sx < cw * 0.45 && sy < ch * 0.32) || (sx < cw * 0.75 && sy > ch * 0.62)) continue;
          const k = (Y * w + X) * 4;
          const r = s[k], g = s[k + 1], b = s[k + 2];
          n += 3; sa += p.r + p.g + p.b; sb += r + g + b;
          saa += p.r * p.r + p.g * p.g + p.b * p.b; sbb += r * r + g * g + b * b; sab += p.r * r + p.g * g + p.b * b;
          dr += r - p.r; dg += g - p.g; db += b - p.b;
        }
        if (n < 30) continue;
        const va = saa - sa * sa / n, vb = sbb - sb * sb / n, ncc = va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : 0;
        // shape alone can't tell look-alikes apart (Red and Orange Potion): the icon's colour cast must match too, though
        // not its brightness (a slot on cooldown is drawn darker)
        const px = n / 3, m = (dr + dg + db) / 3, cast = (Math.abs(dr - m) + Math.abs(dg - m) + Math.abs(db - m)) / px / 255;
        const sc = ncc - CAST_WEIGHT * cast;
        if (sc > best) { best = sc; shape = ncc; std = Math.sqrt(vb / n); }
      }
      if (best > (scores.get(ic.name)?.sc ?? -Infinity)) scores.set(ic.name, { sc: best, shape, std });
    }
    const ranked = [...scores].map(([n, v]) => [n, v.sc, v.shape, v.std] as const).sort((a, b) => b[1] - a[1]);
    const [top, next] = ranked;
    if (detail) { out.push(`${top?.[0]} ${top?.[1].toFixed(2)} (shape ${top?.[2].toFixed(2)} std ${top?.[3].toFixed(0)}) / ${next?.[0]} ${next?.[1].toFixed(2)}`); continue; }
    out.push(top && top[2] >= MIN_SHAPE && top[3] >= MIN_STD && top[1] >= MIN_SCORE && (!next || top[1] - next[1] >= MARGIN) ? top[0] : null);
  }
  return out;
}

/**
 * Turns slot scans into hotbar changes, carefully: a potion is placed after the same one is seen in a slot on
 * PLACE_AFTER scans in a row, and taken off after REMOVE_AFTER scans in a row see none there (a cursor, a tooltip or
 * a window over the quickslot only hides it for a moment), and never while its count can still be read (`counted`).
 */
export const PLACE_AFTER = 3, REMOVE_AFTER = 4;
export class HotbarAuto {
  private hist: (string | null)[][] = [];
  /** Feed one scan; returns the new hotbar when it should change, else null. */
  feed(scan: (string | null)[], current: (string | null)[], counted: boolean[] = []): (string | null)[] | null {
    const next = [...current];
    let changed = false;
    scan.forEach((name, i) => {
      const h = (this.hist[i] ??= []);
      h.push(name);
      if (h.length > REMOVE_AFTER) h.shift();
      const lastN = (n: number) => h.length >= n && h.slice(-n).every(x => x === h[h.length - 1]);
      if (name && name !== current[i] && lastN(PLACE_AFTER)) { next[i] = name; changed = true; }
      else if (!name && current[i] && !counted[i] && lastN(REMOVE_AFTER)) { next[i] = null; changed = true; }
    });
    return changed ? next : null;
  }
  reset() { this.hist = []; }
}
