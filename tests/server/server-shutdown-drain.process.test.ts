// stop() stops accepting, lets an in-flight request finish within the drain window, closes a stuck one when it ends,
// and gives work a request handed off a bounded wait before the stores close.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { AuthResolver, ServerHandle } from '../../src/server.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';
import { log } from '../../src/base/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';
import { HeldWrites } from '../../src/db/held-writes.js';
import { DETACHED_SETTLE_MS } from '../../src/surface/server/lifecycle.js';
import { readLocalKey } from '../../src/surface/server/local-key.js';
import { startHashedEmbeddings } from '../_helpers/hashed-embedding-server.js';

const homes: string[] = [];

function trackedRoot(): string {
  const home = makeRoot('drain');
  homes.push(home);
  return home;
}

/** A resolver that vouches once `release()` is called, so the test decides how long a request stays in flight. */
function gatedResolver() {
  let release = (): void => undefined;
  const vouched = new Promise<Awaited<ReturnType<AuthResolver>>>((resolve) => {
    release = () => resolve({ tenantId: 'default', subject: 'drain-test', role: 'admin' });
  });
  return { resolver: () => vouched, release };
}

const neverResolves: AuthResolver = () => new Promise(() => undefined);

/** The built module's URL as a string literal, for a script the test spawns. */
const dist = (file: string): string => JSON.stringify(pathToFileURL(resolve('dist', file)).href);

/** The resolver, plus a promise that settles once a request is held inside it: the request is then in flight on the server. */
function watched(inner: AuthResolver) {
  let mark!: () => void;
  const asked = new Promise<void>((ok) => {
    mark = ok;
  });
  const resolver: AuthResolver = (token) => {
    mark();
    return inner(token);
  };
  return { resolver, asked };
}

function slowRecall(handle: ServerHandle): Promise<Response> {
  return fetch(`${handle.url}/v1/memories?q=anything`, { headers: { authorization: 'Bearer slow-idp-token' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('serve() graceful stop', () => {
  it('lets a request already running finish instead of cutting its socket', async () => {
    const gate = gatedResolver();
    const { resolver, asked } = watched(gate.resolver);
    const handle = await serve({ hippoRoot: trackedRoot(), port: 0, authResolver: resolver, shutdownDrainMs: 5000 });
    const pending = slowRecall(handle);
    await asked;
    const stopped = handle.stop();
    gate.release();

    const res = await pending;
    expect(res.status).toBe(200);
    await stopped;
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  });

  it('closes a request that outlives the drain window so stop() still returns', async () => {
    const { resolver, asked } = watched(neverResolves);
    const handle = await serve({
      hippoRoot: trackedRoot(),
      port: 0,
      authResolver: resolver,
      authResolverTimeoutMs: 60_000,
      shutdownDrainMs: 200,
    });
    const pending = slowRecall(handle).then(
      () => 'answered',
      () => 'reset',
    );
    await asked;
    const warn = vi.spyOn(log, 'warn');
    await handle.stop();
    // The line names the window stop() waited, so the short one given above is the one it used.
    expect(warn.mock.calls.map(([line]) => line)).toContain(
      'shutdown: 1 request(s) still running after 200 ms; closing them',
    );
    expect(await pending).toBe('reset');
  });

  it.skipIf(needsHippoDb('team'))(
    'waits a bounded time for an embed a request handed off, then flushes the held writes and closes',
    async () => {
      const embeddings = await startHashedEmbeddings();
      try {
        const home = trackedRoot();
        // Only the global store embeds, so the promote's copy is the one embed in flight.
        writeFileSync(join(home, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
        const global = join(home, '.global');
        mkdirSync(global);
        const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
        writeFileSync(join(global, 'config.json'), JSON.stringify(config));
        vi.stubEnv('HIPPO_HOME', global);
        vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
        const handle = await serve({ hippoRoot: home, port: 0 });
        const headers = { authorization: `Bearer ${readLocalKey(home)}`, 'content-type': 'application/json' };
        const made = await fetch(`${handle.url}/v1/memories`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'the release checklist lives in the wiki' }),
        });
        // SAFETY: a remember on /v1/memories answers with the stored row's id.
        const { id } = (await made.json()) as { id: string };
        // The promote answers before its global copy's embed, which this endpoint never answers.
        embeddings.setFault('stall');
        const promoted = await fetch(`${handle.url}/v1/memories/${id}/promote`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(promoted.status).toBe(200);
        const warn = vi.spyOn(log, 'warn');
        const flush = vi.spyOn(HeldWrites.prototype, 'flush');
        const started = performance.now();
        await handle.stop();
        expect(performance.now() - started).toBeLessThan(DETACHED_SETTLE_MS + 3000);
        expect(warn.mock.calls.map(([line]) => line)).toContain(
          `shutdown: 1 handed-off task(s) still running after ${DETACHED_SETTLE_MS} ms; closing the stores`,
        );
        // The runtime's own flush takes no root; a held write's timer names its root.
        expect(flush).toHaveBeenCalledWith();
      } finally {
        await embeddings.close();
      }
    },
    20_000,
  );

  it('exits 1 when a signal-driven shutdown fails', async () => {
    const home = trackedRoot();
    const script = join(home, 'failing-stop.mjs');
    // Closing the server first makes stop()'s own close fail with ERR_SERVER_NOT_RUNNING.
    writeFileSync(
      script,
      [
        `const { serve } = await import(${dist('server.js')});`,
        `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true });`,
        'handle.server.close();',
        "process.emit('SIGTERM');",
      ].join('\n'),
    );
    const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global') } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    expect(stderr).toMatch(/serve shutdown after SIGTERM failed: .*errorClass=/);
    expect(code).toBe(1);
  });

  it('on an uncaught exception, logs it, answers the request already running, then exits 1', async () => {
    const home = trackedRoot();
    const script = join(home, 'crash-mid-request.mjs');
    // The auth step schedules the throw and vouches only once the crash handler has run, so the request is in flight.
    writeFileSync(
      script,
      [
        `const { serve } = await import(${dist('server.js')});`,
        'const authResolver = () => {',
        "  const vouched = new Promise((done) => process.once('uncaughtException', () => done({ tenantId: 'default', subject: 'drain-test', role: 'admin' })));",
        "  setTimeout(() => { throw new Error('boom-serve'); }, 0);",
        '  return vouched;',
        '};',
        `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true, authResolver });`,
        'console.log(handle.url);',
      ].join('\n'),
    );
    const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global') } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const closed = new Promise<number | null>((done) => child.once('close', done));
    const url = await new Promise<string>((done) =>
      child.stdout.once('data', (chunk: Buffer) => done(chunk.toString('utf8').trim())),
    );

    const answer = await fetch(`${url}/v1/memories?q=anything`, {
      headers: { authorization: 'Bearer slow-idp-token' },
    }).then(
      (res) => res.status,
      () => 'connection cut',
    );

    expect(answer).toBe(200);
    expect(await closed).toBe(1);
    expect(stderr).toMatch(/serve uncaught exception: boom-serve .*errorClass=Error stack=/);
  });
});
