import { describe, expect, it } from 'vitest';
import { lineAmount, lineKind, parseExp, parsePair, cleanMap } from './parse';
import { newSession } from './session';
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
    const total = 216500 / R(216500).pct * 100;
    t.onExp(R(300, 240000));
    expect(t.onExp(R(400, 240000))).toBe(true);
    expect(s.level).toBe(38);
    expect(Math.round(s.exp)).toBe(500 + Math.round(total - 216500) + 400);
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
    t.onExp(R(300, 240000)); t.onExp(R(400, 240000)); // level-up → bar at 0.16%
    const before = s.exp;
    t.onExp({ exp: 1000500, pct: R(500, 240000).pct }); // "500" read with a stray 1 in front, % read right
    t.onExp({ exp: 1000500, pct: R(500, 240000).pct });
    t.onExp(R(600, 240000));
    expect(s.exp - before).toBe(200);
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
  it('starts cleanly below 0.2% and needs a huge jump read twice', () => {
    const { s, t } = make();
    t.onExp(R(100)); t.onExp(R(150)); t.onExp({ exp: 1000150, pct: 0.06 }); t.onExp(R(250));
    expect(s.exp).toBe(150);
    t.onExp(R(30000)); // +13% of a level in one read: wait for a second read
    expect(s.exp).toBe(150);
    t.onExp(R(30010));
    expect(s.exp).toBe(30010 - 100);
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
