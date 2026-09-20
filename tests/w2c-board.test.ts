/**
 * W2c C1: no more Access-Control-Allow-Origin, a loopback Host allowlist, and a mid-route throw no longer kills the server.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  initStore,
  createCard,
  claimCard,
  addCardComment,
  saveSessionHandoff,
  blockCard,
  reviewCard,
  completeCard,
  heartbeatCard,
} from '../src/store.js';
import { serveDashboard } from '../src/dashboard.js';
import { resolveTenantId } from '../src/tenant.js';

function dashboardRequest(
  port: number,
  path: string,
  host: string,
  method: string = 'GET',
): Promise<{ status: number; body: string; acaoPresent: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { Host: host } },
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

function listenAndGetPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    const onListening = () => {
      const addr = server.address();
      // SAFETY: serveDashboard binds a TCP port, not a pipe, so address()
      // is AddressInfo whenever the server is listening.
      resolve((addr as AddressInfo).port);
    };
    if (server.listening) onListening();
    else server.once('listening', onListening);
  });
}

function rawHttp10Get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
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
  let server: Server | undefined;
  let port: number;
  let prevTenant: string | undefined;
  let prevHippoHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-dash-entry-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    prevTenant = process.env.HIPPO_TENANT;
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = join(home, '.hippo-global');
    server = serveDashboard(hippoRoot, 0);
    port = await listenAndGetPort(server);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => (err ? reject(err) : resolve())),
      );
      server = undefined;
    }
    if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = prevTenant;
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('E1: a loopback Host gets 200 with no ACAO, on API and static paths', async () => {
    const stats = await dashboardRequest(port, '/api/stats', `127.0.0.1:${port}`);
    expect(stats.status).toBe(200);
    expect(stats.acaoPresent).toBe(false);

    const root = await dashboardRequest(port, '/', `127.0.0.1:${port}`);
    expect(root.acaoPresent).toBe(false);
  });

  it('E2: a foreign Host gets 403 Forbidden, on API and static paths', async () => {
    const stats = await dashboardRequest(port, '/api/stats', `evil.example:${port}`);
    expect(stats.status).toBe(403);
    expect(stats.body).toBe('Forbidden');

    const root = await dashboardRequest(port, '/', `evil.example:${port}`);
    expect(root.status).toBe(403);
    expect(root.body).toBe('Forbidden');
  });

  it('E3: localhost, LOCALHOST and a portless 127.0.0.1 all get 200', async () => {
    const lower = await dashboardRequest(port, '/api/stats', `localhost:${port}`);
    expect(lower.status).toBe(200);

    const upper = await dashboardRequest(port, '/api/stats', `LOCALHOST:${port}`);
    expect(upper.status).toBe(200);

    const noPort = await dashboardRequest(port, '/api/stats', '127.0.0.1');
    expect(noPort.status).toBe(200);
  });

  it('E4: a Host with a space gets 403, and the server keeps serving', async () => {
    const bad = await dashboardRequest(port, '/api/stats', 'a b');
    expect(bad.status).toBe(403);

    const after = await dashboardRequest(port, '/api/stats', `127.0.0.1:${port}`);
    expect(after.status).toBe(200);
  });

  it('E5: GET // answers 500 and the server keeps serving', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const broken = await dashboardRequest(port, '//', `127.0.0.1:${port}`);
    expect(broken.status).toBe(500);
    expect(broken.body).toBe('{"error":"Internal error"}');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const after = await dashboardRequest(port, '/api/stats', `127.0.0.1:${port}`);
    expect(after.status).toBe(200);

    errorSpy.mockRestore();
  });

  it('E6: an HTTP/1.0 request with no Host header is routed as today', async () => {
    const raw = await rawHttp10Get(port, '/api/stats');
    expect(raw).toMatch(/^HTTP\/1\.[01] 200 /);
  });
});

describe('card routes', () => {
  const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
  let home: string;
  let cwd: string;
  let hippoRoot: string;
  let server: Server;
  let port: number;
  let tenant: string;
  let P: string;
  let C: string;
  let Q: string;
  let T: string;
  let listJson: string;
  let showPJson: string;
  let showCJson: string;
  let prevTenant: string | undefined;
  let prevHippoHome: string | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-w2c-routes-'));
    cwd = join(home, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const cliEnv = { ...process.env, HIPPO_HOME: globalDir, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    delete cliEnv.HIPPO_TENANT;
    execFileSync(process.execPath, [CLI_PATH, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
      cwd,
      env: cliEnv,
      encoding: 'utf8',
    });
    hippoRoot = join(cwd, '.hippo');
    expect(existsSync(hippoRoot)).toBe(true);

    prevTenant = process.env.HIPPO_TENANT;
    prevHippoHome = process.env.HIPPO_HOME;
    delete process.env.HIPPO_TENANT;
    process.env.HIPPO_HOME = globalDir;
    tenant = resolveTenantId({});

    const p = createCard(hippoRoot, tenant, { title: 'P', repo: 'r', contract: 'c', budget: 5 });
    P = p.id;
    const c = createCard(hippoRoot, tenant, { title: 'C', dependsOn: [P] });
    C = c.id;

    expect(claimCard(hippoRoot, tenant, P, 'r1')).not.toBeNull();
    expect(addCardComment(hippoRoot, tenant, P, 'a', 'note')).not.toBeNull();
    expect(saveSessionHandoff(hippoRoot, tenant, { version: 1, sessionId: 's1', summary: 's', cardId: P })).not.toBeNull();

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

    // execFileSync blocks the event loop; run every parity read before the
    // server takes its first request (tests/cli-scope-valueless-guard.test.ts:61-66).
    listJson = execFileSync(process.execPath, [CLI_PATH, 'card', 'list', '--json'], {
      cwd,
      env: cliEnv,
      encoding: 'utf8',
    });
    showPJson = execFileSync(process.execPath, [CLI_PATH, 'card', 'show', P, '--json'], {
      cwd,
      env: cliEnv,
      encoding: 'utf8',
    });
    showCJson = execFileSync(process.execPath, [CLI_PATH, 'card', 'show', C, '--json'], {
      cwd,
      env: cliEnv,
      encoding: 'utf8',
    });

    server = serveDashboard(hippoRoot, 0);
    port = await listenAndGetPort(server);
  });

  afterEach(() => {
    delete process.env.HIPPO_TENANT;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = prevTenant;
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    rmSync(home, { recursive: true, force: true });
  });

  const host = () => `127.0.0.1:${port}`;

  it('R1: GET /api/cards matches the CLI list --json and holds exactly P, C and Q', async () => {
    const res = await dashboardRequest(port, '/api/cards', host());
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify(JSON.parse(listJson)));
    const parsed = JSON.parse(res.body);
    expect(parsed.cards).toHaveLength(3);
    const ids = parsed.cards.map((card: { id: string }) => card.id).sort();
    expect(ids).toEqual([P, C, Q].sort());
  });

  it('R2: GET /api/cards/:id matches the CLI show --json for P and for C', async () => {
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

  it('R3: an unknown or malformed card id returns 404', async () => {
    const unknown = await dashboardRequest(port, '/api/cards/card_000000000000', host());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('{"error":"Not found"}');

    const malformed = await dashboardRequest(port, '/api/cards/a.b', host());
    expect(malformed.status).toBe(404);
    expect(malformed.body).toBe('{"error":"Not found"}');
  });

  it('R4: POST /api/cards and POST /api/cards/:id both return 404', async () => {
    const listPost = await dashboardRequest(port, '/api/cards', host(), 'POST');
    expect(listPost.status).toBe(404);

    const showPost = await dashboardRequest(port, `/api/cards/${P}`, host(), 'POST');
    expect(showPost.status).toBe(404);
  });

  it('R5: HIPPO_TENANT scopes /api/cards and /api/cards/:id to the resolved tenant', async () => {
    process.env.HIPPO_TENANT = 'tenant_b';
    const listB = await dashboardRequest(port, '/api/cards', host());
    const idsB = JSON.parse(listB.body).cards.map((card: { id: string }) => card.id);
    expect(idsB).not.toContain(T);
    const showB = await dashboardRequest(port, `/api/cards/${T}`, host());
    expect(showB.status).toBe(404);

    process.env.HIPPO_TENANT = 'tenant_a';
    const listA = await dashboardRequest(port, '/api/cards', host());
    const idsA = JSON.parse(listA.body).cards.map((card: { id: string }) => card.id);
    expect(idsA).toEqual([T]);
    const showA = await dashboardRequest(port, `/api/cards/${T}`, host());
    expect(showA.status).toBe(200);
  });

  it('R6: card routes carry no access-control-allow-origin header', async () => {
    const list = await dashboardRequest(port, '/api/cards', host());
    expect(list.acaoPresent).toBe(false);
    const show = await dashboardRequest(port, `/api/cards/${P}`, host());
    expect(show.acaoPresent).toBe(false);
  });

  it('R7: a broken tenant answers 500 and the server keeps serving', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIPPO_TENANT = 'sess_x';
    const broken = await dashboardRequest(port, '/api/cards', host());
    expect(broken.status).toBe(500);
    expect(broken.body).toBe('{"error":"Internal error"}');

    delete process.env.HIPPO_TENANT;
    const after = await dashboardRequest(port, '/api/cards', host());
    expect(after.status).toBe(200);
    errorSpy.mockRestore();
  });
});
