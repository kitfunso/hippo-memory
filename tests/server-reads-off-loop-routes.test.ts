// The graph, quarantine and recall routes answer from store workers as they do on the in-process store, and fail when a handler opens hippo.db on the server thread.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { log } from '../src/util/log.js';
import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { __resetSessionRecallHistoryHttp, serve, type ServerHandle } from '../src/server.js';
import type { HippoStore, StoreGroups } from '../src/store/index.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import { startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { EMBEDDING_MODEL, HELD_SCOPE, leftBehind, type MovedReadsSeed, seedMovedReads } from './_helpers/moved-reads-seed.js';
import { CLEARED_ENV, FAKE_NOW, freshStore, SESSION } from './_helpers/recall-golden-seed.js';
import { auditRows, get, holdWriteLock, mirrorFiles, post, seen, undoAll } from './_helpers/store-worker-server.js';

type InProcess = HippoStore & StoreGroups;

interface Run {
  readonly server: ServerHandle;
  readonly seed: MovedReadsSeed;
}

type Send = (run: Run) => Promise<Response>;
type Step = readonly [label: string, send: Send, status: number];

const MISSING = 'mem_000000000000';
const WITH_SESSION = `session_id=${SESSION}`;
const FRESH_TAIL = `q=deploy&fresh_tail_count=1&fresh_tail_session_id=${SESSION}&${WITH_SESSION}`;
const FORWARD_CLAIM = `q=${encodeURIComponent('the deploy will take 3 days')}`;

const graph = (query: string, as: keyof MovedReadsSeed['keys'] = 'main'): Send => (r) => get(r.server, `/v1/graph${query}`, r.seed.keys[as]);
const held = (query: string, as: keyof MovedReadsSeed['keys'] = 'main'): Send => (r) => get(r.server, `/v1/quarantine${query}`, r.seed.keys[as]);
const recall = (query: string, as: keyof MovedReadsSeed['keys'] = 'main'): Send => (r) => get(r.server, `/v1/memories?${query}`, r.seed.keys[as]);
const decide = (verb: 'approve' | 'reject', id: (seed: MovedReadsSeed) => string | undefined, as: keyof MovedReadsSeed['keys'] = 'main'): Send =>
  (r) => post(r.server, `/v1/quarantine/${id(r.seed) ?? MISSING}/${verb}`, {}, r.seed.keys[as]);

const GRAPH_STEPS: readonly Step[] = [
  ['graph', graph(''), 200],
  ['graph from an entity', graph('?entity=RetryPolicy'), 200],
  ['graph from an unknown entity', graph('?entity=NoSuchPolicy'), 200],
  ['graph capped at one row', graph('?limit=1'), 200],
  ['graph with a zero limit', graph('?limit=0'), 400],
  ['graph as a member', graph('', 'member'), 200],
  ['graph as the other tenant', graph('', 'other'), 200],
  ['graph with an unknown key', graph('', 'unknown'), 401],
];

const QUARANTINE_STEPS: readonly Step[] = [
  ['list', held(''), 200],
  ['list one per page', held('?limit=1'), 200],
  ['list an unknown status', held('?status=bogus'), 400],
  ['list as a member', held('', 'member'), 403],
  ['list as the other tenant', held('', 'other'), 200],
  ['list with an unknown key', held('', 'unknown'), 401],
  ['approve', decide('approve', (seed) => seed.held[0]), 200],
  ['approve it again', decide('approve', (seed) => seed.held[0]), 409],
  ['approve a missing record', decide('approve', () => MISSING), 404],
  ["approve the other tenant's record", decide('approve', (seed) => seed.otherHeld), 404],
  ['approve as a member', decide('approve', (seed) => seed.held[2], 'member'), 403],
  ['approve with an unknown key', decide('approve', (seed) => seed.held[2], 'unknown'), 401],
  ['reject', decide('reject', (seed) => seed.held[1]), 200],
  ['reject it again', decide('reject', (seed) => seed.held[1]), 409],
  ['reject the approved record', decide('reject', (seed) => seed.held[0]), 409],
  ['reject a missing record', decide('reject', () => MISSING), 404],
  ['reject as a member', decide('reject', (seed) => seed.held[2], 'member'), 403],
  ['list every status', held('?status=all'), 200],
  ['list the approved', held('?status=approved'), 200],
];

