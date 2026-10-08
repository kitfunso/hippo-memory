// The personal-memories plan's lane T walk, written from the plan alone: one shared-store server, callers A, B and an unowned admin.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as api from '../src/api.js';
import { BadRequestError } from '../src/api-errors.js';
import { createApiKey } from '../src/auth.js';
import { extractFromTexts } from '../src/capture/extract.js';
import { captureSessionTexts } from '../src/capture/session-texts.js';
import { cmdRecall } from '../src/cli/recall.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { insertEntity } from '../src/graph/write.js';
import type { JsonValue } from '../src/json.js';
import { Layer, generateId, type CreateMemoryOptions, type MemoryEntry } from '../src/memory.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { promptHookContext } from '../src/prompt-hook.js';
import { serve, type ServerHandle } from '../src/server.js';
import type { AuthResolver } from '../src/server/types.js';
import { listMemoryConflicts, replaceDetectedConflicts, resolveConflict } from '../src/store/conflicts.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { runInProcess } from './_helpers/run-in-process.js';

const A_SCOPE = 'personal:private:oid-a';
const B_SCOPE = 'personal:private:oid-b';
const ZIRCON = 'zircon-kettle note for alpha';
// Recall and context drop a later copy of the same text, so the team row adds words to stay visible beside A's.
const ZIRCON_TEAM = 'zircon-kettle note for alpha, team copy';
const QUILL = 'the quillonmarsh valve sticks after a cold start';
const TEAL = 'the tealwickharbour gauge reads high after a cold start';
const BASALT = 'basalt-lantern note for bravo';
const SESSION = 'walk-session';
const OWNER_400 = 'personal memories need a key its owner minted';
const SIGNIN_A = 'signin-oid-a';
const SIGNIN_B_SCOPED = 'signin-oid-b-scoped';
const OTHERS = ['B', 'ADM'] as const;

type Who = 'A' | 'B' | 'ADM';
interface Key { readonly plaintext: string; readonly keyId: string }
interface Keys { readonly A: Key; readonly B: Key; readonly ADM: Key }
interface Reply { readonly status: number; readonly text: string }

let tmp: string;
let store: string;
let handle: ServerHandle | undefined;
let keys: Keys;
const ids = { aZircon: '', teamZircon: '', bBasalt: '', aQuill: '', teamTeal: '', summary: '', child: '', teamRaw: '' };
const origEnv = { HIPPO_HOME: process.env.HIPPO_HOME, HIPPO_V1_RPS: process.env.HIPPO_V1_RPS };

const resolver: AuthResolver = (token) => {
  if (token === SIGNIN_A) return { tenantId: 'default', subject: 'oid-a', role: 'member' };
  if (token === SIGNIN_B_SCOPED) return { tenantId: 'default', subject: 'oid-b', role: 'member', scopes: [A_SCOPE] };
  return null;
};

function mint(label: string, role: 'admin' | 'member', ownerSubject?: string, root = store): Key {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', label, role, ownerSubject });
  } finally {
    closeHippoDb(db);
  }
}

function ctxOf(who: Who): api.Context {
  const subject = `api_key:${keys[who].keyId}`;
  if (who === 'ADM') return { hippoRoot: store, tenantId: 'default', actor: { subject, role: 'admin' } };
  return { hippoRoot: store, tenantId: 'default', actor: { subject, role: 'member', owner: who === 'A' ? 'oid-a' : 'oid-b' } };
}

