// The recall branches the surface golden skips, over serve() on hippo.db: each reply, every row written and the stats
// mirror. The snapshot came from the code before recall moved behind the store port, so any drift here is a regression.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { serve, __resetSessionRecallHistoryHttp } from '../src/server.js';
import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import type { RecallResult } from '../src/api.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, normalise, RECALL_BRANCHES, rowsOf, seedPortBranches, seedTemplates, statsMirror, type Templates,
} from './_helpers/recall-golden-seed.js';

type Surface = 'http' | 'mcp';
type Args = Record<string, string | number | boolean>;
interface HttpReply { status: number; body: RecallResult }
interface McpReply { status: number; text: string | null; error: unknown }

const SURFACES: readonly Surface[] = ['http', 'mcp'];
const SCENARIOS = RECALL_BRANCHES.flatMap((b) => SURFACES.map((via) => [`${via}: ${b.name}`, via, b] as const));

let templates: Templates;

async function recallOver(url: string, via: Surface, args: Args): Promise<HttpReply | McpReply> {
  if (via === 'http') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) params.set(k === 'query' ? 'q' : k, String(v));
    const res = await fetch(`${url}/v1/memories?${params.toString()}`);
    // SAFETY: every branch call is valid, so /v1/memories answers with a serialised RecallResult.
    return { status: res.status, body: (await res.json()) as RecallResult };
  }
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: args } };
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
  // SAFETY: /mcp answers tools/call with a JSON-RPC reply whose result is { content: [{ text }] }, or with an error.
  const reply = (await res.json()) as { result?: { content?: { text: string }[] }; error?: unknown };
  return { status: res.status, text: reply.result?.content?.[0]?.text ?? null, error: reply.error ?? null };
}

/** savePrediction draws its memory's id at random, so the snapshot names that one id by its role. */
function withPredictionId<T>(value: T, root: string): T {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT projects exactly one column, memory_id, and the seed saves one prediction.
    const { memory_id } = db.prepare('SELECT memory_id FROM predictions').get() as { memory_id: string };
    // SAFETY: only one id string is rewritten, so the JSON parses back to the same shape.
    return JSON.parse(JSON.stringify(value).split(memory_id).join('<prediction-memory>')) as T;
  } finally {
    closeHippoDb(db);
  }
}

beforeAll(() => {
  // savePrediction stamps its memory from the eval clock, so a fixed clock keeps that row's score the same on every run.
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  _resetAblationCacheForTests();
  templates = seedTemplates(seedPortBranches);
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('recall branch replies and rows match the code before the store port', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    __resetSessionRecallHistoryHttp();
    __resetSessionRecallHistoryMcp();
    _resetAblationCacheForTests();
    lastRecalledIds.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  it.each(SCENARIOS)('%s', async (_name, via, branch) => {
    const s = freshStore(templates, 'local');
    try {
      const handle = await serve({ hippoRoot: s.root, port: 0 });
      let reply: HttpReply | McpReply;
      try {
        reply = await recallOver(handle.url, via, { query: branch.query, ...branch[via] });
      } finally {
        await handle.stop();
      }
      // MCP replies with text, so only the HTTP body proves the branch ran.
      if ('body' in reply && branch.reaches) expect(branch.reaches(reply.body)).toBe(true);
      const got = { reply, local: rowsOf(s.root), global: rowsOf(s.globalRoot), statsMirror: statsMirror(s.root) };
      expect(withPredictionId(normalise(got, s), s.root)).toMatchSnapshot();
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  }, 60_000);
});
