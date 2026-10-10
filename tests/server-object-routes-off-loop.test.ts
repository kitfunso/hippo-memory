// The typed-object routes answer from store workers as they do on the in-process store, and fail when a handler opens hippo.db on the server thread.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer } from '../src/core/memory.js';
import { mintApiKey } from '../src/store/auth.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { insertRejectedValue, rejectionDigest } from '../src/store/rejection.js';
import type { ServerHandle } from '../src/server.js';
import type { HippoStore } from '../src/store/index.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import type { JsonValue } from '../src/util/json.js';
import { log } from '../src/util/log.js';
import { V1_ROWS } from './_helpers/v1-route-rows.js';
import { entryMirrorFiles } from './_helpers/entry-mirror-files.js';
import { loadExtractionQueue } from './_helpers/graph-queue.js';
import { auditRows, get, holdWriteLock, keyFor, mirrorFiles, newRoot, onDb, patientStore, postText, scrub, seen, start, undoAll } from './_helpers/store-worker-server.js';

afterEach(undoAll);

const REFUSED = 'the decision a person rejected';
const BLOCKED_LINE = 'opened on the server thread by a route';

/** A row of the objects group left on the server thread on purpose, by its label; each needs its reason beside it. */
const ON_LOOP: readonly string[] = [];

interface ObjectRoute {
  /** `METHOD /v1/<kind>[/:id[/verb]]`, a regex row read as its pattern would be. */
  readonly label: string;
  readonly offLoop: boolean;
}

/** Every V1_ROUTES row that names the objects group, in table order, read from the live table. */
function objectRoutes(): ObjectRoute[] {
  return V1_ROWS
    .filter(({ route }) => route.storeReady === 'objects')
    .map(({ key, route }) => ({ label: key, offLoop: route.loop === 'off' }));
}

interface Sent {
  /** `$receipt` stands for a seeded memory id. */
  readonly body?: JsonValue;
  /** `$cursor` stands for the cursor the last page named. */
  readonly query?: string;
  readonly status: number;
}

const AS_OF = '?date=2099-01-01T00:00:00.000Z';

/** One request per object route that its handler answers in full, in an order where each finds the row the one before it left. */
const SENDS = new Map(Object.entries<Sent>({
  'POST /v1/decisions': { body: { text: 'ship behind a flag', context: 'the last release broke login' }, status: 201 },
  'GET /v1/decisions': { status: 200 },
  'POST /v1/decisions/:id/supersede': { body: { text: 'ship behind a flag, to 5% first' }, status: 201 },
  'POST /v1/decisions/:id/close': { status: 200 },
  'GET /v1/decisions/:id': { status: 200 },
  'POST /v1/incidents': { body: { text: 'login answered 500 for ten minutes', context: 'after the flag flip' }, status: 201 },
  'GET /v1/incidents': { query: '?status=open', status: 200 },
  'POST /v1/incidents/:id/resolve': { body: { resolutionText: 'rolled the flag back' }, status: 200 },
  'POST /v1/incidents/:id/close': { status: 200 },
  'GET /v1/incidents/:id': { status: 200 },
  'POST /v1/processes': { body: { processName: 'release', steps: ['tag', 'build', 'publish'], description: 'the weekly release' }, status: 201 },
  'GET /v1/processes': { status: 200 },
  'POST /v1/processes/:id/supersede': { body: { steps: ['tag', 'build', 'smoke', 'publish'], changeSummary: 'adds the smoke step' }, status: 200 },
  'POST /v1/processes/:id/close': { status: 200 },
  'GET /v1/processes/:id': { status: 200 },
  'POST /v1/policies': { body: { policyName: 'RollbackPolicy', policyText: 'roll back within ten minutes', validFrom: '2026-01-01' }, status: 201 },
  'GET /v1/policies': { status: 200 },
  'GET /v1/policies/asof': { query: `${AS_OF}&name=RollbackPolicy`, status: 200 },
  'POST /v1/policies/:id/supersede': { body: { policyText: 'roll back within five minutes', changeSummary: 'halves the window' }, status: 200 },
  'POST /v1/policies/:id/close': { status: 200 },
  'GET /v1/policies/:id': { status: 200 },
  'POST /v1/skills': { body: { skillName: 'rollback', instructions: 'page the owner, then revert the flag', trigger: 'a failed canary' }, status: 201 },
  'GET /v1/skills': { status: 200 },
  'GET /v1/skills/export': { status: 200 },
  'POST /v1/skills/:id/supersede': { body: { instructions: 'revert the flag, then page the owner' }, status: 200 },
  'POST /v1/skills/:id/close': { status: 200 },
  'GET /v1/skills/:id': { status: 200 },
  'POST /v1/project-briefs': { body: { repo: 'hippo', summary: 'agent memory, served over HTTP' }, status: 201 },
  'GET /v1/project-briefs': { query: '?repo=hippo', status: 200 },
  'POST /v1/project-briefs/refresh': { body: { repo: 'hippo' }, status: 200 },
  'POST /v1/project-briefs/:id/supersede': { body: { summary: 'agent memory, served from store workers', changeSummary: 'names the workers' }, status: 200 },
  'POST /v1/project-briefs/:id/close': { status: 200 },
  'GET /v1/project-briefs/:id': { status: 200 },
  'POST /v1/customer-notes': { body: { customer: 'acme', note: 'renews in March' }, status: 201 },
  'GET /v1/customer-notes': { query: '?customer=acme', status: 200 },
  'POST /v1/customer-notes/:id/supersede': { body: { note: 'renews in April', changeSummary: 'the date moved' }, status: 200 },
  'POST /v1/customer-notes/:id/close': { status: 200 },
  'GET /v1/customer-notes/:id': { status: 200 },
}));

