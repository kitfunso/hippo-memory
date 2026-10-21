// Whole-tenant walks read keyset pages: no statement hands back more than a page of rows, and no row is dropped.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { peakRowsRead, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  loadAllEntries,
  loadAllL2Summaries,
  loadAmbientCandidates,
  writeEntriesTogether,
} from '../_helpers/root-forms.js';
import { DAG_LEVEL, type MemoryEntry } from '../../src/base/memory/memory.js';
import { READ_PAGE_ROWS } from '../../src/base/util/pages.js';

const ROWS = READ_PAGE_ROWS * 2 + 30;
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function seeded(pinned: boolean, extra: Partial<MemoryEntry> = {}): { root: string; ids: string[] } {
  const root = makeRoot('tenant-walk');
  roots.push(root);
  const entries = Array.from({ length: ROWS }, (_, i) => ({
    ...createMemory(`walk row ${i}`),
    id: `mem_w${String(i).padStart(5, '0')}`,
    pinned,
    ...extra,
    created: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
  }));
  writeEntriesTogether(root, entries);
  return { root, ids: entries.map((e) => e.id) };
}

describe('whole-tenant walks', () => {
  it('reads every pin in pages', () => {
    const { root, ids } = seeded(true);
    const { result, reads } = recordStatements(() => loadAmbientCandidates(root, 'default', 0, () => true));
    expect(result.entries.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'FROM memories')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  }, 60_000);

  it('reads a whole tenant in pages', () => {
    const { root, ids } = seeded(false);
    const { result, reads } = recordStatements(() => loadAllEntries(root, 'default'));
    expect(result.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'FROM memories')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  }, 60_000);

  it('reads the unprofiled topic summaries in pages', () => {
    const { root, ids } = seeded(false, { dagLevel: DAG_LEVEL.topic });
    const { result, reads } = recordStatements(() => loadAllL2Summaries(root));
    expect(result.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'dag_parent_id IS NULL')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  }, 60_000);
});
