/**
 * LC1 wiring tests (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers the three wired recall paths: api.recall, api.getContext, CLI
 * cmdRecall — one trace row per recall, pinnedOnly writes nothing, the
 * v1.11.5 no-side-effects contract (api.recall must NOT write last_trace_id),
 * the F1 atomic last_trace_id/last_retrieval_ids lockstep (via loadLastRecall,
 * since readLastTraceId was deleted), F2 (suppressRecallTrace), and F5
 * (getContext's bare empty-result early return also traces).
 *
 * This is a NEW file beside the locked tests/api-recall-no-side-effects.test.ts
 * — that file is never edited (v1.11.5 lock); this file extends the
 * invariant to the new last_trace_id meta key.
 *
 * Real-DB per project convention. Scratch HIPPO_HOME, never a repo checkout.
 */

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadLastRecall } from '../src/store/index-and-stats.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { remember, retrieve, getContext } from '../src/api/index.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { runCli } from '../src/cli.js';
import { resetSessionRings } from '../src/api/recall/finish.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { makeRoot } from './_helpers/make-root.js';

const INIT = ['init', '--no-hooks', '--no-schedule', '--no-learn'];

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes; a non-zero exit fails the test as execFileSync threw. */
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

// Zero-result tests must not depend on an optional embedder being installed.
function disableEmbeddings(storeDir: string) {
  writeFileSync(join(storeDir, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
}

function tmpHome() {
  const home = makeRoot('recall-trace-wiring');
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

/** Concrete SQLite column value: what node:sqlite can actually return. */
type SqliteValue = string | number | bigint | null | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

function traceRows(home: string, pipeline: string): SqliteRow[] {
  const db: DatabaseSyncLike = openHippoDb(home);
  try {
    // SAFETY: sql is a literal SELECT against the known recall_traces schema;
    // the SqliteRow value type already reflects what node:sqlite can return.
    return db.prepare(`SELECT * FROM recall_traces WHERE pipeline = ?`).all(pipeline) as SqliteRow[];
  } finally {
    closeHippoDb(db);
  }
}

function resultRowsFor(home: string, traceId: number): SqliteRow[] {
  const db: DatabaseSyncLike = openHippoDb(home);
  try {
    // SAFETY: sql is a literal SELECT against the known recall_trace_results
    // schema; the SqliteRow value type already reflects what node:sqlite can
    // return.
    return db.prepare(`SELECT * FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank ASC`).all(traceId) as SqliteRow[];
  } finally {
    closeHippoDb(db);
  }
}

// readLastTraceId was deleted (F1(e) structural fix) — last_trace_id is now
// read the same way production reads it: via loadLastRecall, which strict-parses
// the meta value (store.ts's parseLastTraceId). Returns a number for easy
// comparison against sqlite row ids, mirroring the deleted helper's shape.
function lastTraceId(home: string): number | null {
  const raw = loadLastRecall(home).last_trace_id;
  return raw !== null ? Number(raw) : null;
}

describe('api.recall — trace wiring', () => {
  it('writes exactly one recall_traces row (pipeline=api) with the full returned id+rank+score list', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'recall-trace-target-alpha' });
      await remember(ctx, { content: 'recall-trace-target-beta also matches' });

      const result = await retrieve(ctx, { query: 'recall-trace-target', limit: 5 });
      expect(result.results.length).toBeGreaterThan(0);

      const traces = traceRows(home, 'api');
      expect(traces).toHaveLength(1);
      expect(traces[0].tenant_id).toBe('default');
      expect(traces[0].result_count).toBe(result.results.length);

      // SAFETY: recall_traces.id is an INTEGER PRIMARY KEY; node:sqlite
      // returns it as a JS number for values within safe-integer range.
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

  it('does NOT write last_trace_id (v1.11.5 no-side-effects contract, extended)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'recall-trace-no-side-effect-target' });

      expect(lastTraceId(home)).toBeNull();
      const result = await retrieve(ctx, { query: 'recall-trace-no-side-effect-target', limit: 5 });
      expect(result.results.length).toBeGreaterThan(0);

      // A trace row WAS written (previous test), but last_trace_id stays null.
      expect(lastTraceId(home)).toBeNull();
      // last_retrieval_ids is also untouched (locked invariant, restated here
      // for context — the authoritative lock lives in api-recall-no-side-effects.test.ts).
      expect(loadLastRecall(home).last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it('batched api.recall calls each insert their own trace row (no overwrite race)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'batched-trace-A' });
      await remember(ctx, { content: 'batched-trace-B' });
      await remember(ctx, { content: 'batched-trace-C' });

      await retrieve(ctx, { query: 'batched-trace-A', limit: 5 });
      await retrieve(ctx, { query: 'batched-trace-B', limit: 5 });
      await retrieve(ctx, { query: 'batched-trace-C', limit: 5 });

      expect(traceRows(home, 'api')).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it('F2: suppressRecallTrace:true writes NO trace row', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'suppressed-trace-target' });

      const result = await retrieve(ctx, { query: 'suppressed-trace-target', limit: 5, suppressRecallTrace: true });
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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'context-trace-target-gamma' });

      const result = await getContext(ctx, { q: 'context-trace-target', budget: 1000 });
      expect(result.entries.length).toBeGreaterThan(0);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(result.entries.length);

      const idx = loadLastRecall(home);
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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      // A memory exists, but the query matches nothing, and there is no
      // active task snapshot / handoff / recent session events — this is
      // the bare `return { entries: [], tokens: 0 }` early-return path
      // (api.ts, the check right after the origin/category annotation).
      disableEmbeddings(home);
      await remember(ctx, { content: 'context-empty-baseline unrelated content' });

      const before = loadLastRecall(home);
      expect(before.last_trace_id).toBeNull();
      expect(before.last_retrieval_ids ?? []).toEqual([]);

      const result = await getContext(ctx, { q: 'zzz-query-matches-absolutely-nothing-xyzzy', budget: 1000 });
      expect(result.entries).toEqual([]);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(0);
      // SAFETY: recall_traces.id is an INTEGER PRIMARY KEY; node:sqlite
      // returns it as a JS number for values within safe-integer range.
      expect(resultRowsFor(home, traces[0].id as number)).toHaveLength(0);

      // Deliberately untouched — this path never advances last_retrieval_ids,
      // so last_trace_id must not advance either (lockstep invariant).
      const after = loadLastRecall(home);
      expect(after.last_trace_id).toBeNull();
      expect(after.last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it('stamps the trace session_id from opts.currentSessionId on a real-query recall', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'context-trace-target-caller-session' });

      const result = await getContext(ctx, { q: 'context-trace-target-caller', budget: 1000, currentSessionId: 'sess-caller-1' });
      expect(result.entries.length).toBeGreaterThan(0);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].session_id).toBe('sess-caller-1');
    } finally {
      restore();
    }
  });

  it('F5 + caller id: the zero-result early-return trace also stamps opts.currentSessionId', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      disableEmbeddings(home);
      await remember(ctx, { content: 'context-empty-baseline-caller unrelated content' });

      const result = await getContext(ctx, { q: 'zzz-query-matches-absolutely-nothing-xyzzy', budget: 1000, currentSessionId: 'sess-caller-2' });
      expect(result.entries).toEqual([]);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(0);
      expect(traces[0].session_id).toBe('sess-caller-2');
    } finally {
      restore();
    }
  });
});

