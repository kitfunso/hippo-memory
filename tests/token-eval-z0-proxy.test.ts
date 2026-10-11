// The G1 request log (smoke report point 1): the proxy forwards and records bodies but never headers, and the read check voids on what it recorded.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startLogProxy, requestBodies } from '../scripts/token-eval/proxy.mjs';
import { sessionVoid } from '../scripts/token-eval/readcheck.mjs';
import { requestLogs } from '../scripts/token-eval/turns.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

const LOGIN = 'Bearer plan-login-not-for-logs-0123456789';

/** A local upstream that answers 200 and keeps what it was sent. */
async function upstream() {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise<void>((r) => server.close(() => r()));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close };
}

describe('startLogProxy', () => {
  afterEach(cleanup);

  it('forwards the request with its login under the upstream path, and logs the body and status but no header', async () => {
    const up = await upstream();
    const log = join(tmp('z0-proxy-'), 'requests.jsonl');
    const proxy = await startLogProxy(log, { upstream: `${up.url}/route/` });
    try {
      const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: LOGIN }, body: '{"system":"hello"}' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      await proxy.close();
      await up.close();
    }
    expect(up.seen).toEqual([{ url: '/route/v1/messages?beta=true', auth: LOGIN, body: '{"system":"hello"}' }]);
    const text = readFileSync(log, 'utf8');
    expect(text).not.toContain('plan-login-not-for-logs');
    expect(text.trim().split('\n').map((l) => JSON.parse(l)).map(({ at: _at, ...e }) => e)).toEqual([
      { method: 'POST', url: '/v1/messages?beta=true', body: '{"system":"hello"}' },
      { url: '/v1/messages?beta=true', status: 200 },
    ]);
    expect(requestBodies(log)).toEqual(['{"system":"hello"}']);
  });

  it('answers 502 and logs the error when the upstream is down', async () => {
    const up = await upstream();
    await up.close();
    const log = join(tmp('z0-proxy-'), 'requests.jsonl');
    const proxy = await startLogProxy(log, { upstream: up.url });
    try {
      expect((await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(502);
    } finally {
      await proxy.close();
    }
    expect(readFileSync(log, 'utf8')).toMatch(/"error":/);
  });

  it('a session that sent nothing has no bodies', () => {
    expect(requestBodies(join(tmp('z0-proxy-'), 'none.jsonl'))).toEqual([]);
  });
});

describe('request-log voids', () => {
  afterEach(cleanup);

  /** G1 for one `arm` session whose only evidence is a request log holding `body`. */
  function verdict(arm: string, body: string, canaries: string[] = []) {
    const out = tmp('z0-reqvoid-');
    const dirs = runDirs(out, 'seqP', arm, 1);
    mkdirSync(dirs.work, { recursive: true });
    const log = join(out, 't1.session1.requests.jsonl');
    writeFileSync(log, `${JSON.stringify({ at: 'now', method: 'POST', url: '/v1/messages', body })}\n`);
    const ctx = { outDir: out, cacheDir: join(out, 'repo-cache'), operatorEnv: { ...process.env }, foreignDirs: [], canaries };
    return sessionVoid(ctx, { arm, dirs, env: {} }, { order: 1 }, { files: [], ownIds: [], delivery: [], requestLogs: [log] });
  }

  it('an operator canary in what the model received voids any arm', () => {
    for (const arm of ['A1', 'A2']) expect(verdict(arm, 'system: zz-op-canary-9', ['zz-op-canary-9'])).toEqual({ void: 'operator-canary', voidHits: [{ reason: 'operator-canary', class: 'request', tool: null, path: null, file: 't1.session1.requests.jsonl' }] });
    expect(verdict('A1', 'system: clean', ['zz-op-canary-9']).void).toBeNull();
  });

  it('injected auto memory voids A0 and A4 only', () => {
    const body = "Contents of MEMORY.md (user's auto-memory, persists across conversations): tabs";
    expect(verdict('A0', body).void).toBe('auto-memory');
    expect(verdict('A4', body).void).toBe('auto-memory');
    expect(verdict('A1', body).void).toBeNull();
  });

  it('hook text or hippo\'s marker voids an arm without hippo, never A2 or A5', () => {
    for (const body of ['SessionStart hook additional context: recall', 'notes <!-- hippo:start --> x']) {
      expect(verdict('A1', body).void).toBe('hippo-text');
      expect(verdict('A0', body).void).toBe('hippo-text');
      expect(verdict('A2', body).void).toBeNull();
      expect(verdict('A5', body).void).toBeNull();
    }
  });
});

describe('requestLogs', () => {
  afterEach(cleanup);

  it('lists one task\'s logs of one kind, every attempt, and never a task whose id it prefixes', () => {
    const rawDir = tmp('z0-reqlogs-');
    for (const f of ['t1.session1.requests.jsonl', 't1.session2.requests.jsonl', 't1.resume1.requests.jsonl', 't10.session1.requests.jsonl', 't1.session1.txt']) writeFileSync(join(rawDir, f), '');
    const names = (kind: string) => requestLogs({ rawDir }, 't1', kind).map((f: string) => f.slice(rawDir.length + 1));
    expect(names('session')).toEqual(['t1.session1.requests.jsonl', 't1.session2.requests.jsonl']);
    expect(names('resume')).toEqual(['t1.resume1.requests.jsonl']);
    expect(requestLogs({ rawDir: join(rawDir, 'missing') }, 't1', 'session')).toEqual([]);
  });
});
