/**
 * LC1 outcome linkage + storage smoke
 * (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers: recall -> outcome -> recall_trace_outcomes row (E2E, via the CLI's
 * cmdRecall + handleOutcome last-retrieval flow); outcome with no prior trace
 * -> no row, no error; an explicit `traceId` on the store's lastRecall group; and
 * the storage-overhead smoke bound (success criterion 3).
 *
 * Real-DB per project convention. Scratch HIPPO_HOME / cwd, never a repo
 * checkout.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, vi } from 'vitest';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  openHippoDb,
  closeHippoDb,
  getHippoDbPath,
  withSharedStoreHandles,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { remember, retrieve, outcome, outcomeForLastRecall } from '../../src/api/index.js';
import { personalScopeOf } from '../../src/core/recall-scope.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadLastRecall, saveIndex } from '../_helpers/root-forms.js';

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(cwd: string, ...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

type RecallTraceRow = { id: number };
type RecallTraceOutcomeRow = { outcome: string; memory_ids_json: string };

function tmpHome() {
  const home = makeRoot('recall-trace-outcome');
  return { home, restore: () => rmSync(home, { recursive: true, force: true }) };
}

describe('outcome linkage E2E (CLI recall -> outcome)', () => {
  it('a cmdRecall-style flow followed by `hippo outcome --good` writes a recall_trace_outcomes row referencing the recall trace', async () => {
    const hippoRoot = makeRoot('cli-outcome-linkage', { init: false });
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    try {
      await hippo(hippoRoot, 'init', '--no-hooks', '--no-schedule', '--no-learn');
      await hippo(hippoRoot, 'remember', 'outcome-link-target zeta fact');
      await hippo(hippoRoot, 'recall', 'outcome-link-target');
      const outcomeOut = await hippo(hippoRoot, 'outcome', '--good');
      expect(outcomeOut).toContain('Applied');

      const localStore = join(hippoRoot, '.hippo');
      const db = openHippoDb(localStore);
      try {
        // SAFETY: recall_traces.id is INTEGER PRIMARY KEY AUTOINCREMENT
        // (src/db/index.ts schema), so every row carries a numeric id.
        const traces = db.prepare(`SELECT * FROM recall_traces WHERE pipeline = 'cli'`).all() as RecallTraceRow[];
        expect(traces).toHaveLength(1);
        // SAFETY: recall_trace_outcomes.outcome and .memory_ids_json are
        // NOT NULL text columns (src/db/index.ts schema), guaranteed on every row.
        const outcomes = db
          .prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`)
          .all(traces[0]!.id) as RecallTraceOutcomeRow[];
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.outcome).toBe('positive');
        const memoryIds = JSON.parse(outcomes[0]!.memory_ids_json);
        expect(memoryIds).toHaveLength(1);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('outcomeForLastRecall — no prior trace', () => {
  it('applies the outcome but writes NO recall_trace_outcomes row, and does not throw', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      const res = await remember(ctx, { content: 'no-trace-outcome-target' });
      // Seed last_retrieval_ids directly WITHOUT ever calling recall()/getContext()
      // — last_trace_id stays unset (fresh store, pre-v40-flow shape).
      const idx = loadLastRecall(home);
      idx.last_retrieval_ids = [res.id];
      saveIndex(home, idx);
      expect(loadLastRecall(home).last_trace_id).toBeNull();

      const result = await outcomeForLastRecall(ctx, true);
      expect(result.applied).toBe(1);

      const db = openHippoDb(home);
      try {
        // SAFETY: `COUNT(*) AS c` always yields exactly one row with a
        // numeric `c` column.
        const outcomes = db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number };
        expect(outcomes.c).toBe(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });
});

describe('lastRecall.applyTracedOutcome explicit traceId (store linkage)', () => {
  it('links to the given trace when a caller supplies traceId explicitly', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'explicit-trace-opt-target' });
      const recallResult = await retrieve(ctx, { query: 'explicit-trace-opt-target', window: { limit: 5 } });
      expect(recallResult.results).toHaveLength(1);

      const db = openHippoDb(home);
      let traceId: number;
      try {
        // SAFETY: `SELECT id` names exactly one numeric column, and this
        // trace was just created by the recall() call above.
        const trace = db.prepare(`SELECT id FROM recall_traces WHERE pipeline = 'api'`).get() as { id: number };
        traceId = trace.id;
      } finally {
        closeHippoDb(db);
      }

      const ids = recallResult.results.map((r) => r.id);
      const target = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor) };
      await ctx.store.lastRecall.applyTracedOutcome({ ...target, ids, good: true }, traceId);

      const db2 = openHippoDb(home);
      try {
        // SAFETY: recall_trace_outcomes.outcome is a NOT NULL text column
        // (src/db/index.ts schema), guaranteed on every row.
        const rows = db2.prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`).all(traceId) as Array<{
          outcome: string;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.outcome).toBe('positive');
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      restore();
    }
  });

  it('without traceId, no linkage row is written (existing behavior unchanged)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      const res = await remember(ctx, { content: 'no-opt-target' });
      await outcome(ctx, [res.id], true);

      const db = openHippoDb(home);
      try {
        // SAFETY: `COUNT(*) AS c` always yields exactly one row with a
        // numeric `c` column.
        const count = db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number };
        expect(count.c).toBe(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });
});

describe('storage overhead smoke (success criterion 3)', () => {
  it('100 traced recalls of 10 results grow the DB by less than ~250KB', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      for (let i = 0; i < 15; i++) {
        await remember(ctx, { content: `storage-smoke-target memory number ${i} filler content` });
      }

      const checkpoint = (db: DatabaseSyncLike) => db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
      const dbSizeBytes = (): number => {
        const db = openHippoDb(home);
        try {
          checkpoint(db);
        } finally {
          closeHippoDb(db);
        }
        return statSync(getHippoDbPath(home)).size;
      };

      const before = dbSizeBytes();
      // One handle for the 100 recalls: each fresh open repeats the pragmas and migration check, which is not what this measures.
      await withSharedStoreHandles(async () => {
        for (let i = 0; i < 100; i++) {
          await retrieve(ctx, { query: 'storage-smoke-target', window: { limit: 10 } });
        }
      });
      const after = dbSizeBytes();

      const growth = after - before;
      // Growth depends on page reuse, so only a floor is fixed: SQLite grows the file in whole 4096-byte pages.
      expect(growth).toBeGreaterThanOrEqual(4096);
      expect(growth % 4096).toBe(0);
      expect(growth).toBeLessThan(250 * 1024);
    } finally {
      restore();
    }
  });
});