async function http(token: string | null, method: string, route: string, body?: JsonValue, extra: Record<string, string> = {}, base = handle!.url): Promise<Reply> {
  const plain = { 'content-type': 'application/json', accept: 'application/json', ...extra };
  const headers = token ? { ...plain, authorization: `Bearer ${token}` } : plain;
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

function json<T>(r: Reply): T {
  // SAFETY: each caller names only the fields of that route's reply it asserts on.
  return JSON.parse(r.text) as T;
}

/** POST /v1/memories that must land; a refusal throws with the body, so a setup failure reads as one. */
async function post(token: string, body: Record<string, JsonValue>): Promise<string> {
  const r = await http(token, 'POST', '/v1/memories', body);
  if (r.status !== 200) throw new Error(`write refused ${r.status}: ${r.text}`);
  return json<{ id: string }>(r).id;
}

function seedRow(content: string, scope: string | null, origin: string | null, opts: Partial<CreateMemoryOptions> = {}, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry: MemoryEntry = { ...createMemory(content, { tenantId: 'default', scope, ...opts }), origin_project: origin, ...patch };
  writeEntry(store, entry);
  return entry;
}

async function recallIds(token: string, query: string): Promise<{ status: number; ids: string[] }> {
  const r = await http(token, 'GET', `/v1/memories?${query}`);
  return { status: r.status, ids: r.status === 200 ? json<{ results: Array<{ id: string }> }>(r).results.map((x) => x.id) : [] };
}

async function contextIds(token: string, query: string): Promise<string[]> {
  const r = await http(token, 'GET', `/v1/context?${query}`);
  expect(r.status, r.text).toBe(200);
  return json<{ entries: Array<{ entry: { id: string } }> }>(r).entries.map((x) => x.entry.id);
}

/** A tools/call reply as text, sent from the alpha repo: the tool's own text, or the JSON-RPC error message a thrown API error becomes. */
async function tool(token: string, name: string, args: Record<string, JsonValue>, base?: string): Promise<string> {
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  const r = await http(token, 'POST', '/mcp', call, { 'x-hippo-project': 'alpha' }, base);
  expect(r.status, r.text).toBe(200);
  const body = json<{ result?: { content: Array<{ text: string }> }; error?: { message: string } }>(r);
  return body.result?.content[0]?.text ?? body.error?.message ?? '';
}

/** F13: the reply for a real id, masked, equals the reply for an id that never existed, and has `status` when given. */
async function sameAsMissing(id: string, run: (id: string) => Promise<Reply>, status?: number): Promise<void> {
  const fake = generateId();
  const real = await run(id);
  const missing = await run(fake);
  expect({ status: real.status, text: real.text.split(id).join('<id>') })
    .toEqual({ status: missing.status, text: missing.text.split(fake).join('<id>') });
  if (status !== undefined) expect(real.status, real.text).toBe(status);
}

function restoreEnv(name: keyof typeof origEnv): void {
  const value = origEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-personal-walk-'));
  // File-wide, not per test: the one server reads both at boot and on every request.
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  process.env.HIPPO_V1_RPS = '0'; // every call comes from one address, so the per-address limiter would cut the walk short
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
  store = path.join(tmp, 'srv', 'hippo-team');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true, pinnedInject: { promptRecall: true } }));
  keys = { A: mint('walk-a', 'member', 'oid-a'), B: mint('walk-b', 'member', 'oid-b'), ADM: mint('walk-adm', 'admin') };
  handle = await serve({ hippoRoot: store, host: '127.0.0.1', port: 0, authResolver: resolver });

  const alpha = { name: 'alpha' };
  ids.aZircon = await post(keys.A.plaintext, { content: ZIRCON, personal: true, project: alpha });
  ids.teamZircon = await post(keys.A.plaintext, { content: ZIRCON_TEAM, project: alpha });
  ids.bBasalt = await post(keys.B.plaintext, { content: BASALT, personal: true });
  ids.aQuill = await post(keys.A.plaintext, { content: QUILL, personal: true, project: alpha });
  ids.teamTeal = await post(keys.B.plaintext, { content: TEAL, project: alpha });

  const summary = seedRow('umberline rollup for the walk session', A_SCOPE, '',
    { layer: Layer.Semantic, dag_level: 2, confidence: 'inferred', tags: ['dag-summary'] }, { descendant_count: 1 });
  ids.summary = summary.id;
  ids.child = seedRow('the umberline ledger closed at noon', A_SCOPE, '', {
    layer: Layer.Episodic, kind: 'raw', confidence: 'observed', dag_level: 1, dag_parent_id: summary.id, source_session_id: SESSION,
  }).id;
  ids.teamRaw = seedRow('the tealraw ledger opened at nine', null, 'alpha',
    { layer: Layer.Episodic, kind: 'raw', confidence: 'observed', source_session_id: SESSION }).id;
});