const RECALL_STEPS: readonly Step[] = [
  ['recall', recall('q=deploy'), 200],
  ['recall in a session with a goal', recall(`q=deploy&${WITH_SESSION}`), 200],
  ['recall with continuity', recall('q=deploy&include_continuity=true'), 200],
  ['recall with a fresh tail', recall(FRESH_TAIL), 200],
  ['recall a forward claim', recall(FORWARD_CLAIM), 200],
  ['recall with overflow summaries', recall('q=deploy&limit=2&summarize_overflow=true'), 200],
  ['recall the approved memory in its scope', recall(`q=wipe&scope=${encodeURIComponent(HELD_SCOPE)}`), 200],
  ['recall with a zero limit', recall('q=deploy&limit=0'), 400],
  ['recall as the other tenant', recall('q=deploy', 'other'), 200],
  ['recall with an unknown key', recall('q=deploy', 'unknown'), 401],
];

const STEPS = [...GRAPH_STEPS, ...QUARANTINE_STEPS, ...RECALL_STEPS];

let seed: MovedReadsSeed;
let embeddings: HashedEmbeddings;
const homes: string[] = [];

function copy(): string {
  const made = freshStore(seed.templates, 'local');
  homes.push(made.home);
  return made.root;
}

/** Recall keeps per-session rings and caches in the server's process, which both passes share. */
function resetRecallState(): void {
  __resetSessionRecallHistoryHttp();
  __resetSessionRecallHistoryMcp();
  _resetAblationCacheForTests();
  lastRecalledIds.clear();
}

/** `use` against a server on `root`, on the worker-backed store when `store` is absent; the server has stopped when it resolves, so every row it writes is in. */
async function onServer<T>(root: string, store: HippoStore | undefined, use: (server: ServerHandle) => Promise<T>): Promise<T> {
  resetRecallState();
  const server = await serve(store ? { hippoRoot: root, port: 0, store } : { hippoRoot: root, port: 0 });
  try {
    return await use(server);
  } finally {
    await server.stop();
    await store?.close();
  }
}

const left = (root: string) => ({ audit: auditRows(root, seed.keyIds), stored: leftBehind(root), mirrors: mirrorFiles(root) });

async function runSteps(steps: readonly Step[], inProcess: boolean) {
  const root = copy();
  const replies = await onServer(root, inProcess ? sqliteStore(root) : undefined, async (server) => {
    const seenSoFar = [];
    for (const [label, send] of steps) seenSoFar.push(await seen(label, await send({ server, seed }), seed.keyIds));
    return seenSoFar;
  });
  return { replies, ...left(root) };
}

// Seeding the template stores row by row runs past the 30 s hook default on a slow runner.
beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
  seed = seedMovedReads();
}, 120_000);

