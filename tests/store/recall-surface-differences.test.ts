// What one recall returns and writes on each surface (CLI `hippo recall`, MCP hippo_recall, HTTP GET /v1/memories) over
// one store: each difference in docs/recall-surface-differences.md (D1 to D18) is asserted here and moves only on purpose.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { handleRecall } from '../../src/cli/recall.js';
import { handleMcpRequest, type McpResponse } from '../../src/mcp/server.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { retrieveRanking, RecallContractError, type RecallResult } from '../../src/api/index.js';
import { loadConfig } from '../../src/core/config.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import {
  CLEARED_ENV,
  FAKE_NOW,
  freshStore,
  normalize,
  RECALL_INPUTS,
  rowsOf,
  seeded,
  SESSION,
  seedTemplates,
  TENANT,
  type Store,
  type Templates,
} from '../_helpers/recall-golden-seed.js';
import type { CliFlags } from '../../src/cli/flag-values.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';
import { recallAuditOps, recallWrites } from '../_helpers/recall-rows.js';
import { createCallerState, type CallerState } from '../../src/api/callers.js';

// Each case is one process: its CLI commands and MCP calls share one CallerState, whose rings keep surfaces apart.
let callers: CallerState;

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
  callers = createCallerState();
});

type Surface = 'cli' | 'mcp' | 'http';
const SURFACES: readonly Surface[] = ['cli', 'mcp', 'http'];

let templates: Templates;

interface RecallCall {
  query: string;
  session?: string;
  budget?: number;
  cliFlags?: CliFlags;
  httpParams?: Record<string, string>;
}

interface CliRecalled {
  output: InProcessResult;
  hint: string | null;
}
interface McpRecalled {
  output: string;
  hint: string | null;
}
interface HttpRecalled {
  output: { status: number; body: RecallResult };
  hint: string | null;
}
type Recalled = CliRecalled | McpRecalled | HttpRecalled;

async function viaCli(s: Store, c: RecallCall): Promise<CliRecalled> {
  const flags: CliFlags = { ...c.cliFlags };
  if (c.session) flags['session-id'] = c.session;
  if (c.budget !== undefined) flags.budget = String(c.budget);
  const out = await runInProcess(() =>
    handleRecall({ hippoRoot: s.root, tenantId: TENANT, args: [c.query], flags, callers }),
  );
  const anchored = /\[anchored_on: ([^\]]+)\]/.exec(out.stdout);
  return { output: out, hint: anchored ? anchored[1]! : null };
}

type ToolArgs = Record<string, string | number | boolean>;

function callTool(root: string, name: string, args: ToolArgs): Promise<McpResponse | null> {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    {
      hippoRoot: root,
      tenantId: TENANT,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(root),
      config: loadConfig(root),
      callers,
    },
  );
}

interface ToolReply {
  text: string;
  isError: boolean;
}

function toolReply(res: McpResponse | null): ToolReply {
  // SAFETY: a tools/call result is written by src/mcp/request.ts as { content: [{ text }], isError? }.
  const result = res?.result as { content?: { text: string }[]; isError?: boolean } | undefined;
  return { text: result?.content?.[0]?.text ?? '', isError: result?.isError === true };
}

async function viaMcp(s: Store, c: RecallCall): Promise<McpRecalled> {
  type McpRecallArgs = { query: string; session_id?: string; budget?: number };
  const args: McpRecallArgs = { query: c.query };
  if (c.session) args.session_id = c.session;
  if (c.budget !== undefined) args.budget = c.budget;
  const { text } = toolReply(await callTool(s.root, 'hippo_recall', args));
  const anchored = /\[anchored_on: ([^\]]+)\]/.exec(text);
  return { output: text, hint: anchored ? anchored[1]! : null };
}

async function viaHttp(handle: ServerHandle, c: RecallCall): Promise<HttpRecalled> {
  const params = new URLSearchParams({ q: c.query });
  if (c.session) params.set('session_id', c.session);
  for (const [k, v] of Object.entries(c.httpParams ?? {})) params.set(k, v);
  const res = await fetch(`${handle.url}/v1/memories?${params.toString()}`);
  // SAFETY: every call here is valid, so /v1/memories answers 200 with a serialised RecallResult.
  const body = (await res.json()) as RecallResult;
  return { output: { status: res.status, body }, hint: body.anchoringHint?.memoryId ?? null };
}

