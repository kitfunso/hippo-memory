import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { remember, rawArchive, retrieve } from '../../src/api/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { recordStatements, countMatching } from '../_helpers/count-statements.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

function queryOne<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get(...params) as T | undefined;
}

type SqliteValue = string | number | bigint | null | Uint8Array;

function queryAll<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T[] {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).all(...params) as T[];
}

describe('GDPR Path A completeness fixes', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('v039-completeness');
  });

  it('1. mirror reaper deletes markdown files for raw_archive rows on first open', () => {
    const db1 = openHippoDb(root);
    try {
      db1
        .prepare(
          `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'mem_legacy_canary_1',
          '2026-04-01T00:00:00.000Z',
          'GDPR purge',
          'cli',
          JSON.stringify({ redacted: true, tenant_id: 'default', kind: 'raw' }),
        );
    } finally {
      closeHippoDb(db1);
    }

    const episodicDir = join(root, 'episodic');
    mkdirSync(episodicDir, { recursive: true });
    const orphanPath = join(episodicDir, 'mem_legacy_canary_1.md');
    writeFileSync(orphanPath, '# legacy memory\n\noriginal-content-canary-FORGET-ME-quaxle', 'utf8');
    expect(existsSync(orphanPath)).toBe(true);

    const db2 = openHippoDb(root);
    try {
      expect(existsSync(orphanPath)).toBe(false);
      const cleanedAt = queryOne<{ mirror_cleaned_at?: string | null }>(
        db2,
        `SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`,
        'mem_legacy_canary_1',
      )?.mirror_cleaned_at;
      expect(cleanedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      closeHippoDb(db2);
    }

    const db3 = openHippoDb(root);
    try {
      const stillCleaned = queryOne<{ mirror_cleaned_at?: string | null }>(
        db3,
        `SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`,
        'mem_legacy_canary_1',
      )?.mirror_cleaned_at;
      expect(stillCleaned).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const pending = queryOne<{ c?: number }>(
        db3,
        `SELECT COUNT(*) AS c FROM raw_archive WHERE mirror_cleaned_at IS NULL`,
      )?.c;
      expect(pending).toBe(0);
    } finally {
      closeHippoDb(db3);
    }
  });

  it('2. mirror reaper is idempotent on a DB with zero raw_archive rows', () => {
    const db = openHippoDb(root);
    try {
      const count = queryOne<{ c?: number }>(db, `SELECT COUNT(*) AS c FROM raw_archive`)?.c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('2b. mirror reaper does NOT delete mirrors of non-archived (live) memories', async () => {
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    const live = await remember(ctx, { content: 'i-am-still-alive-content' });

    const db1 = openHippoDb(root);
    try {
      db1
        .prepare(
          `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'mem_other_archived_id',
          '2026-04-01T00:00:00.000Z',
          'GDPR purge',
          'cli',
          JSON.stringify({ redacted: true, tenant_id: 'default', kind: 'raw' }),
        );
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      const cleanedAt = queryOne<{ mirror_cleaned_at?: string | null }>(
        db2,
        `SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`,
        'mem_other_archived_id',
      )?.mirror_cleaned_at;
      expect(cleanedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      closeHippoDb(db2);
    }

    const layers = ['episodic', 'buffer', 'semantic'];
    const liveStillPresent = layers.some((layer) => existsSync(join(root, layer, `${live.id}.md`)));
    expect(liveStillPresent).toBe(true);
  });

  it('2c. reaper retries a failed unlink on every open, then stops scanning once the archive is clean', () => {
    const memId = 'mem_retry_canary_1';
    const opensThatSweep = (opens: number): number => {
      const { statements } = recordStatements(() => {
        for (let i = 0; i < opens; i++) closeHippoDb(openHippoDb(root));
      });
      return countMatching(statements, /^SELECT memory_id FROM raw_archive WHERE mirror_cleaned_at IS NULL/);
    };
    const pending = (): number | undefined => {
      const db = openHippoDb(root);
      try {
        return queryOne<{ c?: number }>(db, `SELECT COUNT(*) AS c FROM raw_archive WHERE mirror_cleaned_at IS NULL`)?.c;
      } finally {
        closeHippoDb(db);
      }
    };

    const db1 = openHippoDb(root);
    try {
      db1
        .prepare(
          `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          memId,
          '2026-04-15T00:00:00.000Z',
          'GDPR purge',
          'cli',
          JSON.stringify({ redacted: true, tenant_id: 'default', kind: 'raw' }),
        );
    } finally {
      closeHippoDb(db1);
    }

    const mirrorPath = join(root, 'episodic', `${memId}.md`);
    mkdirSync(mirrorPath, { recursive: true });
    expect(opensThatSweep(3)).toBe(3);
    expect(pending()).toBe(1);

    rmSync(mirrorPath, { recursive: true });
    writeFileSync(mirrorPath, 'legacy mirror content', 'utf8');
    expect(opensThatSweep(1)).toBe(1);
    expect(existsSync(mirrorPath)).toBe(false);
    expect(pending()).toBe(0);

    expect(opensThatSweep(5)).toBe(0);
  });

  it('3. recall audit_log row stores query_hash + query_length, no query field', async () => {
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'something to find with the canary query' });

    const distinctive = 'gdpr-canary-quaxle-2026';
    await retrieve(ctx, { query: distinctive });

    const db = openHippoDb(root);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events).toHaveLength(1);
      const meta = events[0].metadata;
      const expectedHash = createHash('sha256').update(distinctive).digest('hex').slice(0, 16);
      expect(meta.query_hash).toBe(expectedHash);
      expect(meta.query_length).toBe(distinctive.length);
      expect(meta.query).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });

  it('4. full RTBF: original content + query text appear in zero persistent tables after archive', async () => {
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    const canary = 'gdpr-canary-99-special-token-xyz';

    const { id } = await remember(ctx, {
      content: `payload contains ${canary} as a secret`,
      kind: 'raw',
    });

    await rawArchive(ctx, id, 'GDPR right-to-be-forgotten');

    await retrieve(ctx, { query: canary });

    const layers = ['episodic', 'buffer', 'semantic'];
    for (const layer of layers) {
      const file = join(root, layer, `${id}.md`);
      expect(existsSync(file)).toBe(false);
    }

    const db = openHippoDb(root);
    try {
      const tables = queryAll<{ name: string }>(
        db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_config' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_content'`,
      ).map((r) => r.name);

      const hits: Array<{ table: string; row: unknown }> = [];
      for (const table of tables) {
        const rows = queryAll<Record<string, SqliteValue>>(db, `SELECT * FROM "${table}"`);
        for (const row of rows) {
          const blob = JSON.stringify(row);
          if (blob.includes(canary)) {
            hits.push({ table, row });
          }
        }
      }
      expect(hits).toEqual([]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('5. cross-recall non-leakage: two recalls before/after archive both leave hash-only audit rows', async () => {
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    const queryText = 'special-private-cross-recall-string';
    const { id } = await remember(ctx, {
      content: `contains ${queryText} as content`,
      kind: 'raw',
    });

    const r1 = await retrieve(ctx, { query: queryText });
    expect(r1.results.length).toBeGreaterThanOrEqual(1);

    await rawArchive(ctx, id, 'GDPR purge');

    const r2 = await retrieve(ctx, { query: queryText });
    expect(r2.results.length).toBe(0);

    const db = openHippoDb(root);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events.length).toBe(2);
      const expectedHash = createHash('sha256').update(queryText).digest('hex').slice(0, 16);
      for (const ev of events) {
        const meta = ev.metadata;
        expect(meta.query).toBeUndefined();
        expect(meta.query_hash).toBe(expectedHash);
        expect(meta.query_length).toBe(queryText.length);
      }

      const rawAudit = queryAll<{ metadata_json: string }>(db, `SELECT metadata_json FROM audit_log`);
      for (const r of rawAudit) {
        expect(r.metadata_json).not.toContain(queryText);
      }
    } finally {
      closeHippoDb(db);
    }
  });
});
