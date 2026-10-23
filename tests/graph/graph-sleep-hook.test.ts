/**
 * E3 sleep enqueue-hook - tests.
 * Docs: docs/plans/2026-06-02-e3-sleep-enqueue-hook.md
 *
 * PRODUCER: every graph-source E2 mutation (save/close of decision/policy/
 * customer_note/project_brief, + project-brief refresh) marks its tenant dirty
 * via markGraphDirty -> graph_extraction_queue (fail-soft).
 * CONSUMER: api.sleep drains the pending queue - per dirty tenant: extractGraph
 * full rebuild, then mark only items at/below the snapshot watermark processed.
 * Real SQLite (temp dirs), no mocks.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeObject } from '../../src/domain/objects/lifecycle.js';
import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import { DECISION, saveDecision } from '../../src/domain/objects/decisions.js';
import { savePolicy } from '../../src/domain/objects/policies.js';
import { saveProjectBrief, refreshedBrief } from '../../src/domain/objects/project-briefs.js';
import { loadExtractionQueue } from '../_helpers/graph-queue.js';
import {
  extractGraph as realExtractGraph,
  extractGraphChunked,
  deriveGraph,
  loadGraphSources,
} from '../../src/domain/graph/extract.js';
import type { EntityType } from '../../src/store/port/graph.js';
import { WRITE_BUDGET } from '../../src/base/util/write-budget.js';
import { sleep, adminActor } from '../../src/api/index.js';
import { runSleep, type SleepPhases } from '../../src/api/sleep/sleep-run.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/base/config/config.js';
import { makeStore, makeRoot } from '../_helpers/make-root.js';
import {
  deleteEntry,
  loadPendingExtractionTenants,
  markGraphDirty,
  loadEntities,
  loadRelations,
} from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

const T = 'default';

interface TestCtx {
  hippoRoot: string;
  ctx: FullContext;
  restore: () => void;
}

function newCtx(): TestCtx {
  const { base: tmpDir, root: hippoRoot } = makeStore('sleep-hook');
  // Per-test HIPPO_HOME isolation (autoShare phase calls initGlobal()).
  const globalTmp = makeRoot('sleep-hook-global', { init: false });
  vi.stubEnv('HIPPO_HOME', globalTmp);
  const ctx = apiCtx(hippoRoot, T, adminActor('test:sleep-hook'));
  return {
    hippoRoot,
    ctx,
    restore: () => {
      removeAfterRequest(tmpDir);
    },
  };
}

function pending(hippoRoot: string, tenant: string = T) {
  return loadExtractionQueue(hippoRoot, tenant, { status: 'pending', limit: 1000 });
}
function processed(hippoRoot: string, tenant: string = T) {
  return loadExtractionQueue(hippoRoot, tenant, { status: 'processed', limit: 1000 });
}

describe('sleep enqueue-hook', () => {
  let tc: TestCtx;
  beforeEach(() => {
    tc = newCtx();
  });
  afterEach(() => {
    tc.restore();
  });

  // -- Producer --------------------------------------------------------------

  it('1. saveDecision enqueues one pending queue item for its tenant', async () => {
    const d = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    const q = pending(tc.hippoRoot);
    expect(q).toHaveLength(1);
    expect(q[0].memoryId).toBe(d.memoryId);
    expect(q[0].status).toBe('pending');
  });

  it('2. markGraphDirty is fail-soft: a bogus/null memoryId does not throw and enqueues nothing', () => {
    expect(() => markGraphDirty(tc.hippoRoot, T, 'does-not-exist')).not.toThrow();
    expect(() => markGraphDirty(tc.hippoRoot, T, null)).not.toThrow();
    expect(pending(tc.hippoRoot)).toHaveLength(0);
  });

  it('3. coalesce: 3 decisions enqueue 3 pending items, all the same tenant', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'one',
    });
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'two',
    });
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'three',
    });
    const q = pending(tc.hippoRoot);
    expect(q).toHaveLength(3);
    expect(new Set(q.map((i) => i.tenantId))).toEqual(new Set([T]));
  });

  it('4. close and project-brief refresh also enqueue (dirty on every graph-source mutation)', async () => {
    const d = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'to be closed',
    });
    await closeObject(objectsAt(tc.hippoRoot), DECISION, T, d.id, CLI_ACTOR);
    await saveProjectBrief(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      repo: 'myrepo',
      summary: 'first',
    });
    await refreshedBrief(
      objectsAt(tc.hippoRoot),
      { baseHalfLifeDays: loadConfig(tc.hippoRoot).defaultHalfLifeDays, tenantId: T, actor: 'cli' },
      'myrepo',
    ); // delegates to saveProjectBrief
    // save(d) + close(d) + saveBrief + refresh(->saveBrief) = 4 enqueues
    expect(pending(tc.hippoRoot).length).toBe(4);
  });

  // -- Consumer --------------------------------------------------------------

  it('5. sleep rebuilds the graph for a dirty tenant and drains its queue', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    await savePolicy(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      policyName: 'RetryPolicy',
      policyText: 'retry 3x',
    });
    expect(pending(tc.hippoRoot).length).toBe(2);
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0); // not yet extracted

    const r = await sleep(tc.ctx, { noShare: true });
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 }).length).toBe(2); // rebuilt by sleep
    expect(pending(tc.hippoRoot)).toHaveLength(0); // drained
    expect(processed(tc.hippoRoot).length).toBe(2);
    expect(r.graph).toEqual({ tenants: 1, entities: 2, relations: 0 });
  });

  it('6. only dirty tenants rebuild: a second sleep with no new writes reports no graph work', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    const r1 = await sleep(tc.ctx, { noShare: true });
    expect(r1.graph?.tenants).toBe(1);
    const r2 = await sleep(tc.ctx, { noShare: true }); // nothing newly dirty
    expect(r2.graph).toBeUndefined();
    expect(pending(tc.hippoRoot)).toHaveLength(0);
  });

  it('7. multi-tenant: two dirty tenants both rebuild + drain; entities stay tenant-isolated', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, 'tenantA', {
      decisionText: 'TenantA adopts Postgres as the system of record',
    });
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, 'tenantB', {
      decisionText: 'TenantB adopts Kafka for the event streaming backbone',
    });
    const r = await sleep(tc.ctx, { noShare: true });
    expect(r.graph?.tenants).toBe(2);
    expect(loadEntities(tc.hippoRoot, 'tenantA', { limit: 100 }).length).toBe(1);
    expect(loadEntities(tc.hippoRoot, 'tenantB', { limit: 100 }).length).toBe(1);
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0);
    expect(pending(tc.hippoRoot, 'tenantA')).toHaveLength(0);
    expect(pending(tc.hippoRoot, 'tenantB')).toHaveLength(0);
  });

  it('8. dryRun: no rebuild, no drain (items stay pending), no graph field', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    const r = await sleep(tc.ctx, { dryRun: true });
    expect(r.graph).toBeUndefined();
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0);
    expect(pending(tc.hippoRoot)).toHaveLength(1); // still dirty
  });

  it('9. snapshot watermark: an item enqueued DURING the rebuild stays pending', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres as the primary application datastore',
    });
    // Inject an extractGraph that enqueues a NEW item (id > watermark) mid-rebuild.
    const phases: Partial<SleepPhases> = {
      extractGraph: async (store, tid) => {
        if (tid === T) {
          await saveDecision(store.objects, loadConfig(tc.hippoRoot).defaultHalfLifeDays, tid, {
            decisionText: 'Adopt Redis as the shared caching tier',
          });
        }
        return realExtractGraph(store, tid);
      },
    };
    await runSleep(tc.ctx, { noShare: true }, phases);
    // The original (<= watermark) is processed; the mid-rebuild arrival is still pending.
    const stillPending = pending(tc.hippoRoot);
    expect(stillPending).toHaveLength(1);
    expect(processed(tc.hippoRoot).length).toBe(1);
  });

  it('10. fault isolation: one tenant extract throwing leaves it pending, others drain, sleep completes', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, 'tenantFail', {
      decisionText: 'TenantFail standardizes on the GraphQL API gateway',
    });
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, 'tenantOk', {
      decisionText: 'TenantOk migrates services onto the gRPC mesh',
    });
    const phases: Partial<SleepPhases> = {
      extractGraph: (store, tid) => {
        if (tid === 'tenantFail') throw new Error('boom: extract failed for tenantFail');
        return realExtractGraph(store, tid);
      },
    };
    const r = await runSleep(tc.ctx, { noShare: true }, phases); // must NOT reject
    expect(loadEntities(tc.hippoRoot, 'tenantOk', { limit: 100 }).length).toBe(1);
    expect(pending(tc.hippoRoot, 'tenantOk')).toHaveLength(0); // ok tenant drained
    expect(pending(tc.hippoRoot, 'tenantFail')).toHaveLength(1); // failed tenant left pending
    expect(r.graph?.tenants).toBe(1); // only tenantOk counted
    expect((r.details ?? []).some((d) => d.includes('graph: extract failed'))).toBe(true);
  });

  it('11. end-to-end: a supersede edge is built by sleep with NO manual extract', async () => {
    const d1 = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres (managed)',
      supersedesDecisionId: d1.id,
    });
    // No call to graph extract / extractGraph here - sleep is the only trigger.
    await sleep(tc.ctx, { noShare: true });
    const rels = loadRelations(tc.hippoRoot, T, { limit: 100 });
    expect(rels.some((r) => r.relType === 'supersedes')).toBe(true);
  });

  it('13. clean store: sleep with no graph-source objects omits the graph field', async () => {
    const r = await sleep(tc.ctx, { noShare: true });
    expect(r.graph).toBeUndefined();
    expect(loadPendingExtractionTenants(tc.hippoRoot)).toHaveLength(0);
  });

  it('14. a tenant still rebuilds when an earlier sleep phase deletes its queued mirror', async () => {
    const d = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres as the system of record',
    });
    expect(pending(tc.hippoRoot)).toHaveLength(1);
    // Simulate dedup/audit removing the queued mirror mid-sleep: the queue row
    // FK-cascade-deletes, so a drain-TIME tenant load would drop T entirely. The
    // dirty-tenant snapshot taken before the deleting phases must still rebuild T.
    const phases: Partial<SleepPhases> = {
      deduplicateStore: async () => {
        deleteEntry(tc.hippoRoot, d.memoryId!);
        return { removed: 1, pairs: [] };
      },
    };
    const r = await runSleep(tc.ctx, { noShare: true }, phases);
    expect(r.graph?.tenants).toBe(1); // T rebuilt despite the mid-sleep deletion
    expect(pending(tc.hippoRoot)).toHaveLength(0); // its queue row cascade-deleted (mark = no-op)
  });

  it('15. fail-soft: a dirty-tenant snapshot failure does not abort core sleep', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres as the system of record',
    });
    const phases: Partial<SleepPhases> = {
      loadPendingExtractionTenants: () => {
        throw new Error('boom: queue read failed');
      },
    };
    const r = await runSleep(tc.ctx, { noShare: true }, phases); // must NOT reject
    expect(r.active).toBeGreaterThanOrEqual(0); // consolidation still ran (result built)
    expect(r.graph).toBeUndefined(); // graph refresh skipped, not crashed
    expect((r.details ?? []).some((d) => d.includes('dirty-tenant snapshot failed'))).toBe(true);
    expect(pending(tc.hippoRoot)).toHaveLength(1); // item left pending, recovered next sleep
  });

  it('16. atomic rebuild: graphRebuild.applyOps rolls back all writes on a throw', async () => {
    const d = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres as the system of record',
    });
    // A rebuild that inserts then throws must leave NO partial graph rows: the
    // whole transaction rolls back. This is what makes extractGraph atomic, so two
    // concurrent rebuilds serialize on the write lock instead of duplicating rows.
    const entity = (entityType: EntityType, memoryId: string) => ({
      entityType,
      name: entityType,
      memoryId,
      sourceObject: { type: 'decision', id: d.id } as const,
    });
    // The second op names another tenant's memory, so its insert throws after the first one wrote.
    const foreign = await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, 'other', {
      decisionText: 'Adopt Redis as a cache',
    });
    await expect(
      sqliteStore(tc.hippoRoot).graphRebuild.applyOps(
        T,
        [
          { op: 'insertEntity', entity: entity('policy', d.memoryId!) },
          { op: 'insertEntity', entity: entity('system', foreign.memoryId!) },
        ],
        { from: 0, holdMs: Infinity },
      ),
    ).rejects.toThrow();
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0); // insert rolled back
  });

  it('17. a sleep stopped between graph chunks leaves the tenant pending, and the next sleep converges', async () => {
    await savePolicy(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      policyName: 'RetryPolicy',
      policyText: 'retry 3x',
    });
    for (const team of ['billing', 'search', 'checkout']) {
      await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
        decisionText: `${team} adopts RetryPolicy for its outbound calls`,
      });
    }
    const queued = pending(tc.hippoRoot).length;
    const stopAtSecondChunk: Partial<SleepPhases> = {
      extractGraph: async (store, tid) =>
        await extractGraphChunked(store, tid, {
          ...WRITE_BUDGET,
          holdMs: 0,
          pause: async () => {
            throw new Error('stopped between chunks');
          },
        }),
    };

    const stopped = await runSleep(tc.ctx, { noShare: true }, stopAtSecondChunk);

    expect(stopped.graph).toBeUndefined();
    expect(pending(tc.hippoRoot)).toHaveLength(queued);
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(1); // the first chunk's one op stays

    await sleep(tc.ctx, { noShare: true });

    expect(pending(tc.hippoRoot)).toHaveLength(0);
    const desired = deriveGraph(await loadGraphSources(objectsAt(tc.hippoRoot), T));
    expect(await sqliteStore(tc.hippoRoot).graphReads.graphDelta(T, desired)).toEqual([]);
    expect(loadRelations(tc.hippoRoot, T, { limit: 100 })).toHaveLength(3);
  });

  it('18. stale ops a rebuild skipped show in the details', async () => {
    await saveDecision(objectsAt(tc.hippoRoot), loadConfig(tc.hippoRoot).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres as the system of record',
    });
    const phases: Partial<SleepPhases> = {
      extractGraph: async (store, tid) => ({ ...(await realExtractGraph(store, tid)), skipped: 2 }),
    };

    const r = await runSleep(tc.ctx, { noShare: true }, phases);

    expect(r.graph?.tenants).toBe(1);
    expect(r.details).toContain('graph: 2 stale op(s) skipped for a tenant; the next sleep redoes them');
  });
});
