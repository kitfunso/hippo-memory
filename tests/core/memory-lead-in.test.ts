// The lead-in contract: the conversation text that led into a memory, capped at the record.
import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { MAX_LEAD_IN_CHARS } from '../../src/base/util/limits.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

describe('the lead-in on a new memory', () => {
  it('keeps a lead-in at the cap and throws over it', () => {
    expect(MAX_LEAD_IN_CHARS).toBe(2000);
    const atCap = createMemory('Three times a week', { leadIn: 'x'.repeat(MAX_LEAD_IN_CHARS) });
    expect(atCap.leadIn).toHaveLength(MAX_LEAD_IN_CHARS);
    expect(() => createMemory('Three times a week', { leadIn: 'x'.repeat(MAX_LEAD_IN_CHARS + 1) })).toThrow(
      BadRequestError,
    );
  });

  it('leaves the key off a memory made with no lead-in, an empty one or null', () => {
    for (const leadIn of [undefined, '', null]) {
      expect(Object.hasOwn(createMemory('Three times a week', { leadIn }), 'leadIn')).toBe(false);
    }
  });
});
