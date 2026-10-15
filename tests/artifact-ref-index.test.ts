import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { LATEST_SCHEMA_VERSION } from './_helpers/schema-version.js';

const INDEX = 'idx_memories_artifact_ref';
const GITHUB_DELETE = `SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`;

describe('artifact_ref index (schema v58)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-artifact-index-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function indexNames(): string[] {
    const db = openHippoDb(root);
    try {
      // SAFETY: row shape follows the selected column.
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } finally {
      closeHippoDb(db);
    }
  }

  it('exists after init and serves the connector delete lookup', () => {
    initStore(root);
    expect(indexNames()).toContain(INDEX);
    const db = openHippoDb(root);
    try {
      // SAFETY: EXPLAIN QUERY PLAN rows carry a `detail` string.
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${GITHUB_DELETE}`).all('github:o/r#1', 'default') as Array<{ detail: string }>;
      expect(plan.map((p) => p.detail).join('\n')).toContain(INDEX);
    } finally {
      closeHippoDb(db);
    }
  });

  it('a store opened at v57 upgrades to v58 and gains the index', () => {
    initStore(root);
    const old = openHippoDb(root);
    old.exec(`DROP INDEX ${INDEX}`);
    old.exec(`UPDATE meta SET value = '57' WHERE key = 'schema_version'`);
    old.exec('PRAGMA user_version = 57');
    closeHippoDb(old);

    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      closeHippoDb(db);
    }
    expect(indexNames()).toContain(INDEX);
  });
});
