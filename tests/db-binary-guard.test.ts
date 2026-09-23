import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { openHippoDb } from '../src/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-binguard-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('min_compatible_binary guard under the migration lock', () => {
  it('stops migrating once another binary raises the minimum mid-run', () => {
    // The trigger plays a newer process: it raises the minimum as soon as the first migration commits.
    const seed = new DatabaseSync(path.join(root, 'hippo.db'));
    seed.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER newer_binary AFTER INSERT ON meta WHEN NEW.key = 'schema_version'
      BEGIN INSERT INTO meta(key, value) VALUES ('min_compatible_binary', '99.0.0'); END;
    `);
    seed.close();
    expect(() => openHippoDb(root)).toThrow(/requires hippo-memory >= 99\.0\.0/);
  });
});
