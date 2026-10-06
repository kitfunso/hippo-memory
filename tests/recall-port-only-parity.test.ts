// Every recall the surface goldens pin, plus the branches they skip, run over serve() once on hippo.db and once on a
// store that answers only through the port; the replies and the rows written must match.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, __resetSessionRecallHistoryHttp, type HippoStore } from '../src/server.js';
import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import type { RecallResult } from '../src/api.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, normalise, RECALL_BRANCHES, RECALL_INPUTS, rowsOf, SESSION, seedPortBranches, seedTemplates, type Templates,
} from './_helpers/recall-golden-seed.js';
import { portOnlyStore } from './_helpers/port-only-store.js';

type Args = Record<string, string | number | boolean>;
type Call = { via: 'http'; args: Args } | { via: 'mcp'; args: Args };
type Surface = Call['via'];
interface Reply { status: number; body: unknown }
interface Scenario { name: string; kind: 'local' | 'wide'; calls: readonly Call[]; reaches?: (replies: readonly Reply[]) => void }

const on =(via: Surface, query: string, args: Args = {}): Call => ({ via, args: { query, ...args } });
const SURFACES: readonly Surface[] = ['http', 'mcp'];

const SCENARIOS: readonly Scenario[] = [
  ...SURFACES.flatMap((via): Scenario[] => [
    { name: `${via}: plain recall, no session`, kind: 'local', calls: [on(via, 'deploy')] },
    { name: `${via}: recall with a session that has an active goal`, kind: 'local', calls: [on(via, 'deploy', { session_id: SESSION })] },
    {
      name: `${via}: anchoring hints over repeated recalls in one session`,
      kind: 'local',
      calls: ['deploy', 'deploy', 'deploy target', 'deploy rollout'].map((q) => on(via, q, { session_id: SESSION })),
    },
  ]),
  { name: 'candidate window', kind: 'wide', calls: [on('http', 'deploy'), on('http', 'deploy', { scorer_window: '50' }), on('mcp', 'deploy')] },
  { name: 'mcp budget 80', kind: 'local', calls: [on('mcp', 'deploy', { budget: 80 })] },
  { name: 'http bm25, hybrid and physics modes', kind: 'local', calls: ['bm25', 'hybrid', 'physics'].map((mode) => on('http', 'deploy', { mode })) },
  {
    name: 'bad and edge inputs',
    kind: 'local',
    calls: RECALL_INPUTS.flatMap(([, args]) => SURFACES.map((via): Call => ({ via, args }))),
  },
  ...RECALL_BRANCHES.flatMap((b) => SURFACES.map((via): Scenario => ({
    name: `${via}: ${b.name}`,
    kind: 'local',
    calls: [on(via, b.query, b[via])],
    // MCP replies with text, so only the HTTP body proves the branch ran.
    reaches: via === 'http' && b.reaches
      ? (replies) => {
        expect(replies[0]!.status).toBe(200);
        // SAFETY: a 200 from GET /v1/memories is a serialised RecallResult.
        expect(b.reaches!(replies[0]!.body as RecallResult)).toBe(true);
      }
      : undefined,
  }))),
];

async function send(url: string, call: Call): Promise<Reply> {
  if (call.via === 'http') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(call.args)) params.set(k === 'query' ? 'q' : k, String(v));
    const res = await fetch(`${url}/v1/memories?${params.toString()}`);
    return { status: res.status, body: await res.json() };
  }
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: call.args } };
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
  return { status: res.status, body: await res.json() };
}

interface Pass { replies: Reply[]; rows: { local: ReturnType<typeof rowsOf>; global: ReturnType<typeof rowsOf> } }

let templates: Templates;

/** One scenario on a fresh store copy, with every module-level ring and cache cleared first. */
async function runPass(scenario: Scenario, makeStore?: (root: string) => HippoStore): Promise<Pass> {
  __resetSessionRecallHistoryHttp();
  __resetSessionRecallHistoryMcp();
  _resetAblationCacheForTests();
  lastRecalledIds.clear();
  const s = freshStore(templates, scenario.kind);
  try {
    const store = makeStore?.(s.root);
    const handle = await serve({ hippoRoot: s.root, port: 0, store });
    const replies: Reply[] = [];
    try {
      for (const call of scenario.calls) replies.push(await send(handle.url, call));
    } finally {
      await handle.stop();
      await store?.close();
    }
    return normalise({ replies, rows: { local: rowsOf(s.root), global: rowsOf(s.globalRoot) } }, s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

beforeAll(() => {
  templates = seedTemplates(seedPortBranches);
});

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('recall over the port matches recall on hippo.db', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const onHippoDb = await runPass(scenario);
    scenario.reaches?.(onHippoDb.replies);
    const onPort = await runPass(scenario, portOnlyStore);
    expect(onPort.replies).toEqual(onHippoDb.replies);
    expect(onPort.rows).toEqual(onHippoDb.rows);
  }, 120_000);
});
