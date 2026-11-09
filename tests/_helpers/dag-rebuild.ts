// Fetchers, dirty-summary setters and entry builders the DAG rebuild tests share.
import { vi } from 'vitest';
import { closeHippoDb, getMeta, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { insertRejectedValue } from '../../src/store/sqlite/review/rejection.js';
import { rejectionDigest, normalizeValueForRejection } from '../../src/base/records/rejection-digest.js';

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
 * A fetcher whose reply text is chosen per call: `textFor` gets the 1-based call number and the
 * prompt. Count the model calls with `toHaveBeenCalledTimes`; text under 20 chars is a content
 * failure of the summary.
 */
export function makeScriptedFetcher(textFor: (call: number, prompt: string) => string): typeof fetch {
  let call = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    // SAFETY: the Anthropic adapter always JSON.stringifies the request body, so init.body is a string.
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const text = textFor(++call, body?.messages?.[0]?.content ?? '');
    return new Response(JSON.stringify({ content: [{ text }] }), { status: 200 });
  });
}

/** A fetcher whose every call is an HTTP 400: a provider failure that says nothing about the summary. */
export function makeProviderFailureFetcher(): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response('bad request', { status: 400 }));
}

/** The `rebuild_hold:<id>` meta value as stored, parsed; null when the summary has none. */
export function readRebuildHold(
  hippoRoot: string,
  summaryId: string,
): { failures: number; retryAfter: string | null } | null {
  const db = openHippoDb(hippoRoot);
  try {
    const raw = getMeta(db, `rebuild_hold:${summaryId}`, '');
    // SAFETY: the adapter writes this key as {"failures": n, "retryAfter": ISO | null}.
    return raw === '' ? null : (JSON.parse(raw) as { failures: number; retryAfter: string | null });
  } finally {
    closeHippoDb(db);
  }
}

/** Writes a meta row by key, as the store would have left it (or a bad write would). */
export function writeMetaRaw(hippoRoot: string, key: string, value: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    setMeta(db, key, value);
  } finally {
    closeHippoDb(db);
  }
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
 * Force-mark summaries dirty by direct SQL (bypasses E2 hook timing).
 * Used to set up tests that need a known dirty starting state.
 */
export function forceMarkDirty(hippoRoot: string, ...summaryIds: string[]): void {
  const db = openHippoDb(hippoRoot);
  try {
    const mark = db.prepare(`UPDATE memories SET summary_dirty = 1 WHERE id = ?`);
    for (const id of summaryIds) mark.run(id);
  } finally {
    closeHippoDb(db);
  }
}

/** Archives rows by direct SQL, so a summary's children or the summary itself drop out of the live set. */
export function archiveBySql(hippoRoot: string, ...ids: string[]): void {
  const db = openHippoDb(hippoRoot);
  try {
    const archive = db.prepare(`UPDATE memories SET kind = 'archived' WHERE id = ?`);
    for (const id of ids) archive.run(id);
  } finally {
    closeHippoDb(db);
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
    closeHippoDb(db);
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
