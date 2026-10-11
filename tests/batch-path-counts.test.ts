// Sleep, sync down and one-id invalidation read only the rows they need: counted in statements and rows, never timed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordStatements, recordStatementsAsync, countMatching, STORE_OPEN } from './_helpers/count-statements.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntriesTogether, writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { MEMORY_SELECT_COLUMNS } from '../src/store/rows.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { insertRejectedValue, rejectionDigest } from '../src/store/rejection.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { runSleep } from '../src/api/sleep-run.js';
import { computeAmbientState } from '../src/core/ambient.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { invalidateMatching } from '../src/learn/invalidation.js';
import { syncGlobalToLocal } from '../src/sharing/global-sync.js';
import type { Context } from '../src/api/index.js';

const FULL_ROW = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`;
/** A full-row read of every row in the store, or of every current distilled row: no id, tenant or parent filter. */
const WHOLE_STORE_READ = /FROM memories\s+(WHERE COALESCE\(kind, 'distilled'\) = 'distilled' AND COALESCE\(superseded_by, ''\) = ''\s+)?ORDER BY created ASC, id ASC$/;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetAblationCacheForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-batch-${label}-`));
  roots.push(root);
  initStore(root);
  return root;
}

const wholeStoreReads = (statements: readonly string[]): number =>
  statements.filter((sql) => sql.startsWith(FULL_ROW) && WHOLE_STORE_READ.test(sql)).length;

describe('sleep after consolidation', () => {
  const ctxFor = (hippoRoot: string): Context =>
    ({ hippoRoot, tenantId: 'default', actor: { subject: 'batch-test', role: 'admin' } });

  function seeded(): string {
    const home = mkdtempSync(join(tmpdir(), 'hippo-batch-home-'));
    roots.push(home);
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:00:00.000Z');
    _resetAblationCacheForTests();
    const root = newRoot('sleep');
    // Every row shares the fake clock's timestamp, so ids in write order keep the merge and survivor picks off random UUIDs.
    let seq = 0;
    const put = (text: string, options: { tags?: string[]; tenantId: string }): void =>
      writeEntry(root, { ...createMemory(text, options), id: `batch-${String(seq++).padStart(2, '0')}` });
    for (const tenantId of ['default', 'acme']) {
      for (const text of ['the deploy runs on friday at noon', 'billing is owned by alice in finance', 'staging restarts every sunday night']) {
        put(text, { tags: ['ops'], tenantId });
      }
      put('the deploy  runs on friday at noon', { tags: ['ops'], tenantId });
      put('nope', { tenantId });
      put('vague thing', { tenantId });
    }
    return root;
  }

  const contentsByTenant = (root: string) => {
    const out: Record<string, string[]> = {};
    for (const e of loadAllEntries(root)) (out[e.tenantId] ??= []).push(e.content);
    for (const list of Object.values(out)) list.sort();
    return out;
  };

  it('dedupes, audits and summarizes every tenant as before', async () => {
    const root = seeded();
    const result = await runSleep(ctxFor(root), { noShare: true });
    expect(result.deduped).toEqual({ removed: 2, semDups: 0, epiDups: 2, crossDups: 0 });
    expect(result.audit).toEqual({ errorsRemoved: 2, warningCount: 10 });
    const kept = [
      '[Consolidated from 2 related memories, newest first]\n\n- the deploy  runs on friday at noon',
      'billing is owned by alice in finance', 'staging restarts every sunday night', 'the deploy  runs on friday at noon', 'vague thing',
    ];
    const keptDefault = kept.map((c) => (c === 'the deploy  runs on friday at noon' ? 'the deploy runs on friday at noon' : c));
    expect(contentsByTenant(root)).toEqual({ default: keptDefault, acme: kept });
    expect(result.ambient).toEqual(computeAmbientState(loadAllEntries(root).filter((e) => !e.superseded_by)));
  });

  it('a dry run reports what a real run would remove and removes nothing', async () => {
    const root = seeded();
    const before = contentsByTenant(root);
    const result = await runSleep(ctxFor(root), { noShare: true, dryRun: true });
    expect(result.deduped).toEqual({ removed: 2, semDups: 0, epiDups: 2, crossDups: 0 });
    expect(result.audit).toEqual({ errorsRemoved: 2, warningCount: 8 });
    expect(contentsByTenant(root)).toEqual(before);
  });

  it('reads the whole store twice, once for consolidation and once shared by dedup, audit and ambient', async () => {
    const root = seeded();
    const { statements } = await recordStatementsAsync(() => runSleep(ctxFor(root), { noShare: true }));
    expect(wholeStoreReads(statements)).toBe(2);
  });
});

