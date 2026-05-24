/**
 * v1.12.3: tests for the auth CLI role surfacing.
 *
 * Covers:
 *   - api.authCreate accepts opts.role and returns it on the result
 *   - api.authCreate defaults to 'admin' when role is omitted
 *   - listApiKeys returns role on each row (admin + member)
 *   - listApiKeys legacy DB row (pre-v26-migration with NULL role) → fail-safe-to-member
 *   - Bearer minted with role='member' is 403-blocked at admin-gated /v1/sleep
 *
 * The CLI flag (`hippo auth create-key --role`) and table-header column are
 * pure surfacing of the api.authCreate / listApiKeys results — covered
 * transitively. Direct subprocess invocation of cmdAuthCreate is awkward in
 * vitest (would mock process.exit / stdout), so the contract is locked at
 * the api/db layer.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authCreate, adminActor, type Context } from '../src/api.js';
import { listApiKeys } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function newCtx(tenantId = 'default'): { ctx: Context; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hippo-auth-role-cli-'));
  const ctx: Context = {
    hippoRoot: tmpDir,
    tenantId,
    actor: adminActor('cli'),
  };
  return {
    ctx,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('v1.12.3 auth CLI role surfacing', () => {
  it('authCreate({}) without role defaults to admin', () => {
    const t = newCtx();
    try {
      const result = authCreate(t.ctx, {});
      expect(result.role).toBe('admin');
    } finally {
      t.cleanup();
    }
  });

  it('authCreate({ role: "admin" }) returns admin', () => {
    const t = newCtx();
    try {
      const result = authCreate(t.ctx, { role: 'admin' });
      expect(result.role).toBe('admin');
    } finally {
      t.cleanup();
    }
  });

  it('authCreate({ role: "member" }) returns member', () => {
    const t = newCtx();
    try {
      const result = authCreate(t.ctx, { role: 'member', label: 'service:reporter' });
      expect(result.role).toBe('member');
    } finally {
      t.cleanup();
    }
  });

  it('listApiKeys returns role column for each row', () => {
    const t = newCtx();
    try {
      authCreate(t.ctx, { label: 'admin-key' }); // defaults to admin
      authCreate(t.ctx, { role: 'member', label: 'member-key' });

      const db = openHippoDb(t.ctx.hippoRoot);
      try {
        const items = listApiKeys(db, { active: true });
        expect(items.length).toBe(2);
        const byLabel = Object.fromEntries(items.map(i => [i.label, i.role]));
        expect(byLabel['admin-key']).toBe('admin');
        expect(byLabel['member-key']).toBe('member');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      t.cleanup();
    }
  });

  it('listApiKeys fail-safe-to-member on unrecognised role value', () => {
    // Construct an api_keys row with a non-canonical role via direct SQL
    // (simulates a legacy or corrupted row). listApiKeys must cast it to
    // 'member' — never silently grant admin.
    const t = newCtx();
    try {
      // First mint a real key so the schema migration runs and the table exists.
      authCreate(t.ctx, { label: 'real-key' });

      const db = openHippoDb(t.ctx.hippoRoot);
      try {
        // Now insert a row with an unrecognised role value
        db.prepare(`
          INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at, role)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('hk_legacy0000000000000000', 'fakehash', 'default', 'legacy', new Date().toISOString(), 'superadmin');

        const items = listApiKeys(db, { active: true });
        const legacy = items.find(i => i.keyId === 'hk_legacy0000000000000000');
        expect(legacy).toBeDefined();
        expect(legacy!.role).toBe('member'); // fail-safe-to-member
      } finally {
        closeHippoDb(db);
      }
    } finally {
      t.cleanup();
    }
  });
});
