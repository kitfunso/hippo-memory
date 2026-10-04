/** `hippo audit list --op` and GET /v1/audit?op= accept a real op and reject an unknown one. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

describe('audit op filter', () => {
  let home: string;
  let hippoRoot: string;
  let globalHome: string;
  let origHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-audit-op-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-audit-op-global-'));
    hippoRoot = join(home, '.hippo');
    initStore(hippoRoot);
    // writeEntry appends a 'remember' audit row, so an accepted op has a row to return.
    writeEntry(hippoRoot, createMemory('audit op filter seed', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
  });

  afterEach(() => {
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  function runAuditList(op: string) {
    if (!existsSync(CLI)) throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
    const r = spawnSync('node', [CLI, 'audit', 'list', '--op', op, '--json'], {
      cwd: home,
      encoding: 'utf8',
      env: { ...process.env, HIPPO_HOME: hippoRoot },
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

    beforeEach(async () => {
      handle = await serve({ hippoRoot, port: 0 });
    });

    afterEach(async () => {
      await handle.stop();
    });

    it('rejects an unknown op with 400', async () => {
      const res = await fetch(`${handle.url}/v1/audit?op=bogus`);
      expect(res.status).toBe(400);
    });

    it('returns the rows for a real op', async () => {
      const res = await fetch(`${handle.url}/v1/audit?op=remember`);
      expect(res.status).toBe(200);
      // SAFETY: GET /v1/audit's response body is the serialized AuditEvent[], checked by the assertions below.
      const body = await res.json() as Array<{ op: string }>;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.every((e) => e.op === 'remember')).toBe(true);
    });
  });
});
