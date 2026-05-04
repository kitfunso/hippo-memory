import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, getMeta } from '../src/db.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('schema v24 — github connector tables', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('github-schema'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('schema version is at least 24', () => {
    const db = openHippoDb(root);
    try {
      const v = Number(getMeta(db, 'schema_version', '0'));
      expect(v).toBeGreaterThanOrEqual(24);
    } finally { closeHippoDb(db); }
  });

  it('github_event_log has PK on idempotency_key and required columns', () => {
    const db = openHippoDb(root);
    try {
      const cols = db.prepare(`PRAGMA table_info(github_event_log)`).all() as Array<Record<string, unknown>>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('idempotency_key')).toBe(true);
      expect(names.has('delivery_id')).toBe(true);
      expect(names.has('event_name')).toBe(true);
      expect(names.has('ingested_at')).toBe(true);
      expect(names.has('memory_id')).toBe(true);
      const pk = cols.find((c) => c.name === 'idempotency_key');
      expect(pk!.pk).toBe(1);

      db.prepare(`INSERT INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?,?,?,?,?)`)
        .run('K1', 'D1', 'issues', '2026-05-04T00:00:00Z', 'm1');
      expect(() =>
        db.prepare(`INSERT INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?,?,?,?,?)`)
          .run('K1', 'D2', 'issues', '2026-05-04T00:00:01Z', 'm2'),
      ).toThrow();
    } finally { closeHippoDb(db); }
  });

  it('github_cursors has composite PK and per-stream HWM columns', () => {
    const db = openHippoDb(root);
    try {
      const cols = db.prepare(`PRAGMA table_info(github_cursors)`).all() as Array<Record<string, unknown>>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('issues_hwm')).toBe(true);
      expect(names.has('issue_comments_hwm')).toBe(true);
      expect(names.has('pr_review_comments_hwm')).toBe(true);

      db.prepare(`INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, issue_comments_hwm, pr_review_comments_hwm, updated_at) VALUES (?,?,?,?,?,?)`)
        .run('default', 'acme/repo', '2026-05-04T00:00:00Z', null, null, '2026-05-04T00:00:00Z');
      expect(() =>
        db.prepare(`INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, issue_comments_hwm, pr_review_comments_hwm, updated_at) VALUES (?,?,?,?,?,?)`)
          .run('default', 'acme/repo', '2026-05-04T00:01:00Z', null, null, '2026-05-04T00:01:00Z'),
      ).toThrow();
    } finally { closeHippoDb(db); }
  });

  it('github_dlq has all replay-required columns', () => {
    const db = openHippoDb(root);
    try {
      const cols = db.prepare(`PRAGMA table_info(github_dlq)`).all() as Array<Record<string, unknown>>;
      const names = new Set(cols.map((c) => c.name));
      for (const col of ['id', 'tenant_id', 'raw_payload', 'error', 'event_name', 'delivery_id', 'signature', 'installation_id', 'repo_full_name', 'retry_count', 'received_at', 'retried_at', 'bucket']) {
        expect(names.has(col), `missing column: ${col}`).toBe(true);
      }
      db.prepare(`INSERT INTO github_dlq (tenant_id, raw_payload, error, received_at, bucket) VALUES (?,?,?,?,?)`)
        .run('default', '{}', 'parse error', '2026-05-04T00:00:00Z', 'parse_error');
      const row = db.prepare(`SELECT id, retry_count FROM github_dlq LIMIT 1`).get() as { id: number; retry_count: number };
      expect(row.id).toBe(1);
      expect(row.retry_count).toBe(0);
    } finally { closeHippoDb(db); }
  });

  it('github_installations has PK on installation_id', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?,?,?)`)
        .run('100', 'acme', '2026-05-04T00:00:00Z');
      expect(() =>
        db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?,?,?)`)
          .run('100', 'other', '2026-05-04T00:00:01Z'),
      ).toThrow();
    } finally { closeHippoDb(db); }
  });

  it('github_repositories has composite PK', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?,?,?)`)
        .run('acme/repo', 'tenant-a', '2026-05-04T00:00:00Z');
      // Same repo for different tenant: NOT a collision (composite PK).
      db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?,?,?)`)
        .run('acme/repo', 'tenant-b', '2026-05-04T00:00:01Z');
      // Same (repo, tenant): collides.
      expect(() =>
        db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?,?,?)`)
          .run('acme/repo', 'tenant-a', '2026-05-04T00:00:02Z'),
      ).toThrow();
    } finally { closeHippoDb(db); }
  });

  it('writes min_compatible_binary = 1.2.1 to meta', () => {
    const db = openHippoDb(root);
    try {
      const v = getMeta(db, 'min_compatible_binary', '');
      expect(v).toBe('1.2.1');
    } finally { closeHippoDb(db); }
  });

  it('migration is idempotent: re-opening the DB does not error', () => {
    const db1 = openHippoDb(root);
    closeHippoDb(db1);
    const db2 = openHippoDb(root);
    try {
      const v = Number(getMeta(db2, 'schema_version', '0'));
      expect(v).toBeGreaterThanOrEqual(24);
    } finally { closeHippoDb(db2); }
  });
});