interface Callers {
  readonly main: string;
  readonly other: string;
  /** Well formed, and in no store. */
  readonly unknown: string;
}

type Step = readonly [label: string, route: string, sent: Sent, as?: keyof Callers];

/** What the store refuses and what it throws, after the route steps have left one closed object of each kind. */
const EDGE_STEPS: readonly Step[] = [
  ['close the closed decision', 'POST /v1/decisions/:id/close', { status: 409 }],
  ['supersede the closed decision', 'POST /v1/decisions/:id/supersede', { body: { text: 'never saved' }, status: 409 }],
  ['supersede a missing decision', 'POST /v1/decisions/999/supersede', { body: { text: 'never saved' }, status: 404 }],
  ['create a decision over a missing one', 'POST /v1/decisions', { body: { text: 'never saved', supersedesDecisionId: 999 }, status: 409 }],
  ['create a decision a person rejected', 'POST /v1/decisions', { body: { text: REFUSED }, status: 400 }],
  ['list decisions one per page', 'GET /v1/decisions', { query: '?limit=1', status: 200 }],
  ['list the page after', 'GET /v1/decisions', { query: '?limit=1&cursor=$cursor', status: 200 }],
  ['open an incident on an unknown memory', 'POST /v1/incidents', { body: { text: 'never saved', linkedMemoryIds: ['mem_000000000000'] }, status: 409 }],
  ['open an incident on a memory', 'POST /v1/incidents', { body: { text: 'the canary failed', linkedMemoryIds: ['$receipt'] }, status: 201 }],
  ['resolve it', 'POST /v1/incidents/:id/resolve', { body: { resolutionText: 'restarted the canary' }, status: 200 }],
  ['resolve it again', 'POST /v1/incidents/:id/resolve', { body: { resolutionText: 'never saved' }, status: 409 }],
  ['list an unknown status', 'GET /v1/processes', { query: '?status=bogus', status: 400 }],
  ['supersede a missing policy', 'POST /v1/policies/999/supersede', { body: { policyText: 'never saved' }, status: 404 }],
  ['policies as of a date before any', 'GET /v1/policies/asof', { query: '?date=1999-01-01', status: 200 }],
  ['policies as of no date', 'GET /v1/policies/asof', { status: 400 }],
  ['get a missing skill', 'GET /v1/skills/999', { status: 404 }],
  ['read the receipts of a brief', 'POST /v1/project-briefs/refresh', { body: { repo: 'hippo', dryRun: true }, status: 200 }],
  ['refresh a repo with no brief', 'POST /v1/project-briefs/refresh', { body: { repo: 'elsewhere' }, status: 200 }],
  ["get the other tenant's note", 'GET /v1/customer-notes/:id', { status: 404 }, 'other'],
  ["close the other tenant's note", 'POST /v1/customer-notes/:id/close', { status: 404 }, 'other'],
  ['list notes as the other tenant', 'GET /v1/customer-notes', { status: 200 }, 'other'],
  ['list skills with an unknown key', 'GET /v1/skills', { status: 401 }, 'unknown'],
  ['create a skill with an unknown key', 'POST /v1/skills', { body: { skillName: 'refused', instructions: 'never saved' }, status: 401 }, 'unknown'],
];

interface Run {
  readonly server: ServerHandle;
  readonly keys: Callers;
  readonly receipts: readonly string[];
  /** `/v1/<kind>` to the id the last write of that kind answered with, which fills `:id`. */
  readonly newest: Map<string, string>;
  cursor?: string;
}

