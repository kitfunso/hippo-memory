import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { remember, retrieve, contextGet } from '../../src/api/index.js';
import { cwdProject } from '../_helpers/api-ctx.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadLastRecall } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

const INIT = ['init', '--no-hooks', '--no-schedule', '--no-learn'];

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

function disableEmbeddings(storeDir: string) {
  writeFileSync(join(storeDir, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
}

function tmpHome() {
  const home = makeRoot('recall-trace-wiring');
  vi.stubEnv('HIPPO_HOME', home);
  return {
    home,
    restore: () => onTestFinished(() => removeDir(home)),
  };
}

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
    return db
      .prepare(`SELECT * FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank ASC`)
      .all(traceId) as SqliteRow[];
  } finally {
    closeHippoDb(db);
  }
}

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

      const result = await retrieve(ctx, { query: 'recall-trace-target', window: { limit: 5 } });
      expect(result.results).toHaveLength(2);

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

  it('does NOT write last_trace_id', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'recall-trace-no-side-effect-target' });

      expect(lastTraceId(home)).toBeNull();
      const result = await retrieve(ctx, { query: 'recall-trace-no-side-effect-target', window: { limit: 5 } });
      expect(result.results).toHaveLength(1);

      expect(lastTraceId(home)).toBeNull();
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

      await retrieve(ctx, { query: 'batched-trace-A', window: { limit: 5 } });
      await retrieve(ctx, { query: 'batched-trace-B', window: { limit: 5 } });
      await retrieve(ctx, { query: 'batched-trace-C', window: { limit: 5 } });

      expect(traceRows(home, 'api')).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it('suppressRecallTrace:true writes NO trace row', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'suppressed-trace-target' });

      const result = await retrieve(ctx, {
        query: 'suppressed-trace-target',
        window: { limit: 5 },
        trace: { suppressRecallTrace: true },
      });
      expect(result.results).toHaveLength(1);

      expect(traceRows(home, 'api')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('api.contextGet - trace wiring', () => {
  it('writes a trace (pipeline=context) + last_trace_id for a real-query recall, atomically with last_retrieval_ids', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'context-trace-target-gamma' });

      const result = await contextGet(ctx, { currentProject: cwdProject(), q: 'context-trace-target', budget: 1000 });
      expect(result.entries).toHaveLength(1);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(result.entries.length);

      const idx = loadLastRecall(home);
      expect(idx.last_trace_id).toBe(String(traces[0].id));
      expect(idx.last_retrieval_ids).toEqual([result.entries[0].entry.id]);
    } finally {
      restore();
    }
  });

  it('pinnedOnly writes NO trace row and leaves last_trace_id untouched', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      writeEntry(home, createMemory('pinned-context-trace-delta', { pinned: true }));

      const result = await contextGet(ctx, { currentProject: cwdProject(), pinnedOnly: true, budget: 1000 });
      expect(result.entries).toHaveLength(1);

      expect(traceRows(home, 'context')).toHaveLength(0);
      expect(lastTraceId(home)).toBeNull();
    } finally {
      restore();
    }
  });

  it('the bare zero-result/no-continuity early return still writes an empty trace (result_count 0), but never touches last_retrieval_ids/last_trace_id', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      disableEmbeddings(home);
      await remember(ctx, { content: 'context-empty-baseline unrelated content' });

      const before = loadLastRecall(home);
      expect(before.last_trace_id).toBeNull();
      expect(before.last_retrieval_ids ?? []).toEqual([]);

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        q: 'zzz-query-matches-absolutely-nothing-xyzzy',
        budget: 1000,
      });
      expect(result.entries).toEqual([]);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].result_count).toBe(0);
      // SAFETY: recall_traces.id is an INTEGER PRIMARY KEY; node:sqlite
      // returns it as a JS number for values within safe-integer range.
      expect(resultRowsFor(home, traces[0].id as number)).toHaveLength(0);

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

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        q: 'context-trace-target-caller',
        budget: 1000,
        currentSessionId: 'sess-caller-1',
      });
      expect(result.entries).toHaveLength(1);

      const traces = traceRows(home, 'context');
      expect(traces).toHaveLength(1);
      expect(traces[0].session_id).toBe('sess-caller-1');
    } finally {
      restore();
    }
  });

  it('+ caller id: the zero-result early-return trace also stamps opts.currentSessionId', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      disableEmbeddings(home);
      await remember(ctx, { content: 'context-empty-baseline-caller unrelated content' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        q: 'zzz-query-matches-absolutely-nothing-xyzzy',
        budget: 1000,
        currentSessionId: 'sess-caller-2',
      });
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

describe('CLI printRecall — trace wiring', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('cli-recall-trace', { init: false });
    vi.stubEnv('HIPPO_HOME', hippoRoot);
  });

  it('writes ONE trace (pipeline=cli) at hippoRoot + last_trace_id, atomically with last_retrieval_ids', async () => {
    await hippo(hippoRoot, ...INIT);
    await hippo(hippoRoot, 'remember', 'cli-trace-target epsilon fact');
    const out = await hippo(hippoRoot, 'recall', 'cli-trace-target');
    expect(out).toContain('cli-trace-target');

    const localStore = join(hippoRoot, '.hippo');
    const traces = traceRows(localStore, 'cli');
    expect(traces).toHaveLength(1);
    const idx = loadLastRecall(localStore);
    expect(idx.last_trace_id).toBe(String(traces[0].id));
    expect(idx.last_retrieval_ids).toHaveLength(1);
  });

  it('a zero-result recall writes an empty trace row (result_count 0, no result rows) but leaves last_trace_id UNCHANGED', async () => {
    await hippo(hippoRoot, ...INIT);
    disableEmbeddings(join(hippoRoot, '.hippo'));
    await hippo(hippoRoot, 'remember', 'zero-result-baseline eta fact');
    await hippo(hippoRoot, 'recall', 'zero-result-baseline');

    const localStore = join(hippoRoot, '.hippo');
    const baselineTraceId = lastTraceId(localStore);
    expect(baselineTraceId).not.toBeNull();

    const out = await hippo(hippoRoot, 'recall', 'zzz-query-matches-absolutely-nothing-xyzzy');
    expect(out).toContain('No memories found');

    const traces = traceRows(localStore, 'cli');
    expect(traces).toHaveLength(2);
    const zeroTrace = traces.find((t) => t.id !== baselineTraceId);
    expect(zeroTrace?.result_count).toBe(0);

    // SAFETY: recall_traces.id is an INTEGER PRIMARY KEY; node:sqlite
    // returns it as a JS number for values within safe-integer range.
    const results = resultRowsFor(localStore, zeroTrace!.id as number);
    expect(results).toHaveLength(0);

    expect(lastTraceId(localStore)).toBe(baselineTraceId);
  });

  it.each([
    {
      name: 'falls back to CLAUDE_CODE_SESSION_ID when HIPPO_SESSION_ID is absent',
      own: '',
      host: 'sess-host-1',
      want: 'sess-host-1',
    },
    {
      name: 'HIPPO_SESSION_ID wins over CLAUDE_CODE_SESSION_ID when both are set',
      own: 'own-1',
      host: 'sess-host-1',
      want: 'own-1',
    },
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
    hippoRoot = makeRoot('cli-goalboost-hostvar', { init: false });
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    vi.stubEnv('HIPPO_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
  });

  it('boosts under --session-id but not under a bare CLAUDE_CODE_SESSION_ID host var', async () => {
    await hippo(hippoRoot, ...INIT);
    disableEmbeddings(join(hippoRoot, '.hippo'));
    await hippo(hippoRoot, 'remember', 'zzgoalboostquery bug fix details', '--tag', 'sprintx');
    await hippo(hippoRoot, 'remember', 'zzgoalboostquery UI polish', '--tag', 'ui');
    await hippo(hippoRoot, 'goal', 'push', 'sprintx', '--session-id', 'S');

    type RecallJson = { results: Array<{ id: string; score: number }> };
    // SAFETY: parses this test's own `hippo recall --json` output, whose shape (cli.ts's asJson branch) is fixed above.
    const recall = async (...flags: string[]): Promise<RecallJson> =>
      JSON.parse(await hippo(hippoRoot, 'recall', 'zzgoalboostquery', '--json', ...flags)) as RecallJson;

    const noSession = await recall();

    const control = await recall('--session-id', 'S');
    expect(control.results.map((r) => r.id)).not.toEqual(noSession.results.map((r) => r.id));

    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'S');
    const host = await recall();
    expect(host.results.map((r) => r.id)).toEqual(noSession.results.map((r) => r.id));
    host.results.forEach((r, i) => expect(r.score).toBeCloseTo(noSession.results[i].score, 4));
  });
});
