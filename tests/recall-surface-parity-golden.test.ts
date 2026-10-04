// Pins what one recall returns and writes on each surface (CLI `hippo recall`, MCP hippo_recall, HTTP GET /v1/memories)
// over one store, so each difference in docs/recall-surface-differences.md is visible here and moves only on purpose.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/memory.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { cmdRecall, __resetSessionRecallHistoryCli } from '../src/cli/recall.js';
import { handleMcpRequest, __resetSessionRecallHistoryMcp, type McpResponse } from '../src/mcp/server.js';
import { serve, __resetSessionRecallHistoryHttp, type ServerHandle } from '../src/server.js';
import { retrieve, RecallContractError, type RecallResult } from '../src/api.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { runInProcess, type InProcessResult } from './_helpers/run-in-process.js';
import type { CliFlags } from '../src/cli/shared.js';

const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const SESSION = 'golden-session';
const TENANT = 'default';
const CLEARED_ENV = [
  'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_TENANT', 'HIPPO_ANCHORING', 'HIPPO_AVAILABILITY', 'HIPPO_AUTODEBIAS',
  'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', 'HIPPO_REQUIRE_AUTH',
  'HIPPO_API_KEY', 'HIPPO_ABLATE_RECALL_BOOST',
];

type Surface = 'cli' | 'mcp' | 'http';
const SURFACES: readonly Surface[] = ['cli', 'mcp', 'http'];

let templates: string;
let goalId = '';

function seeded(content: string, id: string, created: string, extra: Partial<MemoryEntry> = {}, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  // createMemory decays strength over the real milliseconds it runs, so a fixed value keeps snapshots stable.
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts }), id, created, last_retrieved: created, valid_from: created, strength: 1, ...extra };
}

function seedLocal(root: string): void {
  initStore(root);
  const rows: MemoryEntry[] = [
    seeded('deploy pipeline uses blue green rollout for the api', 'mem_p_plain', '2026-01-20T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('deploy freeze applies to the billing service on fridays', 'mem_p_pinned', '2026-01-05T00:00:00.000Z', {}, { pinned: true, tags: ['deploy'] }),
    seeded('deploy checklist for team alpha runs smoke tests first', 'mem_p_scoped', '2026-01-18T00:00:00.000Z', {}, { scope: 'team-alpha' }),
    seeded('private deploy token rotation lives in slack', 'mem_p_private', '2026-01-19T00:00:00.000Z', {}, { scope: 'slack:private:C1' }),
    seeded('deploy target was the old staging cluster', 'mem_p_old', '2026-01-02T00:00:00.000Z', { superseded_by: 'mem_p_new' }),
    seeded('deploy target is the new staging cluster in eu west', 'mem_p_new', '2026-01-25T00:00:00.000Z'),
    seeded('deploy goal work: migrate the rollout scripts to the new runner', 'mem_p_goal', '2026-01-15T00:00:00.000Z', { retrieval_count: 3 }, { tags: ['goal-alpha'] }),
    seeded('deploy trace: ran the canary and promoted it', 'mem_p_trace', '2026-01-22T00:00:00.000Z', {}, { layer: Layer.Trace, trace_outcome: 'success' }),
    seeded('unrelated note about lunch options near the office', 'mem_p_noise', '2026-01-21T00:00:00.000Z'),
  ];
  for (let i = 0; i < 6; i++) {
    rows.push(seeded(`deploy log line ${i} for the nightly batch`, `mem_p_fill${i}`, `2026-01-1${i}T00:00:00.000Z`));
  }
  for (const row of rows) writeEntry(root, row);
  goalId = pushGoal(root, { sessionId: SESSION, tenantId: TENANT, goalName: 'goal-alpha' }).id;
}

function seedWide(root: string): void {
  initStore(root);
  for (let i = 0; i < 230; i++) {
    writeEntry(root, seeded(`deploy step ${i} of the wide rollout`, `mem_w_${String(i).padStart(3, '0')}`, '2026-01-10T00:00:00.000Z'));
  }
}

function seedGlobal(root: string): void {
  initStore(root);
  writeEntry(root, seeded('deploy notes from the global store about rollbacks', 'mem_p_global', '2026-01-12T00:00:00.000Z'));
}

interface Store { home: string; root: string; globalRoot: string }

/** A fresh copy of a template store plus the global store, with HIPPO_HOME pointed at that global store. */
function freshStore(kind: 'local' | 'wide'): Store {
  const home = mkdtempSync(join(tmpdir(), 'hippo-parity-'));
  const root = join(home, 'store');
  const globalRoot = join(home, 'global');
  cpSync(join(templates, kind), root, { recursive: true });
  cpSync(join(templates, 'global'), globalRoot, { recursive: true });
  vi.stubEnv('HIPPO_HOME', globalRoot);
  return { home, root, globalRoot };
}

function normalise<T>(value: T, s: Store): T {
  const text = JSON.stringify(value)
    .split(JSON.stringify(s.home).slice(1, -1)).join('<home>')
    .split(s.home.replace(/\\/g, '/')).join('<home>')
    .split(goalId).join('<goal>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  // SAFETY: text is the JSON of a T with only string contents rewritten, so it parses back to the same shape.
  return JSON.parse(text) as T;
}

interface RecallCall { query: string; session?: string; budget?: number; cliFlags?: CliFlags; httpParams?: Record<string, string> }

interface CliRecalled { output: InProcessResult; hint: string | null }
interface McpRecalled { output: string; hint: string | null }
interface HttpRecalled { output: { status: number; body: RecallResult }; hint: string | null }
type Recalled = CliRecalled | McpRecalled | HttpRecalled;

async function viaCli(s: Store, c: RecallCall): Promise<CliRecalled> {
  const flags: CliFlags = { ...c.cliFlags };
  if (c.session) flags['session-id'] = c.session;
  if (c.budget !== undefined) flags.budget = String(c.budget);
  const out = await runInProcess(() => cmdRecall(s.root, c.query, flags));
  const anchored = /\[anchored_on: ([^\]]+)\]/.exec(out.stdout);
  return { output: out, hint: anchored ? anchored[1]! : null };
}

type ToolArgs = Record<string, string | number | boolean>;

function callTool(root: string, name: string, args: ToolArgs): Promise<McpResponse | null> {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { hippoRoot: root, tenantId: TENANT, actor: 'mcp' },
  );
}

