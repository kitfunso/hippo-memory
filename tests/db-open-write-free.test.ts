// A store already at CURRENT_SCHEMA_VERSION must open write-free: same-value
// meta upserts on every open turned a concurrent writer into a locked read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'module';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb, getMeta } from '../src/db.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; this require + cast mirrors
// tests/store-migration.test.ts's documented boundary.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-open-write-free-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('openHippoDb on an already-current store is write-free', () => {
  it('returns in under 1000ms even while a second connection holds BEGIN IMMEDIATE', () => {
    // Fully migrate + stamp fts5_available first.
    closeHippoDb(openHippoDb(root));

    const dbPath = join(root, 'hippo.db');
    const holder = new DatabaseSync(dbPath);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec(`INSERT INTO meta(key, value) VALUES('lockprobe', 'x') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

    try {
      const started = Date.now();
      const db = openHippoDb(root);
      const elapsedMs = Date.now() - started;
      try {
        expect(elapsedMs).toBeLessThan(1000);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('self-heal is intact: fresh store stamps fts5_available=1', () => {
    const db = openHippoDb(root);
    try {
      expect(getMeta(db, 'fts5_available')).toBe('1');
    } finally {
      closeHippoDb(db);
    }
  });

  it('self-heal is intact: dropping memories_fts rebuilds and backfills it on reopen', () => {
    initStore(root);
    const m = createMemory('fts self-heal probe content', { layer: Layer.Episodic });
    writeEntry(root, m);

    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE memories_fts');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      const tables = (db2
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`)
        .all() as Array<{ name: string }>);
      expect(tables.length).toBe(1);
      const row = db2.prepare(`SELECT COUNT(*) AS c FROM memories_fts WHERE id = ?`).get(m.id) as
        | { c?: number }
        | undefined;
      expect(row?.c ?? 0).toBe(1);
      expect(getMeta(db2, 'fts5_available')).toBe('1');
    } finally {
      closeHippoDb(db2);
    }
  });
});
