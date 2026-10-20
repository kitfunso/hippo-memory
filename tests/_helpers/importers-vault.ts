// A hippo store and a scratch vault folder per test, with the note writer and archive reader the vault import tests share.
import { beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'node:url';
import { type ImportOptions } from '../../src/surface/importers/core.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeAfterRequest } from './one-request-per-test.js';

export let tmpDir: string; // hippo root (the store)
export let vaultDir: string; // a scratch vault folder we mutate per-test

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vault-imports');

export function useVaultImport() {
  beforeEach(() => {
    tmpDir = makeRoot('vault-store');
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-src-'));
  });

  afterEach(() => {
    removeAfterRequest(vaultDir);
  });
}

export function writeNote(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

export function opts(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return { hippoRoot: tmpDir, tenantId: 'default', ...overrides };
}

/** Read raw_archive rows directly for archive assertions. */
export function archivedRows(): Array<{ memory_id: string; reason: string }> {
  const db = openHippoDb(tmpDir);
  try {
    // SAFETY: query selects only the memory_id and reason text columns from
    // raw_archive, so every row in the result has exactly this shape.
    return db.prepare(`SELECT memory_id, reason FROM raw_archive ORDER BY archived_at ASC`).all() as Array<{
      memory_id: string;
      reason: string;
    }>;
  } finally {
    closeHippoDb(db);
  }
}