afterAll(async () => {
  await embeddings.close();
  for (const dir of [seed.templates.dir, ...homes]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  for (const name of CLEARED_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_V1_RPS', '0');
});

afterEach(async () => {
  await undoAll();
  _resetAblationCacheForTests();
});

describe('the worker-backed graph, quarantine and recall routes against the in-process store', () => {
  it('gives every moved route the same status, headers, body, audit rows, stored rows and mirror files', async () => {
    const inProcess = await runSteps(STEPS, true);
    const onWorkers = await runSteps(STEPS, false);

    expect(onWorkers.replies).toEqual(inProcess.replies);
    expect(onWorkers.audit).toEqual(inProcess.audit);
    expect(onWorkers.stored).toEqual(inProcess.stored);
    expect(onWorkers.mirrors).toEqual(inProcess.mirrors);
    expect(onWorkers.replies.map((reply) => [reply.label, reply.status])).toEqual(STEPS.map(([label, , status]) => [label, status]));
    const bodyOf = Object.fromEntries(onWorkers.replies.map((reply) => [reply.label, reply.body]));
    expect(bodyOf['graph from an entity']).toContain('RetryPolicy');
    expect(bodyOf['graph as the other tenant']).toContain('AcmePolicy');
    expect(bodyOf['list the approved']).toContain('before every commit');
    expect(bodyOf['recall the approved memory in its scope']).toContain('before every commit');
    expect(bodyOf['recall with overflow summaries']).toContain('"isSummary":true');
    expect(onWorkers.stored.filter((row) => row.startsWith('traces '))).toHaveLength(8);
  }, 120_000);

  it('answers a read behind a held write lock with its 200, and a decision and a recall with the same 503 and Retry-After', async () => {
    const busy: readonly Step[] = [
      ['graph', graph(''), 200],
      ['list', held(''), 200],
      ['approve', decide('approve', (made) => made.held[0]), 503],
      ['reject', decide('reject', (made) => made.held[1]), 503],
      ['recall', recall('q=deploy'), 503],
    ];
    const behindLock = async (inProcess: boolean) => {
      const root = copy();
      const before = left(root);
      const replies = await onServer(root, inProcess ? sqliteStore(root) : undefined, async (server) => {
        const lock = holdWriteLock(root);
        const seenSoFar = [];
        for (const [label, send] of busy) seenSoFar.push(await seen(label, await send({ server, seed }), seed.keyIds));
        lock.release();
        return seenSoFar;
      });
      expect(left(root)).toEqual(before);
      return replies;
    };

    const inProcess = await behindLock(true);
    const onWorkers = await behindLock(false);

    expect(onWorkers).toEqual(inProcess);
    expect(onWorkers.map((reply) => [reply.label, reply.status])).toEqual(busy.map(([label, , status]) => [label, status]));
    expect(onWorkers[2]?.headers).toContainEqual(['retry-after', '1']);
  }, 120_000);
});

describe("the server-thread block of a `loop: 'off'` route this file covers", () => {
  // The last column is false where the route has written before it reaches the swapped method.
  const ROUTES: ReadonlyArray<readonly [route: string, swapped: (inProcess: InProcess) => Partial<InProcess>, send: Send, writesNothing: boolean]> = [
    ['GET /v1/graph', (p) => ({ graphReads: p.graphReads }), graph(''), true],
    ['GET /v1/quarantine', (p) => ({ quarantine: p.quarantine }), held(''), true],
    ['POST /v1/quarantine/:id/approve', (p) => ({ quarantine: p.quarantine }), decide('approve', (made) => made.held[0]), true],
    ['POST /v1/quarantine/:id/reject', (p) => ({ quarantine: p.quarantine }), decide('reject', (made) => made.held[1]), true],
    ['GET /v1/memories, by its candidate read', (p) => ({ searchRecallEntries: p.searchRecallEntries }), recall('q=deploy'), true],
    ['GET /v1/memories, by its goal read', (p) => ({ activeGoals: p.activeGoals }), recall(`q=deploy&${WITH_SESSION}`), true],
    ['GET /v1/memories, by its fresh tail', (p) => ({ freshRawEntries: p.freshRawEntries }), recall(FRESH_TAIL), true],
    ['GET /v1/memories, by its continuity block', (p) => ({ continuity: p.continuity }), recall('q=deploy&include_continuity=true'), true],
    ['GET /v1/memories, by its forward-claim evidence', (p) => ({ planningFallacyEvidence: p.planningFallacyEvidence }), recall(FORWARD_CLAIM), true],
    ['GET /v1/memories, by its overflow summaries', (p) => ({ entriesByIds: p.entriesByIds }), recall('q=deploy&limit=2&summarize_overflow=true'), true],
    ['GET /v1/memories, by its closing write', (p) => ({ finishRecall: p.finishRecall }), recall('q=deploy'), true],
    ['GET /v1/memories, by its recall counter', (p) => ({ bumpRecallStats: p.bumpRecallStats }), recall('q=deploy'), false],
    ['GET /v1/memories, by its vector reads', (p) => ({ vectors: p.vectors }), recall('q=deploy&mode=hybrid'), true],
    ['GET /v1/memories, by its vector views', (p) => ({ vectorViews: p.vectorViews }), recall('q=deploy&mode=hybrid'), true],
  ];

  it.each(ROUTES)('%s fails when its handler opens hippo.db on the server thread', async (_route, swapped, send, writesNothing) => {
    const root = copy();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: EMBEDDING_MODEL, apiBaseUrl: embeddings.url } }));
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    const before = left(root);
    const info = vi.spyOn(log, 'info');
    // The worker-backed store with one group or method swapped back to the in-process one: the defect the block exists to catch.
    const store = Object.assign(workerSqliteStore(root), swapped(sqliteStore(root)));

    const res = await onServer(root, store, (server) => send({ server, seed }));

    expect(res.status).toBe(501);
    expect(info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('opened on the server thread by a route'))).toHaveLength(1);
    if (writesNothing) expect(left(root)).toEqual(before);
  });
});
