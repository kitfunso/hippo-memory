import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { makeRoot } from './_helpers/make-root.js';

describe('bi-temporal schema v11', () => {
  it('new entries have valid_from defaulting to created and superseded_by null', () => {
    const home = makeRoot('bt');
    const e = createMemory('test bi-temporal', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read).not.toBeNull();
    expect(read!.valid_from).toBe(e.created);
    expect(read!.superseded_by).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('valid_from can be overridden in createMemory', () => {
    const home = makeRoot('bt');
    const pastDate = '2025-01-01T00:00:00.000Z';
    const e = createMemory('historical fact', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic, validFrom: pastDate });
    expect(e.valid_from).toBe(pastDate);
    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read!.valid_from).toBe(pastDate);
    rmSync(home, { recursive: true, force: true });
  });
});
