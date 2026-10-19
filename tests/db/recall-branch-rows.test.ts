// The recall branches the surface differences test skips, over serve() on hippo.db: what each branch returns on HTTP and
// MCP, the rows it writes, the stats mirror, and that the global store is never touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { serve } from '../../src/server.js';
import { __resetSessionRecallHistoryHttp } from '../../src/entry/testing.js';
import { _resetSessionRecallHistoryMcpForTests } from '../../src/mcp/server.js';
import { lastRecalledIds } from '../../src/api/recall/last-recalled.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import type { RecallResult } from '../../src/api/index.js';
import {
  CLEARED_ENV,
  FAKE_NOW,
  freshStore,
  RECALL_BRANCHES,
  seedPortBranches,
  seedTemplates,
  SESSION,
  statsMirror,
  type Store,
  type Templates,
} from '../_helpers/recall-golden-seed.js';
import { recallAuditOps, recallWrites, type RecallWrites } from '../_helpers/recall-rows.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

type Surface = 'http' | 'mcp';
type Args = Record<string, string | number | boolean>;
type Branch = (typeof RECALL_BRANCHES)[number];

let templates: Templates;

async function recallOver(url: string, via: Surface, args: Args): Promise<RecallResult | string> {
  if (via === 'http') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) params.set(k === 'query' ? 'q' : k, String(v));
    const res = await fetch(`${url}/v1/memories?${params.toString()}`);
    expect(res.status).toBe(200);
    // SAFETY: every branch call is valid, so /v1/memories answers with a serialised RecallResult.
    return (await res.json()) as RecallResult;
  }
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: args } };
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rpc),
  });
  expect(res.status).toBe(200);
  // SAFETY: /mcp answers tools/call with a JSON-RPC reply whose result is { content: [{ text }] }, or with an error.
  const reply = (await res.json()) as { result?: { content?: { text: string }[] }; error?: unknown };
  expect(reply.error).toBeUndefined();
  return reply.result!.content![0]!.text;
}

/** savePrediction draws its memory's id at random, so the rows name that one id by its role. */
function predictionId(root: string): string {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT projects exactly one column, memory_id, and the seed saves one prediction.
    return (db.prepare('SELECT memory_id FROM predictions').get() as { memory_id: string }).memory_id;
  } finally {
    closeHippoDb(db);
  }
}

interface Ran {
  reply: RecallResult | string;
  writes: RecallWrites;
  audit: string[];
  global: { writes: RecallWrites; audit: string[] };
  mirror: { total_recalled: number } | null;
}

