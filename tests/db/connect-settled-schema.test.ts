// A store this process has proven is not probed again; a newer stamp or floor still refuses. Real SQLite store.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb, isFtsInSync, getMeta, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { DatabaseSync } from '../../src/db/sqlite.js';
import { getCurrentSchemaVersion, repairFtsDrift } from '../../src/db/migrate.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

// SAFETY: node:sqlite has no bundled types; the spy only needs prepare's SQL argument.
const { DatabaseSync: NodeSqlite } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};
// Only the full probe names its meta key count.
const FULL_PROBE = /AS meta_keys/;

/** How many times `fn` prepares the schema probe, counted at prepare so a probe that throws on a new file still counts. */
function probesPrepared(fn: () => void): number {
  const original = NodeSqlite.prototype.prepare;
  let probes = 0;
  const spy = vi.spyOn(NodeSqlite.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSyncLike,
    ...args: [string]
  ) {
    if (FULL_PROBE.test(args[0])) probes++;
    return original.apply(this, args);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return probes;
}

describe('connection open after the schema is proven', () => {
  it('a store opened twice in one process runs the schema probe once', () => {
    const root = makeRoot('settled-probe', { init: false });
    const probes = probesPrepared(() => {
      closeHippoDb(openHippoDb(root));
      closeHippoDb(openHippoDb(root));
      closeHippoDb(openHippoDb(root));
    });
    expect(probes).toBe(1);
  });

  it('a newer user_version sends the open down the full path and a raised floor still refuses', () => {
    const root = makeRoot('settled-newer');
    closeHippoDb(openHippoDb(root));
    const raw = new DatabaseSync(join(root, 'hippo.db'));
    try {
      raw.exec(`PRAGMA user_version = ${getCurrentSchemaVersion() + 1}`);
      setMeta(raw, 'min_compatible_binary', '99.0.0');
    } finally {
      raw.close();
    }
    expect(() => openHippoDb(root)).toThrow(/requires hippo-memory >= 99\.0\.0/);
  });

  it('a user_version moved by another process sends the next open through the probe again', () => {
    const root = makeRoot('settled-moved');
    closeHippoDb(openHippoDb(root));
    const raw = new DatabaseSync(join(root, 'hippo.db'));
    try {
      raw.exec('PRAGMA user_version = 1');
    } finally {
      raw.close();
    }
    expect(probesPrepared(() => closeHippoDb(openHippoDb(root)))).toBe(1);
  });
});

describe('the FTS in-sync flag', () => {
  it('a raw write that drifts the index is repaired by sleep and the flag reads true after', () => {
    const root = makeRoot('settled-fts');
    writeEntry(root, createMemory('a gribblesnort row for the flag test'));
    const db = openHippoDb(root);
    try {
      expect(isFtsInSync(db)).toBe(true);
      db.prepare(`DELETE FROM memories_fts WHERE content LIKE '%gribblesnort%'`).run();
      setMeta(db, 'fts_in_sync', '0');
      expect(repairFtsDrift(db)).toBe(true);
      expect(isFtsInSync(db)).toBe(true);
      expect(getMeta(db, 'fts_in_sync')).toBe('1');
    } finally {
      closeHippoDb(db);
    }
  });
});
