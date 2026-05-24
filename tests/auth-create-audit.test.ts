/**
 * v1.12.4: tests for the auth_create audit emit.
 *
 * Closes the v1.12.3 CHANGELOG-flagged deferral. Mirrors auth_revoke audit
 * coverage (already locked in tests/audit.test.ts and the M1 fix history).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authCreate, authRevoke, adminActor, type Context } from '../src/api.js';
import { queryAuditEvents } from '../src/audit.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function newCtx(tenantId = 'default'): { ctx: Context; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hippo-auth-create-audit-'));
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

function getAuditRows(hippoRoot: string, tenantId: string, op: 'auth_create' | 'auth_revoke'): Array<{
  actor: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
}> {
  const db = openHippoDb(hippoRoot);
  try {
    return queryAuditEvents(db, { tenantId, op, limit: 50 }).map((r) => ({
      actor: r.actor,
      targetId: r.targetId,
      metadata: r.metadata as Record<string, unknown>,
    }));
  } finally {
    closeHippoDb(db);
  }
}

describe('v1.12.4 auth_create audit emit', () => {
  it('authCreate emits one auth_create audit row with label + role metadata', () => {
    const t = newCtx();
    try {
      const result = authCreate(t.ctx, { label: 'cli', role: 'admin' });

      const rows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      expect(rows.length).toBe(1);
      expect(rows[0].targetId).toBe(result.keyId);
      expect(rows[0].actor).toBe('cli');
      expect(rows[0].metadata.label).toBe('cli');
      expect(rows[0].metadata.role).toBe('admin');
    } finally {
      t.cleanup();
    }
  });

  it('authCreate with default role logs role=admin in audit metadata', () => {
    const t = newCtx();
    try {
      authCreate(t.ctx, { label: 'no-role-passed' });
      const rows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      expect(rows.length).toBe(1);
      expect(rows[0].metadata.role).toBe('admin');
    } finally {
      t.cleanup();
    }
  });

  it('authCreate with role=member logs role=member in audit metadata', () => {
    const t = newCtx();
    try {
      authCreate(t.ctx, { label: 'reporter', role: 'member' });
      const rows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      expect(rows.length).toBe(1);
      expect(rows[0].metadata.role).toBe('member');
      expect(rows[0].metadata.label).toBe('reporter');
    } finally {
      t.cleanup();
    }
  });

  it('authCreate with no label logs label=null (not "undefined" string)', () => {
    const t = newCtx();
    try {
      authCreate(t.ctx, {});
      const rows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      expect(rows.length).toBe(1);
      expect(rows[0].metadata.label).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('audit metadata MUST NOT contain plaintext key (security invariant)', () => {
    const t = newCtx();
    try {
      const result = authCreate(t.ctx, { label: 'security-check' });
      const rows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      expect(rows.length).toBe(1);
      // The full JSON-stringified metadata must not contain the plaintext
      const stringified = JSON.stringify(rows[0].metadata);
      expect(stringified).not.toContain(result.plaintext);
      // Sanity: the plaintext starts with 'hk_' + 24 chars + '.' + body
      expect(result.plaintext).toMatch(/^hk_[a-z2-7]{24}\.[a-z2-7]+$/);
    } finally {
      t.cleanup();
    }
  });

  it('mint + revoke pair: 1 auth_create row + 1 auth_revoke row, both targetId match', () => {
    const t = newCtx();
    try {
      const mint = authCreate(t.ctx, { label: 'mint-then-revoke' });
      authRevoke(t.ctx, mint.keyId);

      const createRows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_create');
      const revokeRows = getAuditRows(t.ctx.hippoRoot, t.ctx.tenantId, 'auth_revoke');
      expect(createRows.length).toBe(1);
      expect(revokeRows.length).toBe(1);
      expect(createRows[0].targetId).toBe(mint.keyId);
      expect(revokeRows[0].targetId).toBe(mint.keyId);
    } finally {
      t.cleanup();
    }
  });
});
