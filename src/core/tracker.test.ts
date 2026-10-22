import { describe, expect, it } from 'vitest';
import { lineAmount, lineKind, parseExp, parsePair, cleanMap } from './parse';
import { newSession, potCost } from './session';
import { anchorOf, LogAnchor } from './logqueue';
import { DEFAULT_REGIONS, DEFAULT_SETTINGS, hudScale, presetRegions } from './config';
import { GLYPHS, SlotCounter, TH, TW } from './potcount';
import { changedPixels, SlotWatch } from './slotwatch';
import { Tracker } from './tracker';
import { parseRecovery, potionsUsed } from './potions';

const make = () => {
  const s = newSession('Flynny', 'Hunter', 37, 0);
  const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0 });
  t.mapCur = 'Map A';
  return { s, t };
};
const R = (exp: number, total = 216600) => ({ exp, pct: Math.floor(exp * 10000 / total) / 100 });

describe('EXP bar', () => {
  it('ignores a misread digit (exp changes but % does not)', () => {
    const { s, t } = make();
    t.onExp(R(124632)); t.onExp(R(124650)); t.onExp({ exp: 125650, pct: R(124650).pct }); t.onExp(R(124700));
    expect(s.exp).toBe(68);
  });
  it('logs a death as EXP lost only after a second matching read, and keeps gains intact', () => {
    const { s, t } = make();
    t.onExp(R(124632)); t.onExp(R(124700));
    const lossTo = 124700 - 21660;
    t.onExp(R(lossTo));
    expect(s.expLost).toBe(0);
    t.onExp(R(lossTo));
    expect(s.expLost).toBe(21660);
    expect(s.deaths).toBe(1);
    expect(s.exp).toBe(68);
    t.onExp(R(lossTo + 50));
    expect(s.exp).toBe(118);
  });
  it('ignores a one-off low read', () => {
    const { s, t } = make();
    t.onExp(R(124632)); t.onExp(R(100000)); t.onExp(R(124640));
    expect(s.expLost).toBe(0);
    expect(s.exp).toBe(8);
  });
  it('detects a level-up when the bar rolls over', () => {
    const { s, t } = make();
    t.onExp(R(216000)); t.onExp(R(216500));
    const total = 216600; // level 37 on the EXP table
    t.onExp(R(300, 240000));
    expect(t.onExp(R(400, 240000))).toBe('candidate'); // the bar rolled over: not a level-up until the level number says so
    expect(s.level).toBe(37);
    t.onLevelRead(38);
    expect(t.onExp(R(450, 240000))).toBe('level');
    expect(s.level).toBe(38);
    expect(Math.round(s.exp)).toBe(500 + Math.round(total - 216500) + 450);
  });
  it('confirms a level-up by the new level needing more EXP when the level number cannot be read', () => {
    const { s, t } = make();
    t.onExp(R(216000)); t.onExp(R(216500));
    t.onExp(R(300, 240000)); t.onExp(R(400, 240000));
    expect(s.level).toBe(37);
    expect(t.onExp(R(600, 240000))).toBe('level'); // 0.25%: 600 EXP is 0.25% of 240,000 > this level's 216,600
    expect(s.level).toBe(38);
  });
  it('never makes a level-up out of a bar that drops while the level number stays the same', () => {
    let clock = 0;
    const s = newSession('Flynny', 'Hunter', 37, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => clock });
    t.onExp(R(216000)); t.onExp(R(216500));
    for (let i = 0; i < 40; i++) { clock += 5000; t.onExp(R(300, 216600)); } // a lower bar, same level total, for 200 s
    t.onLevelRead(37);
    expect(s.level).toBe(37);
    expect(s.levelUps).toBe(0);
    expect(s.exp).toBe(500);
  });
  it('repairs a stray extra digit and never turns a repeated misread into a level-up', () => {
    const { s, t } = make();
    t.onExp(R(124923)); t.onExp(R(124950));
    // "125,072" read as "1250728" on a still frame, several times in a row
    for (let i = 0; i < 5; i++) t.onExp({ exp: 1250728, pct: R(125072).pct });
    t.onExp(R(125123)); t.onExp(R(125130));
    expect(s.level).toBe(37);
    expect(s.exp).toBe(125130 - 124923);
  });
  it('never counts an extra-digit misread at a fraction of a percent (fresh level)', () => {
    const { s, t } = make();
    t.onExp(R(216000)); t.onExp(R(216500));
    t.onLevelRead(38);
    t.onExp(R(300, 240000)); t.onExp(R(400, 240000)); // level-up → bar at 0.16%
    expect(s.level).toBe(38);
    const before = s.exp;
    t.onExp({ exp: 1000500, pct: R(500, 240000).pct }); // "500" read with a stray 1 in front, % read right
    t.onExp({ exp: 1000500, pct: R(500, 240000).pct });
    t.onExp(R(600, 240000));
    expect(s.exp - before).toBe(200);
  });
  it('uses the EXP table for the level total, so a digit misread on every frame is repaired, not believed', () => {
    // level 38 takes 240,500: "85857" read as "858571" each time would otherwise make the level look 2.4M EXP
    const s = newSession('Flynny', 'Hunter', 38, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0 });
    t.mapCur = 'Map A';
    const L = (exp: number) => ({ exp: exp * 10 + 1, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onExp(L(85857)); t.onExp(L(85892)); t.onExp(L(85927)); t.onExp(L(85962));
    expect(t.total).toBe(240500);
    expect(t.exp).toBe(85962);
    expect(s.exp).toBe(85962 - 85857);
  });
  it('drops reads that fit neither the level nor a single-digit repair', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0 });
    const L = (exp: number) => ({ exp, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onExp(L(85857)); t.onExp(L(85892));
    t.onExp({ exp: 99999, pct: L(85900).pct }); // garbage that agrees with nothing
    t.onExp(L(85927));
    expect(s.exp).toBe(85927 - 85857);
  });
  it('credits no monster with EXP on a map with several kinds and no recent drop', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0, soleMob: () => null });
    t.mapCur = 'Subway';
    const L = (exp: number) => ({ exp, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onExp(L(85857)); t.onExp(L(85892));
    expect(s.kills).toBeUndefined();
  });
  it('credits EXP to the monster whose etc drop just came on this map', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0);
    const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0, soleMob: () => null, mobForDrop: () => 'Jr. Necki' });
    t.mapCur = 'Subway';
    const L = (exp: number) => ({ exp, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onLogLines(['Jr. Necki Skin x1 earned. (Etc)']);
    t.onExp(L(85857)); t.onExp(L(85892));
    expect(s.kills?.['Jr. Necki'].exp).toBe(35);
  });
  it('says a counted read was counted (for the diagnostics log)', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0 });
    const L = (exp: number) => ({ exp, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onExp(L(85857)); t.onExp(L(85892));
    expect(t.verdict).toBe('counted');
  });
  it('says why a read was turned away (for the diagnostics log)', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0 });
    const L = (exp: number) => ({ exp, pct: Math.floor(exp * 10000 / 240500) / 100 });
    t.onExp(L(85857)); t.onExp(L(85892));
    t.onExp({ exp: 99999, pct: L(85900).pct });
    expect(t.verdict).toBe('off-table');
  });
  it('does not take a misread first reading as the baseline', () => {
    const { s, t } = make();
    t.onExp({ exp: 1124632, pct: R(124632).pct }); // first read garbled
    t.onExp(R(124632)); t.onExp(R(124700)); t.onExp(R(124800));
    expect(s.exp).toBe(124800 - 124632);
  });
  it('does not count a slightly misread first value as the first gain (395 instead of 35)', () => {
    const { s, t } = make();
    t.onExp({ exp: 124156, pct: R(124516).pct }); // a digit misread on the very first read, % read right
    t.onExp(R(124516));
    t.onExp(R(124551)); // the first real gain: +35
    expect(s.exp).toBe(35);
  });
  it('starts cleanly below 0.2% and never counts an impossible jump, even read twice', () => {
    const { s, t } = make();
    t.onExp(R(100)); t.onExp(R(150)); t.onExp({ exp: 1000150, pct: 0.06 }); t.onExp(R(250));
    expect(s.exp).toBe(150);
    t.onExp(R(30000)); // +29,750 in one 5 s read: more than any monster gives
    t.onExp(R(30010));
    expect(s.exp).toBe(150);
    t.onExp(R(30050)); // the baseline moved there without counting; normal gains go on
    expect(s.exp).toBe(190);
  });
  it('caps EXP by what the monsters on this map can give in the time between reads', () => {
    let clock = 0;
    const s = newSession('Flynny', 'Hunter', 37, 0);
    const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => clock, maxMobExp: m => (m === 'Line 2 <Area 1>' ? 66 : null) });
    t.mapCur = 'Line 2 <Area 1>';
    t.onExp(R(124000)); t.onExp(R(124000));
    clock += 5000; t.onExp(R(124600)); // +600 in 5 s: fine (cap 66 × 2 kills/s × 2 × 5 s = 1,320)
    expect(s.exp).toBe(600);
    clock += 5000; t.onExp(R(130000)); clock += 5000; t.onExp(R(130010)); // +5,400: a misread, even twice
    expect(s.exp).toBe(600);
    clock += 60000; t.onExp(R(140000)); // a minute without a good read: +9,990 fits (cap 15,840)
    expect(s.exp).toBe(600 + 9990);
  });
  it('attributes EXP to the current map', () => {
    const { s, t } = make();
    t.onExp(R(1000)); t.onExp(R(1500));
    expect(s.maps['Map A']).toBe(500);
  });
  it('only accepts real map names once the map list is loaded', () => {
    const s = newSession('Flynny', 'Hunter', 37, 0);
    const real = ['Hunting Ground I', 'Pig Beach'];
    const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => 0, mapsKnown: () => true, canonMap: raw => real.find(m => m.toLowerCase() === raw.toLowerCase()) ?? null });
    t.onMap('Cette Wonio'); // OCR noise at the start: not a map
    t.onExp(R(1000)); t.onExp(R(1300));
    expect(t.mapName).toBe('Cannot determine');
    t.onMap('pig beach');
    expect(t.mapName).toBe('Pig Beach');
    t.onMap('Cette Wonio'); // one bad read keeps the map…
    expect(t.mapName).toBe('Pig Beach');
    t.onMap('Cette Wonio'); // …two in a row mean we can't tell any more
    expect(t.mapName).toBe('Cannot determine');
    expect(s.maps['Cannot determine']).toBe(300);
  });
});

