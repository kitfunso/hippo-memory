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

interface AdapterHandle {
  child: ChildProcess;
  baseUrl: string;
  stderrChunks: Buffer[];
}

// Shared by both describe blocks below so a second real server pair costs
// one call, not a second copy of the spawn wiring.
function spawnAdapter(hippoPort: number): Promise<AdapterHandle> {
  const stderrChunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    // stdout keeps growing with access-log lines, so the regex matches again on every chunk.
    let readyStarted = false;
    const child = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        ADAPTER_PORT: '0',
        HIPPO_URL: `http://127.0.0.1:${hippoPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // No handle reaches the caller on a failed start, so the helper must reap its own child.
    const fail = (err: unknown): void => {
      clearTimeout(startupTimer);
      child.kill();
      reject(err);
    };
    const startupTimer = setTimeout(() => fail(new Error('adapter never printed its listening line')), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const match = /listening on :(\d+)/.exec(stdoutBuf);
      if (match && !readyStarted) {
        readyStarted = true;
        const baseUrl = `http://127.0.0.1:${Number(match[1])}`;
        waitForAdapterReady(baseUrl)
          .then(() => {
            clearTimeout(startupTimer);
            resolve({ child, baseUrl, stderrChunks });
          })
          .catch(fail);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        fail(new Error(`adapter process exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
      }
    });
  });
}

function stopAdapter(handle: AdapterHandle | undefined): void {
  handle?.child.kill();
}

describe('AML protocol adapter (deploy/aml/adapter/adapter.mjs)', () => {
  let hippoRoot: string;
  let hippoHandle: ServerHandle;
  let adapterHandle: AdapterHandle;
  let baseUrl: string;
  let validKey: string;
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

    adapterHandle = await spawnAdapter(hippoHandle.port);
    baseUrl = adapterHandle.baseUrl;
  }, 30_000);

  afterAll(async () => {
    stopAdapter(adapterHandle);
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

// Second real server pair with the production limiter env, pinning the two
// release-safety behaviours the first describe never exercises (see
// docs/plans/2026-09-05-aml-adapter-status-and-ip-header.md).
describe('rate-limit key forwarding and status pass-through', () => {
  let rlHippoRoot: string;
  let rlHippoHandle: ServerHandle;
  let rlAdapterHandle: AdapterHandle;
  let rlBaseUrl: string;
  let rlValidKey: string;
  const savedRequireAuth = process.env.HIPPO_REQUIRE_AUTH;
  const savedClientIpHeader = process.env.HIPPO_CLIENT_IP_HEADER;
  const savedV1Rps = process.env.HIPPO_V1_RPS;

  beforeAll(async () => {
    rlHippoRoot = join(mkdtempSync(join(tmpdir(), 'hippo-aml-adapter-ratelimit-')), '.hippo');
    initStore(rlHippoRoot);

    // HIPPO_V1_RPS is read at serve() boot, so all three must be set before
    // this call; clientIpForRateLimit reads its header per request either way.
    process.env.HIPPO_REQUIRE_AUTH = '1';
    process.env.HIPPO_CLIENT_IP_HEADER = 'cf-connecting-ip';
    process.env.HIPPO_V1_RPS = '0.5';
    rlHippoHandle = await serve({ hippoRoot: rlHippoRoot, host: '127.0.0.1', port: 0 });

    const db = openHippoDb(rlHippoRoot);
    try {
      ({ plaintext: rlValidKey } = createApiKey(db, { tenantId: 'default', label: 'aml-adapter-ratelimit-test' }));
    } finally {
      closeHippoDb(db);
    }

    rlAdapterHandle = await spawnAdapter(rlHippoHandle.port);
    rlBaseUrl = rlAdapterHandle.baseUrl;
  }, 30_000);

  afterAll(async () => {
    stopAdapter(rlAdapterHandle);
    await rlHippoHandle?.stop();
    if (savedRequireAuth === undefined) {
      delete process.env.HIPPO_REQUIRE_AUTH;
    } else {
      process.env.HIPPO_REQUIRE_AUTH = savedRequireAuth;
    }
    if (savedClientIpHeader === undefined) {
      delete process.env.HIPPO_CLIENT_IP_HEADER;
    } else {
      process.env.HIPPO_CLIENT_IP_HEADER = savedClientIpHeader;
    }
    if (savedV1Rps === undefined) {
      delete process.env.HIPPO_V1_RPS;
    } else {
      process.env.HIPPO_V1_RPS = savedV1Rps;
    }
    rmSync(rlHippoRoot, { recursive: true, force: true });
  });

  // Clears adapter validation on every call so the request always reaches
  // hippo; only the extra headers vary between calls.
  function rlSearch(extraHeaders: Record<string, string>) {
    return fetch(`${rlBaseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${rlValidKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ query: 'x', user_id: 'user-ratelimit', top_k: 1 }),
    });
  }

  it("a hippo non-200 (exercised with a real 429) passes through with hippo's status and body", async () => {
    const [first, second] = await Promise.all([
      rlSearch({ 'cf-connecting-ip': '203.0.113.10' }),
      rlSearch({ 'cf-connecting-ip': '203.0.113.10' }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);

    const limited = first.status === 429 ? first : second;
    const limitedBody = await limited.json();
    expect(limitedBody).toEqual({ error: 'rate limit exceeded' });
  });

  it("only cf-connecting-ip reaches hippo's rate-limit key; x-forwarded-for and x-real-ip do not", async () => {
    const forwarded = await Promise.all([
      rlSearch({ 'cf-connecting-ip': '198.51.100.1' }),
      rlSearch({ 'cf-connecting-ip': '198.51.100.2' }),
      rlSearch({ 'cf-connecting-ip': '198.51.100.3' }),
    ]);
    expect(forwarded.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200]);

    // No cf-connecting-ip: both fall back to the socket-address bucket, which
    // no earlier request in this describe has touched.
    const notForwarded = await Promise.all([
      rlSearch({ 'x-forwarded-for': '198.51.100.4', 'x-real-ip': '198.51.100.5' }),
      rlSearch({ 'x-forwarded-for': '198.51.100.6', 'x-real-ip': '198.51.100.7' }),
    ]);
    expect(notForwarded.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 429]);
  });
});