interface ToolReply { text: string; isError: boolean }

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

function rowsOf(root: string) {
  const db = openHippoDb(root);
  try {
    const q = (sql: string): unknown[] => db.prepare(sql).all();
    return {
      audit: q("SELECT ts, tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'recall%' ORDER BY id"),
      goalRecallLog: q('SELECT goal_id, memory_id, session_id, score FROM goal_recall_log ORDER BY memory_id'),
      stats: q("SELECT key, value FROM meta WHERE key LIKE 'total_%' ORDER BY key"),
      traces: q('SELECT id, tenant_id, session_id, pipeline, result_count, explain_mode FROM recall_traces ORDER BY id'),
      traceResults: q('SELECT trace_id, memory_id, result_rank, score FROM recall_trace_results ORDER BY trace_id, result_rank'),
      ledger: q('SELECT tenant_id, session_id, surface, event, items, tokens FROM token_ledger ORDER BY id'),
      retrieved: q('SELECT id, retrieval_count, strength FROM memories WHERE retrieval_count > 0 ORDER BY id'),
    };
  } finally {
    closeHippoDb(db);
  }
}

interface AuditOp { actor: string; op: string; target_id: string | null; metadata_json: string }

function auditOps(root: string): AuditOp[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names exactly the four audit_log columns AuditOp declares.
    return db.prepare("SELECT actor, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'recall%' ORDER BY id").all() as AuditOp[];
  } finally {
    closeHippoDb(db);
  }
}

