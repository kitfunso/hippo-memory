import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { runCli as runCliEntry } from '../../src/cli.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { generateId } from '../../src/base/memory/entry.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { AuthResolver } from '../../src/surface/server/types.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { serveKeyed, type KeyedServer } from '../_helpers/keyed-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const ROW_TEXT = 'the vellichorn sluice gate sticks after a thaw';
const SECRET_TEXT = 'service api key sk_vendor_deadbeef123456 for the ingest worker';
const NEEDS_PROJECT = "a shared store needs the caller's project";
const GRANT_SCOPE = 'slack:private:alpha-ops';
const ALPHA = { project: { name: 'alpha' } };
const BETA = { project: { name: 'beta' } };

interface Reply {
  readonly status: number;
  readonly text: string;
}
interface Key {
  readonly plaintext: string;
  readonly keyId: string;
}

const resolver: AuthResolver = (token) => {
  if (token === 'signin-adm') return { tenantId: 'default', subject: 'oid-adm', role: 'admin' };
  if (token === 'signin-b-grant') {
    return { tenantId: 'default', subject: 'oid-b', role: 'member', scopes: [GRANT_SCOPE] };
  }
  return null;
};

function mint(root: string, label: string, role: 'admin' | 'member', ownerSubject?: string): Key {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', label, role, ownerSubject });
  } finally {
    closeHippoDb(db);
  }
}

async function promoteRows(
  root: string,
): Promise<Array<{ actor: string; targetId: string | null; metadata?: unknown }>> {
  const store = sqliteStore(root);
  try {
    return await store.auditLog.listAuditEvents({ tenantId: 'default', op: 'promote' });
  } finally {
    await store.close();
  }
}

