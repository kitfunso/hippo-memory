// Sleep's dedup, audit and ambient read the store in keyset pages; a run on small pages must match a run on one page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { Layer } from '../../src/core/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { runSleep } from '../../src/api/sleep/sleep-run.js';
import { auditMemoryQuality } from '../../src/api/auth/audit.js';
import { deduplicateStore, type DedupPair } from '../../src/consolidate/dedupe.js';
import { auditMemories, type AuditIssue } from '../../src/core/memory-audit.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import type { SleepResult } from '../../src/api/sleep/sleep.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';

const PAGE = 4;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ctxFor = (root: string): FullContext => apiCtx(root, 'default', { subject: 'paged-test', role: 'admin' });

// Every row shares the fake clock's `created`, so the ids set the page order: a copy in another page of PAGE rows
// beats the earlier copy (p-03 and p-04, p-02 then p-06 then p-10, acme p-07 and p-13).
const ROWS: ReadonlyArray<readonly [string, string, { tenantId?: string; pinned?: boolean; retrievals?: number }]> = [
  ['p-00', 'the deploy runs on friday at noon', {}],
  ['p-01', 'billing is owned by alice in finance', {}],
  ['p-02', 'the cache warms every hour on the hour', {}],
  ['p-03', 'the queue drains every night at two', {}],
  ['p-04', 'the  queue drains every night at two', {}],
  ['p-05', 'nope', {}],
  ['p-06', 'the cache warms every  hour on the hour', { retrievals: 2 }],
  ['p-07', 'the queue drains every night at two', { tenantId: 'acme' }],
  ['p-08', 'the release branch is cut on monday', { pinned: true }],
  ['p-09', 'vague thing', {}],
  ['p-10', 'the  cache warms every hour on the hour', { retrievals: 5 }],
  ['p-11', 'nope', { tenantId: 'acme' }],
  ['p-12', 'the release branch is cut  on monday', { retrievals: 4 }],
  ['p-13', 'the queue  drains every night at two', { tenantId: 'acme', retrievals: 1 }],
  ['p-14', 'staging restarts every sunday night', {}],
  ['p-15', 'the logs rotate daily at midnight utc', {}],
  ['p-16', 'oncall hands over every tuesday morning', { tenantId: 'acme' }],
  ['p-17', 'the cache warms every hour on the  hour', { tenantId: 'acme' }],
  ['p-18', 'the cache warms every hour on the hour', { tenantId: 'acme', retrievals: 3 }],
  ['p-19', 'metrics are kept for ninety days', {}],
];

// Semantic rows, so consolidation merges none: a merged row's random id would order it differently in each run.
function seeded(): string {
  const root = makeRoot('sleep-paged');
  roots.push(root);
  for (const [id, text, { tenantId = 'default', pinned = false, retrievals = 0 }] of ROWS) {
    const entry = createMemory(text, { tags: ['ops'], tenantId, pinned, layer: Layer.Semantic });
    writeEntry(root, { ...entry, id, retrieval_count: retrievals });
  }
  return root;
}

interface SleepRun {
  readonly result: SleepResult;
  readonly pairs: DedupPair[];
  readonly issues: AuditIssue[];
  readonly left: string[];
}

async function sleepWithPages(pageSize: number, dryRun: boolean): Promise<SleepRun> {
  const root = seeded();
  const pairs: DedupPair[] = [];
  const issues: AuditIssue[] = [];
  const result = await runSleep(ctxFor(root), { noShare: true, dryRun }, {
    pageSize,
    deduplicateStore: (store, options) => {
      const out = deduplicateStore(store, options);
      pairs.push(...out.pairs);
      return out;
    },
    auditMemories: (entries, backing) => {
      const out = auditMemories(entries, backing);
      issues.push(...out.issues);
      return out;
    },
  });
  return { result, pairs, issues, left: loadEveryTenantEntries(root).map((e) => e.id) };
}

describe('sleep in keyset pages', () => {
  it.each([false, true])('matches a one-page run row for row (dryRun %s)', async (dryRun) => {
    const home = makeRoot('sleep-paged-home');
    roots.push(home);
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:00:00.000Z');
    _resetAblationCacheForTests();
    expect(ROWS.length).toBeGreaterThan(PAGE * 2);

    const paged = await sleepWithPages(PAGE, dryRun);
    const whole = await sleepWithPages(1000, dryRun);

    expect(paged.pairs).toEqual(whole.pairs);
    expect(paged.issues).toEqual(whole.issues);
    expect(paged.result).toEqual(whole.result);
    expect(paged.left).toEqual(whole.left);
    // A sorted whole-store pass gives these: survivors by rank within each tenant, the beaten pinned p-08 kept.
    expect(paged.pairs.map((p) => [p.kept, p.removed])).toEqual([
      ['p-10', 'p-06'], ['p-10', 'p-02'], ['p-04', 'p-03'], ['p-18', 'p-17'], ['p-13', 'p-07'],
    ]);
    expect(paged.issues.filter((i) => i.severity === 'error').map((i) => i.memoryId).sort()).toEqual(['p-05', 'p-11']);
  });

  it('audits the caller tenant page by page with the same result as one page', async () => {
    const root = seeded();
    const ctx = ctxFor(root);
    const paged = await auditMemoryQuality(ctx, { pageSize: 2 });
    expect(paged.total).toBe(ROWS.filter(([, , o]) => (o.tenantId ?? 'default') === 'default').length);
    expect(paged).toEqual(await auditMemoryQuality(ctx));
  });
});
