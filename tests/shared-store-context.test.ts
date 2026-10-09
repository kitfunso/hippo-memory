// Context reads on a store flagged `"sharedStore": true` must name the caller's project, so no member sees another's rows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { adminActor, getContext, type Context } from '../src/api/index.js';
import { BadRequestError } from '../src/core/api-errors.js';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { log } from '../src/util/log.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

const REFUSAL = 'hippo_context needs a project on a shared store; use hippo_recall';
const GATE = "hippo_context needs the caller's project on a shared store; the client sends it in the X-Hippo-Project header";
const ROWS = {
  acme: 'acme deploys go through the blue green switch',
  alias: 'acme alias rows keep the old repo name',
  beta: 'beta keeps its feature flags in launchdarkly',
  none: 'a row nobody named a project for',
  global: 'the operator likes tabs over spaces',
} as const;

interface ContextBody { readonly entries: ReadonlyArray<{ readonly entry: { readonly content: string } }> }
interface McpBody { readonly result?: { readonly content: ReadonlyArray<{ readonly text: string }>; readonly isError?: boolean } }

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only this file's /v1/context and /mcp replies, whose fields the callers assert on next.
  return (await res.json()) as T;
}

let home: string;
let globalHome: string;
let handle: ServerHandle | null = null;
const origHippoHome = process.env.HIPPO_HOME;

/** A served store holding one row per origin, beside a global store with one user-global row. */
async function start(flagged: boolean, extra: Record<string, boolean> = {}): Promise<ServerHandle> {
  const config = flagged ? { ...extra, sharedStore: true } : extra;
  home = makeRoot('shared-ctx', Object.keys(config).length > 0 ? { config } : {});
  writeEntry(home, { ...createMemory(ROWS.acme), origin_project: 'acme/app' });
  writeEntry(home, { ...createMemory(ROWS.alias), origin_project: 'app' });
  writeEntry(home, { ...createMemory(ROWS.beta), origin_project: 'beta' });
  writeEntry(home, { ...createMemory(ROWS.none), origin_project: null });
  initStore(globalHome);
  writeEntry(globalHome, { ...createMemory(ROWS.global), origin_project: '' });
  handle = await serve({ hippoRoot: home, port: 0 });
  return handle;
}

async function contextTexts(h: ServerHandle, query: string, headers: Record<string, string> = {}): Promise<{ status: number; texts: readonly string[] }> {
  const res = await fetch(`${h.url}/v1/context${query}`, { headers });
  if (res.status !== 200) return { status: res.status, texts: [] };
  const body = await jsonAs<ContextBody>(res);
  return { status: 200, texts: body.entries.map((e) => e.entry.content) };
}

async function mcpContext(h: ServerHandle, headers: Record<string, string> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${h.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: {} } }),
  });
  expect(res.status).toBe(200);
  const result = (await jsonAs<McpBody>(res)).result;
  return { text: result?.content?.[0]?.text ?? '', isError: result?.isError === true };
}

beforeEach(() => {
  _resetSharedStoreCacheForTests();
  globalHome = makeRoot('shared-ctx-global');
  process.env.HIPPO_HOME = globalHome;
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHippoHome;
  _resetSharedStoreCacheForTests();
  rmSync(home, { recursive: true, force: true });
  rmSync(globalHome, { recursive: true, force: true });
});

