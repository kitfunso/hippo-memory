import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { appendAuditEvent, queryAuditEvents } from '../src/audit.js';

describe('audit log', () => {
  it('appendAuditEvent persists row with required fields', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-'));
    const db = openHippoDb(home);
    try {
      appendAuditEvent(db, {
        tenantId: 'default',
        actor: 'cli',
        op: 'remember',
        targetId: 'm1',
        metadata: { content_len: 42 },
      });
      const rows = queryAuditEvents(db, { tenantId: 'default' });
      expect(rows.length).toBe(1);
      expect(rows[0]!.op).toBe('remember');
      expect(rows[0]!.targetId).toBe('m1');
      expect(rows[0]!.metadata.content_len).toBe(42);
      expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('queryAuditEvents filters by op and limit', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-'));
    const db = openHippoDb(home);
    try {
      for (const op of ['remember', 'remember', 'recall', 'forget'] as const) {
        appendAuditEvent(db, { tenantId: 'default', actor: 'cli', op });
      }
      const recalls = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(recalls.length).toBe(1);
      const limited = queryAuditEvents(db, { tenantId: 'default', limit: 2 });
      expect(limited.length).toBe(2);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('queryAuditEvents isolates by tenant', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-'));
    const db = openHippoDb(home);
    try {
      appendAuditEvent(db, { tenantId: 'alpha', actor: 'cli', op: 'remember' });
      appendAuditEvent(db, { tenantId: 'beta', actor: 'cli', op: 'remember' });
      expect(queryAuditEvents(db, { tenantId: 'alpha' }).length).toBe(1);
      expect(queryAuditEvents(db, { tenantId: 'beta' }).length).toBe(1);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