/** One server for a whole run of calls, as a long-lived HTTP client sees it. */
async function httpCalls(s: Store, calls: readonly RecallCall[]): Promise<HttpRecalled[]> {
  const handle = await serve({ hippoRoot: s.root, port: 0 });
  try {
    const out: HttpRecalled[] = [];
    for (const c of calls) out.push(await viaHttp(handle, c));
    return out;
  } finally {
    await handle.stop();
  }
}

async function recallOn(surface: Surface, s: Store, calls: readonly RecallCall[]): Promise<Recalled[]> {
  if (surface === 'http') return httpCalls(s, calls);
  const out: Recalled[] = [];
  for (const c of calls) out.push(surface === 'cli' ? await viaCli(s, c) : await viaMcp(s, c));
  return out;
}

async function onFreshStore<T>(kind: 'local' | 'wide', fn: (s: Store) => Promise<T>): Promise<T> {
  const s = freshStore(templates, kind);
  try {
    return normalize(await fn(s), s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

const printedIds = (stdout: string): string[] => [...stdout.matchAll(/^--- (\S+)/gm)].map((m) => m[1]!);
const FILLS_DOWN = ['mem_p_fill5', 'mem_p_fill4', 'mem_p_fill3', 'mem_p_fill2', 'mem_p_trace', 'mem_p_fill1'];
const FILLS_UP = ['mem_p_fill0', 'mem_p_fill1', 'mem_p_fill2', 'mem_p_fill3', 'mem_p_fill4', 'mem_p_fill5'];
/** The engine order CLI and MCP share over the local store; the CLI adds the global row on top. */
const ENGINE = ['mem_p_plain', 'mem_p_pinned', ...FILLS_DOWN, 'mem_p_fill0', 'mem_p_scoped', 'mem_p_new', 'mem_p_goal'];
/** HTTP's SQL load order with no mode: ten rows, the default limit. */
const SQL_ORDER = ['mem_p_pinned', 'mem_p_plain', ...FILLS_UP, 'mem_p_trace', 'mem_p_scoped'];
const SHOWN_ONCE = Object.fromEntries(ENGINE.filter((id) => id !== 'mem_p_goal').map((id) => [id, 1]));
const positions = (n: number): number[] => Array.from({ length: n }, (_, i) => 1 - i / n);

beforeAll(async () => {
  templates = await seedTemplates();
});

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('recall surface differences', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // D1, D3, D5, D7, D9, D10: what one plain recall shows and writes, local and global store.
  it('cli: the engine order plus the global row, budget-fit, counted, audited in both stores', async () => {
    const got = await onFreshStore('local', async (s) => {
      // SAFETY: recallOn answers each cli call with a CliRecalled (viaCli and viaMcp above).
      const [r] = (await recallOn('cli', s, [{ query: 'deploy' }])) as CliRecalled[];
      return {
        r: r!.output,
        written: recallWrites(s.root),
        audit: recallAuditOps(s.root),
        global: recallAuditOps(s.globalRoot),
      };
    });
    expect([got.r.status, got.r.stderr]).toEqual([0, '']);
    expect(got.r.stdout).toMatch(/^Found 13 memories \(\d+ tokens\) for: "deploy"/);
    expect(printedIds(got.r.stdout)).toEqual(['mem_p_global', ...ENGINE]);
    expect(got.r.stdout).toContain('--- mem_p_global [episodic] [verified] [global] score=');
    expect(got.audit).toEqual(['cli recall_anchor_skipped_no_session', 'cli recall 13']);
    expect(got.global).toEqual(['cli recall 13']);
    expect(got.written).toEqual({
      recalled: '13',
      traces: ['cli 13 -'],
      ranked: ['mem_p_global', ...ENGINE],
      ledger: ['recall 13 -'],
      bumped: { ...SHOWN_ONCE, mem_p_goal: 4 },
      goalLog: [],
    });
  });

  it('mcp: the engine order, no global row, no score, audited first, never counted', async () => {
    const got = await onFreshStore('local', async (s) => {
      // SAFETY: recallOn answers each mcp call with a McpRecalled (viaCli and viaMcp above).
      const [r] = (await recallOn('mcp', s, [{ query: 'deploy' }])) as McpRecalled[];
      return {
        r: r!.output,
        written: recallWrites(s.root),
        audit: recallAuditOps(s.root),
        global: recallAuditOps(s.globalRoot),
      };
    });
    expect(got.r.split('\n')[0]).toBe('Found 12 memories:');
    expect(got.r).not.toContain('score');
    expect(got.r).not.toContain('global store');
    expect(got.audit).toEqual(['mcp recall 12', 'mcp recall_anchor_skipped_no_session']);
    expect(got.global).toEqual([]);
    expect(got.written).toEqual({
      recalled: '0',
      traces: ['mcp 12 -'],
      ranked: ENGINE,
      ledger: ['mcp_recall 0 -'],
      bumped: { ...SHOWN_ONCE, mem_p_goal: 4 },
      goalLog: [],
    });
  });

  it('http: the SQL load order, position scores, ten rows, counted as returned', async () => {
    const got = await onFreshStore('local', async (s) => {
      const [r] = await httpCalls(s, [{ query: 'deploy' }]);
      return {
        r: r!.output,
        written: recallWrites(s.root),
        audit: recallAuditOps(s.root),
        global: recallAuditOps(s.globalRoot),
      };
    });
    expect(got.r.status).toBe(200);
    expect(got.r.body.results.map((r) => [r.id, r.score])).toEqual(SQL_ORDER.map((id, i) => [id, positions(10)[i]]));
    expect(got.r.body).toMatchObject({ total: 12, windowSize: 200, suppressionSummary: { droppedByBudget: 2 } });
    expect(got.audit).toEqual(['localhost:cli recall_anchor_skipped_no_session', 'localhost:cli recall 10']);
    expect(got.global).toEqual([]);
    const bumped = Object.fromEntries(SQL_ORDER.map((id) => [id, 1]));
    expect(got.written).toEqual({
      recalled: '10',
      traces: ['api 10 -'],
      ranked: SQL_ORDER,
      ledger: ['http_recall 10 -'],
      bumped: { ...bumped, mem_p_goal: 3 },
      goalLog: [],
    });
  });

  // D6: the goal-stack boost and the goal_recall_log rows a session recall writes.
  it('a session with an active goal lifts the goal row on CLI and MCP; HTTP order stays the load order', async () => {
    const goalFirst = ['mem_p_goal', ...ENGINE.filter((id) => id !== 'mem_p_goal')];
    const cli = await onFreshStore('local', async (s) => {
      // SAFETY: recallOn answers each cli call with a CliRecalled (viaCli and viaMcp above).
      const [r] = (await recallOn('cli', s, [{ query: 'deploy', session: SESSION }])) as CliRecalled[];
      return { ids: printedIds(r!.output.stdout), written: recallWrites(s.root), audit: recallAuditOps(s.root) };
    });
    expect(cli.ids).toEqual(['mem_p_global', ...goalFirst]);
    expect(cli.audit).toEqual(['cli recall 13']);
    expect(cli.written).toMatchObject({ traces: [`cli 13 ${SESSION}`], ledger: ['recall 13 -'] });
    expect(cli.written.goalLog).toEqual([`mem_p_goal ${SESSION}`]);

    const mcp = await onFreshStore('local', async (s) => {
      // SAFETY: recallOn answers each mcp call with a McpRecalled (viaCli and viaMcp above).
      const [r] = (await recallOn('mcp', s, [{ query: 'deploy', session: SESSION }])) as McpRecalled[];
      return { head: r!.output.split('\n').slice(0, 3), written: recallWrites(s.root), audit: recallAuditOps(s.root) };
    });
    expect(mcp.head).toEqual(['Found 12 memories:', '', '[verified] tags: goal-alpha (strength=1.00)']);
    expect(mcp.audit).toEqual(['mcp recall 12']);
    expect(mcp.written).toMatchObject({ ranked: goalFirst, traces: [`mcp 12 ${SESSION}`] });
    expect(mcp.written.goalLog).toEqual([`mem_p_goal ${SESSION}`]);

    const http = await onFreshStore('local', async (s) => {
      const [r] = await httpCalls(s, [{ query: 'deploy', session: SESSION }]);
      return {
        ids: r!.output.body.results.map((x) => x.id),
        written: recallWrites(s.root),
        audit: recallAuditOps(s.root),
      };
    });
    expect(http.ids).toEqual(SQL_ORDER);
    expect(http.audit).toEqual(['localhost:cli recall 10']);
    expect(http.written).toMatchObject({ traces: [`api 10 ${SESSION}`], ledger: [`http_recall 10 ${SESSION}`] });
    expect(http.written.goalLog).toEqual([]);
  });

  // D11: each surface keeps its own session ring, so hints and their audit rows follow the surface's own history.
  it.each([
    ['cli', 'mem_p_global', ['cli recall 13', 'cli recall_anchor_detected_query_repeat mem_p_global', 'cli recall 13']],
    ['mcp', 'mem_p_goal', ['mcp recall 12', 'mcp recall 12', 'mcp recall_anchor_detected_query_repeat mem_p_goal']],
    [
      'http',
      'mem_p_pinned',
      [
        'localhost:cli recall 10',
        'localhost:cli recall 10',
        'localhost:cli recall_anchor_detected_query_repeat mem_p_pinned',
      ],
    ],
  ] as const)(
    '%s: only a repeated query in one session gets a hint, on its own top row',
    async (surface, top, head) => {
      const calls: RecallCall[] = ['deploy', 'deploy', 'deploy target', 'deploy rollout'].map((query) => ({
        query,
        session: SESSION,
      }));
      const got = await onFreshStore('local', async (s) => {
        const out = await recallOn(surface, s, calls);
        return { hints: out.map((r) => r.hint), audit: recallAuditOps(s.root) };
      });
      expect(got.hints).toEqual([null, top, null, null]);
      expect(got.audit.slice(0, 3)).toEqual(head);
      expect(got.audit.slice(3)).toHaveLength(2);
      expect(got.audit.filter((row) => row.includes('anchor'))).toHaveLength(1);
    },
  );

  it('rings do not cross surfaces: a repeat on another surface is a first recall there', async () => {
    const got = await onFreshStore('local', async (s) => {
      const call: RecallCall = { query: 'deploy', session: SESSION };
      const hints: Record<string, (string | null)[]> = {};
      for (const surface of SURFACES) hints[surface] = (await recallOn(surface, s, [call, call])).map((r) => r.hint);
      return hints;
    });
    expect(got).toEqual({
      cli: [null, 'mem_p_global'],
      mcp: [null, 'mem_p_goal'],
      http: [null, 'mem_p_pinned'],
    });
  });

  // D7: the audit rows are written first, so a recall the store cannot audit records nothing; only the CLI still answers.
  it('a recall whose audit row the store refuses leaves no hint row, strengthen, trace or count', async () => {
    const refused = <T>(call: (s: Store) => Promise<T>) =>
      onFreshStore('local', async (s) => {
        const before = rowsOf(s.root);
        const db = openHippoDb(s.root);
        try {
          db.exec(
            "CREATE TRIGGER refuse_recall_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'recall' BEGIN SELECT RAISE(ABORT, 'recall audit refused'); END",
          );
        } finally {
          closeHippoDb(db);
        }
        const out = await call(s);
        return { out, before, after: rowsOf(s.root), globalAudit: recallAuditOps(s.globalRoot) };
      });
    const cli = await refused((s) => viaCli(s, { query: 'deploy' }));
    const http = await refused(async (s) => (await httpCalls(s, [{ query: 'deploy' }]))[0]!);
    const mcp = await refused((s) =>
      callTool(s.root, 'hippo_recall', { query: 'deploy' }).then(
        () => 'answered',
        (err: Error) => err.message,
      ),
    );

    for (const got of [cli, http, mcp]) {
      expect({ ...got.after, ledger: [] }).toEqual({ ...got.before, ledger: [] });
      expect(got.globalAudit).toEqual([]);
    }
    expect(cli.out.output.status).toBe(0);
    expect(cli.out.output.stdout).toContain('mem_p_goal');
    expect(cli.out.output.stderr).toContain('audit write failed');
    // The ledger books text that was sent: the CLI printed its block, HTTP sent no memory.
    expect(cli.after.ledger).toHaveLength(cli.before.ledger.length + 1);
    expect(http.out.output.status).toBe(500);
    expect(http.after.ledger).toEqual(http.before.ledger);
    expect(mcp.out).toBe('recall audit refused');
  });

  // D2: candidate windows on a store with 230 matching rows.
  // A store per surface: a recall rewrites the rows it returns, and that write time breaks the next surface's ties.
  it('candidate window per surface', async () => {
    const cli = await onFreshStore('wide', async (s) => {
      const out = await viaCli(s, { query: 'deploy', cliFlags: { json: true, why: true } });
      // SAFETY: `hippo recall --json` prints one JSON object carrying a RecallResult-shaped suppressionSummary.
      return (JSON.parse(out.output.stdout) as Pick<RecallResult, 'suppressionSummary'>).suppressionSummary;
    });
    expect(cli).toMatchObject({ totalCandidates: 201, droppedPreRank: 0 });
    expect(cli!.droppedByBudget).toBeGreaterThan(0);

    const mcpHead = await onFreshStore('wide', async (s) => (await viaMcp(s, { query: 'deploy' })).output.split('\n'));
    expect(mcpHead.slice(0, 4)).toEqual([
      'Found 230 memories:',
      '',
      '[verified] (strength=1.00)',
      'deploy step 0 of the wide rollout',
    ]);

    const windowOf = ({ output: { body } }: HttpRecalled) => ({
      windowSize: body.windowSize,
      candidates: body.suppressionSummary?.totalCandidates,
      dropped: body.suppressionSummary?.droppedByBudget,
      returned: body.results.length,
    });
    const http = await onFreshStore('wide', async (s) =>
      (await httpCalls(s, [{ query: 'deploy' }, { query: 'deploy', httpParams: { scorer_window: '50' } }])).map(
        windowOf,
      ),
    );
    expect(http).toEqual([
      { windowSize: 200, candidates: 200, dropped: 190, returned: 10 },
      { windowSize: 50, candidates: 50, dropped: 40, returned: 10 },
    ]);
  });

  // D8: MCP's 'recall' audit row counts the rows the budget let it show, as CLI and HTTP count the rows they return.
  it('mcp audit counts the rows shown', async () => {
    const got = await onFreshStore('local', async (s) => {
      const r = await viaMcp(s, { query: 'deploy', budget: 80 });
      return { heading: /Found \d+ memor[a-z]*/.exec(r.output)?.[0], audit: recallAuditOps(s.root) };
    });
    expect(got).toEqual({
      heading: 'Found 2 memories',
      audit: ['mcp recall 2', 'mcp recall_anchor_skipped_no_session'],
    });
  });

  // D4: HTTP scores are list positions in every mode; hybrid and physics only reorder.
  it('http scores are positions in bm25, hybrid and physics modes', async () => {
    const got = await onFreshStore('local', async (s) => {
      const out = await httpCalls(
        s,
        ['bm25', 'hybrid', 'physics'].map((mode) => ({ query: 'deploy', httpParams: { mode } })),
      );
      return out.map((r) => r.output.body.results);
    });
    const engine = ['mem_p_plain', 'mem_p_pinned', ...[...FILLS_UP].reverse(), 'mem_p_trace', 'mem_p_scoped'];
    expect(got.map((rows) => rows.map((r) => r.id))).toEqual([SQL_ORDER, engine, engine]);
    for (const rows of got) expect(rows.map((r) => r.score)).toEqual(positions(10));
  });

  // D6: under retrieveRanking the boost runs on the ranked list and again on the window band's position scores.
  it('mcp path applies the goal boost twice', async () => {
    const got = await onFreshStore('local', async (s) => {
      let rankedScore = 0;
      const result = await retrieveRanking(
        apiCtx(s.root, TENANT, { subject: 'mcp', role: 'admin' }),
        {
          query: 'deploy',
          window: { limit: 50 },
          mode: 'physics',
          boost: { sessionId: SESSION },
          filter: { keepHeldCopies: true },
          hints: { suppressAvailabilityHint: true },
        },
        ({ ranked }) => {
          rankedScore = ranked.find((r) => r.entry.id === 'mem_p_goal')?.score ?? 0;
          return { ids: ranked.map((r) => r.entry.id), audit: [] };
        },
      );
      const idx = result.results.findIndex((r) => r.id === 'mem_p_goal');
      return { rankedScore, bandIndex: idx, bandScore: result.results[idx]?.score ?? null };
    });
    expect(got.rankedScore).toBeGreaterThan(0);
    expect(got.bandIndex).toBe(0);
    expect(got.bandScore).toBe(2);
  });
});

// D12-D17: the same bad input on MCP and HTTP (RECALL_INPUTS). MCP answers with text, an isError result or a raw throw; HTTP with a status.
const CONTEXT_INPUTS: readonly [string, Record<string, string | number | boolean>][] = [
  ['budget -1', { budget: -1 }],
  ['budget abc', { budget: 'abc' }],
  ['scope 300 chars', { scope: 'x'.repeat(300) }],
  ['q 1100 chars', { q: 'q'.repeat(1100) }],
  ['limit 0', { limit: 0 }],
];

type McpOutcome =
  | { isError: string }
  | { ok: string | true }
  | { thrown: string; code: string | null; message: string };
type HttpOutcome = { status: number; error?: string | null; code?: string | null };

const badArgs = (tool: string, message: string): McpOutcome => ({
  isError: `Invalid arguments for ${tool}: ${message}`,
});
const status400 = (error: string, code: string | null = null): HttpOutcome => ({ status: 400, error, code });
const thrownWindow = (got: string): McpOutcome => ({
  thrown: 'RecallContractError',
  code: 'invalid_scorer_window',
  message: `scorerWindow must be a positive integer; got ${got}`,
});
const RECALL = 'hippo_recall';

/** What each surface answers to each RECALL_INPUTS case, by name. */
const RECALL_OUTCOMES = new Map<string, { mcp: McpOutcome; http: HttpOutcome }>(
  Object.entries({
    'empty query': { mcp: badArgs(RECALL, 'query is required'), http: status400('q is required') },
    'scorer_window 0': {
      mcp: thrownWindow('0'),
      http: status400('scorerWindow must be a positive integer; got 0', 'invalid_scorer_window'),
    },
    'scorer_window 5000': {
      mcp: badArgs(RECALL, 'scorer_window must be <= 1000'),
      http: status400('scorer_window must be <= 1000'),
    },
    'scorer_window abc': {
      mcp: thrownWindow('NaN'),
      http: status400('scorerWindow must be a positive integer; got NaN', 'invalid_scorer_window'),
    },
    'fresh_tail_count -1': {
      mcp: badArgs(RECALL, 'fresh_tail_count must be a non-negative number'),
      http: status400('fresh_tail_count must be a non-negative number'),
    },
    'fresh_tail_count abc': {
      mcp: badArgs(RECALL, 'fresh_tail_count must be a number (got "abc")'),
      http: status400('fresh_tail_count must be a non-negative number'),
    },
    'fresh_tail_session_id 300 chars': {
      mcp: badArgs(RECALL, 'fresh_tail_session_id exceeds 256-character cap'),
      http: status400('fresh_tail_session_id exceeds 256-character cap'),
    },
    'session_id 300 chars': {
      mcp: badArgs(RECALL, 'session_id must be at most 256 characters (got 300)'),
      http: status400('session_id exceeds 256-character cap'),
    },
    'session_id blank': { mcp: { ok: 'Found 12 memories:' }, http: { status: 200 } },
    'summarize_overflow banana': {
      mcp: badArgs(RECALL, 'summarize_overflow must be a boolean (got "banana")'),
      http: { status: 200 },
    },
    'scope empty': { mcp: { ok: 'Found 12 memories:' }, http: { status: 200 } },
    'budget -1': { mcp: badArgs(RECALL, 'budget must be >= 0 (got -1)'), http: { status: 200 } },
    'mode bogus': {
      mcp: badArgs(RECALL, "mode must be 'bm25', 'hybrid', or 'physics'"),
      http: status400("mode must be 'bm25', 'hybrid', or 'physics'"),
    },
    'limit 0': {
      mcp: badArgs(RECALL, 'limit must be a positive integer <= 1000'),
      http: status400('limit must be a positive integer <= 1000'),
    },
  } satisfies Record<string, { mcp: McpOutcome; http: HttpOutcome }>),
);

const CONTEXT = 'hippo_context';
const CONTEXT_OUTCOMES = new Map<string, { mcp: McpOutcome; http: HttpOutcome }>(
  Object.entries({
    'budget -1': {
      mcp: badArgs(CONTEXT, 'budget must be >= 0 (got -1)'),
      http: status400('budget must be a non-negative number'),
    },
    'budget abc': {
      mcp: badArgs(CONTEXT, 'budget must be a number (got "abc")'),
      http: status400('budget must be a non-negative number'),
    },
    'scope 300 chars': {
      mcp: badArgs(CONTEXT, 'scope exceeds 256-character cap'),
      http: status400('scope exceeds 256-character cap'),
    },
    'q 1100 chars': { mcp: { ok: true }, http: status400('q exceeds 1024-character cap') },
    'limit 0': {
      mcp: badArgs(CONTEXT, 'limit must be a positive number'),
      http: status400('limit must be a positive number'),
    },
  } satisfies Record<string, { mcp: McpOutcome; http: HttpOutcome }>),
);

async function mcpOutcome(root: string, tool: string, args: ToolArgs): Promise<McpOutcome> {
  try {
    const { text, isError } = toolReply(await callTool(root, tool, args));
    if (isError) return { isError: text };
    // Context text follows the git state of the working directory, so only recall checks its first line.
    return { ok: tool === 'hippo_recall' ? text.split('\n')[0]! : true };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const code = err instanceof RecallContractError ? err.code : null;
    return { thrown: err.name, code, message: err.message };
  }
}

async function httpOutcome(
  handle: ServerHandle,
  path: string,
  args: Record<string, string | number | boolean>,
): Promise<HttpOutcome> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) params.set(k === 'query' ? 'q' : k, String(v));
  const res = await fetch(`${handle.url}${path}?${params.toString()}`);
  // SAFETY: the server's error replies are { error, code? }; a 200 body is not read past this line.
  const body = (await res.json()) as { error?: string; code?: string };
  return res.status === 200
    ? { status: 200 }
    : { status: res.status, error: body.error ?? null, code: body.code ?? null };
}

