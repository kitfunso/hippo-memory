/**
 * LC1 outcome linkage + storage smoke
 * (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers: recall -> outcome -> recall_trace_outcomes row (E2E, via the CLI's
 * cmdRecall + cmdOutcome last-retrieval flow); outcome with no prior trace
 * -> no row, no error; the explicit `traceId` SDK opt on api.outcome; and
 * the storage-overhead smoke bound (success criterion 3).
 *
 * Real-DB per project convention. Scratch HIPPO_HOME / cwd, never a repo
 * checkout.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { initStore, loadIndex, saveIndex } from '../src/store.js';
import { openHippoDb, closeHippoDb, getHippoDbPath, type DatabaseSyncLike } from '../src/db.js';
import { remember, recall, outcome, outcomeForLastRecall, type Context } from '../src/api.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hippoBin = join(repoRoot, 'bin', 'hippo.js');

type RecallTraceRow = { id: number };
type RecallTraceOutcomeRow = { outcome: string; memory_ids_json: string };

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'hippo-recall-trace-outcome-'));
  initStore(home);
  return { home, restore: () => rmSync(home, { recursive: true, force: true }) };
}

describe('outcome linkage E2E (CLI recall -> outcome)', () => {
  it('a cmdRecall-style flow followed by `hippo outcome --good` writes a recall_trace_outcomes row referencing the recall trace', () => {
    const hippoRoot = mkdtempSync(join(tmpdir(), 'hippo-cli-outcome-linkage-'));
    try {
      const env = { ...process.env, HIPPO_HOME: hippoRoot };
      execFileSync('node', [hippoBin, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: hippoRoot, env });
      execFileSync('node', [hippoBin, 'remember', 'outcome-link-target zeta fact'], { cwd: hippoRoot, env });
      execFileSync('node', [hippoBin, 'recall', 'outcome-link-target'], { cwd: hippoRoot, env, encoding: 'utf-8' });
      const outcomeOut = execFileSync('node', [hippoBin, 'outcome', '--good'], { cwd: hippoRoot, env, encoding: 'utf-8' });
      expect(outcomeOut).toContain('Applied');

      const localStore = join(hippoRoot, '.hippo');
      const db = openHippoDb(localStore);
      try {
        // SAFETY: recall_traces.id is INTEGER PRIMARY KEY AUTOINCREMENT
        // (src/db.ts schema), so every row carries a numeric id.
        const traces = db.prepare(`SELECT * FROM recall_traces WHERE pipeline = 'cli'`).all() as RecallTraceRow[];
        expect(traces).toHaveLength(1);
        // SAFETY: recall_trace_outcomes.outcome and .memory_ids_json are
        // NOT NULL text columns (src/db.ts schema), guaranteed on every row.
        const outcomes = db.prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`).all(traces[0]!.id) as RecallTraceOutcomeRow[];
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.outcome).toBe('positive');
        const memoryIds = JSON.parse(outcomes[0]!.memory_ids_json);
        expect(memoryIds).toHaveLength(1);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(hippoRoot, { recursive: true, force: true });
    }
  });
});

describe('outcomeForLastRecall — no prior trace', () => {
  it('applies the outcome but writes NO recall_trace_outcomes row, and does not throw', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      const res = remember(ctx, { content: 'no-trace-outcome-target' });
      // Seed last_retrieval_ids directly WITHOUT ever calling recall()/getContext()
      // — last_trace_id stays unset (fresh store, pre-v40-flow shape).
      const idx = loadIndex(home);
      idx.last_retrieval_ids = [res.id];
      saveIndex(home, idx);
      expect(loadIndex(home).last_trace_id).toBeNull();

      expect(() => {
        const result = outcomeForLastRecall(ctx, true);
        expect(result.applied).toBe(1);
      }).not.toThrow();

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

describe('api.outcome explicit traceId opt (SDK linkage)', () => {
  it('links to the given trace when a caller supplies traceId explicitly', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'explicit-trace-opt-target' });
      const recallResult = recall(ctx, { query: 'explicit-trace-opt-target', limit: 5 });
      expect(recallResult.results.length).toBeGreaterThan(0);

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
      outcome(ctx, ids, true, { traceId });

      const db2 = openHippoDb(home);
      try {
        // SAFETY: recall_trace_outcomes.outcome is a NOT NULL text column
        // (src/db.ts schema), guaranteed on every row.
        const rows = db2.prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`).all(traceId) as Array<{ outcome: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.outcome).toBe('positive');
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      restore();
    }
  });

  it('without traceId, no linkage row is written (existing behavior unchanged)', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      const res = remember(ctx, { content: 'no-opt-target' });
      outcome(ctx, [res.id], true);

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
  it('100 traced recalls of 10 results grow the DB by less than ~250KB', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      for (let i = 0; i < 15; i++) {
        remember(ctx, { content: `storage-smoke-target memory number ${i} filler content` });
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
      for (let i = 0; i < 100; i++) {
        recall(ctx, { query: 'storage-smoke-target', limit: 10 });
      }
      const after = dbSizeBytes();

      const growth = after - before;
      expect(growth).toBeGreaterThan(0); // sanity: traces were actually written
      expect(growth).toBeLessThan(250 * 1024);
    } finally {
      restore();
    }
  });
});
