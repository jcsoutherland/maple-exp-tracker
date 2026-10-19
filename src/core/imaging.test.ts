import { describe, expect, it } from 'vitest';
import { newLineCount, type LogScan } from './imaging';

/** A log scan whose slots (bottom-up) hold the given lines; each line id draws its own pixel pattern. */
function scan(lines: string[]): LogScan {
  const W = 80, P = 14, H = P * 6 + 4, sc = new Float32Array(W * H), slots: [number, number][] = [];
  lines.forEach((id, k) => {
    const z = H - 2 - k * P, a = z - P;
    slots.push([a, z]);
    let seed = [...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7);
    for (let y = a + 3; y < z - 2; y++) for (let x = 0; x < W; x++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; if (seed % 5 === 0) sc[y * W + x] = 60; }
  });
  return { W, H, f: 1, sc, slots };
}

describe('new log lines', () => {
  it('counts a repeat of the same line when the log is full', () => {
    // three "+10" lines at the bottom, then a fourth arrives: the bottom three slots look the same either way
    const prev = scan(['m10', 'm10', 'm10', 'b6', 'e21', 'm9']), cur = scan(['m10', 'm10', 'm10', 'm10', 'b6', 'e21']);
    expect(newLineCount(prev, cur)).toEqual({ count: 1, aligned: true });
  });
  it('still sees an unchanged log as unchanged', () => {
    const s = ['m10', 'm10', 'm10', 'b6', 'e21', 'm9'];
    expect(newLineCount(scan(s), scan(s))).toEqual({ count: 0, aligned: true });
  });
  it('counts several new lines', () => {
    expect(newLineCount(scan(['m9', 'e8', 'b2', 'm5']), scan(['b2', 'e8', 'm9', 'e8', 'b2', 'm5'])).count).toBe(2);
  });
});
