import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSearchEntries, writeEntry } from '../_helpers/root-forms.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { makeStore } from '../_helpers/make-root.js';

function makeRawMemory(id: string, content: string, tenantId = 'default'): MemoryEntry {
  return {
    id,
    content,
    created: '2026-05-24T10:00:00.000Z',
    lastRetrieved: '2026-05-24T10:00:00.000Z',
    retrievalCount: 0,
    strength: 1.0,
    halfLifeDays: 30,
    layer: Layer.Episodic,
    tags: [],
    emotionalValence: 'neutral' as const,
    schemaFit: 0.7,
    source: 'test',
    outcomeScore: null,
    outcomePositive: 0,
    outcomeNegative: 0,
    conflictsWith: [],
    pinned: false,
    confidence: 'verified' as const,
    parents: [],
    starred: false,
    traceOutcome: null,
    sourceSessionId: null,
    validFrom: '2026-05-24T10:00:00.000Z',
    supersededBy: null,
    extractedFrom: null,
    dagLevel: 0,
    dagParentId: null,
    kind: 'raw' as const,
    scope: null,
    owner: null,
    artifactRef: null,
    tenantId: tenantId,
  };
}

describe('loadSearchEntries defensive kind!=archived filter', () => {
  let hippoRoot: string;
  let db: DatabaseSyncLike;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('archived-filter'));
    db = openHippoDb(hippoRoot);
  });

  afterEach(() => {
    closeHippoDb(db);
  });

  function poisonToArchived(id: string): void {
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

  it('LIKE-fallback path: archived row excluded on a part-word LIKE match', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible token bravo'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived token bravo'));
    poisonToArchived('mem_archived');

    const results = loadSearchEntries(hippoRoot, 'brav', 10, 'default');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });

  it('empty-query full-scan path: archived row excluded when no terms tokenize', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible content'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived content'));
    poisonToArchived('mem_archived');

    const results = loadSearchEntries(hippoRoot, '   ', 10, 'default');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });

  it('cross-tenant: archived filter applies when tenantId is undefined', () => {
    writeEntry(hippoRoot, makeRawMemory('mem_visible', 'visible token charlie', 'default'));
    writeEntry(hippoRoot, makeRawMemory('mem_archived', 'archived token charlie', 'default'));
    poisonToArchived('mem_archived');

    const results = loadSearchEntries(hippoRoot, 'charlie', 10, undefined);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('mem_visible');
    expect(ids).not.toContain('mem_archived');
  });
});
