// tests/aml-adapter.test.ts
//
// Exercises deploy/aml/adapter/adapter.mjs against a real hippo store and a
// real hippo HTTP server, spawned in a child process exactly the way it runs
// in production (deploy/aml/entrypoint.sh starts hippo, the adapter runs as
// its own process in front of it). Every request in this suite goes over
// real HTTP, no mocks.
//
// Store-root convention follows tests/serve-nonloopback-auth.test.ts's
// makeEnv: the store root passed to initStore/serve IS the .hippo directory
// itself, not its parent. HIPPO_REQUIRE_AUTH=1 is set the same way that test
// sets it, so the throwaway hippo server in this suite enforces Bearer auth
// exactly like the production deployment (deploy/aml/Dockerfile bakes in the
// same env var) -- without it, hippo's loopback no-auth fallback would admit
// unauthenticated local requests and the "no credential -> 401" case below
// would never actually exercise auth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

const ADAPTER_PATH = fileURLToPath(new URL('../deploy/aml/adapter/adapter.mjs', import.meta.url));

interface SearchRow {
  id: string;
  content: string;
  score?: number;
  created_at?: string;
}

async function waitForAdapterReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`adapter never became reachable at ${baseUrl}: ${String(lastErr)}`);
}

describe('AML protocol adapter (deploy/aml/adapter/adapter.mjs)', () => {
  let hippoRoot: string;
  let hippoHandle: ServerHandle;
  let adapterProcess: ChildProcess;
  let baseUrl: string;
  let validKey: string;
  const stderrChunks: Buffer[] = [];
  const savedRequireAuth = process.env.HIPPO_REQUIRE_AUTH;

  beforeAll(async () => {
    hippoRoot = join(mkdtempSync(join(tmpdir(), 'hippo-aml-adapter-')), '.hippo');
    initStore(hippoRoot);

    // Match the production deployment: hippo requires auth on every route
    // except GET /health. Without this, hippo's loopback no-auth fallback
    // would silently admit the adapter's unauthenticated forwards.
    process.env.HIPPO_REQUIRE_AUTH = '1';
    hippoHandle = await serve({ hippoRoot, host: '127.0.0.1', port: 0 });

    const db = openHippoDb(hippoRoot);
    try {
      ({ plaintext: validKey } = createApiKey(db, { tenantId: 'default', label: 'aml-adapter-test' }));
    } finally {
      closeHippoDb(db);
    }

    const adapterReady = new Promise<number>((resolve, reject) => {
      let stdoutBuf = '';
      adapterProcess = spawn(process.execPath, [ADAPTER_PATH], {
        env: {
          ...process.env,
          ADAPTER_PORT: '0',
          HIPPO_URL: `http://127.0.0.1:${hippoHandle.port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      adapterProcess.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const match = /listening on :(\d+)/.exec(stdoutBuf);
        if (match) resolve(Number(match[1]));
      });
      adapterProcess.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      adapterProcess.once('error', reject);
      adapterProcess.once('exit', (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`adapter process exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
        }
      });
    });

    const adapterPort = await adapterReady;
    baseUrl = `http://127.0.0.1:${adapterPort}`;
    await waitForAdapterReady(baseUrl);
  }, 30_000);

  afterAll(async () => {
    adapterProcess?.kill();
    await hippoHandle?.stop();
    if (savedRequireAuth === undefined) {
      delete process.env.HIPPO_REQUIRE_AUTH;
    } else {
      process.env.HIPPO_REQUIRE_AUTH = savedRequireAuth;
    }
    rmSync(hippoRoot, { recursive: true, force: true });
  });

  function authHeader(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}` };
  }

  async function postAdd(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function postSearch(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  // 1. Health -----------------------------------------------------------

  it('GET /health: 200 with no auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  // 2. Add happy path + persistence --------------------------------------

  it('POST /add happy path: 200, ids echoed byte-exactly, row is findable via /search', async () => {
    const request_id = 'req-happy-0001';
    const user_id = 'user-happy';
    const session_id = 'sess-happy';

    const addRes = await postAdd(
      {
        request_id,
        user_id,
        session_id,
        messages: [{ role: 'user', content: 'aml-happy-path-marker distinctive text' }],
      },
      authHeader(validKey),
    );
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json();
    expect(addBody).toEqual({ success: true, request_id, user_id, session_id });

    const searchRes = await postSearch(
      { query: 'aml-happy-path-marker', user_id, top_k: 5 },
      authHeader(validKey),
    );
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(Array.isArray(searchBody.data)).toBe(true);
    const found = (searchBody.data as SearchRow[]).some((row) =>
      row.content.includes('aml-happy-path-marker'),
    );
    expect(found).toBe(true);
  });

  // 3. Isolation (load-bearing) -------------------------------------------

  it('isolates by user_id: user_a search excludes user_b rows and an unscoped row written directly to hippo', async () => {
    const marker = 'aml-isolation-marker-77';

    const addA = await postAdd(
      {
        request_id: 'iso-a-1',
        user_id: 'user-a-iso',
        session_id: 'sess-a-iso',
        messages: [{ role: 'user', content: `${marker} row-a content` }],
      },
      authHeader(validKey),
    );
    expect(addA.status).toBe(200);

    const addB = await postAdd(
      {
        request_id: 'iso-b-1',
        user_id: 'user-b-iso',
        session_id: 'sess-b-iso',
        messages: [{ role: 'user', content: `${marker} row-b content` }],
      },
      authHeader(validKey),
    );
    expect(addB.status).toBe(200);

    // Bypasses the adapter entirely: talks straight to hippo with no scope.
    const directRes = await fetch(`http://127.0.0.1:${hippoHandle.port}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(validKey) },
      body: JSON.stringify({ content: `${marker} row-unscoped content, written direct to hippo` }),
    });
    expect(directRes.status).toBe(200);

    const searchRes = await postSearch(
      { query: marker, user_id: 'user-a-iso', top_k: 10 },
      authHeader(validKey),
    );
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    const contents = (searchBody.data as SearchRow[]).map((row) => row.content);

    const hasA = contents.some((c) => c.includes('row-a content'));
    const hasB = contents.some((c) => c.includes('row-b content'));
    const hasUnscoped = contents.some((c) => c.includes('row-unscoped content'));

    expect(hasA).toBe(true);
    expect(hasB).toBe(false);

    // OBSERVED (verified by running this suite, not inferred): hippo's
    // GET /v1/memories?scope=X applies an EXACT-match filter once a
    // non-empty scope is passed (src/api.ts recall(), line ~758:
    // `entries = all.filter((e) => e.scope === opts.scope)`), and a
    // directly-written row with no `scope` field has scope=null, which
    // fails that exact match against 'aml/user-a-iso'. So the unscoped row
    // does NOT leak into a scoped search. Operational consequence: an
    // eval store that already has legacy unscoped rows in it does NOT need
    // to start fresh for THIS adapter's isolation to hold, because the
    // adapter always sends an explicit non-empty scope on both routes.
    expect(hasUnscoped).toBe(false);
  });

  // 4. Search shape ---------------------------------------------------

  it('POST /search: data array, items carry id + content, capped at top_k', async () => {
    const user_id = 'user-shape';
    const marker = 'aml-shape-marker-42';

    await postAdd(
      {
        request_id: 'shape-1',
        user_id,
        session_id: 'sess-shape-1',
        messages: [{ role: 'user', content: `${marker} first row` }],
      },
      authHeader(validKey),
    );
    await postAdd(
      {
        request_id: 'shape-2',
        user_id,
        session_id: 'sess-shape-2',
        messages: [{ role: 'user', content: `${marker} second row` }],
      },
      authHeader(validKey),
    );

    const res = await postSearch({ query: marker, user_id, top_k: 1 }, authHeader(validKey));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(1);
    for (const row of body.data as SearchRow[]) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.content).toBe('string');
    }
  });

  it('POST /search: an empty result set is a valid 200 with data: []', async () => {
    const res = await postSearch(
      { query: 'no-such-content-anywhere-zzz-999', user_id: 'user-empty-search', top_k: 5 },
      authHeader(validKey),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
  });

  // 5. Auth ------------------------------------------------------------

  describe('auth', () => {
    it('no credential -> 401', async () => {
      const res = await postSearch({ query: 'x', user_id: 'user-auth', top_k: 1 });
      expect(res.status).toBe(401);
    });

    it('X-Api-Key header works', async () => {
      const res = await postSearch(
        { query: 'x', user_id: 'user-auth', top_k: 1 },
        { 'X-Api-Key': validKey },
      );
      expect(res.status).toBe(200);
    });

    it('Authorization: Token <key> works', async () => {
      const res = await postSearch(
        { query: 'x', user_id: 'user-auth', top_k: 1 },
        { Authorization: `Token ${validKey}` },
      );
      expect(res.status).toBe(200);
    });

    it('garbage key -> 401', async () => {
      const res = await postSearch(
        { query: 'x', user_id: 'user-auth', top_k: 1 },
        { Authorization: 'Bearer not-a-real-key' },
      );
      expect(res.status).toBe(401);
    });
  });

  // 6. Validation --------------------------------------------------------

  describe('validation', () => {
    it('POST /add missing request_id -> 400', async () => {
      const res = await postAdd(
        {
          user_id: 'user-val',
          session_id: 'sess-val',
          messages: [{ role: 'user', content: 'hi' }],
        },
        authHeader(validKey),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    });

    it('POST /add empty messages -> 400', async () => {
      const res = await postAdd(
        {
          request_id: 'req-val-2',
          user_id: 'user-val',
          session_id: 'sess-val',
          messages: [],
        },
        authHeader(validKey),
      );
      expect(res.status).toBe(400);
    });

    it('POST /search missing user_id -> 400', async () => {
      const res = await postSearch({ query: 'x', top_k: 1 }, authHeader(validKey));
      expect(res.status).toBe(400);
    });
  });

  // 7. Transcript joining --------------------------------------------------

  it('joins messages into "<role>: <content>" lines before writing to hippo', async () => {
    const user_id = 'user-transcript';
    const addRes = await postAdd(
      {
        request_id: 'req-transcript-1',
        user_id,
        session_id: 'sess-transcript',
        messages: [
          { role: 'user', content: 'zqx7' },
          { role: 'assistant', content: 'wvk3' },
        ],
      },
      authHeader(validKey),
    );
    expect(addRes.status).toBe(200);

    const searchRes = await postSearch({ query: 'zqx7 wvk3', user_id, top_k: 5 }, authHeader(validKey));
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    const row = (searchBody.data as SearchRow[]).find(
      (r) => r.content.includes('zqx7') && r.content.includes('wvk3'),
    );
    expect(row).toBeDefined();
    expect(row!.content).toContain('user: zqx7');
    expect(row!.content).toContain('assistant: wvk3');
  });
});
