import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { authCreate, adminActor } from '../src/api.js';
import { initStore } from '../src/store.js';
import { queryAuditEvents } from '../src/audit.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const cli = resolve(__dirname, '..', 'dist', 'cli.js');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-cli-revoke-audit-'));
  const root = join(dir, '.hippo');
  initStore(root);
  const created = authCreate({ hippoRoot: root, tenantId: 'tenant-x', actor: adminActor('seed') }, { label: 'k', role: 'member' });
  const run = (...args: string[]) =>
    spawnSync('node', [cli, 'auth', 'revoke', ...args], { cwd: dir, env: { ...process.env, HIPPO_HOME: dir }, encoding: 'utf8' });
  const rows = () => {
    const db = openHippoDb(root);
    try {
      return queryAuditEvents(db, { tenantId: 'tenant-x', op: 'auth_revoke', limit: 50 });
    } finally {
      closeHippoDb(db);
    }
  };
  return { dir, keyId: created.keyId, run, rows };
}

describe('hippo auth revoke CLI audit', () => {
  it('writes one auth_revoke row with actor cli in the key tenant, and none on re-revoke', () => {
    const t = setup();
    try {
      const first = t.run(t.keyId, '--json');
      expect(first.status).toBe(0);
      const out = JSON.parse(first.stdout) as { keyId: string; revokedAt: string };
      expect(out.keyId).toBe(t.keyId);
      expect(out.revokedAt).toBeTruthy();
      const rows = t.rows();
      expect(rows.length).toBe(1);
      expect(rows[0].actor).toBe('cli');
      expect(rows[0].targetId).toBe(t.keyId);

      const second = t.run(t.keyId);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain(`Revoked ${t.keyId} at ${out.revokedAt}`);
      expect(t.rows().length).toBe(1);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('prints Unknown key_id to stderr and exits 1 for a missing key', () => {
    const t = setup();
    try {
      const res = t.run('hk_doesnotexist');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Unknown key_id: hk_doesnotexist');
      expect(t.rows().length).toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
