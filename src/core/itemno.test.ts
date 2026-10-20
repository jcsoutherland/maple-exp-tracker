import { describe, expect, it } from 'vitest';
import { crossRead } from './itemno';

describe('crossRead (templates vs the game\'s digit sprites)', () => {
  const r = (value: number, score: number) => ({ value, score });
  it('agreeing reads stand', () => expect(crossRead(r(209, 0.7), r(209, 1), true)).toEqual(r(209, 1)));
  it('at the Ideal ratio a strong sprite read wins a disagreement', () => expect(crossRead(r(280, 0.8), r(200, 0.98), true)?.value).toBe(200));
  it('a weak sprite read does not overrule the templates', () => expect(crossRead(r(209, 0.8), r(20, 0.8), true)?.value).toBe(209));
  it('the templates stand when the sprites are not exact (Default ratio)', () => expect(crossRead(r(209, 0.8), r(200, 0.99), false)?.value).toBe(209));
  it('a strong sprite read stands alone at the Ideal ratio, a weak one does not', () => {
    expect(crossRead(null, r(209, 0.97), true)?.value).toBe(209);
    expect(crossRead(null, r(209, 0.8), true)).toBeNull();
  });
});
