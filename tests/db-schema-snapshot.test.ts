import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { dumpSchema } from './_helpers/schema-dump.js';

// Pins the exact DDL a fresh store ends with, so moving migration code cannot change one byte of schema.
describe('fresh store schema', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('matches the pinned sqlite_master and user_version', () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-schema-fresh-'));
    const db = openHippoDb(root);
    try {
      expect(dumpSchema(db)).toMatchSnapshot();
    } finally {
      closeHippoDb(db);
    }
  });
});
