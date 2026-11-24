import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { waitFor } from '../_helpers/wait-for.js';
import { makeStore } from '../_helpers/make-root.js';

afterAll(() => {
  vi.unstubAllEnvs();
});

const ADAPTER_PATH = fileURLToPath(new URL('../../deploy/aml/adapter/adapter.mjs', import.meta.url));

interface SearchRow {
  id: string;
  content: string;
  score?: number;
  created_at?: string;
}

async function waitForAdapterReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(
    async () => {
      try {
        const res = await fetch(`${baseUrl}/health`);
        return res.status === 200 || res.status === 503;
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 50, what: `adapter reachable at ${baseUrl}` },
  );
}

interface AdapterHandle {
  child: ChildProcess;
  baseUrl: string;
  stderrChunks: Buffer[];
}

function spawnAdapter(hippoPort: number): Promise<AdapterHandle> {
  const stderrChunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let readyStarted = false;
    const child = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        ADAPTER_PORT: '0',
        HIPPO_URL: `http://127.0.0.1:${hippoPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fail = (err: Error): void => {
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

  beforeAll(async () => {
    hippoRoot = makeStore('aml-adapter').root;

    hippoHandle = await serve({ hippoRoot, host: '127.0.0.1', port: 0 });

    const db = openHippoDb(hippoRoot);
    try {
      ({ plaintext: validKey } = createApiKey(db, { tenantId: 'default', label: 'aml-adapter-test' }));
    } finally {
      closeHippoDb(db);
    }

    adapterHandle = await spawnAdapter(hippoHandle.port);
    baseUrl = adapterHandle.baseUrl;
  });

  afterAll(async () => {
    stopAdapter(adapterHandle);
    await hippoHandle?.stop();
  });

  function authHeader(key: string) {
    return { Authorization: `Bearer ${key}` };
  }

  async function postAdd(body: JsonValue, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function postSearch(body: JsonValue, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('GET /health: 200 with no auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

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

    const searchRes = await postSearch({ query: 'aml-happy-path-marker', user_id, top_k: 5 }, authHeader(validKey));
    expect(searchRes.status).toBe(200);
    const searchBody: { data: SearchRow[] } = await searchRes.json();
    expect(Array.isArray(searchBody.data)).toBe(true);
    const found = searchBody.data.some((row) => row.content.includes('aml-happy-path-marker'));
    expect(found).toBe(true);
  });

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

    const directRes = await fetch(`http://127.0.0.1:${hippoHandle.port}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(validKey) },
      body: JSON.stringify({ content: `${marker} row-unscoped content, written direct to hippo` }),
    });
    expect(directRes.status).toBe(200);

    const searchRes = await postSearch({ query: marker, user_id: 'user-a-iso', top_k: 10 }, authHeader(validKey));
    expect(searchRes.status).toBe(200);
    const searchBody: { data: SearchRow[] } = await searchRes.json();
    const contents = searchBody.data.map((row) => row.content);

    const hasA = contents.some((c) => c.includes('row-a content'));
    const hasB = contents.some((c) => c.includes('row-b content'));
    const hasUnscoped = contents.some((c) => c.includes('row-unscoped content'));

    expect(hasA).toBe(true);
    expect(hasB).toBe(false);

    expect(hasUnscoped).toBe(false);
  });

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
    const body: { data: SearchRow[] } = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(1);
    for (const row of body.data) {
      expect(row.id).toEqual(expect.any(String));
      expect(row.content).toEqual(expect.any(String));
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

  describe('auth', () => {
    it('no credential -> 401', async () => {
      const res = await postSearch({ query: 'x', user_id: 'user-auth', top_k: 1 });
      expect(res.status).toBe(401);
    });

    it('X-Api-Key header works', async () => {
      const res = await postSearch({ query: 'x', user_id: 'user-auth', top_k: 1 }, { 'X-Api-Key': validKey });
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
      expect(body.error).toEqual(expect.any(String));
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
    const searchBody: { data: SearchRow[] } = await searchRes.json();
    const row = searchBody.data.find((r) => r.content.includes('zqx7') && r.content.includes('wvk3'));
    expect(row?.content).toBe('user: zqx7\nassistant: wvk3');
  });
});

describe('rate-limit key forwarding and status pass-through', () => {
  let rlHippoRoot: string;
  let rlHippoHandle: ServerHandle;
  let rlAdapterHandle: AdapterHandle;
  let rlBaseUrl: string;
  let rlValidKey: string;

  beforeAll(async () => {
    rlHippoRoot = makeStore('aml-adapter-ratelimit').root;

    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'cf-connecting-ip');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '127.0.0.1,::1');
    vi.stubEnv('HIPPO_V1_RPS', '0.5');
    rlHippoHandle = await serve({ hippoRoot: rlHippoRoot, host: '127.0.0.1', port: 0 });

    const db = openHippoDb(rlHippoRoot);
    try {
      ({ plaintext: rlValidKey } = createApiKey(db, { tenantId: 'default', label: 'aml-adapter-ratelimit-test' }));
    } finally {
      closeHippoDb(db);
    }

    rlAdapterHandle = await spawnAdapter(rlHippoHandle.port);
    rlBaseUrl = rlAdapterHandle.baseUrl;
  });

  afterAll(async () => {
    stopAdapter(rlAdapterHandle);
    await rlHippoHandle?.stop();
  });

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

    const notForwarded = await Promise.all([
      rlSearch({ 'x-forwarded-for': '198.51.100.4', 'x-real-ip': '198.51.100.5' }),
      rlSearch({ 'x-forwarded-for': '198.51.100.6', 'x-real-ip': '198.51.100.7' }),
    ]);
    expect(notForwarded.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 429]);
  });
});
