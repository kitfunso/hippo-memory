// Sweep: every by-id or by-scope surface of a member read grant, asked as four keys on one real server over HTTP and MCP.
// A new route or tool that takes an id must join the table below or be exempted, so a surface cannot skip the rule.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb, setMeta } from '../../src/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { createApiKey, grantScope } from '../../src/store/sqlite/keys/auth.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import type { CreateMemoryOptions } from '../../src/base/memory/entry.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { makeRoot } from '../_helpers/make-root.js';
import { listMemoryConflicts, readEntry, replaceDetectedConflicts, writeEntry } from '../_helpers/root-forms.js';

const S = 'slack:private:c1';
const QUARANTINE = 'quarantine:private:q1';
const SESSION = 'sess-r';
const MODEL = 'test:sweep';
const VECTOR = [1, 0, 0];
const WHO = ['O', 'M', 'N', 'A'] as const;
type Who = (typeof WHO)[number];

/** What each of the four keys sees on one surface: O owns the row and holds the grant, M holds the grant only, N holds
 * none, A is an admin with none. */
type PerKey<T> = Readonly<Record<Who, T>>;
type Cells = PerKey<string>;
interface Key {
  readonly plaintext: string;
  readonly keyId: string;
}
interface Keys {
  readonly O: Key;
  readonly M: Key;
  readonly N: Key;
  readonly A: Key;
}
interface Pair {
  conflict: number;
  keep: string;
}
interface PairSet {
  O: Pair;
  M: Pair;
  N: Pair;
  A: Pair;
}
/** The fields of a reply the table reads; each route's reply holds only its own. */
interface Body {
  error?: string;
  results?: Array<{ id: string }>;
  entries?: Array<{ entry: { id: string } }>;
  items?: Array<{ id: string }>;
  children?: Array<{ id: string }>;
  ids?: string[];
  edges?: Array<{ relType: string }>;
}
interface Reply {
  readonly status: number;
  readonly json: Body;
}

let store = '';
let globalHome = '';
let handle: ServerHandle;
let keys: Keys;
let counter = 0;
const ids = { r: '', raw: '', summary: '', childS: '', pairList: 0 };
const emptyPairs = (): PairSet => ({
  O: { conflict: 0, keep: '' },
  M: { conflict: 0, keep: '' },
  N: { conflict: 0, keep: '' },
  A: { conflict: 0, keep: '' },
});
const pairs = { weaken: emptyPairs(), forget: emptyPairs(), reject: emptyPairs() };

function mint(label: string, role: 'admin' | 'member', owner: string | undefined, grants: readonly string[]): Key {
  const db = openHippoDb(store);
  try {
    const key = createApiKey(db, { tenantId: 'default', label, role, ownerSubject: owner });
    for (const scope of grants) grantScope(db, key.keyId, scope);
    return key;
  } finally {
    closeHippoDb(db);
  }
}

async function send(who: Who, method: string, path: string, body?: JsonValue): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${keys[who].plaintext}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function http(who: Who, method: string, path: string, body?: JsonValue): Promise<Reply> {
  const res = await send(who, method, path, body);
  const text = await res.text();
  // SAFETY: each caller reads only the fields of its own route's reply, all optional in Body.
  return { status: res.status, json: text.length === 0 ? {} : (JSON.parse(text) as Body) };
}

/** A JSON-RPC reply: a result, or the error a refused call becomes. */
interface RpcBody {
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { message: string };
}

/** A tools/call reply: the tool's own text, or the message of the error a refused or failed call becomes. */
interface ToolReply {
  readonly text: string;
  readonly failed: boolean;
}

async function mcpCall(who: Who, name: string, args: Record<string, JsonValue>): Promise<ToolReply> {
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  const res = await send(who, 'POST', '/mcp', call);
  expect(res.status).toBe(200);
  // SAFETY: /mcp answers a JSON-RPC envelope, whose result and error are the two fields read here.
  const body = (await res.json()) as RpcBody;
  return {
    text: body.result?.content[0]?.text ?? body.error?.message ?? '',
    failed: body.error !== undefined || body.result?.isError === true,
  };
}