describe('CLI cmdRecall — trace wiring', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = mkdtempSync(join(tmpdir(), 'hippo-cli-recall-trace-'));
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    resetSessionRings('cli');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('writes ONE trace (pipeline=cli) at hippoRoot + last_trace_id, atomically with last_retrieval_ids', async () => {
    await hippo(hippoRoot, ...INIT);
    await hippo(hippoRoot, 'remember', 'cli-trace-target epsilon fact');
    const out = await hippo(hippoRoot, 'recall', 'cli-trace-target');
    expect(out).toContain('cli-trace-target');

    // The CLI's local store lives at `<cwd>/.hippo` (getHippoRoot,
    // store/open.ts) — HIPPO_HOME only governs the separate global store.
    const localStore = join(hippoRoot, '.hippo');
    const traces = traceRows(localStore, 'cli');
    expect(traces).toHaveLength(1);
    const idx = loadLastRecall(localStore);
    expect(idx.last_trace_id).toBe(String(traces[0].id));
    expect(idx.last_retrieval_ids.length).toBeGreaterThan(0);
  });

  it('a zero-result recall writes an empty trace row (result_count 0, no result rows) but leaves last_trace_id UNCHANGED', async () => {
    // The zero-result branch once returned before the trace write; it must trace without touching localIndex,
    // since it never advances last_retrieval_ids and last_trace_id moves in lockstep with it.
    await hippo(hippoRoot, ...INIT);
    disableEmbeddings(join(hippoRoot, '.hippo'));
    await hippo(hippoRoot, 'remember', 'zero-result-baseline eta fact');
    // First recall: populates last_trace_id with a real trace id.
    await hippo(hippoRoot, 'recall', 'zero-result-baseline');

    const localStore = join(hippoRoot, '.hippo');
    const baselineTraceId = lastTraceId(localStore);
    expect(baselineTraceId).not.toBeNull();

    // Second recall: a query that matches nothing.
    const out = await hippo(hippoRoot, 'recall', 'zzz-query-matches-absolutely-nothing-xyzzy');
    expect(out).toContain('No memories found');

    const traces = traceRows(localStore, 'cli');
    expect(traces).toHaveLength(2);
    const zeroTrace = traces.find((t) => t.id !== baselineTraceId);
    expect(zeroTrace).toBeDefined();
    expect(zeroTrace!.result_count).toBe(0);

    // SAFETY: recall_traces.id is an INTEGER PRIMARY KEY; node:sqlite
    // returns it as a JS number for values within safe-integer range.
    const results = resultRowsFor(localStore, zeroTrace!.id as number);
    expect(results).toHaveLength(0);

    // last_trace_id must still point at the FIRST (non-empty) trace.
    expect(lastTraceId(localStore)).toBe(baselineTraceId);
  });

  it.each([
    { name: 'falls back to CLAUDE_CODE_SESSION_ID when HIPPO_SESSION_ID is absent', own: '', host: 'sess-host-1', want: 'sess-host-1' },
    { name: 'HIPPO_SESSION_ID wins over CLAUDE_CODE_SESSION_ID when both are set', own: 'own-1', host: 'sess-host-1', want: 'own-1' },
    { name: 'session_id is null when neither var is set', own: '', host: '', want: null },
  ])('hostSessionId(): $name', async ({ own, host, want }) => {
    vi.stubEnv('HIPPO_SESSION_ID', own);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', host);
    await hippo(hippoRoot, ...INIT);
    await hippo(hippoRoot, 'remember', 'host-fallback-target zeta fact');
    await hippo(hippoRoot, 'recall', 'host-fallback-target');

    const traces = traceRows(join(hippoRoot, '.hippo'), 'cli');
    expect(traces).toHaveLength(1);
    expect(traces[0].session_id).toBe(want);
  });
});

