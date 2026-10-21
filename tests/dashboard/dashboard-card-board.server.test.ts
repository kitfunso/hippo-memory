/**
 * W2c C1: no more Access-Control-Allow-Origin, a loopback Host allowlist, and a mid-route throw no longer kills the server.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { serveDashboard } from '../../src/surface/server/dashboard-listener.js';
import type { ServerHandle } from '../../src/surface/server/types.js';
import { resolveTenantId } from '../../src/surface/server/boot.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { sessionCookie } from '../_helpers/dashboard-fixture.js';
import { runCliOut } from '../_helpers/run-cli-as.js';
import {
  createCard,
  claimCard,
  addCardComment,
  blockCard,
  reviewCard,
  completeCard,
  heartbeatCard,
  saveSessionHandoff,
} from '../_helpers/root-forms.js';

afterAll(() => {
  vi.unstubAllEnvs();
});

const DASHBOARD_TOKEN = 'test-dashboard-token';

function dashboardRequest(
  port: number,
  path: string,
  host: string,
  method: string = 'GET',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; acaoPresent: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { Host: host, cookie: sessionCookie(port, DASHBOARD_TOKEN), ...extraHeaders },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            acaoPresent: Object.hasOwn(res.headers, 'access-control-allow-origin'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startFor(hippoRoot: string, tenantId: string): Promise<ServerHandle> {
  return serveDashboard({ hippoRoot, port: 0, token: DASHBOARD_TOKEN, tenantId });
}

function rawHttp10Get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.0\r\nCookie: ${sessionCookie(port, DASHBOARD_TOKEN)}\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('dashboard entry', () => {
  let home: string;
  let hippoRoot: string;
  let server: ServerHandle | undefined;
  let port: number;

  beforeEach(async () => {
    ({ base: home, root: hippoRoot } = makeStore('dash-entry'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo-global'));
    server = await startFor(hippoRoot, 'default');
    port = server.port;
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('a loopback Host gets 200 with no ACAO, on API and static paths', async () => {
    const stats = await dashboardRequest(port, '/api/overview', `127.0.0.1:${port}`);
    expect(stats.status).toBe(200);
    expect(stats.acaoPresent).toBe(false);

    const root = await dashboardRequest(port, '/', `127.0.0.1:${port}`);
    expect(root.acaoPresent).toBe(false);
  });

  it('a foreign Host gets 403, on API, static, pin POST and unrouted paths', async () => {
    const refused = '{"error":"cross-site or non-local request refused"}';
    for (const [path, method] of [
      ['/api/overview', 'GET'],
      ['/', 'GET'],
      ['/api/memory/mem_x/pin', 'POST'],
      ['/api/nope', 'GET'],
    ]) {
      const reply = await dashboardRequest(port, path!, `evil.example:${port}`, method);
      expect([reply.status, reply.body]).toEqual([403, refused]);
    }
  });

  it('a wrong POST from another site is 403 even with a loopback Host', async () => {
    const host = `127.0.0.1:${port}`;
    const json = { 'Content-Type': 'application/json' };
    const wrong = (headers: Record<string, string>) =>
      dashboardRequest(port, '/api/memory/mem_x/wrong', host, 'POST', { ...json, ...headers });
    expect((await wrong({ Origin: 'http://evil.example' })).status).toBe(403);
    expect((await wrong({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await wrong({ Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(404);
    expect((await wrong({})).status).toBe(404);
  });

  it('localhost, LOCALHOST and a portless 127.0.0.1 all get 200', async () => {
    const lower = await dashboardRequest(port, '/api/overview', `localhost:${port}`);
    expect(lower.status).toBe(200);

    const upper = await dashboardRequest(port, '/api/overview', `LOCALHOST:${port}`);
    expect(upper.status).toBe(200);

    const noPort = await dashboardRequest(port, '/api/overview', '127.0.0.1');
    expect(noPort.status).toBe(200);
  });

  it('a Host with a space gets 403, and the server keeps serving', async () => {
    const bad = await dashboardRequest(port, '/api/overview', 'a b');
    expect(bad.status).toBe(403);

    const after = await dashboardRequest(port, '/api/overview', `127.0.0.1:${port}`);
    expect(after.status).toBe(200);
  });

  it('GET // is the 400 any request target the URL parser refuses gets, and the server keeps serving', async () => {
    const broken = await dashboardRequest(port, '//', `127.0.0.1:${port}`);
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body)).toEqual({ error: expect.any(String) });

    const after = await dashboardRequest(port, '/api/overview', `127.0.0.1:${port}`);
    expect(after.status).toBe(200);
  });

  it('an HTTP/1.0 request with no Host header is routed as today', async () => {
    const raw = await rawHttp10Get(port, '/api/overview');
    expect(raw).toMatch(/^HTTP\/1\.[01] 200 /);
  });
});

describe('card routes', () => {
  let home: string;
  let cwd: string;
  let hippoRoot: string;
  let server: ServerHandle;
  let port: number;
  let tenant: string;
  let P: string;
  let C: string;
  let Q: string;
  let T: string;
  let listJson: string;
  let showPJson: string;
  let showCJson: string;

  // Seeds a real store and runs four CLI verbs in process, and a runner's disk sets how long that takes.
  beforeAll(async () => {
    home = makeRoot('w2c-routes', { init: false });
    cwd = join(home, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalDir, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    delete cliEnv.HIPPO_TENANT;
    await runCliOut(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd, env: cliEnv });
    hippoRoot = join(cwd, '.hippo');
    expect(existsSync(hippoRoot)).toBe(true);
    vi.stubEnv('HIPPO_TENANT', undefined);
    vi.stubEnv('HIPPO_HOME', globalDir);
    tenant = resolveTenantId({});

    const p = createCard(hippoRoot, tenant, { title: 'P', repo: 'r', contract: 'c', budget: 5 });
    P = p.id;
    const c = createCard(hippoRoot, tenant, { title: 'C', dependsOn: [P] });
    C = c.id;

    expect(claimCard(hippoRoot, tenant, P, 'r1')).not.toBeNull();
    expect(addCardComment(hippoRoot, tenant, P, 'a', 'note')).not.toBeNull();
    expect(
      saveSessionHandoff(hippoRoot, tenant, { version: 1, sessionId: 's1', summary: 's', cardId: P }),
    ).not.toBeNull();

    expect(blockCard(hippoRoot, tenant, P, 'waiting')).not.toBeNull();
    expect(claimCard(hippoRoot, tenant, P, 'r2')).not.toBeNull();
    expect(reviewCard(hippoRoot, tenant, P)).not.toBeNull();
    expect(completeCard(hippoRoot, tenant, P, 'success')).not.toBeNull();

    const q = createCard(hippoRoot, tenant, { title: 'Q' });
    Q = q.id;
    const claimedQ = claimCard(hippoRoot, tenant, Q, 'r3');
    expect(claimedQ).not.toBeNull();
    expect(heartbeatCard(hippoRoot, tenant, Q, claimedQ!.runId)).not.toBeNull();

    const t = createCard(hippoRoot, 'tenant_a', { title: 'T' });
    T = t.id;

    listJson = await runCliOut(['card', 'list', '--json'], { cwd, env: cliEnv });
    showPJson = await runCliOut(['card', 'show', P, '--json'], { cwd, env: cliEnv });
    showCJson = await runCliOut(['card', 'show', C, '--json'], { cwd, env: cliEnv });

    server = await startFor(hippoRoot, tenant);
    port = server.port;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  });

  const host = () => `127.0.0.1:${port}`;

  // A dashboard serves the one tenant its CLI root resolved, so each tenant here gets its own server.
  async function onTenant(tenantId: string, use: (at: number, atHost: string) => Promise<void>): Promise<void> {
    const other = await startFor(hippoRoot, tenantId);
    try {
      await use(other.port, `127.0.0.1:${other.port}`);
    } finally {
      await other.stop();
    }
  }

  it('GET /api/cards matches the CLI list --json and holds exactly P, C and Q', async () => {
    const res = await dashboardRequest(port, '/api/cards', host());
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify(JSON.parse(listJson)));
    const parsed = JSON.parse(res.body);
    expect(parsed.cards).toHaveLength(3);
    const ids = parsed.cards.map((card: { id: string }) => card.id).sort();
    expect(ids).toEqual([P, C, Q].sort());
  });

  it('GET /api/cards/:id matches the CLI show --json for P and for C', async () => {
    const resP = await dashboardRequest(port, `/api/cards/${P}`, host());
    expect(resP.status).toBe(200);
    expect(resP.body).toBe(JSON.stringify(JSON.parse(showPJson)));
    const detailP = JSON.parse(resP.body);
    expect(detailP.runs).toHaveLength(2);
    const systemComment = detailP.comments.find((cm: { author: string }) => cm.author === 'system');
    expect(systemComment?.body).toBe('waiting');
    const authorComment = detailP.comments.find((cm: { author: string }) => cm.author === 'a');
    expect(authorComment?.body).toBe('note');
    expect(detailP.handoff?.summary).toBe('s');
    expect(detailP.deps.children).toEqual([C]);

    const resC = await dashboardRequest(port, `/api/cards/${C}`, host());
    expect(resC.status).toBe(200);
    expect(resC.body).toBe(JSON.stringify(JSON.parse(showCJson)));
    const detailC = JSON.parse(resC.body);
    expect(detailC.deps.parents).toEqual([P]);
    expect(detailC.card.status).toBe('ready');
  });

  it('an unknown or malformed card id returns 404', async () => {
    const unknown = await dashboardRequest(port, '/api/cards/card_000000000000', host());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('{"error":"Not found"}');

    const malformed = await dashboardRequest(port, '/api/cards/a.b', host());
    expect(malformed.status).toBe(404);
    expect(malformed.body).toBe('{"error":"Not found"}');
  });

  it('POST /api/cards and POST /api/cards/:id both return 404', async () => {
    const listPost = await dashboardRequest(port, '/api/cards', host(), 'POST');
    expect(listPost.status).toBe(404);

    const showPost = await dashboardRequest(port, `/api/cards/${P}`, host(), 'POST');
    expect(showPost.status).toBe(404);
  });

  it('the resolved tenant scopes /api/cards and /api/cards/:id', async () => {
    await onTenant('tenant_b', async (at, atHost) => {
      const listB = await dashboardRequest(at, '/api/cards', atHost);
      const idsB = JSON.parse(listB.body).cards.map((card: { id: string }) => card.id);
      expect(idsB).not.toContain(T);
      const showB = await dashboardRequest(at, `/api/cards/${T}`, atHost);
      expect(showB.status).toBe(404);
    });
    await onTenant('tenant_a', async (at, atHost) => {
      const listA = await dashboardRequest(at, '/api/cards', atHost);
      const idsA = JSON.parse(listA.body).cards.map((card: { id: string }) => card.id);
      expect(idsA).toEqual([T]);
      const showA = await dashboardRequest(at, `/api/cards/${T}`, atHost);
      expect(showA.status).toBe(200);
    });
  });

  it('card routes carry no access-control-allow-origin header', async () => {
    const list = await dashboardRequest(port, '/api/cards', host());
    expect(list.acaoPresent).toBe(false);
    const show = await dashboardRequest(port, `/api/cards/${P}`, host());
    expect(show.acaoPresent).toBe(false);
  });

  it('a broken tenant answers 500 with the request id, logs the stack, and the server keeps serving', async () => {
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await onTenant('sess_x', async (at, atHost) => {
      const broken = await dashboardRequest(at, '/api/cards', atHost);
      expect(broken.status).toBe(500);
      expect(JSON.parse(broken.body)).toEqual({ error: 'internal server error', requestId: expect.any(String) });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/GET \/api\/cards failed.* stack=\S*Error.* at /));
      expect((await dashboardRequest(at, '/api/cards', atHost)).status).toBe(500);
    });
    const after = await dashboardRequest(port, '/api/cards', host());
    expect(after.status).toBe(200);
    errorSpy.mockRestore();
  });
});