describe('HP/MP bars', () => {
  it('handles "]" read as a trailing 1, filters misreads, counts pot-sized recovery', () => {
    const { s, t } = make();
    const reads: [number, number][] = [[1303, 1303], [1303, 13031], [1303, 1303], [1000, 1303], [1000, 1303], [1000, 1303], [100, 1303], [100, 1303],
      [1000, 1303], [1160, 1303], [1160, 1303], [1160, 1303]];
    reads.forEach(p => t.onBar('hp', p));
    expect(t.hp.max).toBe(1303);
    expect(s.hp.used).toBe(303);
    expect(s.hp.rec).toBe(160);
    expect(s.hp.jumps).toEqual([160]);
  });
});

describe('HP/MP gauges', () => {
  const W = 96, px = (n: number) => n / W; // a 96px gauge read 10x/s
  let clock = 0;
  const feed = (t: Tracker, kind: 'hp' | 'mp', cols: (number | null)[]) => cols.forEach(c => { clock += 100; t.onGauge(kind, c == null ? null : px(c)); });
  const withMax = () => {
    const s = newSession('Flynny', 'Hunter', 37, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => clock });
    for (let i = 0; i < 3; i++) t.onBar('hp', [1303, 1303]);
    return { s, t };
  };
  const _ = null; // a flashing (unreadable) frame

  it('counts a potion across the flash the game shows when the bar changes', () => {
    const { s, t } = withMax();
    feed(t, 'hp', [60, 60, 60, _, _, _, _, _, 72, 72, 72, 72]);
    expect(s.hp.jumps!.length).toBe(1);
  });

  it('counts each potion as a sharp rise, even while taking damage', () => {
    const { s, t } = withMax();
    // full, hit down, pot (+12px ~ 160 HP), hit, hit, pot, hit, pot
    feed(t, 'hp', [90, 90, 90, 80, 80, 80, 70, 70, 70, 82, 82, 82, 76, 76, 76, 68, 68, 68, 80, 80, 80, 74, 74, 74, 86, 86, 86]);
    expect(s.hp.jumps!.length).toBe(3);
    expect(s.hp.jumps!.every(j => j >= 140 && j <= 170)).toBe(true);
    expect(potionsUsed(s.hp.jumps!, 160)).toBe(3);
  });
  it('treats an animated rise over several frames as one potion', () => {
    const { s, t } = withMax();
    feed(t, 'hp', [50, 50, 50, 54, 58, 62, 62, 62, 62]);
    expect(s.hp.jumps!.length).toBe(1);
  });
  it('ignores one-frame noise, regen ticks and respawns', () => {
    const { s, t } = withMax();
    feed(t, 'hp', [50, 50, 50, 70, 50, 50, 51, 51, 51]); // a one-frame blip and a 1px (~14 HP) regen tick
    feed(t, 'hp', [0, 0, 0, 48, 48, 48]); // respawn
    expect(s.hp.jumps ?? []).toEqual([]);
  });
  it('never counts a rise across an unreadable gauge (loading screen)', () => {
    const { s, t } = withMax();
    feed(t, 'hp', [40, 40, 40, ...Array(20).fill(_), 80, 80, 80, 80]); // 2 s unreadable
    expect(s.hp.jumps ?? []).toEqual([]);
  });
  it('counts hotbar potions by item, and ignores gauge rises while the hotbar counts that stat', () => {
    let counted = true;
    const s = newSession('Flynny', 'Hunter', 37, 0), t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => clock, potsCounted: k => counted && k === 'mp' });
    for (let i = 0; i < 3; i++) { t.onBar('hp', [1303, 1303]); t.onBar('mp', [1078, 1078]); }
    t.creditPots('mp', 'Blue Potion', 2); t.creditPots('hp', 'Red Potion', 1);
    feed(t, 'mp', [50, 50, 50, 70, 70, 70]); // MP from something else (a party skill): not a potion
    feed(t, 'hp', [50, 50, 50, 70, 70, 70]); // no hotbar count for HP: the gauge still counts it
    expect(s.mp.counted).toEqual({ 'Blue Potion': 2 });
    expect(s.hp.counted).toEqual({ 'Red Potion': 1 });
    expect(s.mp.jumps ?? []).toEqual([]);
    expect(s.hp.jumps.length).toBe(1);
  });
  it('notes when MP is spent (the character is attacking)', () => {
    const { t } = withMax();
    feed(t, 'mp', [80, 80, 80, 80]);
    expect(t.lastDrop('mp')).toBe(-Infinity);
    feed(t, 'mp', [78, 78, 78]);
    expect(t.lastDrop('mp')).toBe(clock - 100); // the second 78 makes the median drop
  });
  it('ignores the OCR numbers for potions while the gauge is readable', () => {
    const { s, t } = withMax();
    feed(t, 'hp', [90, 90, 90]);
    ([[1000, 1303], [1000, 1303], [1000, 1303], [1160, 1303], [1160, 1303], [1160, 1303]] as [number, number][]).forEach(p => t.onBar('hp', p));
    expect(s.hp.jumps ?? []).toEqual([]);
  });
});