const mcp = async (who: Who, name: string, args: Record<string, JsonValue>): Promise<string> =>
  (await mcpCall(who, name, args)).text;

/** A refusal as the status it stands for, so an HTTP cell and an MCP cell read alike. */
function refusal(status: number, message: string): string | null {
  if (status === 403 || /requires admin role|written by someone else|records no writer/.test(message)) return '403';
  if (status === 404 || /not found|No drillable|Could not resolve/i.test(message)) return '404';
  return null;
}

function row(extra: Partial<CreateMemoryOptions> = {}, tag = 'sweepother'): string {
  counter += 1;
  const entry = createMemory(`${tag} rule number ${counter} about the staging deploy window`, {
    scope: S,
    owner: 'oid-o',
    ...extra,
  });
  writeEntry(store, entry);
  return entry.id;
}

/** A row each write case consumes, with text no earlier share left in the global store. */
const fresh = (extra: Partial<CreateMemoryOptions> = {}): string => row(extra, `sweepfresh${counter}`);

const seenIn = (found: boolean): string => (found ? 'R' : 'hidden');
const refused = (reply: Reply): string | null => refusal(reply.status, reply.json.error ?? '');
// A cell reads 'hidden' only after a 200, so a 400 or 500 for every key cannot pass as a hidden row.
const readCell = (reply: Reply, found: (json: Body) => boolean): string =>
  refused(reply) ?? (reply.status === 200 ? seenIn(found(reply.json)) : `status ${reply.status}`);
const textCell = (call: ToolReply, marker: string): string =>
  refusal(0, call.text) ?? (call.failed ? `error: ${call.text}` : seenIn(call.text.includes(marker)));
const writeCell = (reply: Reply): string => (reply.status === 200 ? '200' : (refused(reply) ?? `${reply.status}`));
const OK_TEXT = /^(Shared|Resolved)/;
const mcpWriteCell = (text: string, ok: RegExp = OK_TEXT): string => refusal(0, text) ?? (ok.test(text) ? '200' : text);
// The reply names the fate the store applied, so a reject that fell back to a plain forget does not read as 200.
const REJECTED_TEXT = /^Resolved conflict \d+: kept \S+, rejected \(tombstoned\) and removed /;

// 'skipped' is a 200 that left the strength alone, so a refusal or a failure is its own cell.
async function outcomeDelta(run: () => Promise<string | null>): Promise<string> {
  const before = readEntry(store, ids.r)?.outcomePositive ?? 0;
  const failure = await run();
  if (failure !== null) return failure;
  return (readEntry(store, ids.r)?.outcomePositive ?? 0) > before ? 'applied' : 'skipped';
}

const rememberEvents = (): Array<{ id: number; actor: string; targetId: string | null }> => {
  const db = openHippoDb(globalHome);
  try {
    return listAuditEvents(db, { tenantId: 'default', op: 'remember' }).map(({ id, actor, targetId }) => ({
      id,
      actor,
      targetId,
    }));
  } finally {
    closeHippoDb(db);
  }
};

/** O's copy leaves one global 'remember' event naming O's key, never the CLI, on a row that keeps S. */
async function auditedCopy(who: Who, run: () => Promise<string>): Promise<string> {
  const before = new Set(rememberEvents().map((event) => event.id));
  const cell = await run();
  if (who !== 'O') return cell;
  const events = rememberEvents().filter((event) => !before.has(event.id));
  const actors = events.map((event) => event.actor);
  if (actors.length !== 1 || actors[0] !== `api_key:${keys.O.keyId}`) return `${cell}, audited as ${actors.join(',')}`;
  const copied = events[0]?.targetId ? readEntry(globalHome, events[0].targetId) : undefined;
  return copied?.scope === S ? cell : `${cell}, copy scope ${copied?.scope ?? 'missing'}`;
}

