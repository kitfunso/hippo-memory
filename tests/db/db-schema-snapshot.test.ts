import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { dumpSchema } from '../_helpers/schema-dump.js';
import { makeRoot } from '../_helpers/make-root.js';

// Pins the exact DDL a fresh store ends with, so moving migration code cannot change one byte of schema.
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
});
