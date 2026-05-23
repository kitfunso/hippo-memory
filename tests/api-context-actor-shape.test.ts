/**
 * Runtime test for v1.12.0 A5 v2 sub-1: Context.actor is now an Actor object
 * (NOT a string). adminActor() helper constructs the common-case (process-local
 * admin) shape used by CLI / MCP / connector entry points.
 *
 * Real-DB per project convention. Verifies the shape via api.remember +
 * audit_log round-trip: the actor.subject is what shows up in the audit row.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { adminActor, remember, type Actor, type Context } from '../src/api.js';

describe('Context.actor shape (v1.12.0)', () => {
  it('Actor is {subject, role}', () => {
    const a: Actor = { subject: 'cli', role: 'admin' };
    expect(a.subject).toBe('cli');
    expect(a.role).toBe('admin');
  });

  it('adminActor() builds {subject, role=admin}', () => {
    const a = adminActor('mcp');
    expect(a).toEqual({ subject: 'mcp', role: 'admin' });
  });

  it('member-role Actor is buildable directly', () => {
    const a: Actor = { subject: 'api_key:hk_test', role: 'member' };
    expect(a.role).toBe('member');
  });

  it('round-trip: ctx.actor.subject lands in audit_log as actor string', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-actor-shape-'));
    initStore(home);
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: adminActor('cli') };
      remember(ctx, { content: 'actor-shape-test-target' });

      const db = openHippoDb(home);
      try {
        const rows = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
        expect(rows.length).toBeGreaterThanOrEqual(1);
        // audit_log.actor column is TEXT storing the subject string (not the
        // full Actor object). v1.12.0 brainstorm decision #2.
        expect(rows[0]!.actor).toBe('cli');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