describe('recall and context validation drift, MCP vs HTTP', () => {
  let s: Store;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    s = freshStore(templates, 'local');
    handle = await serve({ hippoRoot: s.root, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(s.home, { recursive: true, force: true });
  });

  it.each(RECALL_INPUTS)('recall: %s', async (name, args) => {
    const got = {
      mcp: await mcpOutcome(s.root, 'hippo_recall', args),
      http: await httpOutcome(handle, '/v1/memories', args),
    };
    expect(got).toEqual(RECALL_OUTCOMES.get(name));
  });

  it.each(CONTEXT_INPUTS)('context: %s', async (name, args) => {
    const got = {
      mcp: await mcpOutcome(s.root, 'hippo_context', args),
      http: await httpOutcome(handle, '/v1/context', args),
    };
    expect(got).toEqual(CONTEXT_OUTCOMES.get(name));
  });
});

// D18: on a shared store MCP recall keeps to the caller's repo, while GET /v1/memories takes no project.
describe('shared store recall, MCP vs HTTP', () => {
  it('MCP hippo_recall shows only the named repo; HTTP GET /v1/memories returns both repos', async () => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    const home = makeRoot('parity-shared', { init: false });
    const root = join(home, 'store');
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    let handle: ServerHandle | undefined;
    try {
      initStore(root);
      writeFileSync(join(root, 'config.json'), JSON.stringify({ sharedStore: true }));
      writeEntry(
        root,
        seeded('lighthouse rota for the acme repo', 'mem_d18_acme', '2026-01-20T00:00:00.000Z', {
          originProject: 'acme',
        }),
      );
      writeEntry(
        root,
        seeded('lighthouse rota for the beta repo', 'mem_d18_beta', '2026-01-20T00:00:00.000Z', {
          originProject: 'beta',
        }),
      );
      const mcp = toolReply(
        await handleMcpRequest(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'hippo_recall', arguments: { query: 'lighthouse' } },
          },
          {
            hippoRoot: root,
            tenantId: TENANT,
            actor: 'mcp',
            role: 'admin',
            hostAdmin: true,
            project: { name: 'acme', legacyName: 'acme' },
            store: sqliteStore(root),
            config: loadConfig(root),
          },
        ),
      );
      expect(mcp.isError, mcp.text).toBe(false);
      expect(mcp.text).toContain('the acme repo');
      expect(mcp.text).not.toContain('the beta repo');
      handle = await serve({ hippoRoot: root, port: 0 });
      const http = await viaHttp(handle, { query: 'lighthouse' });
      expect(http.output.status).toBe(200);
      expect(http.output.body.results.map((r) => r.id).sort()).toEqual(['mem_d18_acme', 'mem_d18_beta']);
    } finally {
      await handle?.stop();
      vi.unstubAllEnvs();
    }
  });
});