afterAll(async () => {
  await handle?.stop();
  restoreEnv('HIPPO_HOME');
  restoreEnv('HIPPO_V1_RPS');
  _resetSharedStoreCacheForTests();
  clearProjectIdentityCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('personal memories walk (plan lane T)', () => {
  it('line 1: POST /v1/memories personal stamps the owner scope and a user-global origin', async () => {
    expect(readEntry(store, ids.aZircon)).toMatchObject({ scope: A_SCOPE, origin_project: '' });
    expect(readEntry(store, ids.bBasalt)).toMatchObject({ scope: B_SCOPE, origin_project: '' });
    const signedIn = await post(SIGNIN_A, { content: 'signin-only note for alpha', personal: true });
    expect(readEntry(store, signedIn)?.scope).toBe(A_SCOPE);
    expect((await http(keys.ADM.plaintext, 'POST', '/v1/memories', { content: 'unowned personal try', personal: true })).status).toBe(400);
    expect((await http(keys.A.plaintext, 'POST', '/v1/memories', { content: 'forged scope row', scope: B_SCOPE })).status).toBe(400);
  });

  it('line 2: GET /v1/memories?q=zircon shows A its row, and ?scope= is 403 for B and ADM', async () => {
    for (const token of [keys.A.plaintext, SIGNIN_A]) {
      expect((await recallIds(token, 'q=zircon')).ids).toEqual(expect.arrayContaining([ids.aZircon, ids.teamZircon]));
    }
    for (const who of OTHERS) {
      const seen = (await recallIds(keys[who].plaintext, 'q=zircon')).ids;
      expect(seen, who).toContain(ids.teamZircon);
      expect(seen, who).not.toContain(ids.aZircon);
    }
    expect((await recallIds(keys.B.plaintext, 'q=basalt')).ids).toContain(ids.bBasalt);
    expect((await recallIds(keys.A.plaintext, 'q=basalt')).ids).not.toContain(ids.bBasalt);

    const scoped = `q=zircon&scope=${encodeURIComponent(A_SCOPE)}`;
    const own = await recallIds(keys.A.plaintext, scoped);
    expect(own.status).toBe(200);
    expect(own.ids).toContain(ids.aZircon);
    for (const who of OTHERS) expect((await recallIds(keys[who].plaintext, scoped)).status, who).toBe(403);
  });

  it('line 3: GET /v1/context with and without a query gives A its row in every project, and nobody else', async () => {
    for (const project of ['alpha', 'beta']) {
      for (const q of ['&q=zircon', '']) {
        const route = `project=${project}${q}`;
        expect(await contextIds(keys.A.plaintext, route), route).toContain(ids.aZircon);
        for (const who of OTHERS) expect(await contextIds(keys[who].plaintext, route), `${who} ${route}`).not.toContain(ids.aZircon);
      }
    }
    for (const who of OTHERS) expect(await contextIds(keys[who].plaintext, 'project=alpha&q=zircon'), who).toContain(ids.teamZircon);
  });

  it('line 4: GET /v1/sessions/:id/assemble and GET /v1/recall/drill/:id on A\'s summary', async () => {
    const assembled = async (who: Who): Promise<string[]> => {
      const r = await http(keys[who].plaintext, 'GET', `/v1/sessions/${SESSION}/assemble`);
      expect(r.status, r.text).toBe(200);
      return json<{ items: Array<{ id: string; substitutedFor?: string[] }> }>(r).items.flatMap((i) => [i.id, ...(i.substitutedFor ?? [])]);
    };
    expect(await assembled('A')).toEqual(expect.arrayContaining([ids.child, ids.teamRaw]));
    for (const who of OTHERS) {
      const seen = await assembled(who);
      expect(seen, who).toContain(ids.teamRaw);
      expect(seen, who).not.toContain(ids.child);
      expect(seen, who).not.toContain(ids.summary);
    }

    const drill = (who: Who, id: string): Promise<Reply> => http(keys[who].plaintext, 'GET', `/v1/recall/drill/${id}`);
    const own = await drill('A', ids.summary);
    expect(own.status, own.text).toBe(200);
    expect(json<{ children: Array<{ id: string }> }>(own).children.map((c) => c.id)).toContain(ids.child);
    for (const who of OTHERS) await sameAsMissing(ids.summary, (id) => drill(who, id), 404);
  });

  it('line 5: POST /mcp hippo_recall, hippo_context, hippo_assemble, hippo_drill and hippo_remember personal', async () => {
    const say = (who: Who, name: string, args: Record<string, JsonValue>): Promise<string> => tool(keys[who].plaintext, name, args);
    expect(await say('A', 'hippo_recall', { query: 'cold start' })).toContain('quillonmarsh');
    expect(await say('A', 'hippo_assemble', { session_id: SESSION })).toContain('umberline');
    expect(await say('A', 'hippo_drill', { summary_id: ids.summary })).toContain(ids.child);
    // A's personal rows are user-global, so the alpha header still shows them.
    expect(await say('A', 'hippo_context', {})).toContain('quillonmarsh');
    for (const who of OTHERS) {
      const recalled = await say(who, 'hippo_recall', { query: 'cold start' });
      expect(recalled, who).toContain('tealwickharbour');
      expect(recalled, who).not.toContain('quillonmarsh');
      const window = await say(who, 'hippo_assemble', { session_id: SESSION });
      expect(window, who).toContain('tealraw');
      expect(window, who).not.toContain('umberline');
      await sameAsMissing(ids.summary, async (id) => ({ status: 200, text: await say(who, 'hippo_drill', { summary_id: id }) }));
    }

    const remembered = await say('A', 'hippo_remember', { text: 'mcp personal note from alpha', personal: true });
    const newId = /Remembered \[([^\]]+)\]/.exec(remembered)?.[1] ?? '';
    expect(readEntry(store, newId)?.scope, remembered).toBe(A_SCOPE);
    expect(await say('ADM', 'hippo_remember', { text: 'unowned mcp personal try', personal: true })).toContain(OWNER_400);
  });

  it('line 5, hippo_context: a shared store refuses it without a project, so a second store that is not shared shows A its row and nobody else', async () => {
    const bare = await http(keys.A.plaintext, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: {} } });
    expect(bare.text).toContain("hippo_context needs the caller's project on a shared store");
    const solo = path.join(tmp, 'solo', '.hippo');
    fs.mkdirSync(solo, { recursive: true });
    initStore(solo);
    const soloKeys: Keys = { A: mint('solo-a', 'member', 'oid-a', solo), B: mint('solo-b', 'member', 'oid-b', solo), ADM: mint('solo-adm', 'admin', undefined, solo) };
    writeEntry(solo, { ...createMemory(QUILL, { tenantId: 'default', scope: A_SCOPE }), origin_project: '' });
    writeEntry(solo, { ...createMemory(TEAL, { tenantId: 'default', scope: null }), origin_project: '' });
    const soloHandle = await serve({ hippoRoot: solo, host: '127.0.0.1', port: 0 });
    const cwd = process.cwd();
    const away = path.join(tmp, 'away');
    fs.mkdirSync(away);
    process.chdir(away); // outside git, so the tool's auto query is empty and it lists by strength
    try {
      const context = (who: Who): Promise<string> => tool(soloKeys[who].plaintext, 'hippo_context', {}, soloHandle.url);
      expect(await context('A')).toContain('quillonmarsh');
      for (const who of OTHERS) {
        const out = await context(who);
        expect(out, who).toContain('tealwickharbour');
        expect(out, who).not.toContain('quillonmarsh');
      }
    } finally {
      process.chdir(cwd);
      await soloHandle.stop();
    }
  });

  it('line 6: promptHookContext gives A its row in every project, and B and ADM never', async () => {
    const hook = async (who: Who, project: string): Promise<string> => (await promptHookContext(ctxOf(who), {
      sessionId: `walk-hook-${who}-${project}`,
      project: { name: project, legacyName: project },
      payload: { prompt: 'quillonmarsh tealwickharbour cold start' },
    }, { sharedStore: true })).stdout;
    expect(await hook('A', 'alpha')).toContain('quillonmarsh');
    expect(await hook('A', 'beta')).toContain('quillonmarsh');
    for (const who of OTHERS) {
      const out = await hook(who, 'alpha');
      expect(out, who).toContain('tealwickharbour');
      expect(out, who).not.toContain('quillonmarsh');
    }
  });

  it('line 6, pinned: pinned-only context, with and without include_recent, and the hook give A its pinned row, and B and ADM never', async () => {
    const mine = seedRow('the marrowfield pin: my standing rule for every session', A_SCOPE, '', { pinned: true });
    const team = seedRow('the larchwood pin: the team standing rule for every session', null, '', { pinned: true });
    for (const route of ['project=alpha&pinned_only=1', 'project=alpha&pinned_only=1&include_recent=5']) {
      expect(await contextIds(keys.A.plaintext, route), route).toEqual(expect.arrayContaining([mine.id, team.id]));
      for (const who of OTHERS) {
        const seen = await contextIds(keys[who].plaintext, route);
        expect(seen, `${who} ${route}`).toContain(team.id);
        expect(seen, `${who} ${route}`).not.toContain(mine.id);
      }
    }
    const hook = async (who: Who): Promise<string> => (await promptHookContext(ctxOf(who), {
      sessionId: `walk-pin-${who}`,
      project: { name: 'alpha', legacyName: 'alpha' },
      payload: { prompt: 'what is the standing rule' },
    }, { sharedStore: true })).stdout;
    expect(await hook('A')).toContain('marrowfield');
    for (const who of OTHERS) {
      const out = await hook(who);
      expect(out, who).toContain('larchwood');
      expect(out, who).not.toContain('marrowfield');
    }
  });

  it('line 7: DELETE, archive, supersede, promote and POST /v1/outcome on A\'s row, then outcome with no ids (F13, F12)', async () => {
    type Path = { name: string; kind: string; aStatus: number; othersStatus: number; call: (token: string, id: string) => Promise<Reply> };
    const paths: readonly Path[] = [
      { name: 'delete', kind: 'distilled', aStatus: 200, othersStatus: 404, call: (t, id) => http(t, 'DELETE', `/v1/memories/${id}`) },
      { name: 'archive', kind: 'raw', aStatus: 200, othersStatus: 404, call: (t, id) => http(t, 'POST', `/v1/memories/${id}/archive`, { reason: 'walk' }) },
      { name: 'supersede', kind: 'distilled', aStatus: 200, othersStatus: 404, call: (t, id) => http(t, 'POST', `/v1/memories/${id}/supersede`, { content: 'walk successor text' }) },
      { name: 'promote', kind: 'distilled', aStatus: 400, othersStatus: 404, call: (t, id) => http(t, 'POST', `/v1/memories/${id}/promote`, {}) },
      { name: 'outcome', kind: 'distilled', aStatus: 200, othersStatus: 200, call: (t, id) => http(t, 'POST', '/v1/outcome', { ids: [id], good: true }) },
    ];
    for (const p of paths) {
      const id = await post(keys.A.plaintext, { content: `walk ${p.name} target row`, personal: true, kind: p.kind });
      for (const who of OTHERS) await sameAsMissing(id, (x) => p.call(keys[who].plaintext, x), p.othersStatus);
      expect(readEntry(store, id)?.outcome_positive, `${p.name} row untouched`).toBe(0);
      const mine = await p.call(keys.A.plaintext, id);
      expect(mine.status, `${p.name}: ${mine.text}`).toBe(p.aStatus);
      if (p.name === 'outcome') expect(json<{ applied: number }>(mine).applied).toBe(1);
    }

    expect(await contextIds(keys.A.plaintext, 'project=alpha&q=zircon')).toContain(ids.aZircon);
    const before = readEntry(store, ids.aZircon);
    const fromB = await http(keys.B.plaintext, 'POST', '/v1/outcome', { good: true });
    expect(fromB.status, fromB.text).toBe(200);
    expect(json<{ ids: string[] }>(fromB).ids).not.toContain(ids.aZircon);
    const after = readEntry(store, ids.aZircon);
    expect([after?.strength, after?.outcome_positive, after?.outcome_negative])
      .toEqual([before?.strength, before?.outcome_positive, before?.outcome_negative]);
    expect(json<{ ids: string[] }>(await http(keys.A.plaintext, 'POST', '/v1/outcome', { good: true })).ids).toContain(ids.aZircon);
  });

  it('line 8: MCP hippo_share and hippo_resolve are off, hippo_conflicts, and a team rejectLoser spares A\'s row (F1)', async () => {
    const off = 'the gravelpine cache must stay off during load tests';
    const alpha = { name: 'alpha' };
    const p1 = await post(keys.A.plaintext, { content: off, personal: true });
    const p2 = await post(keys.A.plaintext, { content: 'the gravelpine cache must stay on during load tests', personal: true });
    const t1 = await post(keys.B.plaintext, { content: off, project: alpha });
    const t2 = await post(keys.B.plaintext, { content: 'the gravelpine cache must stay on during soak tests', project: alpha });
    replaceDetectedConflicts(store, [
      { memory_a_id: p1, memory_b_id: p2, reason: 'walk: A pair', score: 0.9 },
      { memory_a_id: t1, memory_b_id: t2, reason: 'walk: team pair', score: 0.9 },
    ]);
    const open = listMemoryConflicts(store, 'open', 'default');
    const pairOf = (id: string): number => open.find((c) => c.memory_a_id === id || c.memory_b_id === id)!.id;
    const [aPair, teamPair] = [pairOf(p1), pairOf(t1)];

    for (const who of ['A', 'B', 'ADM'] as const) {
      expect(await tool(keys[who].plaintext, 'hippo_share', { id: who === 'A' ? p1 : t2, force: true }), who).toContain('hippo_share is off on a shared store');
      expect(await tool(keys[who].plaintext, 'hippo_resolve', { conflict_id: aPair, keep: p1 }), who).toContain('hippo_resolve is off on a shared store');
    }

    expect(await tool(keys.A.plaintext, 'hippo_conflicts', {})).toContain(`conflict_${aPair}:`);
    for (const who of OTHERS) {
      const listed = await tool(keys[who].plaintext, 'hippo_conflicts', {});
      expect(listed, who).toContain(`conflict_${teamPair}:`);
      expect(listed, who).not.toContain(`conflict_${aPair}:`);
    }

    // The admin resolves with the CLI on a shared store, which runs this.
    expect(resolveConflict(store, teamPair, t2, false, 'default', { rejectLoserValue: true, rejectedBy: 'walk' })).not.toBeNull();
    expect(readEntry(store, t1)).toBeFalsy();
    expect(readEntry(store, p1)?.content).toBe(off);
  });

  it('line 9: GET /v1/graph shows the entity from A\'s row to A only', async () => {
    insertEntity(store, 'default', { entityType: 'system', name: 'ZirconKettle', memoryId: ids.aZircon });
    insertEntity(store, 'default', { entityType: 'system', name: 'TealHarbour', memoryId: ids.teamZircon });
    const names = async (who: Who): Promise<string[]> => {
      const r = await http(keys[who].plaintext, 'GET', '/v1/graph');
      expect(r.status, r.text).toBe(200);
      return json<{ nodes: Array<{ name: string }> }>(r).nodes.map((n) => n.name);
    };
    expect(await names('A')).toEqual(expect.arrayContaining(['ZirconKettle', 'TealHarbour']));
    for (const who of OTHERS) {
      const seen = await names(who);
      expect(seen, who).toContain('TealHarbour');
      expect(seen, who).not.toContain('ZirconKettle');
    }
  });

  it('line 10: captureSessionTexts by B with A\'s exact text captures a team row', async () => {
    const said = 'We decided to pin the frostgale build cache because the nightly job keeps evicting it.';
    const item = extractFromTexts([said])[0]!.content;
    await post(keys.A.plaintext, { content: item, personal: true, project: { name: 'alpha' } });
    const req = (sessionId: string) => ({ sessionId, project: { name: 'alpha', legacyName: 'alpha' }, texts: [said] });
    expect(captureSessionTexts(ctxOf('B'), req('walk-capture-1'))).toMatchObject({ captured: 1, skipped: 0 });
    expect(loadAllEntries(store).filter((e) => e.content === item && !e.scope)).toHaveLength(1);
    expect(captureSessionTexts(ctxOf('B'), req('walk-capture-2'))).toMatchObject({ captured: 0, skipped: 1 });
  });

  it('line 11: api.authGrant of A\'s scope is 400, and a resolver scope list naming it opens nothing (F8)', async () => {
    expect(() => api.authGrant(ctxOf('ADM'), keys.B.keyId, A_SCOPE)).toThrow(BadRequestError);
    expect(api.authGrant(ctxOf('ADM'), keys.B.keyId, 'slack:private:C9')).toEqual({ ok: true });

    const scoped = `q=zircon&scope=${encodeURIComponent(A_SCOPE)}`;
    expect((await recallIds(SIGNIN_A, scoped)).ids).toContain(ids.aZircon);
    expect((await recallIds(SIGNIN_B_SCOPED, scoped)).status).toBe(403);
    const open = await recallIds(SIGNIN_B_SCOPED, 'q=zircon');
    expect(open.ids).toContain(ids.teamZircon);
    expect(open.ids).not.toContain(ids.aZircon);
  });

  it('line 12: GET /v1/memories?scope=slack:private:C1 reads for a granted member and ADM, unchanged', async () => {
    const granted = mint('walk-c', 'member');
    api.authGrant(ctxOf('ADM'), granted.keyId, 'slack:private:C1');
    const slack = seedRow('the kowalskiwharf payroll rollout starts thursday', 'slack:private:C1', null);
    const route = `q=kowalskiwharf&scope=${encodeURIComponent('slack:private:C1')}`;
    for (const token of [granted.plaintext, keys.ADM.plaintext]) {
      const r = await recallIds(token, route);
      expect(r.status).toBe(200);
      expect(r.ids).toContain(slack.id);
    }
    expect((await recallIds(keys.B.plaintext, route)).status).toBe(403);
  });

  it('line 13: GET /v1/audit names A\'s write by actor and memory id and holds no row text', async () => {
    for (const who of ['A', 'B', 'ADM'] as const) {
      const r = await http(keys[who].plaintext, 'GET', '/v1/audit?op=remember&limit=1000');
      expect(r.status, `${who}: ${r.text}`).toBe(200);
      expect(r.text, who).not.toContain('zircon-kettle');
      expect(r.text, who).not.toContain('quillonmarsh');
      const write = json<Array<{ actor: string; targetId: string | null }>>(r).find((e) => e.targetId === ids.aZircon);
      expect(write?.actor, who).toBe(`api_key:${keys.A.keyId}`);
    }
  });

  it('line 14: POST /v1/sleep derives from each pair of seeds into that pair\'s scope and mixes nothing', async () => {
    const base = 'rotate the cobaltfern staging certificates before expiry';
    const scopeOf = new Map<string, string | null>([['amberquill', A_SCOPE], ['tealmarker', null], ['bravomarker', B_SCOPE]]);
    for (const [marker, scope] of scopeOf) {
      seedRow(`${base} ${marker}`, scope, '');
      seedRow(`${base} ${marker} notify the on-call channel`, scope, '');
    }
    const r = await http(null, 'POST', '/v1/sleep', { no_share: true });
    expect(r.status, r.text).toBe(200);

    const derived = loadAllEntries(store).filter((e) => e.source === 'consolidation' && e.content.includes('cobaltfern'));
    const markerOf = (e: MemoryEntry): string[] => [...scopeOf.keys()].filter((m) => e.content.includes(m));
    expect(derived.flatMap(markerOf).sort()).toEqual([...scopeOf.keys()].sort());
    for (const e of derived) {
      expect(markerOf(e), e.content).toHaveLength(1);
      expect(e.scope ?? null, e.content).toBe(scopeOf.get(markerOf(e)[0]!));
    }
  });

  it('line 15: local CLI recall --scope personal:private:oid-a returns no personal row', async () => {
    // Fresh rows, because the line 14 sleep may merge the earlier zircon rows into one consolidated row.
    const team = seedRow('the harrowfen pump note for the cli, team row', null, '');
    const mine = seedRow('the harrowfen pump note for the cli, kept by A', A_SCOPE, '');
    const run = (flags: Record<string, string | boolean>) => runInProcess(() => cmdRecall(store, 'harrowfen', { json: true, ...flags }));
    expect((await run({})).stdout).toContain(team.id);
    const scoped = await run({ scope: A_SCOPE });
    expect(scoped.stdout).toContain(team.id);
    const personal = loadAllEntries(store).filter((e) => e.scope?.startsWith('personal:'));
    expect(personal.map((e) => e.id)).toContain(mine.id);
    expect(personal.filter((e) => scoped.stdout.includes(e.id)).map((e) => e.id)).toEqual([]);
  });
});