describe('CLI goal-stack boost — ignores the CLAUDE_CODE_SESSION_ID host var', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = mkdtempSync(join(tmpdir(), 'hippo-cli-goalboost-hostvar-'));
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    vi.stubEnv('HIPPO_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    resetSessionRings('cli');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('boosts under --session-id but not under a bare CLAUDE_CODE_SESSION_ID host var', async () => {
    await hippo(hippoRoot, ...INIT);
    disableEmbeddings(join(hippoRoot, '.hippo'));
    // Tag shares no substring with the query, so any ranking gap is the goal boost, not a tag/query match.
    await hippo(hippoRoot, 'remember', 'zzgoalboostquery bug fix details', '--tag', 'sprintx');
    await hippo(hippoRoot, 'remember', 'zzgoalboostquery UI polish', '--tag', 'ui');
    await hippo(hippoRoot, 'goal', 'push', 'sprintx', '--session-id', 'S');

    type RecallJson = { results: Array<{ id: string; score: number }> };
    // SAFETY: parses this test's own `hippo recall --json` output, whose shape (cli.ts's asJson branch) is fixed above.
    const recall = async (...flags: string[]): Promise<RecallJson> =>
      JSON.parse(await hippo(hippoRoot, 'recall', 'zzgoalboostquery', '--json', ...flags)) as RecallJson;

    const noSession = await recall();

    // Control: --session-id S makes the boost visible at all (order flips).
    const control = await recall('--session-id', 'S');
    expect(control.results.map((r) => r.id)).not.toEqual(noSession.results.map((r) => r.id));

    // Test arm: CLAUDE_CODE_SESSION_ID=S only -- must match the no-session run, not the control.
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'S');
    const host = await recall();
    // Score has a real-time decay term, so re-running moments apart drifts ~1e-8; toBeCloseTo tolerates that, not a real boost's ~2x jump.
    expect(host.results.map((r) => r.id)).toEqual(noSession.results.map((r) => r.id));
    host.results.forEach((r, i) => expect(r.score).toBeCloseTo(noSession.results[i].score, 4));
  });
});
