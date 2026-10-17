import { describe, expect, it } from 'vitest';
import { classLook, rollLook } from './avatar/msio';
import { fixIL } from './imaging';
import type { OcrChar } from './ocr/engine';

describe('name reading: i / l check', () => {
  // a tiny ink mask: "F", a tall stroke, an "n", a dotted short stroke
  const w = 30, h = 20, mask = new Uint8Array(w * h);
  const ink = (x0: number, x1: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 1; };
  ink(1, 5, 2, 15);                 // F (ascender height)
  ink(8, 9, 2, 15);                 // l: one tall stroke
  ink(12, 16, 8, 15);               // n (x-height)
  ink(19, 20, 5, 5); ink(19, 20, 8, 15); // i: dot + short stroke
  const box = (c: string, x0: number, x1: number): OcrChar => ({ c, x0, x1, y0: 0, y1: h - 1 });

  it('turns a tall unbroken stroke read as "i" into "l", and a dotted one into "i"', () => {
    expect(fixIL([box('F', 1, 5), box('i', 8, 9), box('n', 12, 16), box('l', 19, 20)], { mask, w, h })).toBe('Flni');
  });
  it('only looks between the neighbouring letters when OCR boxes overlap', () => {
    expect(fixIL([box('F', 1, 5), box('i', 7, 14), box('n', 12, 16), box('i', 18, 21)], { mask, w, h })).toBe('Flni');
  });
});

describe('character looks', () => {
  it('rolls instantly with the chosen gender and the job weapon', () => {
    for (const gender of [0, 1] as const) {
      const l = rollLook('Hunter', 37, gender);
      expect(l.gender).toBe(gender);
      expect(Math.floor(l.hair / 1000)).toBe(30 + gender);
      expect(Math.floor(l.face / 1000)).toBe(20 + gender);
      expect(l.attack).toBe('shoot1');
      expect(l.weapon).not.toBeNull();
    }
    expect(classLook('Assassin')).toBe('thief');
    expect(rollLook('Fighter', 30, 0).stand).toBe('stand2'); // two-handed sword stance
  });
});
