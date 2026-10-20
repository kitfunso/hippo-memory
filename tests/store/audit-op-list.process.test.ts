/** `hippo audit list --op` and GET /v1/audit?op= accept a real op and reject an unknown one. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { makeStore, makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const CLI = resolve(__dirname, '..', '..', 'bin', 'hippo.js');

describe('audit op filter', () => {
  let home: string;
  let hippoRoot: string;
  let globalHome: string;

  beforeEach(() => {
    ({ base: home, root: hippoRoot } = makeStore('audit-op'));
    globalHome = makeRoot('audit-op-global', { init: false });
    // writeEntry appends a 'remember' audit row, so an accepted op has a row to return.
    writeEntry(hippoRoot, createMemory('audit op filter seed', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    vi.stubEnv('HIPPO_HOME', globalHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function runAuditList(op: string) {
    if (!existsSync(CLI)) throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
    const r = hippoRun(['audit', 'list', '--op', op, '--json'], {
      cwd: home,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      exe: 'node',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('hippo audit list --op rejects an unknown op and exits 1', () => {
    const r = runAuditList('bogus');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown --op value: bogus');
  });

  it('hippo audit list --op returns the rows for a real op', () => {
    const r = runAuditList('remember');
    expect(r.status).toBe(0);
    // SAFETY: `audit list --json` prints the serialized AuditEvent[], checked by the assertions below.
    const events = JSON.parse(r.stdout) as Array<{ op: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.op === 'remember')).toBe(true);
  });

  describe('GET /v1/audit', () => {
    let handle: ServerHandle;

    let bearer = '';

    beforeEach(async () => {
      const db = openHippoDb(hippoRoot);
      try {
        bearer = createApiKey(db, { tenantId: 'default', label: 'audit-op-admin', role: 'admin' }).plaintext;
      } finally {
        closeHippoDb(db);
      }
      handle = await serve({ hippoRoot, port: 0 });
    });

    afterEach(async () => {
      await handle.stop();
    });

    it('rejects an unknown op with 400', async () => {
      const res = await fetch(`${handle.url}/v1/audit?op=bogus`, { headers: { authorization: `Bearer ${bearer}` } });
      expect(res.status).toBe(400);
    });

    it('returns the rows for a real op', async () => {
      const res = await fetch(`${handle.url}/v1/audit?op=remember`, { headers: { authorization: `Bearer ${bearer}` } });
      expect(res.status).toBe(200);
      // SAFETY: GET /v1/audit's response body is the serialized AuditEvent[], checked by the assertions below.
      const body = (await res.json()) as Array<{ op: string }>;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.every((e) => e.op === 'remember')).toBe(true);
    });
  });
});
