import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { HEALED_TABLES } from '../../src/db/continuity-tables.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { dumpSchema, type SchemaDump } from '../_helpers/schema-dump.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string | undefined;

/** Migrates a new store under `label` from nothing, runs `lose` on it, and returns the schema it had before. */
function migratedThenLost(label: string, lose: (db: DatabaseSyncLike) => void): SchemaDump {
  root = makeRoot(label, { init: false });
  const db = openHippoDb(root);
  try {
    const migrated = dumpSchema(db);
    lose(db);
    return migrated;
  } finally {
    closeHippoDb(db);
  }
}

function reopenedSchema(): SchemaDump {
  const db = openHippoDb(root!);
  try {
    return dumpSchema(db);
  } finally {
    closeHippoDb(db);
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// Pins the DDL a fresh store ends with, less its comments and layout, so moving migration code cannot change the schema.
describe('fresh store schema', () => {
  // First in the file: the chain's result is kept per process, so a heal before this would hide a build here.
  it('a reopen that heals no table or index never runs the migration chain on its own', () => {
    const up = vi.spyOn(MIGRATIONS[0]!, 'up');
    try {
      // A missing meta default sends the reopen down the repair path, past the probe that skips it.
      migratedThenLost('schema-lazy', (db) => db.exec(`DELETE FROM meta WHERE key = 'last_trace_id'`));
      expect(reopenedSchema().objects.length).toBeGreaterThan(0);
      expect(up).toHaveBeenCalledTimes(1);
    } finally {
      up.mockRestore();
    }
  });

  it('matches the pinned sqlite_master and user_version', () => {
    root = makeRoot('schema-fresh');
    const db = openHippoDb(root);
    try {
      expect(dumpSchema(db)).toMatchSnapshot();
    } finally {
      closeHippoDb(db);
    }
  });

  it('a stamped store that lost its healed tables reopens to the schema the migrations make', () => {
    const migrated = migratedThenLost('schema-healed', (db) => {
      for (const table of HEALED_TABLES) db.exec(`DROP TABLE ${table}`);
    });
    expect(reopenedSchema()).toEqual(migrated);
  });

  it.each(['idx_cards_tenant_status', 'idx_compactions_request'])(
    'a stamped store that lost only %s reopens to the schema the migrations make',
    (index) => {
      const migrated = migratedThenLost('schema-healed-index', (db) => db.exec(`DROP INDEX ${index}`));
      expect(reopenedSchema()).toEqual(migrated);
    },
  );
});
