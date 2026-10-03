import { afterEach, describe, expect, it } from 'vitest';
import { biasHintEnabled } from '../src/recall-history.js';

const saved = {
  a: process.env.HIPPO_ANCHORING,
  v: process.env.HIPPO_AVAILABILITY,
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore('HIPPO_ANCHORING', saved.a);
  restore('HIPPO_AVAILABILITY', saved.v);
});

describe('biasHintEnabled', () => {
  it('is on by default for both kinds', () => {
    delete process.env.HIPPO_ANCHORING;
    delete process.env.HIPPO_AVAILABILITY;
    expect(biasHintEnabled('anchoring')).toBe(true);
    expect(biasHintEnabled('availability')).toBe(true);
  });

  it('off disables each kind independently, read at call time', () => {
    delete process.env.HIPPO_AVAILABILITY;
    process.env.HIPPO_ANCHORING = 'off';
    expect(biasHintEnabled('anchoring')).toBe(false);
    expect(biasHintEnabled('availability')).toBe(true);

    delete process.env.HIPPO_ANCHORING;
    process.env.HIPPO_AVAILABILITY = 'off';
    expect(biasHintEnabled('anchoring')).toBe(true);
    expect(biasHintEnabled('availability')).toBe(false);
  });

  it('any value other than off keeps it on', () => {
    for (const v of ['', '0', 'false', 'OFF', 'on']) {
      process.env.HIPPO_ANCHORING = v;
      process.env.HIPPO_AVAILABILITY = v;
      expect(biasHintEnabled('anchoring')).toBe(true);
      expect(biasHintEnabled('availability')).toBe(true);
    }
  });
});