describe('potions', () => {
  it('only counts hotbar potions, and gives each gauge rise to the hotbar potion its size fits', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0);
    s.hp.jumps = [100, 92, 250, 240]; s.mp.jumps = [200];
    const bar = Array.from({ length: 12 }, (_, i) => ({ 5: 'Orange Potion', 6: 'Red Potion', 10: 'Blue Potion' } as Record<number, string>)[i] ?? null);
    const pc = potCost(s, { ...DEFAULT_SETTINGS, hotbar: bar });
    const n = (name: string) => pc.items.find(i => i.name === name)?.count ?? 0;
    expect([n('Red Potion'), n('Orange Potion'), n('Blue Potion')]).toEqual([2, 2, 1]);
    expect(potCost(s, { ...DEFAULT_SETTINGS, hotbar: Array(12).fill(null) }).total).toBe(0); // nothing on the hotbar: nothing counted
  });
  it('has digit templates for every position', () => {
    expect(GLYPHS.length).toBe(3);
    for (const set of GLYPHS) { expect(set.length).toBe(10); for (const g of set) { expect(g.mean.length).toBe(TW * TH); expect(g.w.length).toBe(TW * TH); } }
  });
  it('turns hotbar count reads into potions used, and never a misread jump', () => {
    const c = new SlotCounter(), r = (value: number, score = 0.9) => ({ value, score });
    const feed = (v: number, moved = true, n = 3) => { let used = 0; for (let k = 0; k < n; k++) used += c.feed(r(v), 0, moved).used; return used; };
    expect(feed(69)).toBe(0);              // the starting count
    expect(feed(68)).toBe(1);              // one drunk, the bar moved: counted
    expect(feed(68)).toBe(0);
    expect(c.feed(r(75), 0, true).used + c.feed(r(75), 0, true).used).toBe(0); // a misread twice: not yet accepted
    expect(feed(75)).toBe(0);              // read three times: taken as a pickup (+7), nothing counted
    expect(feed(67)).toBe(0);              // 75 → 67 = 8 "used": impossible, rejected (baseline moves)
    expect(feed(66)).toBe(1);              // and normal counting goes on
    expect(feed(65, false)).toBe(1);       // one potion counts even if the bar didn't visibly move (drunk near full)
    expect(feed(63, false)).toBe(0);       // but two at once need the bar to agree
    expect(c.feed(r(64, 0.3), 0, true).used).toBe(0); // a read too unsure to trust
  });
  it('only lets a count change when the slot picture changed (a steady misread on a still slot never counts)', () => {
    const c = new SlotCounter(), r = (value: number) => ({ value, score: 0.9 });
    const feed = (v: number, changed: boolean, n = 3) => { let used = 0; for (let k = 0; k < n; k++) used += c.feed(r(v), 0, true, changed).used; return used; };
    expect(feed(78, false)).toBe(0);             // the starting count needs no change
    expect(feed(73, false)).toBe(0);             // misread three times on an unchanged slot: ignored
    expect(c.val).toBe(78);
    expect(feed(77, true)).toBe(1);              // the slot changed and reads one less: counted
    expect(feed(70, false, 12)).toBe(0);         // a new number held a long time with no change: baseline moves, nothing counted
    expect(c.val).toBe(70);
  });
  it('notices a slot picture changing, but not noise or something passing over it', () => {
    const N = 50 * 27, base = new Float32Array(N).fill(220), w = new SlotWatch();
    const with_ = (k: number, v: number, from = 0) => { const a = base.slice(); for (let i = from; i < from + k; i++) a[i] = v; return a; };
    expect(w.feed(base, 0)).toBeNull();
    expect(w.feed(with_(5, 30), 300)).toBeNull();          // a few pixels of noise
    expect(w.feed(with_(40, 30), 600)).toBeNull();         // something passes over…
    expect(w.feed(base, 900)).toBeNull();                  // …and is gone: no change
    expect(w.feed(with_(40, 30, 100), 1200)).toBeNull();   // the digits change…
    expect(w.feed(with_(40, 30, 100), 1500)).toBe(1200);   // …and stay: changed, as of the first read showing it
    expect(changedPixels(base, with_(40, 30))).toBe(40);
  });
  it('totals hotbar-counted potions per item', () => {
    const s = newSession('Flynny', 'Hunter', 38, 0);
    s.hp.counted = { 'Red Potion': 12, 'Orange Potion': 5 }; s.mp.counted = { 'Blue Potion': 8 };
    const pc = potCost(s, DEFAULT_SETTINGS);
    expect(pc.items.map(i => [i.name, i.count])).toEqual(expect.arrayContaining([['Red Potion', 12], ['Orange Potion', 5], ['Blue Potion', 8]]));
    expect(pc.detail.hp?.count).toBe(17);
  });
  it('parses recovery amounts from item descriptions', () => {
    expect(parseRecovery('Tasty-looking meat.\nRestores around 160 HP.')).toEqual({ hp: 160, mp: 0, hpPct: 0, mpPct: 0 });
    expect(parseRecovery('A very ripe watermelon.\nRestores about 800 HP and 800 MP.')).toEqual({ hp: 800, mp: 800, hpPct: 0, mpPct: 0 });
    expect(parseRecovery('A legendary potion.\nRestores 35% of your HP and MP, but')).toEqual({ hp: 0, mp: 0, hpPct: 0.35, mpPct: 0.35 });
    expect(parseRecovery('A wing cut off of a Stirge.')).toBeNull();
  });
  it('counts potions consumed from recovery jumps', () => {
    expect(potionsUsed([160, 150, 320], 160)).toBe(4); // the 320 jump is two meats between reads
    expect(potionsUsed([90], 160)).toBe(1); // a jump is at least one potion (topped off near max)
    expect(potionsUsed([45, 60], 160)).toBe(2); // jumps are already above the regen cutoff: a partly-shown pot is still one
  });
});

