// The composition roots' request sessions carry the lock wait each root had before they moved into the store layer.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { HOOK_DB_WAIT_MS, SERVER_DB_WAIT_MS } from '../../src/db/index.js';
import { runSqliteRequest } from '../../src/store/sqlite/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { grantFor } from '../../src/store/sqlite/grant.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('runSqliteRequest presets', () => {
  it("opens a session at the root's lock wait", async () => {
    expect(await runSqliteRequest((session) => session.busyWaitMs, 'cli')).toBeUndefined();
    expect(await runSqliteRequest((session) => session.busyWaitMs, 'server')).toBe(SERVER_DB_WAIT_MS);
    expect(await runSqliteRequest((session) => session.busyWaitMs, 'hook')).toBe(HOOK_DB_WAIT_MS);
  });

  it('a hook session drops its handles to no wait once one wait runs out; a server session does not', async () => {
    const root = makeRoot('scope-preset');
    roots.push(root);
    const waitAfterNoteBusy = (preset: 'hook' | 'server'): Promise<number> =>
      runSqliteRequest((session) => {
        const db = grantFor({ session }).open(root);
        session.noteBusy();
        // SAFETY: PRAGMA busy_timeout answers one row with a numeric `timeout` column.
        return (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      }, preset);
    expect(await waitAfterNoteBusy('hook')).toBe(0);
    expect(await waitAfterNoteBusy('server')).toBe(SERVER_DB_WAIT_MS);
  });
});
