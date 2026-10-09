/** listAuditEventsAfter pages the audit log by id without skipping or repeating an event. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { appendAuditEvent, listAuditEventsAfter, queryAuditEvents } from '../src/store/audit.js';
import { pruneAuditLog } from '../src/cli/audit-prune.js';

const INSERT_SQL =
  'INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)';

let home: string;
let db: DatabaseSyncLike;

function add(tenantId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    appendAuditEvent(db, { tenantId, actor: 'test', op: 'remember', targetId: `t-${i}` });
  }
}

function page(afterId: number, limit: number, tenantId?: string) {
  return listAuditEventsAfter(db, { afterId, limit, tenantId });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-audit-cursor-'));
  db = openHippoDb(home);
});

afterEach(() => {
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});

describe('listAuditEventsAfter', () => {
  it('pages 25 events across two tenants by 10 with unique ascending ids', () => {
    for (let i = 0; i < 25; i++) add(i % 2 === 0 ? 'tenant-a' : 'tenant-b', 1);
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const rows = page(cursor, 10);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      cursor = rows[rows.length - 1]!.id;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  // SHORTCUT: a rowid seek also reads other tenants' rows; add a (tenant_id, id) index if wide per-tenant exports get slow.
  it('seeks a tenant page by rowid, not via the tenant_ts index and its per-page sort', () => {
    add('tenant-a', 3);
    const seen: string[] = [];
    // SAFETY: listAuditEventsAfter only calls prepare, which the spy forwards to the real db.
    const spy = { prepare: (sql: string) => (seen.push(sql), db.prepare(sql)) } as DatabaseSyncLike;
    listAuditEventsAfter(spy, { afterId: 0, limit: 10, tenantId: 'tenant-a' });
    expect(seen).toHaveLength(1);
    // SAFETY: EXPLAIN QUERY PLAN returns rows with a `detail` text column.
    const planRows = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]!}`).all(0, 'tenant-a', 10) as Array<{ detail: string }>;
    const plan = planRows
      .map((r) => String(r.detail))
      .join(' | ');
    expect(plan).toContain('INTEGER PRIMARY KEY');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('filters by tenant and returns every tenant when omitted', () => {
    add('tenant-a', 3);
    add('tenant-b', 2);
    expect(page(0, 100, 'tenant-a')).toHaveLength(3);
    expect(page(0, 100, 'tenant-b').every((r) => r.tenantId === 'tenant-b')).toBe(true);
    expect(page(0, 100)).toHaveLength(5);
  });

  it('shows an event appended mid-paging on a later page', () => {
    add('tenant-a', 4);
    const first = page(0, 3);
    appendAuditEvent(db, { tenantId: 'tenant-a', actor: 'test', op: 'recall', targetId: 'late' });
    const rest = page(first[first.length - 1]!.id, 10);
    expect(rest.map((r) => r.targetId)).toContain('late');
    expect(rest).toHaveLength(2);
  });

  it('rejects a negative or fractional afterId with RangeError', () => {
    expect(() => page(-1, 10)).toThrow(RangeError);
    expect(() => page(1.5, 10)).toThrow(RangeError);
    expect(() => page(Number.NaN, 10)).toThrow(RangeError);
  });

  it('rejects a NaN or fractional limit with RangeError', () => {
    expect(() => page(0, Number.NaN)).toThrow(RangeError);
    expect(() => page(0, 2.5)).toThrow(RangeError);
  });

  it('clamps limit to 1..10000 and defaults to 1000', () => {
    add('tenant-a', 3);
    expect(page(0, 0)).toHaveLength(1);
    expect(page(0, -5)).toHaveLength(1);
    expect(listAuditEventsAfter(db, { afterId: 0 })).toHaveLength(3);
    const insert = db.prepare(INSERT_SQL);
    db.exec('BEGIN');
    for (let i = 0; i < 1100; i++) insert.run(new Date().toISOString(), 'tenant-c', 'test', 'remember', null, '{}');
    db.exec('COMMIT');
    expect(listAuditEventsAfter(db, { afterId: 0 })).toHaveLength(1000);
    expect(page(0, 50000, 'tenant-c')).toHaveLength(1100);
  });

  it('keeps paging correctly across a retention prune', () => {
    const insert = db.prepare(INSERT_SQL);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (let i = 0; i < 6; i++) insert.run(old, 'tenant-a', 'test', 'remember', null, '{}');
    add('tenant-a', 4);
    const first = page(0, 3);
    const lastSeen = first[first.length - 1]!.id;
    pruneAuditLog(home, { olderThanDays: 30, tenantId: 'tenant-a' });
    const rest = listAuditEventsAfter(db, { afterId: lastSeen, limit: 100 });
    expect(rest.every((r) => r.id > lastSeen)).toBe(true);
    expect(new Set(rest.map((r) => r.id)).size).toBe(rest.length);
    expect(rest.some((r) => r.op === 'audit_prune')).toBe(true);
    expect(rest.filter((r) => r.op === 'remember')).toHaveLength(4);
  });

  it('maps rows the same way queryAuditEvents does', () => {
    appendAuditEvent(db, { tenantId: 'tenant-a', actor: 'test', op: 'remember', targetId: 'x', metadata: { k: 1 } });
    expect(page(0, 10, 'tenant-a')).toEqual(queryAuditEvents(db, { tenantId: 'tenant-a' }));
  });
});