describe('pickup log', () => {
  it('learns where the newest log line sits from jittery detections, ignoring the odd wrong one', () => {
    const v = [...Array(60).fill(179), ...Array(50).fill(177), ...Array(30).fill(176), ...Array(10).fill(195), 141, 188];
    expect(anchorOf(v)).toBe(179);
    const a = new LogAnchor();
    for (const x of v) a.add(x, 'size1');
    expect(a.value).toBe(179);
    a.add(178, 'size2'); // capture size or region changed: learn again
    expect(a.value).toBeNull();
  });
  it('parses real OCR outputs from gameplay footage', () => {
    expect(lineAmount('You have gained Mesos (+45;')).toBe(45);
    expect(lineAmount('Yuu have dained MIESUE (141;')).toBe(41);
    expect(lineAmount('Yuu have gaired mesos +9,')).toBe(9);
    expect(lineKind('Py You have paired mesos (+8)')).toBe('meso');
    expect(lineKind('‘e Tau receivad EXP (+6)')).toBe('exp');
    expect(lineKind('Mushroom Snoe <1 eared, (Ete')).toBe('item');
  });
  it('counts each new line once as the log scrolls', () => {
    const { s, t } = make();
    t.onLog(['You have gained mesos (+12)', 'Tree Branch x1 earned. (Etc)', 'You received EXP (+15)']);
    t.onLog(['You have gained mesos (+7)', 'You have gained mesos (+12)', 'Tree Branch x1 earned. (Etc)', 'You received EXP (+15)']);
    expect(s.mesos).toBe(19);
    expect(Object.values(s.drops).map(d => d.qty)).toEqual([1]);
  });
  it('snaps item names through canonItem', () => {
    const s = newSession('a', 'b', 1, 0);
    const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, canonItem: r => (r.startsWith('Stiae') ? { name: 'Stirge Wing', id: 4000017 } : null) });
    t.onLog(['Stiae Ming 51 earned. (Etc)']);
    expect(s.drops['Stirge Wing']).toEqual({ qty: 1, cat: 'Etc', id: 4000017 });
  });
});

