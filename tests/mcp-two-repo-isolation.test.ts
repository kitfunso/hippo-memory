// One shared store, two repos: an MCP session in acme never gets beta's, NULL-origin or another tenant's rows, and beta's mirrors it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assemble, recall, type Context } from '../src/api.js';
import { createApiKey } from '../src/auth.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { saveEmbeddingIndex, saveStoredEmbeddingModel } from '../src/embeddings.js';
import type { JsonValue } from '../src/json.js';
import { Layer, type CreateMemoryOptions, type MemoryEntry } from '../src/memory.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { serve, type ServerHandle } from '../src/server.js';
import { listMemoryConflicts, replaceDetectedConflicts } from '../src/store/conflicts.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { initStore } from '../src/store/open.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const TENANT = 'default';
const SESSION = 'two-repo-session';
const ACME = { name: 'acme', legacyName: 'acme' } as const;
const SUMMARY: Partial<CreateMemoryOptions> = { layer: Layer.Semantic, dag_level: 2, confidence: 'inferred', tags: ['dag-summary'] };

type Repo = 'acme' | 'beta';
interface Reply { readonly text: string; readonly isError: boolean }

let tmp: string;
let store: string;
let handle: ServerHandle | undefined;
let aliceKey = '';
const realFetch = globalThis.fetch;
const origEnv = { HIPPO_HOME: process.env.HIPPO_HOME, HIPPO_V1_RPS: process.env.HIPPO_V1_RPS, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
const BASE_CONFIG = { sharedStore: true, embeddings: { provider: 'openai', model: 'text-embedding-3-small' } };

const ids = {
  acme: '', beta: '', global: '', none: '', other: '', alice: '', bob: '', betaNear: '',
  acmeSum: '', betaSum: '', acmeRaw1: '', acmeRaw2: '', betaRaw1: '', betaRaw2: '', acmeOdd1: '', acmeOdd2: '', nullRaw: '',
  acmeSumO: '', betaSumO: '',
};
const pairs = { acme: 0, beta: 0, slack: 0, none: 0 };

function seed(content: string, origin: string | null, opts: Partial<CreateMemoryOptions> = {}): string {
  const entry: MemoryEntry = { ...createMemory(content, { tenantId: TENANT, ...opts }), origin_project: origin };
  writeEntry(store, entry);
  return entry.id;
}

function raw(content: string, origin: string | null, parent?: string): string {
  return seed(content, origin, { layer: Layer.Episodic, kind: 'raw', confidence: 'observed', source_session_id: SESSION, dag_level: parent ? 1 : 0, dag_parent_id: parent });
}

async function tool(repo: Repo, name: string, args: Record<string, JsonValue> = {}): Promise<Reply> {
  const res = await realFetch(`${handle!.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${aliceKey}`, 'x-hippo-project': repo },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  // SAFETY: a tools/call reply is a result with text content or a JSON-RPC error; only those fields are read.
  const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  return { text: body.result?.content[0]?.text ?? body.error?.message ?? '', isError: body.result?.isError === true || body.error !== undefined };
}

/** The ids hippo_recall or hippo_context listed, read from the outcome map both fill. */
async function shown(repo: Repo, name: 'hippo_recall' | 'hippo_context', args: Record<string, JsonValue> = {}): Promise<string[]> {
  lastRecalledIds.clear();
  const r = await tool(repo, name, args);
  expect(r.isError, r.text).toBe(false);
  return [...lastRecalledIds.values()].flat();
}

function expectOnly(seen: readonly string[], present: readonly string[], absent: readonly string[], label: string): void {
  for (const id of present) expect(seen, `${label} should show ${id}`).toContain(id);
  for (const id of absent) expect(seen, `${label} should hide ${id}`).not.toContain(id);
}

function apiCtx(): Context {
  return { hippoRoot: store, tenantId: TENANT, actor: { subject: 'api_key:two-repo', role: 'member', owner: 'alice' } };
}

function writeConfig(extra: Record<string, JsonValue> = {}): void {
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ ...BASE_CONFIG, ...extra }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const HIDDEN_FROM_ACME = (): string[] => [ids.beta, ids.none, ids.other, ids.bob, ids.betaNear];
const HIDDEN_FROM_BETA = (): string[] => [ids.acme, ids.none, ids.other, ids.bob];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-two-repo-'));
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  process.env.HIPPO_V1_RPS = '0';
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
  // The server shares this process, so its own requests pass through and only the embedding call is faked.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (handle && url.startsWith(handle.url)) return realFetch(input, init);
    // SAFETY: body is the OpenAI embeddings request the provider just serialised.
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
  }));

  store = path.join(tmp, 'srv', 'hippo-team');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  writeConfig();
  const db = openHippoDb(store);
  try {
    aliceKey = createApiKey(db, { tenantId: TENANT, label: 'two-repo-alice', role: 'member', ownerSubject: 'alice' }).plaintext;
  } finally {
    closeHippoDb(db);
  }

  ids.acme = seed('acmemark lighthouse keeper log for the acme repo', 'acme');
  ids.beta = seed('betamark lighthouse keeper log for the beta repo', 'beta');
  ids.global = seed('globalmark lighthouse keeper log for every repo', '');
  ids.none = seed('nullmark lighthouse keeper log with no project', null);
  ids.other = seed('othermark lighthouse keeper log in another tenant', 'acme', { tenantId: 'other' });
  ids.alice = seed('alicemark lighthouse keeper log kept by alice', '', { scope: 'personal:private:alice' });
  ids.bob = seed('bobmark lighthouse keeper log kept by bob', '', { scope: 'personal:private:bob' });
  // Shares no word with the query, so only the vector arm can bring it in.
  ids.betaNear = seed('zebrafinch quokka marmalade', 'beta');
  const vectors: Record<string, number[]> = {};
  for (const id of [ids.acme, ids.beta, ids.global, ids.none, ids.other, ids.alice, ids.bob]) vectors[id] = [0.6, 0.8, 0];
  vectors[ids.betaNear] = [1, 0, 0];
  saveEmbeddingIndex(store, vectors);
  saveStoredEmbeddingModel(store, resolveEmbeddingProvider(store).id);

  ids.acmeSum = seed('acmesum rollup of the acme session work', 'acme', SUMMARY);
  ids.betaSum = seed('betasum rollup of the beta session work', 'beta', SUMMARY);
  ids.acmeRaw1 = raw('acme raw one opened the ticket', 'acme', ids.acmeSum);
  ids.acmeRaw2 = raw('acme raw two closed the ticket', 'acme', ids.acmeSum);
  ids.betaRaw1 = raw('beta raw one opened the ticket', 'beta', ids.betaSum);
  ids.betaRaw2 = raw('beta raw two closed the ticket', 'beta', ids.betaSum);
  // A DAG link across repos, which no writer makes today: the filter must hold on the summary and on its children.
  ids.acmeOdd1 = raw('acme odd one under the beta rollup', 'acme', ids.betaSum);
  ids.acmeOdd2 = raw('acme odd two under the beta rollup', 'acme', ids.betaSum);
  ids.nullRaw = raw('null raw with no project in the session', null);

  ids.acmeSumO = seed('overflow rollup for acme', 'acme', SUMMARY);
  ids.betaSumO = seed('overflow rollup for beta', 'beta', SUMMARY);
  for (let i = 0; i < 6; i++) {
    seed(`harbourline leaf ${i} under the acme rollup`, 'acme', { dag_level: 1, dag_parent_id: ids.acmeSumO });
    seed(`harbourline leaf ${i} under the beta rollup`, 'acme', { dag_level: 1, dag_parent_id: ids.betaSumO });
  }

  const pair = (a: string, b: string, reason: string) => ({ memory_a_id: a, memory_b_id: b, reason, score: 0.9 });
  const conflictRows = {
    acme: [seed('the acme cache must stay on during deploys', 'acme'), seed('the acme cache must stay off during deploys', 'acme')],
    beta: [seed('the beta cache must stay on during deploys', 'beta'), seed('the beta cache must stay off during deploys', 'beta')],
    slack: [seed('the slack cache must stay on during deploys', 'acme', { scope: 'slack:private:c1' }), seed('the slack cache must stay off during deploys', 'acme')],
    none: [seed('the null cache must stay on during deploys', null), seed('the null cache must stay off during deploys', null)],
  };
  replaceDetectedConflicts(store, Object.entries(conflictRows).map(([k, [a, b]]) => pair(a!, b!, `two-repo ${k}`)));
  const open = listMemoryConflicts(store, 'open', TENANT);
  const idOf = (k: string): number => open.find((c) => c.reason === `two-repo ${k}`)!.id;
  Object.assign(pairs, { acme: idOf('acme'), beta: idOf('beta'), slack: idOf('slack'), none: idOf('none') });

  saveActiveTaskSnapshot(store, TENANT, { task: 'acmetask ship the release', summary: 'acme summary', next_step: 'acme next', session_id: 'acme-s' }, { owner: 'alice', project: ['acme'] });
  saveActiveTaskSnapshot(store, TENANT, { task: 'betatask fix the build', summary: 'beta summary', next_step: 'beta next', session_id: 'beta-s' }, { owner: 'alice', project: ['beta'] });
  saveSessionHandoff(store, TENANT, { version: 1, sessionId: 'acme-s', summary: 'acmehandoff tagged the release' }, { owner: 'alice', project: ['acme'] });
  saveSessionHandoff(store, TENANT, { version: 1, sessionId: 'beta-s', summary: 'betahandoff pinned the compiler' }, { owner: 'alice', project: ['beta'] });

  handle = await serve({ hippoRoot: store, host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await handle?.stop();
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(origEnv)) restoreEnv(name, value);
  _resetSharedStoreCacheForTests();
  clearProjectIdentityCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP on a shared store with two repos', () => {
  it('hippo_recall shows each repo its rows, user-global rows and the caller\'s personal row, with embeddings on', async () => {
    expectOnly(await shown('acme', 'hippo_recall', { query: 'lighthouse' }), [ids.acme, ids.global, ids.alice], HIDDEN_FROM_ACME(), 'acme recall');
    expectOnly(await shown('beta', 'hippo_recall', { query: 'lighthouse' }), [ids.beta, ids.global, ids.alice, ids.betaNear], HIDDEN_FROM_BETA(), 'beta recall');
  });

  it('hippo_recall in physics mode keeps beta\'s nearest row out of acme', async () => {
    writeConfig({ physics: { enabled: true } });
    try {
      expectOnly(await shown('acme', 'hippo_recall', { query: 'lighthouse' }), [ids.acme], HIDDEN_FROM_ACME(), 'acme physics recall');
      expectOnly(await shown('beta', 'hippo_recall', { query: 'lighthouse' }), [ids.beta, ids.betaNear], HIDDEN_FROM_BETA(), 'beta physics recall');
    } finally {
      writeConfig();
    }
  });

  it('include_continuity gives each repo its own task snapshot', async () => {
    const acme = await tool('acme', 'hippo_recall', { query: 'lighthouse', include_continuity: true });
    expect(acme.text).toContain('acmetask');
    expect(acme.text).not.toContain('betatask');
    const beta = await tool('beta', 'hippo_recall', { query: 'lighthouse', include_continuity: true });
    expect(beta.text).toContain('betatask');
    expect(beta.text).not.toContain('acmetask');
  });

  it('hippo_assemble keeps one session\'s rows and summaries to the caller\'s repo', async () => {
    const acme = await tool('acme', 'hippo_assemble', { session_id: SESSION, fresh_tail_count: 0 });
    expect(acme.isError, acme.text).toBe(false);
    for (const id of [ids.acmeSum, ids.acmeOdd1, ids.acmeOdd2]) expect(acme.text, `acme assemble should show ${id}`).toContain(id);
    for (const id of [ids.betaSum, ids.betaRaw1, ids.betaRaw2, ids.nullRaw]) expect(acme.text, `acme assemble should hide ${id}`).not.toContain(id);

    const beta = await tool('beta', 'hippo_assemble', { session_id: SESSION, fresh_tail_count: 0 });
    expect(beta.isError, beta.text).toBe(false);
    expect(beta.text).toContain(ids.betaSum);
    for (const id of [ids.acmeSum, ids.acmeRaw1, ids.acmeRaw2, ids.acmeOdd1, ids.acmeOdd2, ids.nullRaw]) {
      expect(beta.text, `beta assemble should hide ${id}`).not.toContain(id);
    }
  });

  it('assemble cut short by its row cap counts only the caller\'s repo rows, not beta\'s or the NULL-origin one', async () => {
    const r = await assemble(apiCtx(), SESSION, { project: ACME, rowCap: 1, summarizeOlder: false });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(4);
  });

  it('hippo_drill answers not found for the other repo\'s summary and drops its children', async () => {
    const own = await tool('acme', 'hippo_drill', { summary_id: ids.acmeSum });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain(ids.acmeRaw1);
    expect((await tool('acme', 'hippo_drill', { summary_id: ids.betaSum })).text).toBe(`No drillable summary at id=${ids.betaSum}.`);

    const beta = await tool('beta', 'hippo_drill', { summary_id: ids.betaSum });
    expect(beta.isError, beta.text).toBe(false);
    expect(beta.text).toContain(ids.betaRaw1);
    expect(beta.text).not.toContain(ids.acmeOdd1);
    expect((await tool('beta', 'hippo_drill', { summary_id: ids.acmeSum })).text).toBe(`No drillable summary at id=${ids.acmeSum}.`);
  });

  it('hippo_drill on the other repo\'s leaf answers not found, and only the owning repo hears it is a leaf', async () => {
    expect((await tool('beta', 'hippo_drill', { summary_id: ids.acmeRaw1 })).text).toBe(`No drillable summary at id=${ids.acmeRaw1}.`);
    expect((await tool('acme', 'hippo_drill', { summary_id: ids.acmeRaw1 })).text).toContain('is a leaf row');
  });

  it('hippo_context returns the caller\'s repo and user-global rows only', async () => {
    expectOnly(await shown('acme', 'hippo_context'), [ids.acme, ids.global], HIDDEN_FROM_ACME(), 'acme context');
    expectOnly(await shown('beta', 'hippo_context'), [ids.beta, ids.global], HIDDEN_FROM_BETA(), 'beta context');
  });

  it('hippo_context gives each repo its own task snapshot and handoff, even when the other repo saved last', async () => {
    const taskState = async (repo: Repo): Promise<string[]> => {
      const r = await tool(repo, 'hippo_context');
      expect(r.isError, r.text).toBe(false);
      return ['acmetask', 'acmehandoff', 'betatask', 'betahandoff'].filter((word) => r.text.includes(word));
    };
    expect(await taskState('acme')).toEqual(['acmetask', 'acmehandoff']);
    saveActiveTaskSnapshot(store, TENANT, { task: 'acmetask ship the release', summary: 'acme summary', next_step: 'acme next', session_id: 'acme-s' }, { owner: 'alice', project: ['acme'] });
    expect(await taskState('beta')).toEqual(['betatask', 'betahandoff']);
  });

  it('hippo_conflicts lists the caller\'s repo pairs and hides NULL-origin and private-scope pairs', async () => {
    const acme = await tool('acme', 'hippo_conflicts');
    expect(acme.isError, acme.text).toBe(false);
    expect(acme.text).toContain(`conflict_${pairs.acme}:`);
    for (const id of [pairs.beta, pairs.slack, pairs.none]) expect(acme.text).not.toContain(`conflict_${id}:`);
    const beta = await tool('beta', 'hippo_conflicts');
    expect(beta.text).toContain(`conflict_${pairs.beta}:`);
    for (const id of [pairs.acme, pairs.slack, pairs.none]) expect(beta.text).not.toContain(`conflict_${id}:`);
  });

  it('overflow substitution never brings in another repo\'s parent summary', () => {
    const summaries = recall(apiCtx(), { query: 'harbourline', limit: 4, project: ACME }).results.filter((r) => r.isSummary).map((r) => r.id);
    expect(summaries).toContain(ids.acmeSumO);
    expect(summaries).not.toContain(ids.betaSumO);
  });

  it('hippo_remember stamps the caller\'s repo, and hippo_outcome touches only what that repo recalled', async () => {
    const remembered = await tool('acme', 'hippo_remember', { text: 'the acme repo pins node twenty two' });
    const newId = /Remembered \[([^\]]+)\]/.exec(remembered.text)?.[1] ?? '';
    expect(readEntry(store, newId)?.origin_project, remembered.text).toBe('acme');

    await shown('beta', 'hippo_recall', { query: 'lighthouse' });
    await shown('acme', 'hippo_recall', { query: 'lighthouse' });
    const before = new Map(loadAllEntries(store).map((e) => [e.id, e.outcome_positive]));
    const applied = await tool('acme', 'hippo_outcome', { good: true });
    expect(applied.text).toMatch(/Applied positive outcome to [1-9]\d* memories/);
    const touched = loadAllEntries(store).filter((e) => e.outcome_positive !== before.get(e.id)).map((e) => e.id);
    expectOnly(touched, [ids.acme], HIDDEN_FROM_ACME(), 'acme outcome');
  });
});
