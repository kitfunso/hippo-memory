/**
 * W2c C1: no more Access-Control-Allow-Origin, a loopback Host allowlist, and a mid-route throw no longer kills the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initStore } from '../src/store.js';
import { serveDashboard } from '../src/dashboard.js';

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