function drillCell(children: readonly string[], refusedAs: string | null): string {
  if (refusedAs) return refusedAs;
  return children.length === 1 && children[0] === ids.childS ? 'S child only' : `children: ${children.join(',')}`;
}

interface SurfaceRow {
  readonly name: string;
  readonly covers: readonly string[];
  readonly expected: Cells;
  readonly run: (who: Who) => Promise<string>;
}

const READ_CELLS = { O: 'R', M: 'R', N: '403', A: 'R' } satisfies Cells;
const WRITE_CELLS = { O: '200', M: '403', N: '404', A: '200' } satisfies Cells;
const DRILL_CELLS = { O: 'S child only', M: 'S child only', N: '404', A: '404' } satisfies Cells;
const HIDDEN_CELLS = { O: 'R', M: 'R', N: 'hidden', A: 'R' } satisfies Cells;

const TABLE: readonly SurfaceRow[] = [
  {
    name: 'recall in a named scope, over HTTP',
    covers: ['GET /v1/memories'],
    expected: READ_CELLS,
    run: async (who) => {
      const reply = await http(who, 'GET', `/v1/memories?q=sweepquartz&scope=${encodeURIComponent(S)}`);
      return readCell(reply, (json) => (json.results ?? []).some((x) => x.id === ids.r));
    },
  },
  {
    name: 'hippo_recall in a named scope',
    covers: ['hippo_recall'],
    expected: READ_CELLS,
    run: async (who) => textCell(await mcpCall(who, 'hippo_recall', { query: 'sweepquartz', scope: S }), 'sweepquartz'),
  },
  {
    name: 'drill into the summary, over HTTP',
    covers: ['GET /v1/recall/drill/:id'],
    expected: DRILL_CELLS,
    run: async (who) => {
      const reply = await http(who, 'GET', `/v1/recall/drill/${ids.summary}`);
      return drillCell(
        (reply.json.children ?? []).map((c) => c.id),
        refused(reply),
      );
    },
  },
  {
    name: 'hippo_drill into the summary',
    covers: ['hippo_drill'],
    expected: DRILL_CELLS,
    run: async (who) => {
      const text = await mcp(who, 'hippo_drill', { summary_id: ids.summary });
      const found: string[] = [];
      if (text.includes('sweepchild-s')) found.push(ids.childS);
      if (text.includes('sweepchild-quarantine')) found.push('quarantine');
      return drillCell(found, refusal(0, text));
    },
  },
  {
    name: 'forget a row',
    covers: ['DELETE /v1/memories/:id'],
    expected: WRITE_CELLS,
    run: async (who) => writeCell(await http(who, 'DELETE', `/v1/memories/${fresh()}`)),
  },
  {
    name: 'archive a raw row',
    covers: ['POST /v1/memories/:id/archive'],
    expected: WRITE_CELLS,
    run: async (who) =>
      writeCell(await http(who, 'POST', `/v1/memories/${fresh({ kind: 'raw' })}/archive`, { reason: 'sweep' })),
  },
  {
    name: 'supersede a row',
    covers: ['POST /v1/memories/:id/supersede'],
    expected: WRITE_CELLS,
    run: async (who) =>
      writeCell(
        await http(who, 'POST', `/v1/memories/${fresh()}/supersede`, { content: `sweep successor ${counter}` }),
      ),
  },
  {
    name: 'promote a row to the global store',
    covers: ['POST /v1/memories/:id/promote'],
    expected: WRITE_CELLS,
    run: (who) =>
      auditedCopy(who, async () => writeCell(await http(who, 'POST', `/v1/memories/${fresh()}/promote`, {}))),
  },
  {
    name: 'hippo_share a row to the global store',
    covers: ['hippo_share'],
    expected: WRITE_CELLS,
    run: (who) =>
      auditedCopy(who, async () => mcpWriteCell(await mcp(who, 'hippo_share', { id: fresh(), force: true }))),
  },
  {
    name: 'POST /v1/outcome with the row id',
    covers: ['POST /v1/outcome'],
    expected: { O: 'applied', M: 'applied', N: 'skipped', A: 'applied' },
    run: (who) =>
      outcomeDelta(async () => {
        const { status } = await http(who, 'POST', '/v1/outcome', { ids: [ids.r], good: true });
        return status === 200 ? null : `status ${status}`;
      }),
  },
  {
    name: 'hippo_outcome on the ids of the last recall',
    covers: ['hippo_outcome'],
    // N's recall of S is refused, so it has no row to rate: this cell is not coverage of N.
    expected: { O: 'applied', M: 'applied', N: 'skipped', A: 'applied' },
    run: (who) =>
      outcomeDelta(async () => {
        await mcp(who, 'hippo_recall', { query: 'sweepquartz', scope: S });
        const call = await mcpCall(who, 'hippo_outcome', { good: true });
        return call.failed ? `error: ${call.text}` : null;
      }),
  },
  {
    name: 'hippo_resolve, fate weaken (reach only, as outcome)',
    covers: ['hippo_resolve'],
    expected: { O: '200', M: '200', N: '404', A: '200' },
    run: async (who) => {
      const { conflict, keep } = pairs.weaken[who];
      return mcpWriteCell(await mcp(who, 'hippo_resolve', { conflict_id: conflict, keep }));
    },
  },
  {
    name: 'hippo_resolve, fate forget',
    covers: ['hippo_resolve'],
    expected: WRITE_CELLS,
    run: async (who) => {
      const { conflict, keep } = pairs.forget[who];
      return mcpWriteCell(await mcp(who, 'hippo_resolve', { conflict_id: conflict, keep, forget: true }));
    },
  },
  {
    name: 'hippo_resolve, fate reject',
    covers: ['hippo_resolve'],
    expected: WRITE_CELLS,
    run: async (who) => {
      const { conflict, keep } = pairs.reject[who];
      const reply = await mcp(who, 'hippo_resolve', { conflict_id: conflict, keep, rejectLoser: true });
      return mcpWriteCell(reply, REJECTED_TEXT);
    },
  },
  {
    name: 'nearest vectors in a named scope',
    covers: ['POST /v1/vectors/nearest'],
    expected: READ_CELLS,
    run: async (who) => {
      const spec = { tenantId: 'default', includeSuperseded: false, scope: { mode: 'exact', value: S } };
      const reply = await http(who, 'POST', '/v1/vectors/nearest', { vector: VECTOR, spec });
      return readCell(reply, (json) => (json.ids ?? []).includes(ids.r));
    },
  },
  {
    name: 'context with a scope query, over HTTP',
    covers: ['GET /v1/context'],
    // HTTP reads `scope` as a tag boost, not an admission request, so no key reads S here and none is refused.
    expected: { O: 'hidden', M: 'hidden', N: 'hidden', A: 'hidden' },
    run: async (who) => {
      const reply = await http(who, 'GET', `/v1/context?scope=${encodeURIComponent(S)}`);
      return readCell(reply, (json) => (json.entries ?? []).some((x) => x.entry.id === ids.r));
    },
  },
  {
    name: 'hippo_context in a named scope',
    covers: ['hippo_context'],
    expected: READ_CELLS,
    run: async (who) => textCell(await mcpCall(who, 'hippo_context', { scope: S, budget: 4000 }), 'sweepquartz'),
  },
  {
    name: 'assemble the session in a named scope, over HTTP',
    covers: ['GET /v1/sessions/:id/assemble'],
    expected: READ_CELLS,
    run: async (who) => {
      const reply = await http(who, 'GET', `/v1/sessions/${SESSION}/assemble?scope=${encodeURIComponent(S)}`);
      return readCell(reply, (json) => (json.items ?? []).some((x) => x.id === ids.raw));
    },
  },
  {
    name: 'hippo_assemble the session in a named scope',
    covers: ['hippo_assemble'],
    expected: READ_CELLS,
    run: async (who) => textCell(await mcpCall(who, 'hippo_assemble', { session_id: SESSION, scope: S }), 'sweepraw'),
  },
  {
    name: 'the graph',
    covers: ['GET /v1/graph'],
    expected: HIDDEN_CELLS,
    run: async (who) => {
      const reply = await http(who, 'GET', '/v1/graph');
      return readCell(reply, (json) => (json.edges ?? []).some((e) => e.relType === 'depends-on'));
    },
  },
  {
    name: 'hippo_conflicts',
    covers: ['hippo_conflicts'],
    expected: HIDDEN_CELLS,
    run: async (who) => textCell(await mcpCall(who, 'hippo_conflicts', {}), `conflict_${ids.pairList}:`),
  },
];

