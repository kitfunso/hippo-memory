/**
 * Unit tests for pruneAuditLog (v1.12.9).
 *
 * Real-DB per project rule.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { appendAuditEvent } from '../src/audit.js';
import { pruneAuditLog, parseOlderThanFlag, computeCutoff } from '../src/audit-prune.js';

function seedAuditRow(
  db: DatabaseSyncLike,
  opts: { tenantId: string; op: 'remember' | 'recall' | 'outcome'; daysAgo: number },
): void {
  // Insert directly so we can control `ts` precisely (appendAuditEvent uses now()).
  const ts = new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ts, opts.tenantId, 'test', opts.op, null, '{}');
}

function countAudit(db: DatabaseSyncLike, tenantId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tenant_id = ?`)
    .get(tenantId) as { c: number | bigint };
  return Number(r.c);
}

describe('parseOlderThanFlag', () => {
  it.each([
    ['30', 30],
    ['30d', 30],
    ['90d', 90],
    ['1', 1],
    ['1d', 1],
    ['365d', 365],
  ])('parses %s as %d days', (raw, days) => {
    expect(parseOlderThanFlag(raw)).toBe(days);
  });

  it.each(['', '0', '0d', '-5', '-5d', 'abc', '30days', '30 d', '1.5d', 'd'])(
    'rejects invalid input %s',
    (raw) => {
      expect(() => parseOlderThanFlag(raw)).toThrow(/Invalid --older-than/);
    },
  );
});

describe('computeCutoff', () => {
  it('produces an ISO timestamp N days before the reference now', () => {
    const now = new Date('2026-05-24T12:00:00.000Z');
    expect(computeCutoff(30, now)).toBe('2026-04-24T12:00:00.000Z');
    expect(computeCutoff(90, now)).toBe('2026-02-23T12:00:00.000Z');
  });

  it('defaults to actual Date.now() when not pinned', () => {
    const before = Date.now();
    const out = computeCutoff(1);
    const after = Date.now();
    const cutoffMs = new Date(out).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - oneDayMs);
    expect(cutoffMs).toBeLessThanOrEqual(after - oneDayMs);
  });
});

describe('pruneAuditLog', () => {
  let root: string;
  let db: DatabaseSyncLike;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-audit-prune-'));
    initStore(root);
    db = openHippoDb(root);
  });

  afterEach(() => {
    closeHippoDb(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes rows older than the cutoff and preserves newer ones', () => {
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 100 });
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 95 });
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 50 });
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 1 });
    expect(countAudit(db, 'acme')).toBe(4);

    const result = pruneAuditLog(db, { olderThanDays: 90, tenantId: 'acme' });
    // 2 rows older than 90 days deleted, 2 rows newer preserved, +1 audit_prune row.
    expect(result.count).toBe(2);
    expect(result.dryRun).toBe(false);
    expect(countAudit(db, 'acme')).toBe(2 + 1); // remaining + the audit_prune event
  });

  it('is per-tenant — does NOT delete rows from other tenants', () => {
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 100 });
    seedAuditRow(db, { tenantId: 'globex', op: 'recall', daysAgo: 100 });
    seedAuditRow(db, { tenantId: 'initech', op: 'recall', daysAgo: 100 });

    const result = pruneAuditLog(db, { olderThanDays: 30, tenantId: 'acme' });
    expect(result.count).toBe(1);
    expect(countAudit(db, 'acme')).toBe(1); // the audit_prune event
    expect(countAudit(db, 'globex')).toBe(1); // untouched
    expect(countAudit(db, 'initech')).toBe(1); // untouched
  });

  it('dry-run returns count without deleting OR emitting an audit_prune row', () => {
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 100 });
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 95 });

    const result = pruneAuditLog(db, { olderThanDays: 90, tenantId: 'acme', dryRun: true });
    expect(result.count).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(countAudit(db, 'acme')).toBe(2); // nothing deleted, no audit_prune emitted
  });

  it('emits an audit_prune row with metadata after a real prune', () => {
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 100 });

    pruneAuditLog(db, { olderThanDays: 30, tenantId: 'acme', actor: 'cli:test' });

    const row = db
      .prepare(`SELECT actor, op, metadata_json FROM audit_log WHERE tenant_id = ? AND op = 'audit_prune'`)
      .get('acme') as { actor: string; op: string; metadata_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.actor).toBe('cli:test');
    expect(row!.op).toBe('audit_prune');
    const meta = JSON.parse(row!.metadata_json);
    expect(meta.count).toBe(1);
    expect(meta.dryRun).toBe(false);
    expect(meta.olderThanDays).toBe(30);
    expect(meta.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns count=0 when nothing matches', () => {
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 1 });

    const result = pruneAuditLog(db, { olderThanDays: 30, tenantId: 'acme' });
    expect(result.count).toBe(0);
    // audit_prune row still emitted even for zero-count prunes (full audit trail).
    expect(countAudit(db, 'acme')).toBe(2);
  });

  it('throws on non-positive olderThanDays', () => {
    expect(() => pruneAuditLog(db, { olderThanDays: 0, tenantId: 'acme' })).toThrow(/positive number/);
    expect(() => pruneAuditLog(db, { olderThanDays: -1, tenantId: 'acme' })).toThrow(/positive number/);
    expect(() => pruneAuditLog(db, { olderThanDays: NaN, tenantId: 'acme' })).toThrow(/positive number/);
  });

  it('throws on missing tenantId', () => {
    expect(() => pruneAuditLog(db, { olderThanDays: 30, tenantId: '' })).toThrow(/tenantId is required/);
  });

  it('the just-emitted audit_prune row is NOT itself pruned by the same call', () => {
    // Edge case: ensure the audit_prune row's ts > cutoff so it survives.
    seedAuditRow(db, { tenantId: 'acme', op: 'recall', daysAgo: 100 });
    pruneAuditLog(db, { olderThanDays: 1, tenantId: 'acme' });
    // 1 old row deleted, 1 audit_prune row remaining (its ts is now, way newer than cutoff).
    expect(countAudit(db, 'acme')).toBe(1);
    const surviving = db
      .prepare(`SELECT op FROM audit_log WHERE tenant_id = ?`)
      .all('acme') as Array<{ op: string }>;
    expect(surviving.map((r) => r.op)).toEqual(['audit_prune']);
  });
});
