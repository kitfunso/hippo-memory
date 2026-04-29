import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, getCurrentSchemaVersion, getSchemaVersion, closeHippoDb } from '../src/db.js';

describe('A3 envelope migration v14', () => {
  it('CURRENT_SCHEMA_VERSION is 14', () => {
    expect(getCurrentSchemaVersion()).toBe(14);
  });

  it('fresh db migrates to v14', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(getSchemaVersion(db)).toBe(14);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