// Routes and tools that take an id and are not memory surfaces, each with its reason.
const INTEGER_ID_ROUTES = [
  'POST /v1/predictions/:id/close',
  'GET /v1/predictions/:id',
  'POST /v1/decisions/:id/supersede',
  'POST /v1/decisions/:id/close',
  'GET /v1/decisions/:id',
  'POST /v1/incidents/:id/resolve',
  'POST /v1/incidents/:id/close',
  'GET /v1/incidents/:id',
  'POST /v1/processes/:id/supersede',
  'POST /v1/processes/:id/close',
  'GET /v1/processes/:id',
  'POST /v1/policies/:id/supersede',
  'POST /v1/policies/:id/close',
  'GET /v1/policies/:id',
  'POST /v1/skills/:id/supersede',
  'POST /v1/skills/:id/close',
  'GET /v1/skills/:id',
  'POST /v1/project-briefs/:id/supersede',
  'POST /v1/project-briefs/:id/close',
  'GET /v1/project-briefs/:id',
  'POST /v1/customer-notes/:id/supersede',
  'POST /v1/customer-notes/:id/close',
  'GET /v1/customer-notes/:id',
];
const EXEMPT_ROUTES: ReadonlyMap<string, string> = new Map([
  ...INTEGER_ID_ROUTES.map((label): [string, string] => [label, 'an integer object id, not a memory id']),
  ['DELETE /v1/auth/keys/:keyId', 'a key id, tested with the grant routes'],
  ['POST /v1/auth/keys/:keyId/grants', 'a key id, tested in auth-grant-routes.server.test.ts'],
  ['DELETE /v1/auth/keys/:keyId/grants', 'a key id, tested in auth-grant-routes.server.test.ts'],
  ['POST /v1/quarantine/:id/approve', 'admin only at the route row'],
  ['POST /v1/quarantine/:id/reject', 'admin only at the route row'],
]);
const EXEMPT_TOOLS: ReadonlyMap<string, string> = new Map();

