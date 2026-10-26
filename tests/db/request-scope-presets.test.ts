// The composition roots' request scopes carry the lock wait each root had before they moved into the store layer.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { currentRequestStores, HOOK_DB_WAIT_MS, runWithRequestStores, SERVER_DB_WAIT_MS } from '../../src/db/index.js';
import { runDetachedSqliteRequest, runSqliteRequest } from '../../src/store/sqlite/index.js';
import { makeRoot } from '../_helpers/make-root.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('runSqliteRequest presets', () => {
  it("opens a scope at the root's lock wait", async () => {
    expect(await runSqliteRequest(() => currentRequestStores()?.busyWaitMs, 'cli')).toBeUndefined();
    expect(await runSqliteRequest(() => currentRequestStores()?.busyWaitMs, 'server')).toBe(SERVER_DB_WAIT_MS);
    expect(await runSqliteRequest(() => currentRequestStores()?.busyWaitMs, 'hook')).toBe(HOOK_DB_WAIT_MS);
  });

  it('a hook scope drops its handles to no wait once one wait runs out; a server scope does not', async () => {
    const root = makeRoot('scope-preset');
    roots.push(root);
    const waitAfterNoteBusy = (preset: 'hook' | 'server'): Promise<number> =>
      runSqliteRequest(() => {
        const scope = currentRequestStores()!;
        const db = scope.get(root);
        scope.noteBusy();
        // SAFETY: PRAGMA busy_timeout answers one row with a numeric `timeout` column.
        return (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      }, preset);
    expect(await waitAfterNoteBusy('hook')).toBe(0);
    expect(await waitAfterNoteBusy('server')).toBe(SERVER_DB_WAIT_MS);
  });

  it("a detached scope is its own and keeps the caller's lock wait", async () => {
    const seen = await runWithRequestStores(
      async () => {
        const outer = currentRequestStores();
        const inner = await runDetachedSqliteRequest(() => currentRequestStores());
        return { outer, inner };
      },
      { busyWaitMs: 250 },
    );
    expect(seen.inner).not.toBe(seen.outer);
    expect(seen.inner?.busyWaitMs).toBe(250);
  });
});
