// stop() stops accepting, lets an in-flight request finish within the drain window, and closes a stuck one when it ends.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { serve, type AuthResolver, type ServerHandle } from '../src/server.js';
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

function slowRecall(handle: ServerHandle): Promise<Response> {
  return fetch(`${handle.url}/v1/memories?q=anything`, { headers: { authorization: 'Bearer slow-idp-token' } });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('serve() graceful stop', () => {
  it('lets a request already running finish instead of cutting its socket', async () => {
    const handle = await serve({ hippoRoot: trackedRoot(), port: 0, authResolver: delayedResolver(400), shutdownDrainMs: 5000 });
    const pending = slowRecall(handle);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = handle.stop();

    const res = await pending;
    expect(res.status).toBe(200);
    await stopped;
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  }, 15000);

  it('closes a request that outlives the drain window so stop() still returns', async () => {
    const handle = await serve({
      hippoRoot: trackedRoot(),
      port: 0,
      authResolver: neverResolves,
      authResolverTimeoutMs: 60_000,
      shutdownDrainMs: 200,
    });
    const pending = slowRecall(handle).then(() => 'answered', () => 'reset');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await pending).toBe('reset');
  }, 15000);

  it('exits 1 when a signal-driven shutdown fails', async () => {
    const home = trackedRoot();
    const script = join(home, 'failing-stop.mjs');
    const dist = (file: string): string => JSON.stringify(pathToFileURL(resolve('dist', file)).href);
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
});