/** One open pair for the listing and one for each write case, since resolving a pair consumes it. */
async function seedConflicts(): Promise<void> {
  const made: Array<{ memoryAId: string; memoryBId: string; reason: string; score: number }> = [];
  const pair = (reason: string): number => made.push({ memoryAId: row(), memoryBId: row(), reason, score: 0.9 }) - 1;
  const at = {
    list: pair('sweep list'),
    weaken: {
      O: pair('sweep weaken O'),
      M: pair('sweep weaken M'),
      N: pair('sweep weaken N'),
      A: pair('sweep weaken A'),
    },
    forget: {
      O: pair('sweep forget O'),
      M: pair('sweep forget M'),
      N: pair('sweep forget N'),
      A: pair('sweep forget A'),
    },
    reject: {
      O: pair('sweep reject O'),
      M: pair('sweep reject M'),
      N: pair('sweep reject N'),
      A: pair('sweep reject A'),
    },
  };
  replaceDetectedConflicts(store, made);
  const open = await listMemoryConflicts(store, 'open', 'default');
  const found = (n: number): Pair => ({
    conflict: open.find((c) => c.memoryAId === made[n].memoryAId || c.memoryBId === made[n].memoryAId)?.id ?? 0,
    keep: made[n].memoryAId,
  });
  ids.pairList = found(at.list).conflict;
  for (const who of WHO) {
    pairs.weaken[who] = found(at.weaken[who]);
    pairs.forget[who] = found(at.forget[who]);
    pairs.reject[who] = found(at.reject[who]);
  }
}

