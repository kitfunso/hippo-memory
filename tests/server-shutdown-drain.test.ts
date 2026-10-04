// stop() stops accepting, lets an in-flight request finish within the drain window, and closes a stuck one when it ends.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type AuthResolver, type ServerHandle } from '../src/server.js';

const homes: string[] = [];

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-drain-'));
  initStore(home);
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
    const handle = await serve({ hippoRoot: makeRoot(), port: 0, authResolver: delayedResolver(400), shutdownDrainMs: 5000 });
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
      hippoRoot: makeRoot(),
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
});
