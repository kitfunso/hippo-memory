// C1 + H10: sleep never auto-deletes a raw or pinned row, keeps a change made while it
// awaits the LLM, and a dry run previews the deletes a real sleep would make.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { consolidate } from '../../src/index.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { sleep, supersede } from '../../src/api/index.js';
import { runSleep } from '../../src/api/sleep/sleep-run.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { sleepResultLines } from '../../src/surface/cli/sleep-render.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteConsolidation } from '../../src/store/sqlite/consolidation.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  loadEveryTenantEntries,
  deleteEntry,
  loadAllDirtySummaries,
  writeEntry,
  readEntry,
  batchWriteAndDelete,
} from '../_helpers/root-forms.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) =>
  createMemory(content, { baseHalfLifeDays: 7, ...options });

const DAY = 86_400_000;
const roots: string[] = [];

function newRoot(configJson?: string): string {
  const root = makeRoot('c1');
  roots.push(root);
  if (configJson) writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

const rawRow = (content: string): MemoryEntry =>
  createMemory7(content, { kind: 'raw', artifactRef: 'slack://T1/C1/1.0', owner: 'user:U1' });
const ctxFor = (hippoRoot: string): FullContext =>
  apiCtx(hippoRoot, 'default', { subject: 'sleep-test', role: 'admin' });
const sixtyDaysOn = (): Date => new Date(Date.now() + 60 * DAY);
const CACHE_FACT = 'the build cache lives in /var/cache/hippo on the CI runners';

function summarizer(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('real network call in a test');
    }),
  );
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ text }] }), { status: 200 }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) removeAfterRequest(r);
});

describe('consolidate never deletes a raw row', () => {
  it.each([false, true])('memoryValue.enabled=%s: the decayed raw row stays, the plain row goes', async (mv) => {
    const root = newRoot(JSON.stringify({ memoryValue: { enabled: mv } }));
    const raw = rawRow('slack message: the deploy moved to friday');
    const plain = createMemory7('an ordinary memory that should decay away');
    writeEntry(root, raw);
    writeEntry(root, plain);

    await consolidate(root, { now: sixtyDaysOn() });

    expect(readEntry(root, raw.id)?.kind).toBe('raw');
    expect(readEntry(root, plain.id)).toBeNull();
    // A second sleep has nothing left to remove: the plain row is already gone and the raw row is never deleted.
    await expect(consolidate(root, { now: sixtyDaysOn() })).resolves.toMatchObject({ removed: 0 });
    expect(readEntry(root, raw.id)?.kind).toBe('raw');
  });
});

describe('the sleep audit and dedup respect raw and pinned rows', () => {
  it('audit deletes only the plain junk row and logs the caller and a reason', async () => {
    const root = newRoot();
    const raw = rawRow('yes!');
    const pinned = createMemory7('ok ok', { pinned: true });
    const plain = createMemory7('nope');
    for (const e of [raw, pinned, plain]) writeEntry(root, e);

    const result = await sleep(ctxFor(root), { noShare: true });

    expect(readEntry(root, raw.id)).not.toBeNull();
    expect(readEntry(root, pinned.id)).not.toBeNull();
    expect(readEntry(root, plain.id)).toBeNull();
    expect(result.audit).toEqual({ errorsRemoved: 1, warningCount: 2 });
    const db = openHippoDb(root);
    try {
      const forgets = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(forgets.map((f) => f.targetId)).toEqual([plain.id]);
      expect(forgets[0]!.actor).toBe('sleep-test');
      expect(String(forgets[0]!.metadata.reason)).toMatch(/^sleep-audit: /);
    } finally {
      closeHippoDb(db);
    }
  });

  it('dedup keeps a pinned duplicate', () => {
    const root = newRoot();
    const keeper = createMemory7(CACHE_FACT);
    const pinnedCopy = { ...createMemory(CACHE_FACT, { pinned: true }), strength: 0.5 };
    writeEntry(root, keeper);
    writeEntry(root, pinnedCopy);

    deduplicateStore(sqliteConsolidation(handlesOf(root)));

    expect(readEntry(root, keeper.id)?.content).toBe(CACHE_FACT);
    expect(readEntry(root, pinnedCopy.id)).toMatchObject({ content: CACHE_FACT, pinned: true });
  });

  it('an automatic delete refuses a pinned or raw row; an explicit forget still deletes', () => {
    const root = newRoot();
    const pinned = createMemory7('ok ok', { pinned: true });
    const raw = rawRow('yes!');
    for (const e of [pinned, raw]) writeEntry(root, e);

    expect(deleteEntry(root, pinned.id, { automatic: true })).toBe(false);
    expect(deleteEntry(root, raw.id, { automatic: true })).toBe(false);
    expect(readEntry(root, raw.id)).not.toBeNull();
    expect(deleteEntry(root, pinned.id)).toBe(true);
  });

  it('the sleep audit keeps a row pinned after its snapshot was taken', async () => {
    const root = newRoot();
    const pinned = createMemory7('nope', { pinned: true });
    writeEntry(root, pinned);
    const staleIssue = { memoryId: pinned.id, content: 'nope', severity: 'error' as const, reason: 'too short' };

    const result = await runSleep(
      ctxFor(root),
      { noShare: true },
      {
        auditMemories: () => ({ total: 1, clean: 0, issues: [staleIssue] }),
      },
    );

    expect(readEntry(root, pinned.id)).not.toBeNull();
    expect(result.audit?.errorsRemoved ?? 0).toBe(0);
  });

  it('a dry run previews the dedup and audit deletes and deletes nothing', async () => {
    const root = newRoot();
    const rows = [createMemory7('nope'), createMemory7(CACHE_FACT), { ...createMemory(CACHE_FACT), strength: 0.5 }];
    for (const e of rows) writeEntry(root, e);

    const result = await sleep(ctxFor(root), { dryRun: true, noShare: true });

    expect(result.deduped?.removed).toBe(1);
    expect(result.audit).toEqual({ errorsRemoved: 1, warningCount: 0 });
    expect(result.shared).toBeUndefined();
    expect(loadEveryTenantEntries(root)).toHaveLength(3);
  });

  it('the dry-run render says "would" instead of "removed"', () => {
    const out = sleepResultLines({
      active: 3,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: true,
      details: [],
      deduped: { removed: 1, semDups: 0, epiDups: 1, crossDups: 0 },
      audit: { errorsRemoved: 1, warningCount: 0 },
    }).join('\n');
    expect(out).toContain('Would dedupe 1 duplicates');
    expect(out).toContain('Audit: would remove 1 junk memories');
    expect(out).not.toMatch(/Deduped|removed 1 junk/);
  });
});

