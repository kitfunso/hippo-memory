// Every recall the surface goldens pin, plus the branches they skip, run over serve() once on hippo.db and once on a
// store that answers only through the port; the replies and the rows written must match.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, __resetSessionRecallHistoryHttp, sqliteStore, type HippoStore } from '../src/server.js';
import { markSharedStore } from '../src/core/config.js';
import { _resetSessionRecallHistoryMcpForTests } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import type { RecallResult } from '../src/api/index.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, normalise, RECALL_BRANCHES, RECALL_INPUTS, rowsOf, SESSION, seedPortBranches, sendRecall, seedTemplates, TENANT, type Templates,
} from './_helpers/recall-golden-seed.js';
import { portOnlyStore } from './_helpers/port-only-store.js';

type Args = Record<string, string | number | boolean>;
type Call = { via: 'http'; args: Args } | { via: 'mcp'; args: Args };
type Surface = Call['via'];
interface Reply { status: number; body: unknown }
interface Scenario { name: string; kind: 'local' | 'wide'; calls: readonly Call[]; reaches?: (replies: readonly Reply[]) => void }

const on =(via: Surface, query: string, args: Args = {}): Call => ({ via, args: { query, ...args } });
const SURFACES: readonly Surface[] = ['http', 'mcp'];
const KEYED_TASK = 'ship the eu cluster for the loopback caller';
// The seeded rows sit in a temp folder outside any project, so they are user-global and any project's recall reaches them.
const PROJECT = 'golden';

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
    reaches: branchReached(via, b),
  }))),
];

/** MCP replies with text, so only the HTTP body proves a branch ran, except continuity: REST names no project, so a shared store's block is empty. */
function branchReached(via: Surface, b: (typeof RECALL_BRANCHES)[number]): Scenario['reaches'] {
  if (b.name === 'include_continuity') {
    return via === 'mcp' ? (replies) => expect(JSON.stringify(replies[0]!.body)).toContain(KEYED_TASK) : undefined;
  }
  if (via === 'mcp' || !b.reaches) return undefined;
  return (replies) => {
    expect(replies[0]!.status).toBe(200);
    // SAFETY: a 200 from GET /v1/memories is a serialised RecallResult.
    expect(b.reaches!(replies[0]!.body as RecallResult)).toBe(true);
  };
}

const send = (url: string, call: Call): Promise<Reply> => sendRecall(url, call.via, call.args, PROJECT);

interface Pass { replies: Reply[]; rows: { local: ReturnType<typeof rowsOf>; global: ReturnType<typeof rowsOf> } }

let templates: Templates;

/** One scenario on a fresh store copy, with every module-level ring and cache cleared first. */
async function runPass(scenario: Scenario, makeStore?: (root: string) => HippoStore): Promise<Pass> {
  __resetSessionRecallHistoryHttp();
  _resetSessionRecallHistoryMcpForTests();
  _resetAblationCacheForTests();
  lastRecalledIds.clear();
  const s = freshStore(templates, scenario.kind);
  try {
    // serve() marks a port store's root shared, so the hippo.db pass must be shared too to compare like with like.
    markSharedStore(s.root);
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

// Seeding three stores row by row ran past the 30 s hook default on windows-latest CI.
beforeAll(() => {
  templates = seedTemplates((root) => {
    seedPortBranches(root);
    // A shared store reads only the caller's keyed snapshot, and MCP's loopback caller owns by its subject.
    const key = { owner: 'localhost:cli', project: [PROJECT] };
    saveActiveTaskSnapshot(root, TENANT, { task: KEYED_TASK, summary: 'cutover planned', next_step: 'run the canary', session_id: SESSION }, key);
  });
}, 120_000);

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
    // The default store answers from worker threads; the same store in process must agree with it.
    const inProcess = await runPass(scenario, sqliteStore);
    expect(onHippoDb.replies).toEqual(inProcess.replies);
    expect(onHippoDb.rows).toEqual(inProcess.rows);
  }, 120_000);
});
