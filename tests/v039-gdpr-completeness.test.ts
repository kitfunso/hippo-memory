import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  openHippoDb,
  closeHippoDb,
  getMeta,
} from '../src/db.js';
import { remember, archiveRaw, recall } from '../src/api.js';
import { queryAuditEvents } from '../src/audit.js';

/**
 * v0.39 GDPR Path A completeness regression suite.
 *
 * Closes the three holes flagged by the pre-landing /review:
 *   1. Markdown mirror reaper after migration v20 (RTBF on historical archives)
 *   2. Recall audit stores sha256(query) hash instead of original query text
 *   3. archiveRaw mirror cleanup wrapped in try/catch; reaper handles retry
 *
 * The full-DB canary scan (test 4) is the load-bearing assertion: after the
 * archive + redact + hash flow, the original content must not exist in any
 * persistent table.
 */
describe('v0.39 GDPR Path A completeness fixes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-v039-completeness-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Fix 1: post-migration mirror reaper for legacy archives
  // ---------------------------------------------------------------------------

  it('1. mirror reaper deletes markdown files for raw_archive rows on first open', () => {
    // Bootstrap a fresh DB so we can hand-craft a "v18-style" raw_archive row
    // and matching markdown mirror that would have existed pre-70180b5.
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
      // Rewind cleanup flag so a re-open triggers the reaper.
      db1
        .prepare(
          `INSERT INTO meta(key, value) VALUES('gdpr_v20_mirror_cleanup', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run();
    } finally {
      closeHippoDb(db1);
    }

    // Plant the orphan markdown file containing the original content.
    const episodicDir = join(root, 'episodic');
    mkdirSync(episodicDir, { recursive: true });
    const orphanPath = join(episodicDir, 'mem_legacy_canary_1.md');
    writeFileSync(
      orphanPath,
      '# legacy memory\n\noriginal-content-canary-FORGET-ME-quaxle',
      'utf8',
    );
    expect(existsSync(orphanPath)).toBe(true);

    // Re-open: reaper runs, file disappears.
    const db2 = openHippoDb(root);
    try {
      expect(existsSync(orphanPath)).toBe(false);
      expect(getMeta(db2, 'gdpr_v20_mirror_cleanup', '')).toBe('done');
    } finally {
      closeHippoDb(db2);
    }

    // Re-open again: idempotent — reaper short-circuits, no errors.
    const db3 = openHippoDb(root);
    try {
      expect(getMeta(db3, 'gdpr_v20_mirror_cleanup', '')).toBe('done');
    } finally {
      closeHippoDb(db3);
    }
  });

  it('2. mirror reaper is idempotent on a DB with zero raw_archive rows', () => {
    // Fresh open — no raw_archive rows. Reaper should set the meta flag and exit cleanly.
    const db = openHippoDb(root);
    try {
      expect(getMeta(db, 'gdpr_v20_mirror_cleanup', '')).toBe('done');
      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM raw_archive`).get() as { c?: number }
      )?.c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('2b. mirror reaper does NOT delete mirrors of non-archived (live) memories', () => {
    // Plant a raw_archive row + a UNRELATED live memory with a mirror; reaper
    // must only touch files whose id appears in raw_archive.
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    const live = remember(ctx, { content: 'i-am-still-alive-content' });

    // Force re-run of reaper on next open by inserting a raw_archive row +
    // resetting the meta flag.
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
      db1
        .prepare(
          `INSERT INTO meta(key, value) VALUES('gdpr_v20_mirror_cleanup', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run();
    } finally {
      closeHippoDb(db1);
    }

    // Re-open: reaper runs. live memory's mirror must survive.
    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'gdpr_v20_mirror_cleanup', '')).toBe('done');
    } finally {
      closeHippoDb(db2);
    }

    // The live memory's markdown file should still exist somewhere under the
    // layer dirs (writeEntry mirrors it on remember).
    const layers = ['episodic', 'buffer', 'semantic'];
    const liveStillPresent = layers.some((layer) =>
      existsSync(join(root, layer, `${live.id}.md`)),
    );
    expect(liveStillPresent).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Fix 2: recall audit stores query_hash, not query text
  // ---------------------------------------------------------------------------

  it('3. recall audit_log row stores query_hash + query_length, no query field', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'something to find with the canary query' });

    const distinctive = 'gdpr-canary-quaxle-2026';
    recall(ctx, { query: distinctive });

    const db = openHippoDb(root);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events.length).toBeGreaterThan(0);
      const meta = events[0].metadata as Record<string, unknown>;
      const expectedHash = createHash('sha256').update(distinctive).digest('hex').slice(0, 16);
      expect(meta.query_hash).toBe(expectedHash);
      expect(meta.query_length).toBe(distinctive.length);
      expect(meta.query).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });

  // ---------------------------------------------------------------------------
  // Fix 3 verification (also full RTBF): canary scan across all tables
  // ---------------------------------------------------------------------------

  it('4. full RTBF: original content + query text appear in zero persistent tables after archive', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    const canary = 'gdpr-canary-99-special-token-xyz';

    // Seed: kind='raw' so it can be archived. Content embeds the canary.
    const { id } = remember(ctx, {
      content: `payload contains ${canary} as a secret`,
      kind: 'raw',
    });

    // Archive (RTBF). Mirror cleanup must NOT throw.
    archiveRaw(ctx, id, 'GDPR right-to-be-forgotten');

    // Recall using the canary as the query — must not bring back the archived row.
    recall(ctx, { query: canary });

    // Markdown mirrors gone.
    const layers = ['episodic', 'buffer', 'semantic'];
    for (const layer of layers) {
      const file = join(root, layer, `${id}.md`);
      expect(existsSync(file)).toBe(false);
    }

    // Full-DB scan: enumerate every user table, dump every TEXT/BLOB column,
    // assert the canary appears nowhere.
    const db = openHippoDb(root);
    try {
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_config' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_content'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      const hits: Array<{ table: string; row: unknown }> = [];
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const blob = JSON.stringify(row);
          if (blob.includes(canary)) {
            hits.push({ table, row });
          }
        }
      }
      // FTS5 is intentionally excluded above (its shadow tables can hold pre-
      // delete tokens for a moment). The persistent record tables must be clean.
      expect(hits).toEqual([]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('5. cross-recall non-leakage: two recalls before/after archive both leave hash-only audit rows', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    const queryText = 'special-private-cross-recall-string';
    const { id } = remember(ctx, {
      content: `contains ${queryText} as content`,
      kind: 'raw',
    });

    // Recall #1: matches.
    const r1 = recall(ctx, { query: queryText });
    expect(r1.results.length).toBeGreaterThanOrEqual(1);

    // Archive.
    archiveRaw(ctx, id, 'GDPR purge');

    // Recall #2: same query text, no match.
    const r2 = recall(ctx, { query: queryText });
    expect(r2.results.length).toBe(0);

    const db = openHippoDb(root);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events.length).toBe(2);
      const expectedHash = createHash('sha256').update(queryText).digest('hex').slice(0, 16);
      for (const ev of events) {
        const meta = ev.metadata as Record<string, unknown>;
        expect(meta.query).toBeUndefined();
        expect(meta.query_hash).toBe(expectedHash);
        expect(meta.query_length).toBe(queryText.length);
      }

      // Belt-and-braces: query text appears nowhere in audit_log raw json.
      const rawAudit = db
        .prepare(`SELECT metadata_json FROM audit_log`)
        .all() as Array<{ metadata_json: string }>;
      for (const r of rawAudit) {
        expect(r.metadata_json).not.toContain(queryText);
      }
    } finally {
      closeHippoDb(db);
    }
  });
});
