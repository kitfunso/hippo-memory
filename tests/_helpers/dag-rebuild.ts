// Fetchers, dirty-summary setters and entry builders the DAG rebuild tests share.
import { vi } from 'vitest';
import { openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { rejectionDigest, normalizeValueForRejection } from '../../src/core/rejection-digest.js';

/**
 * Build a fetcher that returns the same synthetic content for every call.
 * Returns ≥20 chars so it passes generateDagSummary's length guard (dag.ts:101).
 * A real Response satisfies typeof fetch's return type directly (no cast
 * needed), and vi.fn<typeof fetch>(...) types the mock's call signature
 * to match fetch exactly.
 */
export function makeOkFetcher(content: string = 'synthetic-summary-from-fetcher-X'): typeof fetch {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ content: [{ text: content }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/**
 * Typed wrapper around a single-row SELECT used throughout this file. Every
 * call site queries a row this test itself already wrote (memories /
 * audit_log / memories_fts, synchronously updated by rebuildDirtySummaries /
 * applyRebuildResult before the call), so the row always matches the
 * caller-supplied T. better-sqlite3 types .get() as `unknown` because the
 * driver has no static knowledge of a query's column shape.
 */
export function getRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T {
  // SAFETY: see function doc comment above.
  return db.prepare(sql).get(...params) as T;
}

/**
 * Force-mark a summary dirty by direct SQL (bypasses E2 hook timing).
 * Used to set up tests that need a known dirty starting state.
 */
export function forceMarkDirty(hippoRoot: string, summaryId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE memories SET summary_dirty = 1 WHERE id = ?`).run(summaryId);
  } finally {
    db.close();
  }
}

/**
 * Insert a tombstone matching `content`'s rejection digest, so a later
 * rebuild that regenerates the identical content gets refused (T4 tests).
 */
export function rejectValue(hippoRoot: string, tenantId: string, content: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    insertRejectedValue(db, {
      tenantId,
      digest: rejectionDigest(content),
      reason: 'T4 refused-stat test fixture',
      rejectedBy: 'test',
      rejectedAt: new Date().toISOString(),
      normalizedChars: normalizeValueForRejection(content).length,
    });
  } finally {
    db.close();
  }
}

export function makeSummary(
  content: string = 'test summary content',
  tenantId: string = 'default',
  tags: string[] = ['topic:test', 'dag-summary'],
): MemoryEntry {
  const s = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Semantic,
    tags,
    confidence: 'inferred',
    dagLevel: 2,
  });
  s.tenantId = tenantId;
  return s;
}

export function makeChild(
  parentId: string,
  content: string,
  tenantId: string = 'default',
  tags: string[] = ['extracted'],
): MemoryEntry {
  const c = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Episodic,
    tags,
    dagLevel: 1,
    dagParentId: parentId,
  });
  c.tenantId = tenantId;
  return c;
}
