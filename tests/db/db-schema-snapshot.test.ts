import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { HEALED_TABLES } from '../../src/db/continuity-tables.js';
import { dumpSchema, type SchemaDump } from '../_helpers/schema-dump.js';
import { makeRoot } from '../_helpers/make-root.js';

// Pins the DDL a fresh store ends with, less its comments and layout, so moving migration code cannot change the schema.
describe('fresh store schema', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
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
    root = makeRoot('schema-healed');
    const db = openHippoDb(root);
    let migrated: SchemaDump;
    try {
      migrated = dumpSchema(db);
      for (const table of HEALED_TABLES) db.exec(`DROP TABLE ${table}`);
    } finally {
      closeHippoDb(db);
    }
    const healed = openHippoDb(root);
    try {
      expect(dumpSchema(healed)).toEqual(migrated);
    } finally {
      closeHippoDb(healed);
    }
  });
});