describe('a row changed while sleep awaits the LLM keeps the change', () => {
  it('a mid-sleep pin, forget and supersede all survive the batch flush', async () => {
    const root = newRoot();
    const condemned = createMemory7('a fact that decays below the threshold by day sixty');
    const forgotten = createMemory7('the staging cluster restarts every sunday at noon', { baseHalfLifeDays: 30 });
    const replaced = createMemory7('invoices are exported as csv files on the first monday', { baseHalfLifeDays: 30 });
    for (const e of [condemned, forgotten, replaced]) writeEntry(root, e);

    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (calls++ === 0) {
        writeEntry(root, { ...readEntry(root, condemned.id)!, pinned: true });
        deleteEntry(root, forgotten.id);
        await supersede(ctxFor(root), replaced.id, 'invoices are exported as parquet files on the first monday');
      }
      return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('real network call in a test');
      }),
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');

    const result = await consolidate(root, { now: sixtyDaysOn(), fetcher });

    expect(fetcher).toHaveBeenCalled();
    expect(readEntry(root, condemned.id)?.pinned).toBe(true);
    expect(readEntry(root, forgotten.id)).toBeNull();
    expect(readEntry(root, replaced.id)?.supersededBy).toMatch(/^mem_[0-9a-f]+$/);
    expect(result.removed).toBe(0);
    expect(result.removedIds).toEqual([]);
    expect(result.details).toContain(`  ↩  ${condemned.id} not removed: pinned or already gone before sleep saved`);
  });

  it('facts linked to a new summary keep the link, so the next sleep pays for no duplicate or rebuild', async () => {
    const root = newRoot();
    const facts = [
      'alice moved the deploy to friday',
      'alice owns the billing service',
      'alice reviews every schema change',
    ].map((text) => createMemory7(text, { layer: Layer.Semantic, dagLevel: 1, tags: ['extracted', 'speaker:alice'] }));
    for (const f of facts) writeEntry(root, f);
    const fetcher = summarizer('Alice moved the deploy to Friday, owns billing and reviews schema changes.');

    await consolidate(root, { now: new Date(Date.now() + DAY), fetcher });
    await consolidate(root, { now: new Date(Date.now() + 2 * DAY), fetcher });

    const after = facts.map((f) => readEntry(root, f.id)!);
    expect(after[0]!.dagParentId).toMatch(/^[a-z]+_[0-9a-f]+$/);
    expect(new Set(after.map((f) => f.dagParentId)).size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(loadAllDirtySummaries(root)).toEqual([]);
  });

  it('a summary rebuilt during sleep keeps its new text', async () => {
    const root = newRoot();
    const summary = createMemory7('alice owns the billing service', {
      layer: Layer.Semantic,
      dagLevel: 2,
      tags: ['speaker:alice', 'dag-summary'],
    });
    writeEntry(root, summary);
    writeEntry(
      root,
      createMemory7('alice now also runs the friday deploy', {
        layer: Layer.Semantic,
        dagLevel: 1,
        dagParentId: summary.id,
        tags: ['extracted', 'speaker:alice'],
      }),
    );
    const rebuilt = 'Alice owns the billing service and runs the Friday deploy.';

    await consolidate(root, { now: new Date(Date.now() + DAY), fetcher: summarizer(rebuilt) });

    expect(readEntry(root, summary.id)?.content).toBe(rebuilt);
  });

  it('a row queued twice in one flush keeps its last version, even a field set back to its loaded value', () => {
    const root = newRoot();
    writeEntry(root, createMemory7('the deploy runs on friday'));
    const [loaded] = loadEveryTenantEntries(root);
    const snapshot = new Map([[loaded!.id, structuredClone(loaded!)]]);

    batchWriteAndDelete(
      root,
      [
        { ...loaded!, strength: 0.5 },
        { ...loaded!, retrievalCount: 1 },
      ],
      [],
      { snapshot },
    );

    expect(readEntry(root, loaded!.id)).toMatchObject({ strength: loaded!.strength, retrievalCount: 1 });
  });
});
