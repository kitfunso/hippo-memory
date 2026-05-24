/**
 * Mid-phase failure-path coverage for `api.sleep` (v1.12.2).
 *
 * Uses the test-only `SleepOpts.__phases` DI seam to inject a throwing stub
 * at each of the 5 phase boundaries. Asserts the `finally` block emits a
 * `consolidate` audit_log row with `partial: true` + `errorMessage` set to
 * the injected error's message — the path that was reachable via store-
 * corruption before but not previously locked by a test (independent-
 * review-critic MED #2 on v1.11.5; deferred in TODOS.md).
 *
 * Each test uses an isolated temp store + per-test HIPPO_HOME so the
 * autoShare phase's initGlobal() doesn't leak into the run-wide baseline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, adminActor, type Context, type SleepPhases } from '../src/api.js';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { queryAuditEvents } from '../src/audit.js';
import { loadConfig as realLoadConfig } from '../src/config.js';

function newCtx(): { ctx: Context; tmpDir: string; restore: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hippo-sleep-fault-'));
  const hippoRoot = join(tmpDir, '.hippo');
  initStore(hippoRoot);

  // Seed at least one entry so consolidate / dedup / audit phases have
  // something to scan (otherwise some phases short-circuit before the
  // injected throw would fire).
  const mem = createMemory('seed memory for sleep phase fault tests', {
    layer: Layer.Episodic,
    tags: ['test'],
    source: 'test',
    confidence: 'observed',
    baseHalfLifeDays: 30,
    tenantId: 'default',
  });
  writeEntry(hippoRoot, mem);

  // Per-test HIPPO_HOME isolation (autoShare phase 4 calls initGlobal()).
  const globalTmp = mkdtempSync(join(tmpdir(), 'hippo-sleep-fault-global-'));
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = globalTmp;

  const ctx: Context = {
    hippoRoot,
    tenantId: 'default',
    actor: adminActor('test:phase-faults'),
  };

  return {
    ctx,
    tmpDir,
    restore: () => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(globalTmp, { recursive: true, force: true });
      if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
      else delete process.env.HIPPO_HOME;
    },
  };
}

function getLastConsolidateAuditRow(hippoRoot: string, tenantId = 'default'): {
  metadata: Record<string, unknown>;
} | null {
  const db = openHippoDb(hippoRoot);
  try {
    const rows = queryAuditEvents(db, { tenantId, op: 'consolidate', limit: 1 });
    if (rows.length === 0) return null;
    return { metadata: rows[0].metadata as Record<string, unknown> };
  } finally {
    closeHippoDb(db);
  }
}

describe('api.sleep mid-phase failure paths emit partial+errorMessage audit row', () => {
  let testCtx: ReturnType<typeof newCtx>;

  beforeEach(() => {
    testCtx = newCtx();
  });

  afterEach(() => {
    testCtx.restore();
  });

  it('phase 1 (consolidate) throw → partial:true + errorMessage', async () => {
    const err = new Error('phase 1 fault: consolidate threw');
    const stubPhases: Partial<SleepPhases> = {
      consolidate: async () => { throw err; },
    };

    await expect(
      sleep(testCtx.ctx, { __phases: stubPhases }),
    ).rejects.toThrow('phase 1 fault: consolidate threw');

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(true);
    expect(row!.metadata.errorMessage).toBe('phase 1 fault: consolidate threw');
    // Pre-phase counters are 0 (consolidate failed before incrementing)
    expect(row!.metadata.consolidationCount).toBe(0);
    expect(row!.metadata.dedupCount).toBe(0);
  });

  it('phase 2 (deduplicateStore) throw → partial:true + earlier phase counters preserved', async () => {
    const err = new Error('phase 2 fault: deduplicateStore threw');
    const stubPhases: Partial<SleepPhases> = {
      deduplicateStore: () => { throw err; },
    };

    await expect(
      sleep(testCtx.ctx, { __phases: stubPhases }),
    ).rejects.toThrow('phase 2 fault: deduplicateStore threw');

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(true);
    expect(row!.metadata.errorMessage).toBe('phase 2 fault: deduplicateStore threw');
    // Phase 1 ran successfully → consolidationCount is set (could be 0 if
    // nothing to consolidate, but the assignment-before-throw path was hit).
    expect(row!.metadata.consolidationCount).toBeDefined();
    // dedupCount still 0 (phase 2 threw before assignment)
    expect(row!.metadata.dedupCount).toBe(0);
  });

  it('phase 3 (auditMemories) throw → partial:true + dedupCount preserved', async () => {
    const err = new Error('phase 3 fault: auditMemories threw');
    const stubPhases: Partial<SleepPhases> = {
      auditMemories: () => { throw err; },
    };

    await expect(
      sleep(testCtx.ctx, { __phases: stubPhases }),
    ).rejects.toThrow('phase 3 fault: auditMemories threw');

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(true);
    expect(row!.metadata.errorMessage).toBe('phase 3 fault: auditMemories threw');
    // Phases 1+2 completed → dedupCount assigned (0 on empty store is fine)
    expect(row!.metadata.dedupCount).toBeDefined();
    // auditDeletedCount still 0 (phase 3 threw before assignment)
    expect(row!.metadata.auditDeletedCount).toBe(0);
  });

  it('phase 4 (autoShare) throw → partial:true + audit counters preserved', async () => {
    const err = new Error('phase 4 fault: autoShare threw');
    const stubPhases: Partial<SleepPhases> = {
      autoShare: () => { throw err; },
    };

    // Phase 4 only runs if config.autoShareOnSleep is true; bypass the gate
    // by also stubbing loadConfig to force the flag on.
    stubPhases.loadConfig = ((root: string) => {
      const cfg = realLoadConfig(root);
      return { ...cfg, autoShareOnSleep: true };
    }) as SleepPhases['loadConfig'];

    await expect(
      sleep(testCtx.ctx, { __phases: stubPhases }),
    ).rejects.toThrow('phase 4 fault: autoShare threw');

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(true);
    expect(row!.metadata.errorMessage).toBe('phase 4 fault: autoShare threw');
    // Phases 1-3 completed
    expect(row!.metadata.auditDeletedCount).toBeDefined();
    // ambientTotal still 0 (phase 5 didn't run)
    expect(row!.metadata.ambientTotal).toBe(0);
  });

  it('phase 5 (computeAmbientState) throw → partial:true + all earlier counters preserved', async () => {
    const err = new Error('phase 5 fault: computeAmbientState threw');
    const stubPhases: Partial<SleepPhases> = {
      computeAmbientState: () => { throw err; },
    };

    await expect(
      sleep(testCtx.ctx, { __phases: stubPhases }),
    ).rejects.toThrow('phase 5 fault: computeAmbientState threw');

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(true);
    expect(row!.metadata.errorMessage).toBe('phase 5 fault: computeAmbientState threw');
    // Phases 1-4 completed
    expect(row!.metadata.auditDeletedCount).toBeDefined();
    // ambientTotal still 0 (phase 5 threw before assignment)
    expect(row!.metadata.ambientTotal).toBe(0);
  });

  it('happy path (no faults) → partial:false + no errorMessage', async () => {
    // No __phases override — uses DEFAULT_SLEEP_PHASES.
    await sleep(testCtx.ctx);

    const row = getLastConsolidateAuditRow(testCtx.ctx.hippoRoot);
    expect(row).not.toBeNull();
    expect(row!.metadata.partial).toBe(false);
    expect(row!.metadata.errorMessage).toBeUndefined();
  });
});
