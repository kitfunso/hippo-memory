// DAG E3 rebuild regressions: born-dirty buildDag, tenant partitioning, race-loser no-op, cap clamp and tombstone counts.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { rebuildDirtySummaries, buildDag } from '../../src/domain/consolidate/dag.js';
import * as dagModule from '../../src/domain/consolidate/dag.js';
import { consolidate } from '../../src/index.js';
import { configReader } from '../../src/base/config/config.js';
import { envRuntimeSettings } from '../../src/base/util/env.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllDirtySummaries, applyRebuildResult, writeEntry } from '../_helpers/root-forms.js';
import { makeOkFetcher, getRow, forceMarkDirty, rejectValue, makeSummary, makeChild } from '../_helpers/dag-rebuild.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sleep-cycle rebuildDirtySummaries', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('dag-e3');
  });

  it('test #10: REGRESSION LOCK: buildDag clean-up. Born-dirty fix: brand-new summaries are NOT re-rebuilt on same sleep cycle.', async () => {
    // Setup 3 extracted facts (buildDag's minimum cluster size) sharing entity tags
    const factA = createMemory('alice did X', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      tags: ['extracted', 'speaker:alice'],
    });
    const factB = createMemory('alice said Y', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      tags: ['extracted', 'speaker:alice'],
    });
    const factC = createMemory('alice noted Z', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      tags: ['extracted', 'speaker:alice'],
    });
    writeEntry(hippoRoot, factA);
    writeEntry(hippoRoot, factB);
    writeEntry(hippoRoot, factC);

    const fetcher = makeOkFetcher('synthetic-summary-X-from-fetcher-mocked-out');

    // Invoke buildDag with injected fetcher
    const buildResult = await buildDag(sqliteStore(hippoRoot), [factA, factB, factC], {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      llm: anthropicLlm({ apiKey: 'test-key', fetcher }),
    });
    expect(buildResult.summariesCreated).toBe(1);

    // The created summary MUST NOT be dirty (the clearSummaryDirtyAfterBuild
    // call inside buildDag cancels the dirty-marks fired during child linkage)
    const stillDirty = loadAllDirtySummaries(hippoRoot);
    expect(stillDirty.length).toBe(0);

    // Audit row for summary_marked_clean source='buildDag-clean' should exist
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: metadata_json is a NOT NULL TEXT column on audit_log; .all()
      // rows always match the queried SELECT's single column.
      const auditRows = db
        .prepare(`
        SELECT metadata_json FROM audit_log WHERE op = 'summary_marked_clean'
      `)
        .all() as Array<{ metadata_json: string }>;
      // One summary was built, and its dirty flag cleared once.
      expect(auditRows).toHaveLength(1);
      const meta = JSON.parse(auditRows[0].metadata_json);
      expect(meta.source).toBe('buildDag-clean');
    } finally {
      closeHippoDb(db);
    }

    // Now run rebuildDirtySummaries — must report attempted=0
    const rebuildResult = await rebuildDirtySummaries(sqliteStore(hippoRoot), {
      llm: anthropicLlm({ apiKey: 'k', fetcher }),
      cap: 20,
    });
    expect(rebuildResult.attempted).toBe(0);
    expect(rebuildResult.rebuilt).toBe(0);
  });

  it('T-followup (hardening pass, docs/plans/2026-08-15-hardening-at1-followups.md): buildDag partitions unparented facts by tenant — two tenants sharing a speaker: tag produce two per-tenant summaries, never one cross-tenant summary in default', async () => {
    // Deliberately the SAME entity tag ('speaker:alice') across both
    // tenants so that without the tenant partition, clusterFacts's jaccard
    // match on entityTags would merge all 6 facts into one 6-member cluster
    // whose LLM-synthesized summary then landed in 'default' regardless of
    // source (memory.ts:535's implicit default when createMemory isn't
    // passed a tenantId). Mirrors T1(a)'s cross-tenant shape
    // (tests/store/consolidate-tenant-landing.test.ts) but for the DAG producer
    // (dag.ts buildDag) instead of consolidate.ts's merge pass.
    const aFacts = ['alice did X', 'alice said Y', 'alice noted Z'].map((c) =>
      createMemory(c, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Episodic,
        dagLevel: 1,
        tags: ['extracted', 'speaker:alice'],
        tenantId: 'tenant-a',
      }),
    );
    const bFacts = ['alice ran P', 'alice flagged Q', 'alice closed R'].map((c) =>
      createMemory(c, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Episodic,
        dagLevel: 1,
        tags: ['extracted', 'speaker:alice'],
        tenantId: 'tenant-b',
      }),
    );
    for (const f of [...aFacts, ...bFacts]) writeEntry(hippoRoot, f);

    const fetcher = makeOkFetcher('synthetic-tenant-partitioned-summary');
    // Host-wide input, exactly like consolidate.ts:543's `extractedFacts`
    // (survivors filtered host-wide, no tenant slicing by the caller) —
    // buildDag itself must do the tenant separation, not its caller.
    const result = await buildDag(sqliteStore(hippoRoot), [...aFacts, ...bFacts], {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      llm: anthropicLlm({ apiKey: 'test-key', fetcher }),
    });

    // Two separate per-tenant clusters, not one 6-member cross-tenant cluster.
    expect(result.candidateClusters).toBe(2);
    expect(result.summariesCreated).toBe(2);
    expect(result.factsLinked).toBe(6);

    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: summaries' shape matches the two columns named in the
      // SELECT above.
      const summaries = db
        .prepare(`SELECT id, tenant_id FROM memories WHERE dag_level = 2 AND tags_json LIKE '%dag-summary%'`)
        .all() as Array<{ id: string; tenant_id: string }>;
      expect(summaries).toHaveLength(2);
      const tenants = summaries.map((s) => s.tenant_id).sort();
      expect(tenants).toEqual(['tenant-a', 'tenant-b']);
      expect(tenants).not.toContain('default');

      // Each tenant's 3 members must be re-parented under THAT tenant's own
      // summary — no member crossed into the other tenant's cluster.
      const summaryByTenant = new Map(summaries.map((s) => [s.tenant_id, s.id]));
      for (const [tenantId, facts] of [
        ['tenant-a', aFacts],
        ['tenant-b', bFacts],
      ] as const) {
        // SAFETY: rows' shape matches the single `dag_parent_id` column
        // named in the SELECT above.
        const rows = db
          .prepare(`SELECT dag_parent_id FROM memories WHERE tenant_id = ? AND dag_level = 1`)
          .all(tenantId) as Array<{ dag_parent_id: string }>;
        expect(rows).toHaveLength(facts.length);
        for (const row of rows) {
          expect(row.dag_parent_id).toBe(summaryByTenant.get(tenantId));
        }
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('test #11: race-loser no-op — pre-cleared dirty flag → applyRebuildResult returns false, no audit, no rebuild_count bump', () => {
    const summary = makeSummary('s11-summary-content');
    writeEntry(hippoRoot, summary);
    // Note: we do NOT force-mark dirty — simulate the race-loser by leaving clean

    const result = applyRebuildResult(hippoRoot, summary, {
      content: 'should-not-land',
      descendantCount: 5,
      earliestAt: '2026-05-25T10:00:00Z',
      latestAt: '2026-05-25T11:00:00Z',
      bumpRebuildCount: true,
      zeroChildren: false,
      actor: 'test',
    });
    expect(result.changed).toBe(false);
    expect(result.refused).toBe(false); // race-loser, not a refusal — no tombstone hit

    const db = openHippoDb(hippoRoot);
    try {
      const row = getRow<{ content: string; rebuild_count: number | null; summary_dirty: number }>(
        db,
        `SELECT content, rebuild_count, summary_dirty FROM memories WHERE id = ?`,
        summary.id,
      );
      // Content unchanged
      expect(row.content).toBe('s11-summary-content');
      // rebuild_count UNCHANGED (null or 0)
      expect(row.rebuild_count ?? 0).toBe(0);

      // No summary_rebuilt audit row for this summary
      // SAFETY: COUNT(*) always returns exactly one row shaped { n: number }.
      const auditRow = db
        .prepare(`
        SELECT COUNT(*) AS n FROM audit_log WHERE op = 'summary_rebuilt' AND target_id = ?
      `)
        .get(summary.id) as { n: number };
      expect(auditRow.n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('test #12: cap hard-ceiling: consolidate() clamps HIPPO_DAG_REBUILD_CAP before it reaches rebuildDirtySummaries', async () => {
    const originalFetch = global.fetch;
    // The spy reads the cap consolidate() computed, so the 1000 ceiling is
    // proven without seeding more than 1000 dirty rows.
    const rebuildSpy = vi.spyOn(dagModule, 'rebuildDirtySummaries');
    try {
      const sum = makeSummary('sum-0');
      writeEntry(hippoRoot, sum);
      writeEntry(hippoRoot, makeChild(sum.id, 'fact-0'));
      forceMarkDirty(hippoRoot, sum.id);
      global.fetch = makeOkFetcher('clamped-ceiling-XXX-content');
      vi.stubEnv('ANTHROPIC_API_KEY', 'k');

      const table: Array<[string, number]> = [
        ['99999', 1000],
        ['1001', 1000],
        ['1000', 1000],
        ['50', 50],
        ['0', 20],
        ['-5', 20],
        ['abc', 20],
      ];
      for (const [index, [raw, expected]] of table.entries()) {
        vi.stubEnv('HIPPO_DAG_REBUILD_CAP', raw);
        // A root's config, so the raw value takes the path the CLI and server give it.
        const result = await consolidate(hippoRoot, { config: configReader(envRuntimeSettings)(hippoRoot) });
        expect(rebuildSpy).toHaveBeenCalledTimes(index + 1);
        expect(rebuildSpy.mock.calls[index][1].cap).toBe(expected);
        if (index === 0) {
          const processed = result.summariesRebuilt + result.summariesZeroChildSkipped + result.summariesRebuildFailed;
          // The one dirty summary seeded above.
          expect(processed).toBe(1);
        }
      }
    } finally {
      rebuildSpy.mockRestore();
      global.fetch = originalFetch;
    }
  });

  it('test #13: T4 — tombstone-hit rebuild increments refused, not rebuilt (dirty still clears, content unchanged)', async () => {
    const summary = makeSummary('original summary content');
    writeEntry(hippoRoot, summary);
    const child = makeChild(summary.id, 'fact for refused rebuild');
    writeEntry(hippoRoot, child);
    forceMarkDirty(hippoRoot, summary.id);

    const rejectedContent = 'this-exact-content-was-already-rejected-XYZ';
    rejectValue(hippoRoot, summary.tenantId, rejectedContent);

    // Fetcher regenerates content byte-identical to the tombstoned value —
    // the deterministic-summarization scenario the AT1 P1a fix guards.
    const fetcher = makeOkFetcher(rejectedContent);
    const result = await rebuildDirtySummaries(sqliteStore(hippoRoot), {
      llm: anthropicLlm({ apiKey: 'test-key', fetcher }),
      cap: 20,
    });

    expect(result.attempted).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.rebuilt).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.zeroChildSkipped).toBe(0);

    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: row's shape matches the four columns named in the SELECT
      // above (store.ts's SummaryRow types these the same way).
      const row = db
        .prepare(`
        SELECT content, summary_dirty, rebuild_count, descendant_count FROM memories WHERE id = ?
      `)
        .get(summary.id) as {
        content: string;
        summary_dirty: number | null;
        rebuild_count: number | null;
        descendant_count: number | null;
      };
      // Content NOT overwritten — the tombstone refused it.
      expect(row.content).toBe('original summary content');
      // Dirty still clears — no infinite retry loop (the pre-existing
      // no-infinite-retry choice T4 keeps).
      expect(row.summary_dirty).toBe(0);
      expect(row.rebuild_count ?? 0).toBe(0);
      // Metadata still applies alongside the refusal.
      expect(row.descendant_count).toBe(1);

      // SAFETY: this get() result's shape matches the single aliased `n`
      // column named in the SELECT above.
      const refusalAudit = db
        .prepare(`
        SELECT COUNT(*) AS n FROM audit_log WHERE op = 'reject_refusal' AND target_id = ?
      `)
        .get(summary.id) as { n: number };
      expect(refusalAudit.n).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('test #14: T4 — clean rebuild (no tombstone hit) increments rebuilt, refused stays zero', async () => {
    const summary = makeSummary('stale summary content');
    writeEntry(hippoRoot, summary);
    const child = makeChild(summary.id, 'fact for clean rebuild');
    writeEntry(hippoRoot, child);
    forceMarkDirty(hippoRoot, summary.id);

    const fetcher = makeOkFetcher('fresh-regenerated-summary-content-T4');
    const result = await rebuildDirtySummaries(sqliteStore(hippoRoot), {
      llm: anthropicLlm({ apiKey: 'test-key', fetcher }),
      cap: 20,
    });

    expect(result.attempted).toBe(1);
    expect(result.rebuilt).toBe(1);
    expect(result.refused).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.zeroChildSkipped).toBe(0);
  });
});