async function sameAsMissing(id: string, run: (id: string) => Promise<Reply>, status?: number): Promise<void> {
  const fake = generateId();
  const real = await run(id);
  const missing = await run(fake);
  expect({ status: real.status, text: real.text.split(id).join('<id>') }).toEqual({
    status: missing.status,
    text: missing.text.split(fake).join('<id>'),
  });
  if (status !== undefined) expect(real.status, real.text).toBe(status);
}

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('promote on a shared store over HTTP', () => {
  let tmp: string;
  let store: string;
  let handle: ServerHandle;
  let A: Key;
  let B: Key;
  let ADM: Key;
  const ids = { row: '', old: '', next: '', secret: '', grant: '', quar: '' };

  async function http(token: string, method: string, route: string, body?: JsonValue): Promise<Reply> {
    const res = await fetch(`${handle.url}${route}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }
  const promoteAs = (token: string, id: string, body: JsonValue = {}): Promise<Reply> =>
    http(token, 'POST', `/v1/memories/${id}/promote`, body);

  async function post(token: string, body: Record<string, JsonValue>): Promise<string> {
    const r = await http(token, 'POST', '/v1/memories', body);
    if (r.status !== 200) throw new Error(`write refused ${r.status}: ${r.text}`);
    // SAFETY: a 200 from POST /v1/memories carries the new row's id.
    return (JSON.parse(r.text) as { id: string }).id;
  }

  async function contextIds(token: string, query: string): Promise<string[]> {
    const r = await http(token, 'GET', `/v1/context?${query}`);
    expect(r.status, r.text).toBe(200);
    // SAFETY: a 200 from GET /v1/context is a bundle whose entries each carry the row.
    return (JSON.parse(r.text) as { entries: Array<{ entry: { id: string } }> }).entries.map((x) => x.entry.id);
  }

  const countRows = (): number => loadAllEntries(store, 'default').length;

  function seed(content: string, patch: { scope?: string }): string {
    const row = {
      ...createMemory(content, { tenantId: 'default', scope: patch.scope ?? null }),
      originProject: 'alpha',
    };
    writeEntry(store, row);
    return row.id;
  }

  beforeAll(async () => {
    tmp = makeRoot('promote-shared', { init: false });
    vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
    vi.stubEnv('HIPPO_V1_RPS', '0');
    store = path.join(tmp, 'srv', 'hippo-team');
    fs.mkdirSync(store, { recursive: true });
    initTestStore(store);
    fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true }));
    A = mint(store, 'promote-a', 'member', 'oid-a');
    B = mint(store, 'promote-b', 'member', 'oid-b');
    ADM = mint(store, 'promote-adm', 'admin');
    ids.secret = seed(SECRET_TEXT, {});
    ids.grant = seed('the alpha ops runbook lives on the blue shelf', { scope: GRANT_SCOPE });
    ids.quar = seed('the quarantined alpha note awaits review', { scope: 'quarantine:private:unscoped' });
    handle = await serve({ hippoRoot: store, host: '127.0.0.1', port: 0, authResolver: resolver });
    ids.row = await post(A.plaintext, { content: ROW_TEXT, ...ALPHA });
    ids.old = await post(A.plaintext, { content: 'the alpha ferry leaves at nine', ...ALPHA });
    const sup = await http(ADM.plaintext, 'POST', `/v1/memories/${ids.old}/supersede`, {
      content: 'the alpha ferry leaves at ten',
    });
    expect(sup.status, sup.text).toBe(200);
    // SAFETY: a 200 from the supersede route names the successor as newId.
    ids.next = (JSON.parse(sup.text) as { newId: string }).newId;
  });

  afterAll(async () => {
    await handle?.stop();
  });

  it('P1 promotes in place: no copy, no remember row, one promote audit row, nothing in the global store', async () => {
    const before = { rows: countRows(), audit: (await promoteRows(store)).length };
    const r = await promoteAs(A.plaintext, ids.row, ALPHA);
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, sourceId: ids.row, globalId: ids.row, originProject: 'alpha' });
    expect(countRows()).toBe(before.rows);
    expect(loadAllEntries(store, 'default').filter((e) => e.id.startsWith('g_'))).toEqual([]);
    const rows = await promoteRows(store);
    expect(rows).toHaveLength(before.audit + 1);
    expect(rows[0]).toMatchObject({
      actor: `api_key:${A.keyId}`,
      targetId: ids.row,
      metadata: { sourceId: ids.row },
    });
    const globalDb = path.join(tmp, 'global', 'hippo.db');
    expect(!fs.existsSync(globalDb) || loadAllEntries(path.join(tmp, 'global'), 'default').length === 0).toBe(true);
  });

  it('P1b a dedupe after the promote removes nothing', async () => {
    const before = countRows();
    const st = sqliteStore(store);
    try {
      expect((await deduplicateStore(st, { actor: 'test' })).removed).toBe(0);
    } finally {
      await st.close();
    }
    expect(countRows()).toBe(before);
    expect(loadAllEntries(store, 'default').some((e) => e.id === ids.row)).toBe(true);
  });

  it('P2 the beta read does not see the row; the alpha read does; one row holds the content', async () => {
    expect(await contextIds(B.plaintext, 'project=beta&q=vellichorn')).not.toContain(ids.row);
    expect(await contextIds(A.plaintext, 'project=alpha&q=vellichorn')).toContain(ids.row);
    expect(loadAllEntries(store, 'default').filter((e) => e.content === ROW_TEXT)).toHaveLength(1);
  });

  it('P3 another project reads every row as a missing id, whatever the row would be refused for', async () => {
    const before = (await promoteRows(store)).length;
    for (const id of [ids.row, ids.old, ids.secret]) {
      await sameAsMissing(id, (x) => promoteAs(B.plaintext, x, BETA), 404);
    }
    await sameAsMissing(ids.grant, (x) => promoteAs('signin-b-grant', x, BETA), 404);
    await sameAsMissing(ids.quar, (x) => promoteAs('signin-adm', x, BETA), 404);
    expect((await promoteRows(store)).length).toBe(before);
  });

  it('P4 the project owner gets the laptop vetoes: 409 for a superseded row, 400 for a secret', async () => {
    const before = (await promoteRows(store)).length;
    const old = await promoteAs(A.plaintext, ids.old, ALPHA);
    expect(old.status, old.text).toBe(409);
    expect(old.text).toContain(
      `Refusing to promote ${ids.old}: it is superseded by ${ids.next}; promote that one instead.`,
    );
    const secret = await promoteAs(A.plaintext, ids.secret, ALPHA);
    expect(secret.status, secret.text).toBe(400);
    expect(secret.text).toContain('content matches secret material');
    expect((await promoteRows(store)).length).toBe(before);
  });

  it('P5 a member needs a project; a host admin key needs none; a resolver admin is a member here', async () => {
    const noProject = await promoteAs(A.plaintext, ids.row, {});
    expect(noProject.status, noProject.text).toBe(400);
    expect(noProject.text).toContain(NEEDS_PROJECT);
    const host = await promoteAs(ADM.plaintext, ids.row, {});
    expect(host.status, host.text).toBe(200);
    expect(JSON.parse(host.text)).toEqual({ ok: true, sourceId: ids.row, globalId: ids.row, originProject: 'alpha' });
    const resolved = await promoteAs('signin-adm', ids.row, {});
    expect(resolved.status, resolved.text).toBe(400);
    expect(resolved.text).toContain(NEEDS_PROJECT);
  });

  it('P5b a member promotes a user-global row in place', async () => {
    const row = {
      ...createMemory('the shared kettle is descaled monthly', { tenantId: 'default' }),
      originProject: '',
    };
    writeEntry(store, row);
    const before = { rows: countRows(), audit: (await promoteRows(store)).length };
    const r = await promoteAs(A.plaintext, row.id, ALPHA);
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, sourceId: row.id, globalId: row.id, originProject: '' });
    expect(countRows()).toBe(before.rows);
    expect(loadAllEntries(store, 'default').filter((e) => e.id.startsWith('g_'))).toEqual([]);
    expect(await promoteRows(store)).toHaveLength(before.audit + 1);
  });

  it('P5c a member naming an alias of its project promotes a row stamped with that alias', async () => {
    const row = {
      ...createMemory('the alpha crane was inspected in june', { tenantId: 'default' }),
      originProject: 'alpha-old',
    };
    writeEntry(store, row);
    const body = { project: { name: 'alpha', aliases: ['alpha-old'] } };
    const before = (await promoteRows(store)).length;
    const r = await promoteAs(A.plaintext, row.id, body);
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, sourceId: row.id, globalId: row.id, originProject: 'alpha-old' });
    expect(await promoteRows(store)).toHaveLength(before + 1);
    await sameAsMissing(row.id, (x) => promoteAs(A.plaintext, x, ALPHA), 404);
  });
});

describe('hippo promote in a shared folder', () => {
  const savedCwd = process.cwd();
  let tmp2: string;
  let root: string;
  let server: KeyedServer | undefined;
  const ids = { cli: '', beta: '', own: '' };

  async function runCli(...args: string[]): Promise<{ out: string; status: number }> {
    const res = await runInProcess(() => runCliEntry(['node', 'hippo', ...args]));
    return { out: res.status === 0 ? res.stdout : res.stdout + res.stderr, status: res.status };
  }

  function seed(content: string, origin: string): string {
    const row = { ...createMemory(content, { tenantId: 'default' }), originProject: origin };
    writeEntry(root, row);
    return row.id;
  }

  beforeAll(async () => {
    tmp2 = makeRoot('promote-cli', { init: false });
    vi.stubEnv('HIPPO_HOME', path.join(tmp2, 'global'));
    vi.stubEnv('HIPPO_TENANT', 'default');
    vi.stubEnv('HIPPO_API_KEY', undefined);
    root = path.join(tmp2, 'team', '.hippo');
    fs.mkdirSync(root, { recursive: true });
    initTestStore(root);
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ sharedStore: true, embeddings: { enabled: false } }),
    );
    fs.writeFileSync(path.join(tmp2, 'team', '.hippo-project.json'), JSON.stringify({ id: 'alpha' }));
    process.chdir(path.join(tmp2, 'team'));
    ids.cli = seed('the alpha loading dock opens at six', 'alpha');
    ids.beta = seed('the beta loading dock opens at seven', 'beta');
  });

  afterAll(async () => {
    process.chdir(savedCwd);
    await server?.stop();
  });

  it('P6 with no server it promotes in place as the CLI, and says nothing of a global store', async () => {
    const r = await runCli('promote', ids.cli);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('in place');
    expect(r.out).toContain('already serves it to its project');
    expect(r.out).not.toContain('global store');
    expect(r.out).not.toContain(path.join(tmp2, 'global'));
    const rows = await promoteRows(root);
    expect(rows.map((x) => [x.actor, x.targetId])).toContainEqual(['cli', ids.cli]);
  });

  it('P7b a row the CLI remembered here has no project; with no server it promotes', async () => {
    const made = await runCli('remember', 'the alpha night shift swaps at midnight', '--force');
    expect(made.status, made.out).toBe(0);
    ids.own =
      loadAllEntries(root, 'default').find((e) => e.content === 'the alpha night shift swaps at midnight')?.id ?? '';
    expect(ids.own).not.toBe('');
    const r = await runCli('promote', ids.own);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('in place');
    expect(r.out).toContain("This row has no project, so a member's project-scoped context read leaves it out");
    expect(r.out).not.toContain('serves it to its project');
  });

  it('P7 with a server running it goes through the server, sends the folder project, and a row of another project is not found', async () => {
    server = await serveKeyed({ hippoRoot: root, port: 0 }, serve);
    const before = (await promoteRows(root)).length;
    const ok = await runCli('promote', ids.cli);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain('in place');
    expect(ok.out).not.toContain('global store');
    const rows = await promoteRows(root);
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ actor: 'localhost:cli', targetId: ids.cli });

    const other = await runCli('promote', ids.beta);
    expect(other.status).not.toBe(0);
    expect(other.out).toContain(`Failed to promote: memory not found: ${ids.beta}`);

    const own = await runCli('promote', ids.own);
    expect(own.status).not.toBe(0);
    expect(own.out).toContain('Failed to promote: memory not found');
    expect(await promoteRows(root)).toHaveLength(before + 1);
  });

  it('P7c with a server running a row stamped with the legacy folder name reads as not found', async () => {
    const legacy = seed('the legacy folder dock opens at eight', 'team');
    const before = (await promoteRows(root)).length;
    const r = await runCli('promote', legacy);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`Failed to promote: memory not found: ${legacy}`);
    expect(await promoteRows(root)).toHaveLength(before);
  });
});