describe('status-bar parsers', () => {
  it('parses HP/MP and EXP text', () => {
    expect(parsePair('3965/1078')).toEqual([965, 1078]);
    expect(parseExp('124,035[57.26%]')).toEqual({ exp: 124035, pct: 57.26 });
    expect(parseExp('124.035 57.26%')).toEqual({ exp: 124035, pct: 57.26 });
  });
  it('rejects minimap noise as a map name', () => {
    expect(cleanMap('l- - I')).toBeNull();
    expect(cleanMap('Kerning City Construction Site]')).toBe('Kerning City Construction Site');
  });
});

describe('UI ratio presets', () => {
  const px = (r: { x: number; y: number; w: number; h: number }, W: number, H: number) => [r.x * W, r.y * H, r.w * W, r.h * H].map(v => Math.round(v));
  it('keeps the measured boxes for the default ratio', () => {
    expect(presetRegions('default', 2560, 1440)).toEqual(DEFAULT_REGIONS);
  });
  it('matches the default ratio in a native-size window', () => {
    const ideal = presetRegions('ideal', 1366, 768);
    for (const [k, r] of Object.entries(DEFAULT_REGIONS)) expect(px(ideal[k as keyof typeof ideal], 1366, 768)).toEqual(px(r, 1366, 768));
  });
  it('keeps the HUD at native size, pinned to its corner, in a bigger window', () => {
    // measured on a 1080p Ideal-ratio screenshot: the level digits at x≈606, the quickslot's slots 35 px apart (the screenshot was 1919×1079)
    const r = presetRegions('ideal', 1920, 1080);
    expect(px(r.level, 1920, 1080)).toEqual([604, 1053, 28, 16]);
    expect(px(r.quickslot, 1920, 1080)).toEqual([1216, 909, 142, 101]);
    expect(px(r.map, 1920, 1080).slice(0, 2)).toEqual([47, 41]);
    expect(Math.round((r.log.x + r.log.w) * 1920)).toBe(1920);
  });
  it('scales the HUD with the window only in the default ratio', () => {
    expect(hudScale('default', 1080)).toBeCloseTo(1.406, 3);
    expect(hudScale('ideal', 1080)).toBe(1);
  });
});