async function runBranch(via: Surface, branch: Branch): Promise<Ran> {
  const s: Store = freshStore(templates, 'local');
  try {
    const handle = await serve({ hippoRoot: s.root, port: 0 });
    let reply: RecallResult | string;
    try {
      reply = await recallOver(handle.url, via, { query: branch.query, ...branch[via] });
    } finally {
      await handle.stop();
    }
    const prediction = predictionId(s.root);
    const writes = recallWrites(s.root);
    const named = (id: string): string => (id === prediction ? '<prediction>' : id);
    const mirror = statsMirror(s.root);
    return {
      reply,
      writes: {
        ...writes,
        ranked: writes.ranked.map(named),
        bumped: Object.fromEntries(Object.entries(writes.bumped).map(([id, n]) => [named(id), n])),
      },
      audit: recallAuditOps(s.root),
      global: { writes: recallWrites(s.globalRoot), audit: recallAuditOps(s.globalRoot) },
      // SAFETY: stats.json is the object writeStatsMirror serialises, total_recalled among its keys.
      mirror: mirror === null ? null : (JSON.parse(mirror) as { total_recalled: number }),
    };
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

const FILLS = ['mem_p_fill0', 'mem_p_fill1', 'mem_p_fill2', 'mem_p_fill3', 'mem_p_fill4', 'mem_p_fill5'];
/** MCP's engine order over the local store plus the port-branch rows; the goal row sinks to the end with no session. */
const ENGINE = [
  'mem_p_plain',
  'mem_p_pinned',
  'mem_p_fill5',
  'mem_p_fill4',
  'mem_p_fill3',
  'mem_p_fill2',
  'mem_p_trace',
  'mem_p_fill1',
  'mem_p_fill0',
  'mem_x_child2',
  '<prediction>',
  'mem_x_child1',
  'mem_p_scoped',
  'mem_p_new',
  'mem_x_raw',
  'mem_p_goal',
];
const HTTP_HEAD = ['mem_p_pinned', 'mem_p_plain', 'mem_x_child1', 'mem_x_child2'];
const HINT = 'localhost:cli recall_autodebias_hint deploy-duration';
const SKIPPED = 'localhost:cli recall_anchor_skipped_no_session';
const recallRow = (n: number): string => `localhost:cli recall ${n}`;

/** Every row a recall shows is strengthened once; the goal row starts the seed at 3. */
const bumpedFor = (shown: readonly string[]) => ({
  mem_p_goal: 3,
  ...Object.fromEntries(shown.map((id) => [id, id === 'mem_p_goal' ? 4 : 1])),
});

interface Want {
  ids: string[];
  audit: string[];
  trace: string;
  ledger: string;
  goalLog?: string[];
  check?: (reply: RecallResult | string) => void;
}

// SAFETY: recallOver answers an http call with a RecallResult, and only http checks read a body.
const body = (reply: RecallResult | string): RecallResult => reply as RecallResult;
// SAFETY: recallOver answers an mcp call with the tool text, and only mcp checks read text.
const text = (reply: RecallResult | string): string => reply as string;

const WANT = new Map<string, Record<Surface, Want>>(
  Object.entries({
    include_continuity: {
      http: {
        ids: [...HTTP_HEAD, ...FILLS],
        audit: [SKIPPED, recallRow(10)],
        trace: 'api 10 -',
        ledger: 'http_recall 10 -',
        check: (reply) => {
          const c = body(reply).continuity!;
          expect(c.activeSnapshot).toMatchObject({ task: 'ship the eu cluster', next_step: 'run the canary' });
          expect(c.sessionHandoff).toMatchObject({ summary: 'handoff after the canary', nextAction: 'promote it' });
          expect(c.recentSessionEvents.map((e) => e.content)).toEqual(['canary passed']);
          expect(body(reply).continuityTokens).toBeGreaterThan(0);
        },
      },
      mcp: {
        ids: ENGINE,
        audit: [recallRow(16), SKIPPED],
        trace: 'mcp 16 -',
        ledger: 'mcp_recall 0 -',
        check: (reply) =>
          expect(text(reply)).toContain(
            '## Continuity\n\n### Active Task Snapshot\n- Task: ship the eu cluster\n- Summary: cutover planned\n' +
              '- Next: run the canary\n\n### Session Handoff\n- Summary: handoff after the canary\n' +
              '- Next action: promote it\n\n### Recent Session Trail\n- [note] canary passed',
          ),
      },
    },
    'fresh_tail_count 1 with a session': {
      http: {
        ids: ['mem_x_raw', ...HTTP_HEAD, ...FILLS],
        audit: [recallRow(11)],
        trace: `api 11 ${SESSION}`,
        ledger: `http_recall 11 ${SESSION}`,
        check: (reply) => {
          expect(body(reply).results[0]).toMatchObject({ id: 'mem_x_raw', isFreshTail: true });
          expect(body(reply).results.filter((r) => r.isFreshTail)).toHaveLength(1);
          expect(body(reply).suppressionSummary?.freshTailAdded).toBe(1);
        },
      },
      mcp: {
        ids: ['mem_p_goal', ...ENGINE.slice(0, -1)],
        audit: [recallRow(16)],
        trace: `mcp 16 ${SESSION}`,
        ledger: 'mcp_recall 0 -',
        goalLog: [`mem_p_goal ${SESSION}`],
      },
    },
    summarize_overflow: {
      http: {
        ids: ['mem_p_pinned', 'mem_p_plain', 'mem_x_summary'],
        audit: [SKIPPED, recallRow(3)],
        trace: 'api 3 -',
        ledger: 'http_recall 3 -',
        check: (reply) => {
          expect(body(reply).results[2]).toMatchObject({
            isSummary: true,
            substitutedFor: ['mem_x_child1', 'mem_x_child2'],
          });
          expect(body(reply).suppressionSummary?.summarySubstitutionsAdded).toBe(1);
        },
      },
      mcp: {
        ids: ENGINE,
        audit: [recallRow(16), SKIPPED],
        trace: 'mcp 16 -',
        ledger: 'mcp_recall 0 -',
        check: (reply) => expect(text(reply)).not.toContain('rollout summary'),
      },
    },
    'forward claim': {
      http: {
        ids: ['mem_p_pinned', 'mem_p_plain', 'mem_x_raw', 'mem_x_child1', 'mem_x_child2', ...FILLS.slice(0, 5)],
        audit: [SKIPPED, recallRow(10), HINT],
        trace: 'api 10 -',
        ledger: 'http_recall 10 -',
        check: (reply) => {
          expect(body(reply).planningFallacyHint).toMatchObject({
            classTag: 'deploy-duration',
            detectedPhrase: 'will take 3 days',
            nClosed: 1,
          });
          expect(body(reply).planningFallacyHint!.meanRatio).toBeGreaterThan(1);
        },
      },
      mcp: {
        ids: [
          'mem_p_plain',
          'mem_p_pinned',
          'mem_x_raw',
          'mem_p_fill5',
          'mem_p_fill4',
          'mem_p_fill3',
          'mem_p_fill2',
          'mem_p_trace',
          'mem_p_fill1',
          'mem_p_fill0',
          'mem_x_child2',
          'mem_x_child1',
          '<prediction>',
          'mem_p_new',
          'mem_p_goal',
          'mem_p_scoped',
          'mem_p_noise',
          'mem_x_cafe',
          'mem_x_summary',
        ],
        audit: [HINT, recallRow(19), SKIPPED],
        trace: 'mcp 19 -',
        ledger: 'mcp_recall 0 -',
        check: (reply) =>
          expect(text(reply)).toMatch(
            /^## Planning fallacy hint\nClass: deploy-duration\n.*\n\(detected: "will take 3 days"\)\n\n---\n\nFound 19 memories:/,
          ),
      },
    },
    'scope team-alpha': {
      http: { ids: ['mem_p_scoped'], audit: [SKIPPED, recallRow(1)], trace: 'api 1 -', ledger: 'http_recall 1 -' },
      mcp: { ids: ['mem_p_scoped'], audit: [recallRow(1), SKIPPED], trace: 'mcp 1 -', ledger: 'mcp_recall 0 -' },
    },
    'no terms': {
      http: {
        ids: ['mem_x_child1', 'mem_x_child2', 'mem_p_pinned', 'mem_x_cafe', 'mem_x_summary', ...FILLS.slice(0, 5)],
        audit: [SKIPPED, recallRow(10)],
        trace: 'api 10 -',
        ledger: 'http_recall 10 -',
        check: (reply) => expect(body(reply).total).toBe(19),
      },
      mcp: {
        ids: [],
        audit: [recallRow(0), SKIPPED],
        trace: 'mcp 0 -',
        ledger: 'mcp_recall 0 -',
        check: (reply) =>
          expect(text(reply)).toBe(
            '## Cutoff\nShowing 0 of 19 candidates; 19 not shown (rank, budget or limit).\n\n---\n\nNo relevant memories found.',
          ),
      },
    },
    'LIKE path': {
      http: { ids: ['mem_x_cafe'], audit: [SKIPPED, recallRow(1)], trace: 'api 1 -', ledger: 'http_recall 1 -' },
      mcp: { ids: ['mem_x_cafe'], audit: [recallRow(1), SKIPPED], trace: 'mcp 1 -', ledger: 'mcp_recall 0 -' },
    },
  } satisfies Record<string, Record<Surface, Want>>),
);

const NO_WRITES: RecallWrites = { recalled: '0', traces: [], ranked: [], ledger: [], bumped: {}, goalLog: [] };
const SCENARIOS = RECALL_BRANCHES.flatMap((b) =>
  (['http', 'mcp'] as const).map((via) => [`${via}: ${b.name}`, via, b] as const),
);

beforeAll(async () => {
  // savePrediction stamps its memory from the eval clock, so a fixed clock keeps that row's score the same on every run.
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  _resetAblationCacheForTests();
  templates = await seedTemplates(seedPortBranches);
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('recall branch replies and rows', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    __resetSessionRecallHistoryHttp();
    _resetSessionRecallHistoryMcpForTests();
    _resetAblationCacheForTests();
    lastRecalledIds.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  it.each(SCENARIOS)('%s', async (_name, via, branch) => {
    const want = WANT.get(branch.name)![via];
    const got = await runBranch(via, branch);
    if (via === 'http') {
      expect(body(got.reply).results.map((r) => r.id)).toEqual(want.ids);
      if (branch.reaches) expect(branch.reaches(body(got.reply))).toBe(true);
    } else if (want.ids.length > 0) {
      expect(text(got.reply)).toContain(`Found ${want.ids.length} memories:`);
    }
    want.check?.(got.reply);
    expect(got.audit).toEqual(want.audit);
    const counted = via === 'http' ? want.ids.length : 0;
    expect(got.writes).toEqual({
      recalled: String(counted),
      traces: [want.trace],
      ranked: want.ids,
      ledger: [want.ledger],
      bumped: bumpedFor(want.ids),
      goalLog: want.goalLog ?? [],
    });
    expect(got.mirror).toEqual(via === 'http' ? expect.objectContaining({ total_recalled: counted }) : null);
    expect(got.global).toEqual({ writes: NO_WRITES, audit: [] });
  });
});
