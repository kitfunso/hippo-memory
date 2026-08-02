/**
 * LC1 wiring tests (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers the three wired recall paths: api.recall, api.getContext, CLI
 * cmdRecall — one trace row per recall, pinnedOnly writes nothing, the
 * v1.11.5 no-side-effects contract (api.recall must NOT write last_trace_id),
 * the F1 atomic last_trace_id/last_retrieval_ids lockstep (via loadIndex,
 * since readLastTraceId was deleted), F2 (suppressRecallTrace), and F5
 * (getContext's bare empty-result early return also traces).
 *
 * This is a NEW file beside the locked tests/api-recall-no-side-effects.test.ts
 * — that file is never edited (v1.11.5 lock); this file extends the
 * invariant to the new last_trace_id meta key.
 *
 * Real-DB per project convention. Scratch HIPPO_HOME, never a repo checkout.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { initStore, loadIndex, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createMemory } from '../src/memory.js';
import { remember, recall, getContext, type Context } from '../src/api.js';

// Invoke this worktree's own bin/hippo.js directly (not the `hippo` binary
// on PATH) so the CLI test exercises THIS build, not whatever hippo-memory
// install happens to be globally linked.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hippoBin = join(repoRoot, 'bin', 'hippo.js');

function tmpHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'hippo-recall-trace-wiring-'));
  initStore(home);
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = home;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        process.env.HIPPO_HOME = origHippoHome;
      } else {
        delete process.env.HIPPO_HOME;
      }
    },
  };
}

function traceRows(home: string, pipeline: string): Array<Record<string, unknown>> {
  const db: DatabaseSyncLike = openHippoDb(home);
  try {
    return db.prepare(`SELECT * FROM recall_traces WHERE pipeline = ?`).all(pipeline) as Array<Record<string, unknown>>;
  } finally {
    closeHippoDb(db);
  }
}

function resultRowsFor(home: string, traceId: number): Array<Record<string, unknown>> {
  const db: DatabaseSyncLike = openHippoDb(home);
  try {
    return db.prepare(`SELECT * FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank ASC`).all(traceId) as Array<Record<string, unknown>>;
  } finally {
    closeHippoDb(db);
  }
}

// readLastTraceId was deleted (F1(e) structural fix) — last_trace_id is now
// read the same way production reads it: via loadIndex, which strict-parses
// the meta value (store.ts's parseLastTraceId). Returns a number for easy
// comparison against sqlite row ids, mirroring the deleted helper's shape.
function lastTraceId(home: string): number | null {
  const raw = loadIndex(home).last_trace_id;
  return raw !== null ? Number(raw) : null;
}

describe('api.recall — trace wiring', () => {
  it('writes exactly one recall_traces row (pipeline=api) with the full returned id+rank+score list', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'recall-trace-target-alpha' });
      remember(ctx, { content: 'recall-trace-target-beta also matches' });

      const result = recall(ctx, { query: 'recall-trace-target', limit: 5 });
      expect(result.results.length).toBeGreaterThan(0);

      const traces = traceRows(home, 'api');
      expect(traces).toHaveLength(1);
      expect(traces[0].tenant_id).toBe('default');
      expect(traces[0].result_count).toBe(result.results.length);

      const rows = resultRowsFor(home, traces[0].id as number);
      expect(rows).toHaveLength(result.results.length);
      rows.forEach((row, i) => {
        expect(row.memory_id).toBe(result.results[i].id);
        expect(row.score).toBe(result.results[i].score);
        expect(row.result_rank).toBe(i + 1);
      });
    } finally {
      restore();
    }
  });

  it('does NOT write last_trace_id (v1.11.5 no-side-effects contract, extended)', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'recall-trace-no-side-effect-target' });

      expect(lastTraceId(home)).toBeNull();
      const result = recall(ctx, { query: 'recall-trace-no-side-effect-target', limit: 5 });
      expect(result.results.length).toBeGreaterThan(0);

      // A trace row WAS written (previous test), but last_trace_id stays null.
      expect(lastTraceId(home)).toBeNull();
      // last_retrieval_ids is also untouched (locked invariant, restated here
      // for context — the authoritative lock lives in api-recall-no-side-effects.test.ts).
      expect(loadIndex(home).last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it('batched api.recall calls each insert their own trace row (no overwrite race)', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'batched-trace-A' });
      remember(ctx, { content: 'batched-trace-B' });
      remember(ctx, { content: 'batched-trace-C' });

      recall(ctx, { query: 'batched-trace-A', limit: 5 });
      recall(ctx, { query: 'batched-trace-B', limit: 5 });
      recall(ctx, { query: 'batched-trace-C', limit: 5 });

      expect(traceRows(home, 'api')).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it('F2: suppressRecallTrace:true writes NO trace row', () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'suppressed-trace-target' });

      const result = recall(ctx, { query: 'suppressed-trace-target', limit: 5, suppressRecallTrace: true });
      expect(result.results.length).toBeGreaterThan(0);

      expect(traceRows(home, 'api')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('api.getContext — trace wiring', () => {
  it('writes a trace (pipeline=context) + last_trace_id for a real-query recall, atomically with last_retrieval_ids', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      remember(ctx, { content: 'context-trace-target-gamma' });

      const result = await getContext(ctx, { q: 'context-trace-target', budget: 1000 });
      expect(result.entries.length).toBeGreaterThan(0);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(result.entries.length);

      const idx = loadIndex(home);
      expect(idx.last_trace_id).toBe(String(traces[0].id));
      // F1 lockstep: last_retrieval_ids advanced in the SAME saveIndex call.
      expect(idx.last_retrieval_ids.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('pinnedOnly writes NO trace row and leaves last_trace_id untouched', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      writeEntry(home, createMemory('pinned-context-trace-delta', { pinned: true }));

      const result = await getContext(ctx, { pinnedOnly: true, budget: 1000 });
      expect(result.entries.length).toBeGreaterThan(0);

      expect(traceRows(home, 'context')).toHaveLength(0);
      expect(lastTraceId(home)).toBeNull();
    } finally {
      restore();
    }
  });

  it('F5: the bare zero-result/no-continuity early return still writes an empty trace (result_count 0), but never touches last_retrieval_ids/last_trace_id', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      // A memory exists, but the query matches nothing, and there is no
      // active task snapshot / handoff / recent session events — this is
      // the bare `return { entries: [], tokens: 0 }` early-return path
      // (api.ts, the check right after the origin/category annotation).
      remember(ctx, { content: 'context-empty-baseline unrelated content' });

      const before = loadIndex(home);
      expect(before.last_trace_id).toBeNull();
      expect(before.last_retrieval_ids ?? []).toEqual([]);

      const result = await getContext(ctx, { q: 'zzz-query-matches-absolutely-nothing-xyzzy', budget: 1000 });
      expect(result.entries).toEqual([]);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(0);
      expect(resultRowsFor(home, traces[0].id as number)).toHaveLength(0);

      // Deliberately untouched — this path never advances last_retrieval_ids,
      // so last_trace_id must not advance either (lockstep invariant).
      const after = loadIndex(home);
      expect(after.last_trace_id).toBeNull();
      expect(after.last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('CLI cmdRecall — trace wiring', () => {
  it('writes ONE trace (pipeline=cli) at hippoRoot + last_trace_id, atomically with last_retrieval_ids', () => {
    const hippoRoot = mkdtempSync(join(tmpdir(), 'hippo-cli-recall-trace-'));
    try {
      execFileSync('node', [hippoBin, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
        cwd: hippoRoot,
        env: { ...process.env, HIPPO_HOME: hippoRoot },
      });
      execFileSync('node', [hippoBin, 'remember', 'cli-trace-target epsilon fact'], {
        cwd: hippoRoot,
        env: { ...process.env, HIPPO_HOME: hippoRoot },
      });
      const out = execFileSync('node', [hippoBin, 'recall', 'cli-trace-target'], {
        cwd: hippoRoot,
        env: { ...process.env, HIPPO_HOME: hippoRoot },
        encoding: 'utf-8',
      });
      expect(out).toContain('cli-trace-target');

      // The CLI's local store lives at `<cwd>/.hippo` (getHippoRoot,
      // store.ts:261) — HIPPO_HOME only governs the separate global store.
      const localStore = join(hippoRoot, '.hippo');
      const traces = traceRows(localStore, 'cli');
      expect(traces).toHaveLength(1);
      const idx = loadIndex(localStore);
      expect(idx.last_trace_id).toBe(String(traces[0].id));
      expect(idx.last_retrieval_ids.length).toBeGreaterThan(0);
    } finally {
      rmSync(hippoRoot, { recursive: true, force: true });
    }
  });

  it('a zero-result recall writes an empty trace row (result_count 0, no result rows) but leaves last_trace_id UNCHANGED', () => {
    // Final-review must-fix: cli.ts's zero-result branch used to return
    // before the trace-write block entirely, so it wrote NO trace at all.
    // It must now write a trace (for training-corpus coverage) without
    // touching localIndex at all — this path never advances
    // last_retrieval_ids (no memories to update), so last_trace_id must not
    // advance either (F1 lockstep invariant).
    const hippoRoot = mkdtempSync(join(tmpdir(), 'hippo-cli-recall-trace-zero-'));
    try {
      const env = { ...process.env, HIPPO_HOME: hippoRoot };
      execFileSync('node', [hippoBin, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: hippoRoot, env });
      execFileSync('node', [hippoBin, 'remember', 'zero-result-baseline eta fact'], { cwd: hippoRoot, env });
      // First recall: populates last_trace_id with a real trace id.
      execFileSync('node', [hippoBin, 'recall', 'zero-result-baseline'], { cwd: hippoRoot, env, encoding: 'utf-8' });

      const localStore = join(hippoRoot, '.hippo');
      const baselineTraceId = lastTraceId(localStore);
      expect(baselineTraceId).not.toBeNull();

      // Second recall: a query that matches nothing.
      const out = execFileSync(
        'node',
        [hippoBin, 'recall', 'zzz-query-matches-absolutely-nothing-xyzzy'],
        { cwd: hippoRoot, env, encoding: 'utf-8' },
      );
      expect(out).toContain('No memories found');

      const traces = traceRows(localStore, 'cli');
      expect(traces).toHaveLength(2);
      const zeroTrace = traces.find((t) => t.id !== baselineTraceId);
      expect(zeroTrace).toBeDefined();
      expect(zeroTrace!.result_count).toBe(0);

      const results = resultRowsFor(localStore, zeroTrace!.id as number);
      expect(results).toHaveLength(0);

      // last_trace_id must still point at the FIRST (non-empty) trace.
      expect(lastTraceId(localStore)).toBe(baselineTraceId);
    } finally {
      rmSync(hippoRoot, { recursive: true, force: true });
    }
  });
});
