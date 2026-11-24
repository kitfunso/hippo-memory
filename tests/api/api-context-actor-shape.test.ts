import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { adminActor, remember, type Actor } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('Context.actor shape', () => {
  it('Actor is {subject, role}', () => {
    const a: Actor = { subject: 'cli', role: 'admin' };
    expect(a.subject).toBe('cli');
    expect(a.role).toBe('admin');
  });

  it('adminActor() builds {subject, role=admin, hostAdmin}', () => {
    const a = adminActor('mcp');
    expect(a).toEqual({ subject: 'mcp', role: 'admin', hostAdmin: true });
  });

  it('member-role Actor is buildable directly', () => {
    const a: Actor = { subject: 'api_key:hk_test', role: 'member' };
    expect(a.role).toBe('member');
  });

  it('round-trip: ctx.actor.subject lands in audit_log as actor string', async () => {
    const home = makeRoot('actor-shape');
    const ctx: FullContext = apiCtx(home, 'default', adminActor('cli'));
    await remember(ctx, { content: 'actor-shape-test-target' });

    const db = openHippoDb(home);
    try {
      const rows = listAuditEvents(db, { tenantId: 'default', op: 'remember' });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.actor).toBe('cli');
    } finally {
      closeHippoDb(db);
    }
  });
});
