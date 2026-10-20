// The JS tally and the SQL aggregate share one freshness window and one schema-fit threshold, so they agree at the edges.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { AMBIENT_FRESH_WINDOW_MS, tallyAmbientEntries } from '../../src/base/memory/ambient.js';
import { HIGH_SCHEMA_FIT } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries, loadAmbientTallies } from '../_helpers/root-forms.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
let root = '';

beforeEach(() => {
  root = makeRoot('ambient-edge');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ambient tallies at the window and threshold edges', () => {
  it('the SQL and JS paths count the same fresh and high-fit rows', () => {
    const edge = NOW.getTime() - AMBIENT_FRESH_WINDOW_MS;
    const ages = [edge - 1000, edge, edge + 1000];
    const fits = [HIGH_SCHEMA_FIT - 0.01, HIGH_SCHEMA_FIT, HIGH_SCHEMA_FIT + 0.01];
    ages.forEach((created, i) => {
      const e = createMemory(`edge row ${i}`);
      e.created = new Date(created).toISOString();
      e.schemaFit = fits[i]!;
      writeEntry(root, e);
    });

    const sql = loadAmbientTallies(root, 'default', { currentProject: [], now: NOW });
    const js = tallyAmbientEntries(loadAllEntries(root, 'default'), NOW);

    expect(js.fresh).toBe(1);
    expect(js.highSchemaFit).toBe(1);
    expect(sql.fresh).toBe(js.fresh);
    expect(sql.highSchemaFit).toBe(js.highSchemaFit);
  });
});
