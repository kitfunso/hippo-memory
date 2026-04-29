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

  it('memories table has kind column with default distilled', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const kind = cols.find((c) => c.name === 'kind');
    expect(kind).toBeDefined();
    expect(kind!.dflt_value).toContain('distilled');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it.todo('rejects kind value outside CHECK set — Task 6');
});
