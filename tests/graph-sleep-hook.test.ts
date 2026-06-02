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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry } from '../src/store.js';
import { saveDecision, closeDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveProjectBrief, refreshBrief } from '../src/project-briefs.js';
import {
  loadExtractionQueue,
  loadEntities,
  loadRelations,
  loadPendingExtractionTenants,
  markGraphDirty,
  runGraphRebuildTransaction,
  insertEntity,
} from '../src/graph.js';
import { extractGraph as realExtractGraph } from '../src/graph-extract.js';
import {
  sleep,
  adminActor,
  type Context,
  type SleepPhases,
  type SleepResult,
} from '../src/api.js';
import { redactSleepResultForCaller } from '../src/sleep-redact.js';

const T = 'default';

interface TestCtx {
  hippoRoot: string;
  ctx: Context;
  restore: () => void;
}

function newCtx(): TestCtx {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hippo-sleep-hook-'));
  const hippoRoot = join(tmpDir, '.hippo');
  mkdirSync(hippoRoot, { recursive: true });
  initStore(hippoRoot);
  // Per-test HIPPO_HOME isolation (autoShare phase calls initGlobal()).
  const globalTmp = mkdtempSync(join(tmpdir(), 'hippo-sleep-hook-global-'));
  const origHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = globalTmp;
  const ctx: Context = { hippoRoot, tenantId: T, actor: adminActor('test:sleep-hook') };
  return {
    hippoRoot,
    ctx,
    restore: () => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(globalTmp, { recursive: true, force: true });
      if (origHome !== undefined) process.env.HIPPO_HOME = origHome;
      else delete process.env.HIPPO_HOME;
    },
  };
}

function pending(hippoRoot: string, tenant: string = T) {
  return loadExtractionQueue(hippoRoot, tenant, { status: 'pending', limit: 1000 });
}
function processed(hippoRoot: string, tenant: string = T) {
  return loadExtractionQueue(hippoRoot, tenant, { status: 'processed', limit: 1000 });
}

