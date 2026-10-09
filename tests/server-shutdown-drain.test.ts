// stop() stops accepting, lets an in-flight request finish within the drain window, and closes a stuck one when it ends.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { serve, type AuthResolver, type ServerHandle } from '../src/server.js';
import { log } from '../src/log.js';
import { makeRoot } from './_helpers/make-root.js';

const homes: string[] = [];

function trackedRoot(): string {
  const home = makeRoot('drain');
  homes.push(home);
  return home;
}

function delayedResolver(ms: number): AuthResolver {
  return () => new Promise((resolve) => setTimeout(() => resolve({ tenantId: 'default', subject: 'drain-test', role: 'admin' }), ms));
}

const neverResolves: AuthResolver = () => new Promise(() => undefined);

/** The built module's URL as a string literal, for a script the test spawns. */
const dist = (file: string): string => JSON.stringify(pathToFileURL(resolve('dist', file)).href);

/** The resolver, plus a promise that settles once a request is held inside it: the request is then in flight on the server. */
function watched(inner: AuthResolver) {
  let mark!: () => void;
  const asked = new Promise<void>((ok) => { mark = ok; });
  const resolver: AuthResolver = (token) => { mark(); return inner(token); };
  return { resolver, asked };
}

function slowRecall(handle: ServerHandle): Promise<Response> {
  return fetch(`${handle.url}/v1/memories?q=anything`, { headers: { authorization: 'Bearer slow-idp-token' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('serve() graceful stop', () => {
  it('lets a request already running finish instead of cutting its socket', async () => {
    const { resolver, asked } = watched(delayedResolver(400));
    const handle = await serve({ hippoRoot: trackedRoot(), port: 0, authResolver: resolver, shutdownDrainMs: 5000 });
    const pending = slowRecall(handle);
    await asked;
    const stopped = handle.stop();

    const res = await pending;
    expect(res.status).toBe(200);
    await stopped;
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  }, 15000);

  it('closes a request that outlives the drain window so stop() still returns', async () => {
    const { resolver, asked } = watched(neverResolves);
    const handle = await serve({
      hippoRoot: trackedRoot(),
      port: 0,
      authResolver: resolver,
      authResolverTimeoutMs: 60_000,
      shutdownDrainMs: 200,
    });
    const pending = slowRecall(handle).then(() => 'answered', () => 'reset');
    await asked;
    const warn = vi.spyOn(log, 'warn');
    await handle.stop();
    // The line names the window stop() waited, so the short one given above is the one it used.
    expect(warn.mock.calls.map(([line]) => line)).toContain('shutdown: 1 request(s) still running after 200 ms; closing them');
    expect(await pending).toBe('reset');
  }, 15000);

  it('exits 1 when a signal-driven shutdown fails', async () => {
    const home = trackedRoot();
    const script = join(home, 'failing-stop.mjs');
    // Closing the server first makes stop()'s own close fail with ERR_SERVER_NOT_RUNNING.
    writeFileSync(script, [
      `const { serve } = await import(${dist('server.js')});`,
      `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true });`,
      'handle.server.close();',
      "process.emit('SIGTERM');",
    ].join('\n'));
    const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global') } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    expect(stderr).toMatch(/error during stop: .*errorClass=/);
    expect(code).toBe(1);
  }, 15000);

  it('on an uncaught exception, logs it, answers the request already running, then exits 1', async () => {
    const home = trackedRoot();
    const script = join(home, 'crash-mid-request.mjs');
    // The throw is scheduled by the auth step, so it always lands while that request is in flight.
    writeFileSync(script, [
      `const { serve } = await import(${dist('server.js')});`,
      'const authResolver = () => {',
      "  setTimeout(() => { throw new Error('boom-serve'); }, 0);",
      "  return new Promise((done) => setTimeout(() => done({ tenantId: 'default', subject: 'drain-test', role: 'admin' }), 300));",
      '};',
      `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true, authResolver });`,
      'console.log(handle.url);',
    ].join('\n'));
    const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global') } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const closed = new Promise<number | null>((done) => child.once('close', done));
    const url = await new Promise<string>((done) => child.stdout.once('data', (chunk: Buffer) => done(chunk.toString('utf8').trim())));

    const answer = await fetch(`${url}/v1/memories?q=anything`, { headers: { authorization: 'Bearer slow-idp-token' } })
      .then((res) => res.status, () => 'connection cut');

    expect(answer).toBe(200);
    expect(await closed).toBe(1);
    expect(stderr).toMatch(/serve uncaught exception: boom-serve .*errorClass=Error stack=/);
  }, 15000);
});
