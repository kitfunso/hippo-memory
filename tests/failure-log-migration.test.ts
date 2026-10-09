/** Schema v46 (ROADMAP CD13): a v45 store gains the failure log on its next open. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getMeta, setMeta } from '../src/db/index.js';
import { LATEST_SCHEMA_VERSION_STR } from './_helpers/schema-version.js';

describe('schema v46', () => {
  it('a v45 store gains failure_log with its columns and both indexes', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v46-'));
    try {
      let db = openHippoDb(home);
      try {
        db.exec('DROP TABLE failure_log');
        setMeta(db, 'schema_version', '45');
      } finally {
        closeHippoDb(db);
      }
      db = openHippoDb(home);
      try {
        expect(getMeta(db, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
        // SAFETY: PRAGMA table_info rows carry a TEXT name column.
        const columns = (db.prepare(`PRAGMA table_info(failure_log)`).all() as Array<{ name: string }>).map((c) => c.name);
        // The open runs on to the latest schema, so v54's owner, project and retry columns follow v46's.
        expect(columns).toEqual(['id', 'ts', 'tenant_id', 'session_id', 'tool', 'outcome', 'skip_rule', 'sig_hash', 'detail_hash', 'owner_subject', 'origin_project', 'request_id']);
        // SAFETY: the SELECT names one TEXT column.
        const indexes = (db.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'failure_log' ORDER BY name`,
        ).all() as Array<{ name: string }>).map((r) => r.name);
        expect(indexes).toEqual(['idx_failure_log_request', 'idx_failure_log_tenant', 'idx_failure_log_ts']);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
