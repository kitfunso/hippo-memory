import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openHippoDb,
  closeHippoDb,
  getCurrentSchemaVersion,
  getSchemaVersion,
} from '../src/db.js';
import { remember, archiveRaw, recall } from '../src/api.js';

/**
 * v0.39 GDPR Path A regression suite.
 *
 * Path A semantics: archiveRawMemory writes a redacted metadata-only payload
 * to raw_archive instead of snapshotting the full row. The compliance audit
 * trail lives in audit_log (op='archive_raw'). True right-to-be-forgotten —
 * after archive, the original content is unrecoverable from the database.
 *
 * Migration v20 backfills existing raw_archive rows to the new shape,
 * preserving tenant_id and kind from the legacy payload when parseable and
 * falling back to 'unknown' when the legacy JSON is malformed.
 */
describe('v0.39 GDPR Path A redaction + migration v20', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-v039-gdpr-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('1. schema v20: getCurrentSchemaVersion() returns 20', () => {
    expect(getCurrentSchemaVersion()).toBe(22);
    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(22);
    } finally {
      closeHippoDb(db);
    }
  });

  it('2. fresh archive Path A: payload_json is metadata-only (no original content)', () => {
    const ctx = { hippoRoot: root, tenantId: 'tenant-A', actor: 'cli' };
    const { id } = remember(ctx, {
      content: 'a-very-distinctive-secret-string-zylph123',
      kind: 'raw',
    });
    archiveRaw(ctx, id, 'GDPR right-to-be-forgotten');

    const db = openHippoDb(root);
    try {
      const archived = db
        .prepare(`SELECT payload_json FROM raw_archive WHERE memory_id = ?`)
        .get(id) as { payload_json: string } | undefined;
      expect(archived).toBeDefined();
      const payload = JSON.parse(archived!.payload_json) as Record<string, unknown>;
      expect(payload.redacted).toBe(true);
      expect(payload.tenant_id).toBe('tenant-A');
      expect(payload.kind).toBe('raw');
      expect(payload.reason).toBe('GDPR right-to-be-forgotten');
      expect(typeof payload.archived_at).toBe('string');
      // Critical: original content fields are NOT present.
      expect(payload.id).toBeUndefined();
      expect(payload.content).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('zylph123');
    } finally {
      closeHippoDb(db);
    }
  });

  it('3. migration v20 backfill: legacy payload with full content is redacted, tenant_id + kind preserved', () => {
    // Open at current version, then rewind schema_version meta to 19 so
    // reopening triggers the v20 migration. Hand-insert a legacy raw_archive
    // row whose payload_json carries the original content shape.
    const db1 = openHippoDb(root);
    try {
      db1
        .prepare(
          `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'm-legacy-1',
          '2026-04-01T00:00:00.000Z',
          'GDPR purge',
          'user:42',
          JSON.stringify({
            id: 'm-legacy-1',
            content: 'legacy-secret-canary-xyzzy',
            tenant_id: 't1',
            kind: 'raw',
          }),
        );
      // Rewind schema_version so the next openHippoDb() re-runs migration v20
      // against the row we just seeded.
      db1
        .prepare(
          `INSERT INTO meta(key, value) VALUES('schema_version', '19') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run();
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getSchemaVersion(db2)).toBe(22);
      const row = db2
        .prepare(`SELECT payload_json FROM raw_archive WHERE memory_id = ?`)
        .get('m-legacy-1') as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload.redacted).toBe(true);
      expect(payload.tenant_id).toBe('t1');
      expect(payload.kind).toBe('raw');
      expect(payload.reason).toBe('GDPR purge');
      expect(payload.archived_at).toBe('2026-04-01T00:00:00.000Z');
      expect(payload.migration).toBe('v20_redact');
      // Original content gone.
      expect(JSON.stringify(payload)).not.toContain('xyzzy');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('4. migration v20 with malformed legacy payload: falls back to unknowns', () => {
    const db1 = openHippoDb(root);
    try {
      db1
        .prepare(
          `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'm-malformed-1',
          '2026-04-02T00:00:00.000Z',
          'corrupted legacy',
          'user:99',
          'not-json',
        );
      db1
        .prepare(
          `INSERT INTO meta(key, value) VALUES('schema_version', '19') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run();
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getSchemaVersion(db2)).toBe(22);
      const row = db2
        .prepare(`SELECT payload_json FROM raw_archive WHERE memory_id = ?`)
        .get('m-malformed-1') as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload.redacted).toBe(true);
      expect(payload.tenant_id).toBe('unknown');
      expect(payload.kind).toBe('unknown');
      expect(payload.reason).toBe('corrupted legacy');
      expect(payload.archived_at).toBe('2026-04-02T00:00:00.000Z');
      expect(payload.migration).toBe('v20_redact');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('5. audit row preserved: archiveRaw writes audit_log op=archive_raw even though raw_archive is gone', () => {
    const ctx = { hippoRoot: root, tenantId: 'tenant-B', actor: 'user:42' };
    const { id } = remember(ctx, { content: 'audit-trail-content', kind: 'raw' });
    archiveRaw(ctx, id, 'compliance test');

    const db = openHippoDb(root);
    try {
      const auditRows = db
        .prepare(
          `SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE op = 'archive_raw' AND target_id = ?`,
        )
        .all(id) as Array<{
        tenant_id: string;
        actor: string;
        op: string;
        target_id: string;
        metadata_json: string;
      }>;
      expect(auditRows.length).toBe(1);
      const audit = auditRows[0];
      expect(audit.op).toBe('archive_raw');
      expect(audit.tenant_id).toBe('tenant-B');
      expect(audit.actor).toBe('user:42');
      expect(audit.target_id).toBe(id);
      const meta = JSON.parse(audit.metadata_json) as Record<string, unknown>;
      expect(meta.reason).toBe('compliance test');
    } finally {
      closeHippoDb(db);
    }
  });

  it('6. no re-recall after archive: original content text returns 0 results', () => {
    const ctx = { hippoRoot: root, tenantId: 'tenant-C', actor: 'cli' };
    const distinctive = 'gdpr-canary-token-quaxle';
    const { id } = remember(ctx, { content: distinctive, kind: 'raw' });

    // Pre-condition: recall finds it.
    const before = recall(ctx, { query: distinctive });
    expect(before.results.some((r) => r.id === id)).toBe(true);

    archiveRaw(ctx, id, 'right-to-be-forgotten');

    // Post-condition: gone from recall.
    const after = recall(ctx, { query: distinctive });
    expect(after.results.length).toBe(0);
  });
});
