/**
 * Defensive filter: `kind='archived'` rows must NOT appear in recall.
 *
 * `kind='archived'` is a transient SAVEPOINT-internal sentinel inside
 * `archiveRawMemory` (src/raw-archive.ts:56): UPDATE kind='archived'
 * immediately followed by DELETE, atomic. In normal operation no concurrent
 * reader sees the intermediate state.
 *
 * The filter in loadSearchRows (v1.12.6) is belt-and-suspenders against:
 *   (a) future bugs that drop the SAVEPOINT wrapping,
 *   (b) future bugs that introduce kind='archived' as a persisted state,
 *   (c) external direct-SQL writes that bypass archiveRawMemory.
 *
 * This test synthetically inserts an `kind='archived'` row via direct SQL
 * (the SAVEPOINT-bypass case (c) above) and asserts recall does not return it,
 * covering all 4 candidate-loading paths in loadSearchRows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadSearchEntries } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { Layer } from '../src/memory.js';

function makeRawMemory(id: string, content: string, tenantId = 'default') {
  return {
    id,
    content,
    created: '2026-05-24T10:00:00.000Z',
    last_retrieved: '2026-05-24T10:00:00.000Z',
    retrieval_count: 0,
    strength: 1.0,
    half_life_days: 30,
    layer: Layer.Episodic,
    tags: [] as string[],
    emotional_valence: 'neutral' as const,
    schema_fit: 0.7,
    source: 'test',
    outcome_score: null,
    outcome_positive: 0,
    outcome_negative: 0,
    conflicts_with: [] as string[],
    pinned: false,
    confidence: 'verified' as const,
    parents: [] as string[],
    starred: false,
    trace_outcome: null,
    source_session_id: null,
    valid_from: '2026-05-24T10:00:00.000Z',
    superseded_by: null,
    extracted_from: null,
    dag_level: 0,
    dag_parent_id: null,
    kind: 'raw' as const,
    scope: null,
    owner: null,
    artifact_ref: null,
    tenantId,
  };
}

describe('loadSearchEntries defensive kind!=archived filter', () => {
  let root: string;
  let hippoRoot: string;
  let db: DatabaseSyncLike;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-archived-filter-'));
    hippoRoot = join(root, '.hippo');
    initStore(hippoRoot);
    db = openHippoDb(hippoRoot);
  });

  afterEach(() => {
    closeHippoDb(db);
    rmSync(root, { recursive: true, force: true });
  });

  function poisonToArchived(id: string): void {
    // SAVEPOINT-bypass: direct SQL UPDATE that leaves kind='archived' visible
    // to a concurrent reader. Simulates the worst-case "what if the
    // archiveRawMemory savepoint were broken" scenario.
    db.prepare(`UPDATE memories SET kind = 'archived' WHERE id = ?`).run(id);
  }

  it('FTS path: archived row is excluded from token-matched recall', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible token alpha'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived token alpha'));
    poisonToArchived('mem_archived');

    const results = loadSearchEntries(hippoRoot, 'alpha', 10, 'default');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });

  it('LIKE-fallback path: archived row excluded with HIPPO_FORCE_LIKE_PATH', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible token bravo'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived token bravo'));
    poisonToArchived('mem_archived');

    const prev = process.env.HIPPO_FORCE_LIKE_PATH;
    process.env.HIPPO_FORCE_LIKE_PATH = '1';
    try {
      const results = loadSearchEntries(hippoRoot, 'bravo', 10, 'default');
      const ids = results.map((r) => r.id);
      expect(ids).toContain('mem_visible');
      expect(ids).not.toContain('mem_archived');
    } finally {
      if (prev === undefined) delete process.env.HIPPO_FORCE_LIKE_PATH;
      else process.env.HIPPO_FORCE_LIKE_PATH = prev;
    }
  });

  it('empty-query full-scan path: archived row excluded when no terms tokenize', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible content'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived content'));
    poisonToArchived('mem_archived');

    // Empty query (whitespace only) hits the no-terms branch (line 713 in store.ts).
    const results = loadSearchEntries(hippoRoot, '   ', 10, 'default');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });

  it('cross-tenant: archived filter applies when tenantId is undefined', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible token charlie', 'default'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived token charlie', 'default'));
    poisonToArchived('mem_archived');

    // tenantId undefined = no tenant filter (legacy callers / background pipelines).
    // The archived filter must still fire.
    const results = loadSearchEntries(hippoRoot, 'charlie', 10, undefined);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });
});
