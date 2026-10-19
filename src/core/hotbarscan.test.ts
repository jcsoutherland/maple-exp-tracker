import { describe, expect, it } from 'vitest';
import { HotbarAuto, PLACE_AFTER, REMOVE_AFTER } from './hotbarscan';

const bar = (o: Record<number, string>): (string | null)[] => Array.from({ length: 12 }, (_, i) => o[i] ?? null);

describe('HotbarAuto', () => {
  it('places a potion only after it is seen in the same slot several scans in a row', () => {
    const a = new HotbarAuto(), cur = bar({}), scan = bar({ 5: 'Red Potion' });
    for (let k = 1; k < PLACE_AFTER; k++) expect(a.feed(scan, cur)).toBeNull();
    expect(a.feed(scan, cur)).toEqual(bar({ 5: 'Red Potion' }));
  });
  it('a slot hidden for a moment keeps its potion', () => {
    const a = new HotbarAuto(), cur = bar({ 5: 'Red Potion' });
    for (let k = 1; k < REMOVE_AFTER; k++) expect(a.feed(bar({}), cur)).toBeNull();
    expect(a.feed(bar({ 5: 'Red Potion' }), cur)).toBeNull();
    expect(a.feed(bar({}), cur)).toBeNull();
  });
  it('removes a potion no longer seen', () => {
    const a = new HotbarAuto(), cur = bar({ 5: 'Red Potion' });
    let out = null;
    for (let k = 0; k < REMOVE_AFTER; k++) out = a.feed(bar({}), cur);
    expect(out).toEqual(bar({}));
  });
  it('follows a potion moved to another slot and a swap to another potion', () => {
    const a = new HotbarAuto();
    let cur = bar({ 5: 'Orange Potion', 9: 'Blue Potion' });
    const scan = bar({ 5: 'White Potion', 2: 'Blue Potion' });
    for (let k = 0; k < REMOVE_AFTER; k++) cur = a.feed(scan, cur) ?? cur;
    expect(cur).toEqual(bar({ 5: 'White Potion', 2: 'Blue Potion' }));
  });
  it('a flickering read never changes the hotbar', () => {
    const a = new HotbarAuto(), cur = bar({ 5: 'Red Potion' });
    for (let k = 0; k < 10; k++) expect(a.feed(bar({ 5: k % 2 ? 'Red Potion' : 'Orange Potion' }), cur)).toBeNull();
  });
});