describe('context reads on a shared store', () => {
  it('GET /v1/context with no project answers 400', async () => {
    const h = await start(true);
    expect((await contextTexts(h, '')).status).toBe(400);
  });

  it("GET /v1/context?project= returns the caller's rows and no other project's, NULL or global row", async () => {
    const h = await start(true);
    const { status, texts } = await contextTexts(h, '?project=acme%2Fapp&alias=app');
    expect(status).toBe(200);
    expect(texts).toContain(ROWS.acme);
    expect(texts).toContain(ROWS.alias);
    for (const hidden of [ROWS.beta, ROWS.none, ROWS.global]) expect(texts).not.toContain(hidden);
  });

  it('GET /v1/context refuses a blank project, too many aliases and an overlong name', async () => {
    const h = await start(true);
    const elevenAliases = Array.from({ length: 11 }, (_, i) => `alias=a${i}`).join('&');
    for (const query of ['?project=%20%20', `?project=acme&${elevenAliases}`, `?project=${'x'.repeat(257)}`]) {
      expect((await contextTexts(h, query)).status).toBe(400);
    }
  });

  it('GET /v1/context refuses a name or alias with capitals, padding or a colon', async () => {
    const h = await start(true);
    for (const query of ['?project=Acme%2Fapp', '?project=%20acme%2Fapp', '?project=acme%3Aapp', '?project=acme%2Fapp&alias=App']) {
      expect((await contextTexts(h, query)).status, query).toBe(400);
    }
  });

  it('GET /v1/context answers 401 for a bad key before it looks at the project', async () => {
    const h = await start(true);
    const bogus = { authorization: 'Bearer hk_bogus' };
    for (const query of ['', '?project=Acme%2Fapp']) expect((await contextTexts(h, query, bogus)).status, query).toBe(401);
  });

  it('GET /v1/context with cross_project=1 opts in to other projects and NULL rows, never the global store', async () => {
    const h = await start(true);
    const { status, texts } = await contextTexts(h, '?project=acme%2Fapp&cross_project=1');
    expect(status).toBe(200);
    expect(texts).toEqual(expect.arrayContaining([ROWS.acme, ROWS.beta, ROWS.none]));
    expect(texts).not.toContain(ROWS.global);
  });

  it('ignores contextProjectIsolation: false with one warning per store', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const h = await start(true, { contextProjectIsolation: false });
      for (let i = 0; i < 2; i++) {
        const { status, texts } = await contextTexts(h, '?project=acme%2Fapp');
        expect(status).toBe(200);
        expect(texts).toContain(ROWS.acme);
        for (const hidden of [ROWS.beta, ROWS.none, ROWS.global]) expect(texts).not.toContain(hidden);
      }
      expect(warn.mock.calls.filter(([m]) => String(m).includes('contextProjectIsolation'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('MCP hippo_context with no project header answers with an error refusal', async () => {
    const h = await start(true);
    expect(await mcpContext(h)).toEqual({ text: GATE, isError: true });
  });

  it("MCP hippo_context with X-Hippo-Project returns the caller's and alias rows and no other project's, NULL or global row", async () => {
    const h = await start(true);
    const { text, isError } = await mcpContext(h, { 'x-hippo-project': 'acme%2Fapp', 'x-hippo-project-aliases': 'app' });
    expect(isError, text).toBe(false);
    expect(text).toContain(ROWS.acme);
    expect(text).toContain(ROWS.alias);
    for (const hidden of [ROWS.beta, ROWS.none, ROWS.global]) expect(text).not.toContain(hidden);
  });

  it("getContext refuses a caller with no project", async () => {
    await start(true);
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: adminActor('shared-ctx-test') };
    await expect(getContext(ctx, { currentProject: '' })).rejects.toBeInstanceOf(BadRequestError);
    await expect(getContext(ctx, { currentProject: { name: '  ', legacyName: '' } })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('context reads on a store that is not shared', () => {
  it('GET /v1/context reads as the served folder and ignores a project param', async () => {
    const h = await start(false);
    const plain = await contextTexts(h, '');
    expect(plain.status).toBe(200);
    expect([...plain.texts].sort()).toEqual(Object.values(ROWS).sort());
    // A read strengthens what it returns, so the second read may order the same rows differently.
    const withParam = await contextTexts(h, '?project=beta');
    expect(withParam.status).toBe(200);
    expect([...withParam.texts].sort()).toEqual(Object.values(ROWS).sort());
  });

  it('MCP hippo_context answers without a refusal', async () => {
    const h = await start(false);
    expect((await mcpContext(h)).text).not.toBe(REFUSAL);
  });
});

function armRows(root: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names one column, n.
    return (db.prepare(`SELECT COUNT(*) AS n FROM token_ledger WHERE event = 'arm'`).get() as { n: number }).n;
  } finally {
    closeHippoDb(db);
  }
}

describe('the prompt hook on a shared store', () => {
  const PILOT = { pilot: { holdoutRateBp: 10000 } };

  async function refusesBeforeTheArm(root: string, opts: { sharedStore?: true }): Promise<void> {
    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: adminActor('shared-ctx-test') };
    const names = ['', '  ', 'Acme/App'];
    for (const [i, name] of names.entries()) {
      await expect(promptHookContext(ctx, { sessionId: `s-${i}`, project: { name, legacyName: '' } }, opts)).rejects.toBeInstanceOf(BadRequestError);
    }
    expect(armRows(root)).toBe(0);
  }

  it('refuses a blank or mixed-case project before it books a pilot arm, on a flagged store', async () => {
    home = makeRoot('shared-hook', { config: { sharedStore: true, ...PILOT } });
    await refusesBeforeTheArm(home, {});
  });

  it('does the same when the route says the store is shared', async () => {
    home = makeRoot('shared-hook-opt', { config: PILOT });
    await refusesBeforeTheArm(home, { sharedStore: true });
  });
});

describe('hippo context on a shared store', () => {
  it('exits 1 with the refusal when the folder names no project', () => {
    home = makeRoot('shared-cli', { config: { sharedStore: true } });
    const cwd = mkdtempSync(join(tmpdir(), 'hippo-shared-cli-cwd-'));
    try {
      const r = spawnSync(process.execPath, [resolve(__dirname, '..', 'bin', 'hippo.js'), 'context'], {
        cwd, env: { ...process.env, HIPPO_HOME: home }, encoding: 'utf8', timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("a shared store needs the caller's project");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