function seedStore(root: string) {
  const main = keyFor(root, 'default');
  const other = keyFor(root, 'acme');
  const receipts = ['the deploy took nine minutes', 'the canary passed on the second run'].map((content) => {
    const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic, confidence: 'observed', tags: ['path:hippo'], tenantId: 'default' });
    writeEntry(root, entry);
    return entry.id;
  });
  onDb(root, (db) => insertRejectedValue(db, {
    tenantId: 'default', digest: rejectionDigest(REFUSED), reason: 'wrong', rejectedBy: 'test', rejectedAt: new Date().toISOString(), normalizedChars: REFUSED.length,
  }));
  return { keys: { main: main.plaintext, other: other.plaintext, unknown: mintApiKey().plaintext }, keyIds: [main.keyId, other.keyId], receipts };
}

async function send(run: Run, [, route, sent, as = 'main']: Step): Promise<Response> {
  const [method = '', path = ''] = route.split(' ');
  const kind = path.split('/').slice(0, 3).join('/');
  const url = `${path.replace(':id', run.newest.get(kind) ?? '0')}${sent.query ?? ''}`.replace('$cursor', encodeURIComponent(run.cursor ?? ''));
  const body = JSON.stringify(sent.body ?? {}).replace('$receipt', run.receipts[0] ?? '');
  const res = await (method === 'GET' ? get(run.server, url, run.keys[as]) : postText(run.server, url, body, run.keys[as]));
  const text = await res.clone().text();
  const id = /"id":(\d+)/.exec(text)?.[1];
  if (method === 'POST' && res.ok && id !== undefined) run.newest.set(kind, id);
  run.cursor = /"next_cursor":"([^"]+)"/.exec(text)?.[1] ?? run.cursor;
  return res;
}

const routeSteps = (routes: readonly ObjectRoute[]): Step[] => routes.map(({ label }) => [label, label, SENDS.get(label) ?? { status: 0 }]);

const TABLES = ['decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'] as const;

const STORED = {
  ...Object.fromEntries(TABLES.map((table) => [table, `SELECT * FROM ${table} ORDER BY id`])),
  memories: `SELECT tenant_id, kind, layer, content, tags_json, source, confidence, scope, origin_project, superseded_by IS NOT NULL AS superseded
    FROM memories ORDER BY rowid`,
  graphQueue: 'SELECT tenant_id, kind, status FROM graph_extraction_queue ORDER BY id',
};

function storedRows(root: string): string[] {
  return onDb(root, (db) => Object.entries(STORED).flatMap(([table, sql]) => db.prepare(sql).all().map((row) => `${table} ${scrub(JSON.stringify(row))}`)));
}

/** `steps` against a fresh store, on the worker-backed store when `inProcess` is false, plus what they left behind. */
async function runSteps(steps: readonly Step[], inProcess: boolean) {
  const root = newRoot('object-routes');
  const { keyIds, ...seeded } = seedStore(root);
  const run: Run = { server: await start(root, inProcess ? sqliteStore(root) : undefined), ...seeded, newest: new Map() };
  const replies = [];
  for (const step of steps) replies.push(await seen(step[0], await send(run, step), keyIds));
  return { replies, audit: auditRows(root, keyIds), stored: storedRows(root), mirrors: mirrorFiles(root) };
}

const statuses = (steps: readonly Step[]): Array<[string, number]> => steps.map(([label, , sent]) => [label, sent.status]);

/** tenant, actor and op of every audit row an object write left. */
function objectAudit(rows: readonly string[]): string[] {
  const named = rows.map((row) => /^\{"tenant_id":"([^"]+)","actor":"([^"]+)","op":"([^"]+)"/.exec(row)?.slice(1).join(' ') ?? row);
  return named.filter((row) => /(decision|incident|process|policy|skill|project_brief|customer_note)_|reject_refusal/.test(row));
}

const WRITER = 'default api_key:<key 0>';

/** A save over an older version audits the older row first, so a supersede step leaves a supersede row and then a create row. */
const versioned = (kind: string): string[] => [`${kind}_create`, `${kind}_supersede`, `${kind}_create`, `${kind}_close`];

/** What the route steps and then the edge steps leave in the audit log, in order. */
const AUDIT = [
  ...versioned('decision'), 'incident_open', 'incident_resolve', 'incident_close', ...versioned('process'), ...versioned('policy'), ...versioned('skill'),
  'project_brief_create', 'project_brief_supersede', ...versioned('project_brief'), ...versioned('customer_note'),
  'reject_refusal', 'incident_open', 'incident_resolve', 'project_brief_create',
].map((op) => `${WRITER} ${op}`);

