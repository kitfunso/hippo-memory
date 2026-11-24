import { describe, expect, it } from 'vitest';
import { LEAD_IN_MARK, duplicateKey, identityText } from '../../src/base/util/same-text.js';

const L1 = 'user: Is the flight booked?';
const L2 = 'user: Did Mel get the job?';

describe('identityText', () => {
  it('gives the content unchanged when there is no lead-in', () => {
    for (const leadIn of [undefined, null, '']) {
      expect(identityText({ content: ' Yes.\n', leadIn })).toBe(' Yes.\n');
    }
  });

  it('folds spacing in each part, so spacing variants of the same pair are equal', () => {
    const plain = identityText({ content: 'Yes.', leadIn: L1 });
    expect(identityText({ content: 'Yes.\n', leadIn: `  ${L1.replace(/ /g, '  ')}` })).toBe(plain);
    expect(duplicateKey(plain)).toBe(plain);
  });

  it('tells the same content under two lead-ins apart, and a lead-in row from a bare one', () => {
    const ids = [
      identityText({ content: 'Yes.', leadIn: L1 }),
      identityText({ content: 'Yes.', leadIn: L2 }),
      identityText({ content: 'Yes.' }),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('gives two identities for "A"+"B\\u001fC" and "A\\u001fB"+"C"', () => {
    const one = identityText({ content: 'A', leadIn: `B${LEAD_IN_MARK}C` });
    const two = identityText({ content: `A${LEAD_IN_MARK}B`, leadIn: 'C' });
    expect(one).not.toBe(two);
  });
});
