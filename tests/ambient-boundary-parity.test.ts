// The JS tally and the SQL aggregate share one freshness window and one schema-fit threshold, so they agree at the edges.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadAmbientTallies } from '../src/store/ambient.js';
import { AMBIENT_FRESH_WINDOW_MS, HIGH_SCHEMA_FIT_ABOVE, tallyAmbientEntries } from '../src/core/ambient.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-ambient-edge-'));
  initStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ambient tallies at the window and threshold edges', () => {
  it('the SQL and JS paths count the same fresh and high-fit rows', () => {
    const edge = NOW.getTime() - AMBIENT_FRESH_WINDOW_MS;
    const ages = [edge - 1000, edge, edge + 1000];
    const fits = [HIGH_SCHEMA_FIT_ABOVE - 0.01, HIGH_SCHEMA_FIT_ABOVE, HIGH_SCHEMA_FIT_ABOVE + 0.01];
    ages.forEach((created, i) => {
      const e = createMemory(`edge row ${i}`);
      e.created = new Date(created).toISOString();
      e.schema_fit = fits[i]!;
      writeEntry(root, e);
    });

    const sql = loadAmbientTallies(root, 'default', { currentProject: [], now: NOW });
    const js = tallyAmbientEntries(loadAllEntries(root), NOW);

    expect(js.fresh).toBe(1);
    expect(js.highSchemaFit).toBe(1);
    expect(sql.fresh).toBe(js.fresh);
    expect(sql.highSchemaFit).toBe(js.highSchemaFit);
  });
});
