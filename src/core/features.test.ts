import { describe, expect, it } from 'vitest';
import { anyOn, DEFAULT_SETTINGS, featureOn } from './config';

describe('feature switches', () => {
  it('every feature is on by default, including ones added later', () => {
    expect(featureOn(DEFAULT_SETTINGS, 'potions')).toBe(true);
    expect(featureOn({ features: { mesos: false } }, 'drops')).toBe(true);
  });
  it('a shared reading stays on while any feature using it is on', () => {
    const s = { features: { mesos: false, drops: true } };
    expect(anyOn(s, 'mesos', 'drops')).toBe(true);
    expect(anyOn({ features: { mesos: false, drops: false } }, 'mesos', 'drops')).toBe(false);
  });
});