describe('E3 sleep enqueue-hook', () => {
  let tc: TestCtx;
  beforeEach(() => { tc = newCtx(); });
  afterEach(() => { tc.restore(); });

  // -- Producer --------------------------------------------------------------

  it('1. saveDecision enqueues one pending queue item for its tenant', () => {
    const d = saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres' });
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

  it('3. coalesce: 3 decisions enqueue 3 pending items, all the same tenant', () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'one' });
    saveDecision(tc.hippoRoot, T, { decisionText: 'two' });
    saveDecision(tc.hippoRoot, T, { decisionText: 'three' });
    const q = pending(tc.hippoRoot);
    expect(q).toHaveLength(3);
    expect(new Set(q.map((i) => i.tenantId))).toEqual(new Set([T]));
  });

  it('4. close and project-brief refresh also enqueue (dirty on every graph-source mutation)', () => {
    const d = saveDecision(tc.hippoRoot, T, { decisionText: 'to be closed' });
    closeDecision(tc.hippoRoot, T, d.id);
    saveProjectBrief(tc.hippoRoot, T, { repo: 'myrepo', summary: 'first' });
    refreshBrief(tc.hippoRoot, T, 'myrepo'); // delegates to saveProjectBrief
    // save(d) + close(d) + saveBrief + refresh(->saveBrief) = 4 enqueues
    expect(pending(tc.hippoRoot).length).toBe(4);
  });

  // -- Consumer --------------------------------------------------------------

  it('5. sleep rebuilds the graph for a dirty tenant and drains its queue', async () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres' });
    savePolicy(tc.hippoRoot, T, { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    expect(pending(tc.hippoRoot).length).toBe(2);
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0); // not yet extracted

    const r = await sleep(tc.ctx, { noShare: true });
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 }).length).toBe(2); // rebuilt by sleep
    expect(pending(tc.hippoRoot)).toHaveLength(0);                        // drained
    expect(processed(tc.hippoRoot).length).toBe(2);
    expect(r.graph).toEqual({ tenants: 1, entities: 2, relations: 0 });
  });

  it('6. only dirty tenants rebuild: a second sleep with no new writes reports no graph work', async () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres' });
    const r1 = await sleep(tc.ctx, { noShare: true });
    expect(r1.graph?.tenants).toBe(1);
    const r2 = await sleep(tc.ctx, { noShare: true }); // nothing newly dirty
    expect(r2.graph).toBeUndefined();
    expect(pending(tc.hippoRoot)).toHaveLength(0);
  });

  it('7. multi-tenant: two dirty tenants both rebuild + drain; entities stay tenant-isolated', async () => {
    saveDecision(tc.hippoRoot, 'tenantA', { decisionText: 'TenantA adopts Postgres as the system of record' });
    saveDecision(tc.hippoRoot, 'tenantB', { decisionText: 'TenantB adopts Kafka for the event streaming backbone' });
    const r = await sleep(tc.ctx, { noShare: true });
    expect(r.graph?.tenants).toBe(2);
    expect(loadEntities(tc.hippoRoot, 'tenantA', { limit: 100 }).length).toBe(1);
    expect(loadEntities(tc.hippoRoot, 'tenantB', { limit: 100 }).length).toBe(1);
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0);
    expect(pending(tc.hippoRoot, 'tenantA')).toHaveLength(0);
    expect(pending(tc.hippoRoot, 'tenantB')).toHaveLength(0);
  });

  it('8. dryRun: no rebuild, no drain (items stay pending), no graph field', async () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres' });
    const r = await sleep(tc.ctx, { dryRun: true });
    expect(r.graph).toBeUndefined();
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0);
    expect(pending(tc.hippoRoot)).toHaveLength(1); // still dirty
  });

  it('9. snapshot watermark: an item enqueued DURING the rebuild stays pending', async () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres as the primary application datastore' });
    // Inject an extractGraph that enqueues a NEW item (id > watermark) mid-rebuild.
    const phases: Partial<SleepPhases> = {
      extractGraph: (root, tid) => {
        if (tid === T) saveDecision(root, tid, { decisionText: 'Adopt Redis as the shared caching tier' });
        return realExtractGraph(root, tid);
      },
    };
    await sleep(tc.ctx, { noShare: true, __phases: phases });
    // The original (<= watermark) is processed; the mid-rebuild arrival is still pending.
    const stillPending = pending(tc.hippoRoot);
    expect(stillPending).toHaveLength(1);
    expect(processed(tc.hippoRoot).length).toBe(1);
  });

  it('10. fault isolation: one tenant extract throwing leaves it pending, others drain, sleep completes', async () => {
    saveDecision(tc.hippoRoot, 'tenantFail', { decisionText: 'TenantFail standardizes on the GraphQL API gateway' });
    saveDecision(tc.hippoRoot, 'tenantOk', { decisionText: 'TenantOk migrates services onto the gRPC mesh' });
    const phases: Partial<SleepPhases> = {
      extractGraph: (root, tid) => {
        if (tid === 'tenantFail') throw new Error('boom: extract failed for tenantFail');
        return realExtractGraph(root, tid);
      },
    };
    const r = await sleep(tc.ctx, { noShare: true, __phases: phases }); // must NOT reject
    expect(loadEntities(tc.hippoRoot, 'tenantOk', { limit: 100 }).length).toBe(1);
    expect(pending(tc.hippoRoot, 'tenantOk')).toHaveLength(0);   // ok tenant drained
    expect(pending(tc.hippoRoot, 'tenantFail')).toHaveLength(1); // failed tenant left pending
    expect(r.graph?.tenants).toBe(1);                            // only tenantOk counted
    expect((r.details ?? []).some((d) => d.includes('graph: extract failed'))).toBe(true);
  });

  it('11. end-to-end: a supersede edge is built by sleep with NO manual extract', async () => {
    const d1 = saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres' });
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
    // No call to graph extract / extractGraph here - sleep is the only trigger.
    await sleep(tc.ctx, { noShare: true });
    const rels = loadRelations(tc.hippoRoot, T, { limit: 100 });
    expect(rels.some((r) => r.relType === 'supersedes')).toBe(true);
  });

  it('12. redaction zeroes graph.* for a non-loopback non-self caller; loopback passes through', () => {
    const base: SleepResult = {
      active: 1, removed: 0, mergedEpisodic: 0, newSemantic: 0, dryRun: false,
      graph: { tenants: 2, entities: 9, relations: 4 },
    };
    const redacted = redactSleepResultForCaller(base, { isLoopback: false, callerTenant: 'acme' });
    expect(redacted.graph).toEqual({ tenants: 0, entities: 0, relations: 0 });
    const passthrough = redactSleepResultForCaller(base, { isLoopback: true, callerTenant: 'acme' });
    expect(passthrough.graph).toEqual({ tenants: 2, entities: 9, relations: 4 });
  });

  it('13. clean store: sleep with no graph-source objects omits the graph field', async () => {
    const r = await sleep(tc.ctx, { noShare: true });
    expect(r.graph).toBeUndefined();
    expect(loadPendingExtractionTenants(tc.hippoRoot)).toHaveLength(0);
  });

  it('14. P1: a tenant still rebuilds when an earlier sleep phase deletes its queued mirror (codex)', async () => {
    const d = saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres as the system of record' });
    expect(pending(tc.hippoRoot)).toHaveLength(1);
    // Simulate dedup/audit removing the queued mirror mid-sleep: the queue row
    // FK-cascade-deletes, so a drain-TIME tenant load would drop T entirely. The
    // dirty-tenant snapshot taken before the deleting phases must still rebuild T.
    const phases: Partial<SleepPhases> = {
      deduplicateStore: (root) => {
        deleteEntry(root, d.memoryId!, T);
        return { removed: 1, pairs: [] };
      },
    };
    const r = await sleep(tc.ctx, { noShare: true, __phases: phases });
    expect(r.graph?.tenants).toBe(1);              // T rebuilt despite the mid-sleep deletion
    expect(pending(tc.hippoRoot)).toHaveLength(0); // its queue row cascade-deleted (mark = no-op)
  });

  it('15. P2 fail-soft: a dirty-tenant snapshot failure does not abort core sleep (codex)', async () => {
    saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres as the system of record' });
    const phases: Partial<SleepPhases> = {
      loadPendingExtractionTenants: () => { throw new Error('boom: queue read failed'); },
    };
    const r = await sleep(tc.ctx, { noShare: true, __phases: phases }); // must NOT reject
    expect(r.active).toBeGreaterThanOrEqual(0);    // consolidation still ran (result built)
    expect(r.graph).toBeUndefined();               // graph refresh skipped, not crashed
    expect((r.details ?? []).some((d) => d.includes('dirty-tenant snapshot failed'))).toBe(true);
    expect(pending(tc.hippoRoot)).toHaveLength(1); // item left pending, recovered next sleep
  });

  it('16. atomic rebuild: runGraphRebuildTransaction rolls back all writes on a throw (codex P2)', () => {
    const d = saveDecision(tc.hippoRoot, T, { decisionText: 'Adopt Postgres as the system of record' });
    // A rebuild that inserts then throws must leave NO partial graph rows: the
    // whole transaction rolls back. This is what makes extractGraph atomic, so two
    // concurrent rebuilds serialize on the write lock instead of duplicating rows.
    expect(() =>
      runGraphRebuildTransaction(tc.hippoRoot, T, (txDb) => {
        insertEntity(tc.hippoRoot, T, { entityType: 'policy', name: 'TempEntity', memoryId: d.memoryId! }, txDb);
        throw new Error('mid-rebuild boom');
      }),
    ).toThrow('mid-rebuild boom');
    expect(loadEntities(tc.hippoRoot, T, { limit: 100 })).toHaveLength(0); // insert rolled back
  });
});