describe('the worker-backed typed-object routes against the in-process store', () => {
  it('gives every route, refusal and thrown error the same status, headers, body, audit rows, stored rows and mirror files', async () => {
    const steps = [...routeSteps(objectRoutes()), ...EDGE_STEPS];
    const inProcess = await runSteps(steps, true);
    const onWorkers = await runSteps(steps, false);

    expect(onWorkers.replies).toEqual(inProcess.replies);
    expect(onWorkers.audit).toEqual(inProcess.audit);
    expect(onWorkers.stored).toEqual(inProcess.stored);
    expect(onWorkers.mirrors).toEqual(inProcess.mirrors);
    expect(onWorkers.replies.map((reply) => [reply.label, reply.status])).toEqual(statuses(steps));
    expect(objectAudit(onWorkers.audit)).toEqual(AUDIT);
    const bodyOf = Object.fromEntries(onWorkers.replies.map((reply) => [reply.label, reply.body]));
    const created = Object.entries(bodyOf).filter(([label]) => /^POST \/v1\/[a-z-]+$/.test(label)).map(([, body]) => /^\{"(\w+)":\{"id":1,"memoryId":"<memory>"/.exec(body)?.[1]);
    expect(created).toEqual(['decision', 'incident', 'process', 'policy', 'skill', 'brief', 'note']);
    expect(bodyOf['GET /v1/policies/asof']).toContain('roll back within ten minutes');
    expect(bodyOf['GET /v1/skills/export']).toContain('page the owner, then revert the flag');
    expect(bodyOf['POST /v1/project-briefs/refresh']).toContain('the canary passed on the second run');
    expect(bodyOf['read the receipts of a brief']).toContain('"receiptCount":2');
    expect(bodyOf['list the page after']).toContain('"decisionText":"ship behind a flag"');
    expect(bodyOf['close the closed decision']).toContain('closed');
    expect(bodyOf['supersede a missing decision']).toContain('999');
    expect(bodyOf['open an incident on an unknown memory']).toContain('linked memory <memory> not found for tenant default');
    expect(onWorkers.mirrors.length).toBeGreaterThan(10);
  }, 120_000);

  it('answers an object write behind a held write lock with the same 503 and Retry-After, and an object read with its 200', async () => {
    const busy: readonly Step[] = [
      ['create', 'POST /v1/decisions', { body: { text: 'never saved' }, status: 503 }],
      ['close', 'POST /v1/decisions/:id/close', { status: 503 }],
      ['open', 'POST /v1/incidents', { body: { text: 'never saved' }, status: 503 }],
      ['list', 'GET /v1/decisions', { status: 200 }],
      ['get', 'GET /v1/decisions/:id', { status: 200 }],
    ];
    const behindLock = async (store: (root: string) => HippoStore | undefined) => {
      const root = newRoot('object-routes');
      const { keyIds, ...seeded } = seedStore(root);
      const run: Run = { server: await start(root, store(root)), ...seeded, newest: new Map() };
      expect((await send(run, ['warm', 'POST /v1/decisions', { body: { text: 'saved before the lock' }, status: 201 }])).status).toBe(201);
      const before = storedRows(root);
      const lock = holdWriteLock(root);
      const replies = [];
      for (const step of busy) replies.push(await seen(step[0], await send(run, step), keyIds));
      lock.release();
      expect(storedRows(root)).toEqual(before);
      return replies;
    };

    const inProcess = await behindLock(sqliteStore);
    const onWorkers = await behindLock(() => undefined);

    expect(onWorkers).toEqual(inProcess);
    expect(onWorkers.map((reply) => [reply.label, reply.status])).toEqual(statuses(busy));
    expect(onWorkers[0]?.headers).toContainEqual(['retry-after', '1']);
  }, 120_000);
});

describe('the server-thread block of the object routes', () => {
  const blockedLines = (info: { readonly mock: { readonly calls: ReadonlyArray<readonly unknown[]> } }): string[] =>
    info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(BLOCKED_LINE));

  it("marks every row of the objects group `loop: 'off'`, and this file sends a request to each", () => {
    const routes = objectRoutes();

    expect(routes.filter((route) => !route.offLoop).map((route) => route.label)).toEqual(ON_LOOP);
    expect(routes.map((route) => route.label).sort()).toEqual([...SENDS.keys()].sort());
  });

  it('answers every one of them from the workers with no open of hippo.db on the server thread', async () => {
    const info = vi.spyOn(log, 'info');
    const steps = routeSteps(objectRoutes().filter((route) => route.offLoop));

    const { replies } = await runSteps(steps, false);

    expect(replies.map((reply) => [reply.label, reply.status])).toEqual(statuses(steps));
    expect(blockedLines(info)).toEqual([]);
  }, 120_000);

  it('fails every one of them when its handler opens hippo.db on the server thread', async () => {
    const root = newRoot('object-routes');
    const { keyIds, ...seeded } = seedStore(root);
    const before = [auditRows(root, keyIds), storedRows(root), mirrorFiles(root)];
    const info = vi.spyOn(log, 'info');
    const steps = routeSteps(objectRoutes().filter((route) => route.offLoop));
    // The worker-backed store with the objects group swapped back to the in-process one: the defect the block exists to catch.
    const store = Object.assign(workerSqliteStore(root), { objects: sqliteStore(root).objects });
    const run: Run = { server: await start(root, store), ...seeded, newest: new Map() };

    const answered: Array<[string, number]> = [];
    for (const step of steps) answered.push([step[0], (await send(run, step)).status]);

    expect(answered).toEqual(steps.map(([label]) => [label, 501]));
    expect(blockedLines(info)).toHaveLength(steps.length);
    expect([auditRows(root, keyIds), storedRows(root), mirrorFiles(root)]).toEqual(before);
  }, 120_000);
});

describe('an object write waiting for the write lock', () => {
  it('leaves every object read answering from a reader thread, then lands from the writer thread', async () => {
    const root = newRoot('object-routes');
    const seeded = seedStore(root);
    const { store, ops, sent } = patientStore(root);
    const run: Run = { ...seeded, server: await start(root, store), newest: new Map() };
    const routes = routeSteps(objectRoutes());
    for (const step of routes.filter(([label]) => /^POST \/v1\/[a-z-]+$/.test(label))) expect((await send(run, step)).status).toBe(201);
    const reads: Step[] = [...routes.filter(([label]) => label.startsWith('GET ')), ['the receipts read', 'POST /v1/project-briefs/refresh', { body: { repo: 'hippo', dryRun: true }, status: 200 }]];
    const saves = ops.filter((op) => op === 'objects.saveObject').length;

    const lock = holdWriteLock(root);
    let landed = false;
    const write = send(run, ['a save behind the lock', 'POST /v1/customer-notes', { body: { customer: 'acme', note: 'behind the lock' }, status: 201 }]).then((res) => {
      landed = true;
      return res;
    });
    await sent('objects.saveObject', saves + 1);
    const answered: Array<[string, number | string]> = [];
    for (const step of reads) {
      // A read sent to the writer thread waits behind the blocked save for as long as the lock is held.
      const first = await Promise.race([send(run, step), delay(5_000, 'late', { ref: false })]);
      answered.push([step[0], first instanceof Response ? first.status : first]);
    }
    const landedUnderLock = landed;
    lock.release();

    expect(answered).toEqual(reads.map(([label]) => [label, 200]));
    expect(landedUnderLock).toBe(false);
    // A reader's connection refuses every write, so a save that lands ran on the writer.
    expect((await write).status).toBe(201);
    expect(storedRows(root).filter((row) => row.includes('behind the lock') && row.startsWith('customer_notes '))).toHaveLength(1);
    expect([...new Set(ops.filter((op) => op.startsWith('objects.')))].sort()).toEqual([
      'objects.activeSkillsByName', 'objects.briefReceipts', 'objects.listObjects', 'objects.objectById', 'objects.openIncident', 'objects.policiesInForce', 'objects.saveObject',
    ]);
  }, 120_000);
});

describe('what an object save does after its commit, on the writer thread', () => {
  it("leaves the mirror memory row, its mirror file and a decision's graph mark", async () => {
    const root = newRoot('object-routes');
    const run: Run = { ...seedStore(root), server: await start(root), newest: new Map() };

    const res = await send(run, ['create', 'POST /v1/decisions', SENDS.get('POST /v1/decisions') ?? { status: 0 }]);
    const memoryId = /"memoryId":"([^"]+)"/.exec(await res.text())?.[1] ?? '';

    expect(res.status).toBe(201);
    expect(onDb(root, (db) => db.prepare('SELECT content, source FROM memories WHERE id = ?').all(memoryId))).toEqual([
      expect.objectContaining({ content: expect.stringContaining('ship behind a flag') }),
    ]);
    expect(entryMirrorFiles(root, memoryId)).toHaveLength(1);
    expect(loadExtractionQueue(root, 'default').map((item) => [item.memoryId, item.status])).toEqual([[memoryId, 'pending']]);
  });
});
