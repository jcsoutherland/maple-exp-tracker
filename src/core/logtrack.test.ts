import { describe, expect, it } from 'vitest';
import { LogFollower, type SlotToken } from './logtrack';

/** bottom-up slots: a text (read), '?' (a line that couldn't be read), '' (empty); "+10@200" sets the brightness */
const T = (...s: string[]): SlotToken[] => Array.from({ length: 6 }, (_, j) => {
  const v = s[j] ?? '', [text, lum] = v.split('@');
  return v === '' ? { text: null, lum: 0, ink: false } : text === '?' ? { text: null, lum: lum ? +lum : 240, ink: true } : { text, lum: lum ? +lum : 240, ink: true };
});
const run = (frames: SlotToken[][]) => {
  const f = new LogFollower(), got: string[] = [];
  for (const fr of frames) for (const l of f.update(fr).identified) got.push(l.text!);
  return got;
};

describe('following the log by recognised lines', () => {
  it('counts new lines once, not the ones already there', () => {
    expect(run([T('A', 'B'), T('A', 'B'), T('C', 'A', 'B'), T('C', 'A', 'B'), T('E', 'D', 'C', 'A', 'B')])).toEqual(['C', 'D', 'E']);
  });
  it('counts a repeat of the same line', () => {
    expect(run([T('B'), T('m10', 'B'), T('m10', 'm10', 'B'), T('m10', 'm10', 'm10', 'B')])).toEqual(['m10', 'm10', 'm10']);
    // the log grows: two identical lines, then three
    expect(run([T('m10'), T('m10', 'm10')])).toEqual(['m10']);
    // full log of the same line: the new one is brighter than the faded one it replaces
    expect(run([T('m9@150', 'm9@140', 'm9@130', 'm9@120', 'm9@110', 'm9@100'), T('m9@245', 'm9@150', 'm9@140', 'm9@130', 'm9@120', 'm9@110')])).toEqual(['m9']);
  });
  it('reads a line that was covered when it arrived, once it shows', () => {
    expect(run([T('A'), T('?', 'A'), T('?', 'A'), T('B', '?', 'A'), T('B', 'm25', 'A')])).toEqual(['B', 'm25']);
  });
  it('is not fooled by a frame where nothing could be read', () => {
    expect(run([T('A', 'B'), T('?', '?'), T('A', 'B')])).toEqual([]);
  });
  it('lets old lines fade out at the top', () => {
    expect(run([T('A', 'B', 'C'), T('A', 'B'), T('A'), T('D', 'A')])).toEqual(['D']);
  });
});

describe('lines that fade or get covered for a moment', () => {
  it('are the same lines when read again', () => {
    expect(run([T('A'), T('m82', 'A'), T('?', '?'), T('', ''), T('m82@150', 'A@150')])).toEqual(['m82']);
  });
  it('a new identical line is still new (brighter than the remembered one)', () => {
    expect(run([T('A'), T('m76@200', 'A'), T('m76@120', 'A'), T('', ''), T('m76@240', '', '')])).toEqual(['m76', 'm76']);
  });
});

describe('lines that arrive unreadable', () => {
  it('two at once, read a frame later', () => {
    expect(run([T('E'), T('?', '?'), T('m75', '?', 'E'), T('m75', 'L', 'E')])).toEqual(['m75', 'L']);
  });
});

describe('scenery and faded lines', () => {
  it('a faded line that can no longer be read is not a new line', () => {
    expect(run([T('m35@130', '?@120'), T('m35@100', ''), T('?@95', '?@110'), T('m35@105', '')])).toEqual([]);
  });
});