async function onFreshStore<T>(kind: 'local' | 'wide', fn: (s: Store) => Promise<T>): Promise<T> {
  const s = freshStore(kind);
  try {
    return normalise(await fn(s), s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

beforeAll(() => {
  templates = mkdtempSync(join(tmpdir(), 'hippo-parity-template-'));
  seedLocal(join(templates, 'local'));
  seedWide(join(templates, 'wide'));
  seedGlobal(join(templates, 'global'));
});

afterAll(() => {
  rmSync(templates, { recursive: true, force: true });
});

describe('recall surface parity goldens', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    _resetAblationCacheForTests();
    __resetSessionRecallHistoryCli();
    __resetSessionRecallHistoryMcp();
    __resetSessionRecallHistoryHttp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  // D1-D5, D7, D9, D10: output, order, scores and every row one plain recall writes, local and global store.
  it.each(SURFACES)('%s: plain recall, no session', async (surface) => {
    const got = await onFreshStore('local', async (s) => {
      const [r] = await recallOn(surface, s, [{ query: 'deploy' }]);
      return { output: r!.output, local: rowsOf(s.root), globalAudit: auditOps(s.globalRoot) };
    });
    expect(got).toMatchSnapshot();
  }, 60_000);

  // D6: the goal-stack boost and the goal_recall_log rows a session recall writes.
  it.each(SURFACES)('%s: recall with a session that has an active goal', async (surface) => {
    const got = await onFreshStore('local', async (s) => {
      const [r] = await recallOn(surface, s, [{ query: 'deploy', session: SESSION }]);
      return { output: r!.output, local: rowsOf(s.root) };
    });
    expect(got).toMatchSnapshot();
  }, 60_000);

  // D11: each surface keeps its own session ring, so hints and their audit rows follow the surface's own history.
  it.each(SURFACES)('%s: anchoring hints over repeated recalls in one session', async (surface) => {
    const calls: RecallCall[] = ['deploy', 'deploy', 'deploy target', 'deploy rollout'].map((query) => ({ query, session: SESSION }));
    const got = await onFreshStore('local', async (s) => {
      const out = await recallOn(surface, s, calls);
      return { hints: out.map((r) => r.hint), audit: auditOps(s.root) };
    });
    expect(got).toMatchSnapshot();
  }, 60_000);

  it('rings do not cross surfaces: a repeat on another surface is a first recall there', async () => {
    const got = await onFreshStore('local', async (s) => {
      const call: RecallCall = { query: 'deploy', session: SESSION };
      const hints: Record<string, (string | null)[]> = {};
      for (const surface of SURFACES) hints[surface] = (await recallOn(surface, s, [call, call])).map((r) => r.hint);
      return hints;
    });
    for (const surface of SURFACES) expect(got[surface]![0]).toBeNull();
    expect(got).toMatchSnapshot();
  }, 60_000);

  // D2: candidate windows on a store with 230 matching rows.
  it('candidate window per surface', async () => {
    const got = await onFreshStore('wide', async (s) => {
      const cli = await viaCli(s, { query: 'deploy', cliFlags: { json: true, why: true } });
      const mcp = await viaMcp(s, { query: 'deploy' });
      const http = await httpCalls(s, [{ query: 'deploy' }, { query: 'deploy', httpParams: { scorer_window: '50' } }]);
      // SAFETY: `hippo recall --json` prints one JSON object carrying a RecallResult-shaped suppressionSummary.
      const cliJson = JSON.parse(cli.output.stdout) as Pick<RecallResult, 'suppressionSummary'>;
      const windowOf = ({ output: { body } }: HttpRecalled) => ({ windowSize: body.windowSize, summary: body.suppressionSummary, returned: body.results.length });
      return {
        cli: cliJson.suppressionSummary,
        mcpHead: mcp.output.split('\n').slice(0, 4),
        http: windowOf(http[0]!),
        httpScorerWindow50: windowOf(http[1]!),
      };
    });
    expect(got).toMatchSnapshot();
  }, 120_000);

  // D8: MCP's 'recall' audit row counts the window band, not the rows the budget let it show.
  it('mcp audit counts the window band, not the rows shown', async () => {
    const got = await onFreshStore('local', async (s) => {
      const r = await viaMcp(s, { query: 'deploy', budget: 80 });
      const recallRow = auditOps(s.root).find((a) => a.op === 'recall');
      // SAFETY: the 'recall' audit row's metadata is { query_hash, query_length, results } (src/api/recall.ts).
      const metadata = JSON.parse(recallRow!.metadata_json) as { results: number };
      return { shownHeading: /Found \d+ memor[a-z]*/.exec(r.output)?.[0] ?? null, auditResults: metadata.results };
    });
    expect(got.auditResults).toBeGreaterThan(Number(/\d+/.exec(got.shownHeading ?? '0')![0]));
    expect(got).toMatchSnapshot();
  }, 60_000);

  // D4: HTTP scores are list positions in every mode; hybrid only reorders.
  it('http scores are positions in bm25, hybrid and physics modes', async () => {
    const got = await onFreshStore('local', async (s) => {
      const out = await httpCalls(s, ['bm25', 'hybrid', 'physics'].map((mode) => ({ query: 'deploy', httpParams: { mode } })));
      return out.map((r) => r.output.body.results.map((x) => [x.id, x.score]));
    });
    expect(got).toMatchSnapshot();
  }, 60_000);

  // D6: under showRanked the boost runs on the ranked list and again on the window band's position scores.
  it('mcp path applies the goal boost twice', async () => {
    const got = await onFreshStore('local', async (s) => {
      let rankedScore = 0;
      const result = await retrieve(
        { hippoRoot: s.root, tenantId: TENANT, actor: { subject: 'mcp', role: 'admin' } },
        {
          query: 'deploy', limit: 50, mode: 'physics', sessionId: SESSION, keepHeldCopies: true, suppressAvailabilityHint: true,
          showRanked: ({ ranked }) => {
            rankedScore = ranked.find((r) => r.entry.id === 'mem_p_goal')?.score ?? 0;
            return ranked.map((r) => r.entry.id);
          },
        },
      );
      const idx = result.results.findIndex((r) => r.id === 'mem_p_goal');
      return { rankedScore, bandIndex: idx, bandScore: result.results[idx]?.score ?? null, positionScore: 1 - idx / 50 };
    });
    expect(got.bandScore).toBeGreaterThan(got.positionScore);
    expect(got).toMatchSnapshot();
  }, 60_000);
});

// D12-D17: the same bad input on MCP and HTTP. MCP answers with text, an isError result or a raw throw; HTTP with a status.
const RECALL_INPUTS: readonly [string, Record<string, string | number | boolean>][] = [
  ['empty query', { query: '' }],
  ['scorer_window 0', { query: 'deploy', scorer_window: 0 }],
  ['scorer_window 5000', { query: 'deploy', scorer_window: 5000 }],
  ['scorer_window abc', { query: 'deploy', scorer_window: 'abc' }],
  ['fresh_tail_count -1', { query: 'deploy', fresh_tail_count: -1 }],
  ['fresh_tail_count abc', { query: 'deploy', fresh_tail_count: 'abc' }],
  ['fresh_tail_session_id 300 chars', { query: 'deploy', fresh_tail_count: 1, fresh_tail_session_id: 'f'.repeat(300) }],
  ['session_id 300 chars', { query: 'deploy', session_id: 's'.repeat(300) }],
  ['session_id blank', { query: 'deploy', session_id: '   ' }],
  ['summarize_overflow banana', { query: 'deploy', summarize_overflow: 'banana' }],
  ['scope empty', { query: 'deploy', scope: '' }],
  ['budget -1', { query: 'deploy', budget: -1 }],
  ['mode bogus', { query: 'deploy', mode: 'bogus' }],
  ['limit 0', { query: 'deploy', limit: 0 }],
];

const CONTEXT_INPUTS: readonly [string, Record<string, string | number | boolean>][] = [
  ['budget -1', { budget: -1 }],
  ['budget abc', { budget: 'abc' }],
  ['scope 300 chars', { scope: 'x'.repeat(300) }],
  ['q 1100 chars', { q: 'q'.repeat(1100) }],
  ['limit 0', { limit: 0 }],
];

type McpOutcome = { isError: string } | { ok: string | true } | { thrown: string; code: string | null; message: string };
type HttpOutcome = { status: number; error?: string | null; code?: string | null };

async function mcpOutcome(root: string, tool: string, args: ToolArgs): Promise<McpOutcome> {
  try {
    const { text, isError } = toolReply(await callTool(root, tool, args));
    if (isError) return { isError: text };
    // Context text follows the git state of the working directory, so only recall pins its first line.
    return { ok: tool === 'hippo_recall' ? text.split('\n')[0]! : true };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const code = err instanceof RecallContractError ? err.code : null;
    return { thrown: err.name, code, message: err.message };
  }
}

async function httpOutcome(handle: ServerHandle, path: string, args: Record<string, string | number | boolean>): Promise<HttpOutcome> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) params.set(k === 'query' ? 'q' : k, String(v));
  const res = await fetch(`${handle.url}${path}?${params.toString()}`);
  // SAFETY: the server's error replies are { error, code? }; a 200 body is not read past this line.
  const body = (await res.json()) as { error?: string; code?: string };
  return res.status === 200 ? { status: 200 } : { status: res.status, error: body.error ?? null, code: body.code ?? null };
}

describe('recall and context validation drift, MCP vs HTTP', () => {
  let s: Store;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    s = freshStore('local');
    handle = await serve({ hippoRoot: s.root, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(s.home, { recursive: true, force: true });
  });

  it.each(RECALL_INPUTS)('recall: %s', async (_name, args) => {
    const got = { mcp: await mcpOutcome(s.root, 'hippo_recall', args), http: await httpOutcome(handle, '/v1/memories', args) };
    expect(normalise(got, s)).toMatchSnapshot();
  }, 60_000);

  it.each(CONTEXT_INPUTS)('context: %s', async (_name, args) => {
    const got = { mcp: await mcpOutcome(s.root, 'hippo_context', args), http: await httpOutcome(handle, '/v1/context', args) };
    expect(normalise(got, s)).toMatchSnapshot();
  }, 60_000);
});