describe('invalidateMatching with onlyId', () => {
  const target = { from: 'zephyrine cache', to: null, type: 'removal' as const };

  function seeded(n: number) {
    const root = newRoot('invalidate');
    const rows = Array.from({ length: n }, (_, i) => createMemory(`row ${i} about the zephyrine cache`));
    writeEntriesTogether(root, rows);
    return { root, rows };
  }

  it('weakens only the named row, as a pattern match over the tenant would', () => {
    const { root, rows } = seeded(5);
    const result = invalidateMatching(root, target, 'default', { onlyId: rows[2]!.id });
    expect(result).toEqual({
      invalidated: 1, targets: [rows[2]!.id], skippedPinned: [], dryRun: false,
      preview: [{ id: rows[2]!.id, headline: 'row 2 about the zephyrine cache' }],
    });
    const after = new Map(loadAllEntries(root).map((e) => [e.id, e]));
    expect(after.get(rows[2]!.id)).toMatchObject({ confidence: 'stale', half_life_days: Math.max(1, Math.floor(rows[2]!.half_life_days / 2)) });
    expect(after.get(rows[2]!.id)!.tags).toContain('invalidated');
    expect(after.get(rows[1]!.id)!.confidence).toBe(rows[1]!.confidence);
  });

  it('cannot see another tenant\'s id, reports a pinned id and writes nothing on a dry run', () => {
    const root = newRoot('invalidate-edges');
    const other = createMemory('acme row about the zephyrine cache', { tenantId: 'acme' });
    const pinned = createMemory('pinned row about the zephyrine cache', { pinned: true });
    const plain = createMemory('plain row about the zephyrine cache');
    for (const row of [other, pinned, plain]) writeEntry(root, row);
    expect(invalidateMatching(root, target, 'default', { onlyId: other.id }).targets).toEqual([]);
    expect(invalidateMatching(root, target, undefined, { onlyId: other.id }).targets).toEqual([other.id]);
    expect(invalidateMatching(root, target, 'default', { onlyId: pinned.id }).skippedPinned).toEqual([pinned.id]);
    expect(invalidateMatching(root, target, 'default', { onlyId: 'no-such-id' }).invalidated).toBe(0);
    expect(invalidateMatching(root, target, 'default', { onlyId: plain.id, dryRun: true }).targets).toEqual([plain.id]);
    expect(loadAllEntries(root).find((e) => e.id === plain.id)!.confidence).toBe(plain.confidence);
  });

  it('reads one memory row however many the tenant holds', () => {
    const read = [10, 200].map((n) => {
      const { root, rows } = seeded(n);
      const { rowsRead, statements } = recordStatements(() => invalidateMatching(root, target, 'default', { onlyId: rows[0]!.id, dryRun: true }));
      expect(statements.filter((sql) => sql.startsWith(FULL_ROW))).toEqual([`${FULL_ROW} WHERE id = ? AND tenant_id = ?`]);
      return rowsRead;
    });
    expect(read[1]).toBe(read[0]);
  });
});

describe('syncGlobalToLocal', () => {
  function stores(n: number) {
    const localRoot = newRoot('sync-local');
    const globalRoot = newRoot('sync-global');
    const rows = Array.from({ length: n }, (_, i) => createMemory(`global lesson ${i} about the zephyrine cache`));
    writeEntriesTogether(globalRoot, rows);
    return { localRoot, globalRoot, rows };
  }

  it('copies what it copied before: skips held ids and texts, secrets, agent notes and rejected values', () => {
    const { localRoot, globalRoot, rows } = stores(3);
    writeEntry(localRoot, rows[0]!);
    const sameText = createMemory('local text the global store also holds');
    writeEntry(localRoot, sameText);
    writeEntry(globalRoot, createMemory(sameText.content));
    writeEntry(globalRoot, createMemory('the deploy key is AKIAIOSFODNN7EXAMPLE', { tags: ['secret'] }));
    writeEntry(globalRoot, createMemory('an imported agent note about caching', { source: 'agent-memory:claude' }));
    const rejected = createMemory('a value this local store rejected');
    const twin = createMemory(rejected.content);
    writeEntry(globalRoot, rejected);
    writeEntry(globalRoot, twin);
    const acme = createMemory('acme lesson about the zephyrine cache', { tenantId: 'acme' });
    writeEntry(globalRoot, acme);
    const db = openHippoDb(localRoot);
    try {
      insertRejectedValue(db, {
        tenantId: 'default', digest: rejectionDigest(rejected.content), reason: 'test', rejectedBy: 'test',
        rejectedAt: '2026-06-01T00:00:00.000Z', normalizedChars: rejected.content.length,
      });
    } finally {
      closeHippoDb(db);
    }
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(syncGlobalToLocal(localRoot, globalRoot)).toBe(3);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 2 rejected value'));
    const local = new Map(loadAllEntries(localRoot).map((e) => [e.id, e]));
    expect([...local.keys()].sort()).toEqual([rows[0]!.id, rows[1]!.id, rows[2]!.id, sameText.id, acme.id].sort());
    expect(local.get(acme.id)!.tenantId).toBe('acme');
    const refusals = (() => {
      const handle = openHippoDb(localRoot);
      try {
        return queryAuditEvents(handle, { tenantId: 'default', op: 'reject_refusal' });
      } finally {
        closeHippoDb(handle);
      }
    })();
    expect(refusals.map((r) => r.targetId).sort()).toEqual([rejected.id, twin.id].sort());
  });

  it('opens each store a fixed number of times and commits every copy in one transaction', () => {
    const counts = [10, 200].map((n) => {
      const { localRoot, globalRoot } = stores(n);
      const { result, statements } = recordStatements(() => syncGlobalToLocal(localRoot, globalRoot));
      expect(result).toBe(n);
      return { opens: countMatching(statements, STORE_OPEN), begins: countMatching(statements, 'BEGIN IMMEDIATE') };
    });
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[0]!.begins).toBe(1);
  });

  it('reads no full row of either store when every global row is already local', () => {
    const { localRoot, globalRoot } = stores(50);
    syncGlobalToLocal(localRoot, globalRoot);
    const { result, statements } = recordStatements(() => syncGlobalToLocal(localRoot, globalRoot));
    expect(result).toBe(0);
    expect(countMatching(statements, FULL_ROW)).toBe(0);
  });
});
