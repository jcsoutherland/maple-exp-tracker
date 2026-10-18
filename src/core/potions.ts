import { allItems, itemByName, type ItemRec } from './data/osms';

/** A recovery item. Flat amounts restore that much; pct amounts restore that share of max HP/MP. */
export interface Potion { name: string; id?: number; hp: number; mp: number; hpPct: number; mpPct: number; shopPrice: number }

/** Shop prices aren't in the item data; the NPC sell value is, and shop price is 10× that (Meat 8→80, Lemon 15→150). */
export const SHOP_PRICE_FACTOR = 10;

/** Parse "Restores 250 HP." / "Restores around 150 MP." / "Restores 35% of your HP and MP" from an item description. */
export function parseRecovery(desc: string): Pick<Potion, 'hp' | 'mp' | 'hpPct' | 'mpPct'> | null {
  const d = desc.replace(/\s+/g, ' ');
  const out = { hp: 0, mp: 0, hpPct: 0, mpPct: 0 };
  const pct = d.match(/restores?\s+(?:around |about )?(\d+)% of (?:your )?(HP and MP|HP|MP)/i);
  if (pct) {
    const v = +pct[1] / 100, which = pct[2].toUpperCase();
    if (which.includes('HP')) out.hpPct = v;
    if (which.includes('MP')) out.mpPct = v;
  }
  const both = d.match(/restores?\s+(?:around |about )?(\d+) HP and (\d+) MP/i);
  if (both) { out.hp = +both[1]; out.mp = +both[2]; }
  else {
    const hp = d.match(/restores?\s+(?:around |about )?(\d+) HP/i), mp = d.match(/restores?\s+(?:around |about )?(\d+) MP/i);
    if (hp) out.hp = +hp[1];
    if (mp) out.mp = +mp[1];
  }
  return out.hp || out.mp || out.hpPct || out.mpPct ? out : null;
}

const toPotion = (i: ItemRec): Potion | null => {
  const r = parseRecovery(i.desc);
  return r && i.cat === 'Consumable' ? { name: i.name, id: i.id, ...r, shopPrice: (i.price ?? 0) * SHOP_PRICE_FACTOR } : null;
};

/** Values from the Classic World item data, used until the item list has loaded. */
const FALLBACK: Potion[] = [
  { name: 'Meat', id: 2010003, hp: 160, mp: 0, hpPct: 0, mpPct: 0, shopPrice: 80 },
  { name: 'Red Potion', id: 2000000, hp: 100, mp: 0, hpPct: 0, mpPct: 0, shopPrice: 50 },
  { name: 'Orange Potion', id: 2000001, hp: 250, mp: 0, hpPct: 0, mpPct: 0, shopPrice: 150 },
  { name: 'White Potion', id: 2000002, hp: 500, mp: 0, hpPct: 0, mpPct: 0, shopPrice: 350 },
  { name: 'Lemon', id: 2010005, hp: 0, mp: 150, hpPct: 0, mpPct: 0, shopPrice: 150 },
  { name: 'Blue Potion', id: 2000003, hp: 0, mp: 200, hpPct: 0, mpPct: 0, shopPrice: 220 },
  { name: 'Mana Elixir', id: 2000006, hp: 0, mp: 0, hpPct: 0, mpPct: 0.5, shopPrice: 10000 },
];

export function potionByName(name: string): Potion | null {
  const rec = itemByName(name);
  return (rec && toPotion(rec)) || FALLBACK.find(p => p.name === name) || null;
}

/** Every recovery item for one stat, deduplicated by name, cheapest first. */
export function allPotions(kind: 'hp' | 'mp'): Potion[] {
  const seen = new Set<string>(), out: Potion[] = [];
  const list = allItems().length ? allItems().map(toPotion).filter((p): p is Potion => !!p) : FALLBACK;
  for (const p of list) {
    if (seen.has(p.name) || !(kind === 'hp' ? p.hp || p.hpPct : p.mp || p.mpPct)) continue;
    seen.add(p.name); out.push(p);
  }
  return out.sort((a, b) => a.shopPrice - b.shopPrice);
}

/** How much one potion restores for `kind`, given the current max (for % potions). */
export const restoreOf = (p: Potion, kind: 'hp' | 'mp', max: number | null) =>
  kind === 'hp' ? p.hp || Math.round(p.hpPct * (max || 0)) : p.mp || Math.round(p.mpPct * (max || 0));

/**
 * Potions actually consumed: each recovery jump is one potion, or more when it's worth several (quaffed together).
 * `jumps` are the sizes of the increases the tracker saw, already above the regen cutoff. A jump much smaller than
 * the Active potion still counts: a potion near max HP, or one taken while being hit, shows only part of its value.
 */
export function potionsUsed(jumps: number[], restore: number): number {
  return jumps.reduce((n, j) => n + (restore > 0 ? Math.max(1, Math.round(j / restore)) : 1), 0);
}