async function seedRows(): Promise<void> {
  ids.r = row({ pinned: true }, 'sweepquartz');
  ids.raw = row({ kind: 'raw', sourceSessionId: SESSION }, 'sweepraw');
  ids.summary = row({ dagLevel: 2, tags: ['dag-summary'] }, 'sweepsummary');
  ids.childS = row({ dagLevel: 1, dagParentId: ids.summary }, 'sweepchild-s');
  row({ dagLevel: 1, dagParentId: ids.summary, scope: QUARANTINE }, 'sweepchild-quarantine');
  const db = openHippoDb(store);
  try {
    upsertVectors(db, [[ids.r, VECTOR]], MODEL);
    setMeta(db, EMBEDDING_MODEL_META_KEY, MODEL);
  } finally {
    closeHippoDb(db);
  }
  const from = insertEntityAt(store, 'default', { entityType: 'system', name: 'QuartzSvc', memoryId: ids.r });
  const to = insertEntityAt(store, 'default', { entityType: 'system', name: 'QuartzDb', memoryId: ids.r });
  insertRelationAt(store, 'default', {
    fromEntityId: from.id,
    toEntityId: to.id,
    relType: 'depends-on',
    memoryId: ids.r,
  });
  await seedConflicts();
}

beforeAll(async () => {
  globalHome = makeRoot('member-grant-sweep-global');
  vi.stubEnv('HIPPO_HOME', globalHome);
  // The context tool's auto query reads the checkout's git state, which differs between a dev branch and CI.
  vi.stubEnv('GIT_DIR', join(globalHome, 'no-repo'));
  vi.stubEnv('HIPPO_V1_RPS', '0');
  store = makeRoot('member-grant-sweep', {
    config: { contextProjectIsolation: false, embeddings: { enabled: false } },
  });
  keys = {
    O: mint('sweep-o', 'member', 'oid-o', [S]),
    M: mint('sweep-m', 'member', 'oid-m', [S]),
    N: mint('sweep-n', 'member', 'oid-n', []),
    A: mint('sweep-a', 'admin', undefined, []),
  };
  await seedRows();
  handle = await serve({ hippoRoot: store, host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await handle?.stop();
  vi.unstubAllEnvs();
});

describe('every by-id surface of a member grant', () => {
  it.each(TABLE.map((surface) => [surface.name, surface] as const))('%s', async (_name, surface) => {
    const seen = {
      O: await surface.run('O'),
      M: await surface.run('M'),
      N: await surface.run('N'),
      A: await surface.run('A'),
    };
    expect(seen).toEqual(surface.expected);
  });
});

describe('the sweep covers every surface that takes an id', () => {
  const covered = new Set(TABLE.flatMap((surface) => surface.covers));

  it('lists a route with a path parameter or a regex in the table, or exempts it with a reason', () => {
    // A regex route's label holds no ':', yet it captures a value, so it counts as a by-id route.
    const missing = V1_ROUTES.filter((route) => 'regex' in route || routeLabel(route).includes(':'))
      .map((route) => `${route.method} ${routeLabel(route)}`)
      .filter((label) => !covered.has(label) && !EXEMPT_ROUTES.has(label));
    expect(missing).toEqual([]);
  });

  it('lists a tool with an id argument in the table, or exempts it with a reason', () => {
    const idTools = TOOLS.filter((tool) =>
      Object.keys(tool.inputSchema.properties ?? {}).some((key) => /[iI]ds?$/.test(key)),
    );
    const missing = idTools.map((tool) => tool.name).filter((name) => !covered.has(name) && !EXEMPT_TOOLS.has(name));
    expect(missing).toEqual([]);
  });

  it('serves hippo_share, so the share row is coverage', async () => {
    const res = await send('O', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(await res.text()).toContain('hippo_share');
  });
});
