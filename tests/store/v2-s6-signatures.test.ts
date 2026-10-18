/** The 2.0 signatures that moved to options objects, on a real store, and the published write options that lost the db handle. */

import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry, type WriteEntryOptions } from '../../src/store/entry-writes.js';
import { writeEntryThenFail } from '../_helpers/failing-write.js';
import { loadRecallSearchEntries } from '../../src/store/search-rows.js';
import type { PromotedCopy } from '../../src/store/port/promotion.js';
import { confidenceFacets, type ConfidenceInputs } from '../../src/core/memory.js';
import { readEntry } from '../../src/store/entry-reads.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadRecallEntries } from '../_helpers/root-forms.js';

let root: string;
beforeEach(() => {
  root = makeRoot('s6-sig');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadRecallEntries', () => {
  it('returns what the positional loadRecallSearchEntries returns for the same arguments', () => {
    writeEntry(root, createMemory('quokka habitat survey notes', { tenantId: 'default' }));
    writeEntry(root, createMemory('quokka diet notes', { tenantId: 'other' }));

    const byOptions = loadRecallEntries(root, 'quokka', {
      tenantId: 'default',
      explicitScopeMode: 'additive',
      includeSuperseded: false,
    });
    const positional = loadRecallSearchEntries(root, 'quokka', undefined, 'default', undefined, 'additive', false);

    expect(byOptions.map((e) => e.id)).toEqual(positional.map((e) => e.id));
    expect(byOptions.map((e) => e.content)).toEqual(['quokka habitat survey notes']);
  });

  it('applies its defaults with no options at all', () => {
    writeEntry(root, createMemory('wombat burrow depth', { tenantId: 'default' }));
    expect(loadRecallEntries(root, 'wombat')).toHaveLength(1);
  });
});

describe('writeEntry options', () => {
  it('keep the db handle out of the published type', () => {
    expectTypeOf<WriteEntryOptions>().not.toHaveProperty('afterWrite');
    expectTypeOf<PromotedCopy>().not.toHaveProperty('afterWrite');
  });

  it('a failure after the INSERT rolls the row back', () => {
    const mem = createMemory('numbat termite log', { tenantId: 'default' });
    expect(() => writeEntryThenFail(root, mem)).toThrow('forced');
    expect(readEntry(root, mem.id, 'default')).toBeNull();
  });
});

describe('confidenceFacets', () => {
  it('reads only the three confidence fields', () => {
    const inputs: ConfidenceInputs = {
      pinned: false,
      confidence: 'observed',
      last_retrieved: new Date().toISOString(),
    };
    expect(confidenceFacets(inputs)).toEqual({ tier: 'observed', agedOut: false });
  });
});
