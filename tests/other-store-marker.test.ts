// A hippo root holding the other-store marker refuses every hippo.db open, from the CLI as from a request, and never creates the file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  OTHER_STORE_MARKER,
  OtherStoreFolderError,
  openHippoDb,
  openHippoDbReadOnly,
  SqliteBlockedError,
  withSharedStoreHandles,
  withSqliteAllowed,
} from '../src/db/index.js';
import { repairAutomaticMemories } from '../src/store/quality-repair.js';
import * as serverEntry from '../src/server.js';
import { initStore } from '../src/store/open.js';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

let root: string;
let marker: string;

const dbFiles = (): string[] => readdirSync(root).filter((name) => name.startsWith('hippo.db'));

/** The refusal `open` throws; any other outcome fails the test. */
function refusal(open: () => DatabaseSyncLike): OtherStoreFolderError {
  try {
    closeHippoDb(open());
  } catch (err) {
    if (err instanceof OtherStoreFolderError) return err;
    throw err;
  }
  throw new Error('hippo.db opened in a marked folder');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-marker-'));
  marker = join(root, OTHER_STORE_MARKER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the other-store marker', () => {
  it.each([
    ['openHippoDb', () => openHippoDb(root)],
    ['openHippoDbReadOnly', () => openHippoDbReadOnly(root)],
  ] as const)('%s refuses with the store kind and creates no hippo.db', (_name, open) => {
    writeFileSync(marker, 'postgres\n');
    const err = refusal(open);
    expect(err).toBeInstanceOf(SqliteBlockedError);
    expect(err.storeKind).toBe('postgres');
    expect(err.message).toBe(`This folder's memories live in the 'postgres' store, so hippo.db is not used here (marker: ${marker})`);
    expect(readdirSync(root)).toEqual([OTHER_STORE_MARKER]);
  });

  it('refuses an existing hippo.db too, as a folder copied to another store keeps one', () => {
    initStore(root);
    writeFileSync(marker, 'postgres');
    expect(refusal(() => openHippoDb(root)).storeKind).toBe('postgres');
    expect(refusal(() => openHippoDbReadOnly(root)).storeKind).toBe('postgres');
  });

  it('withSqliteAllowed waives it, across an await as well', async () => {
    writeFileSync(marker, 'postgres');
    closeHippoDb(withSqliteAllowed(() => openHippoDb(root)));
    expect(existsSync(join(root, 'hippo.db'))).toBe(true);
    const db = await withSqliteAllowed(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return openHippoDbReadOnly(root);
    });
    closeHippoDb(db);
    expect(refusal(() => openHippoDb(root)).storeKind).toBe('postgres');
  });

  it.each([
    ['an empty marker', () => writeFileSync(marker, '  \n')],
    ['an unreadable marker', () => mkdirSync(marker)],
  ] as const)('%s still refuses, with the kind unknown', (_name, write) => {
    write();
    expect(refusal(() => openHippoDb(root)).storeKind).toBe('unknown');
    expect(dbFiles()).toEqual([]);
  });

  it('without a marker, both opens work as before', () => {
    closeHippoDb(openHippoDb(root));
    closeHippoDb(openHippoDbReadOnly(root));
    expect(dbFiles()).toContain('hippo.db');
  });

  it('is checked on every open, so a marker written while a scope holds a handle refuses the next open', async () => {
    await withSharedStoreHandles(() => {
      closeHippoDb(openHippoDb(root));
      writeFileSync(marker, 'postgres');
      expect(refusal(() => openHippoDb(root)).storeKind).toBe('postgres');
    });
  });

  it('initStore refuses before it makes any mirror folder', () => {
    writeFileSync(marker, 'postgres');
    expect(() => initStore(root)).toThrow(OtherStoreFolderError);
    expect(readdirSync(root)).toEqual([OTHER_STORE_MARKER]);
  });

  it('the server entry exports what store copy needs', () => {
    expect(serverEntry.OTHER_STORE_MARKER).toBe(OTHER_STORE_MARKER);
    expect(serverEntry.OtherStoreFolderError).toBe(OtherStoreFolderError);
    expect(serverEntry.withSqliteAllowed).toBe(withSqliteAllowed);
  });

  it('quality repair, which opens hippo.db itself to skip migrations, refuses and takes no backup', () => {
    initStore(root);
    writeFileSync(marker, 'postgres');
    expect(() => repairAutomaticMemories(root, { tenantId: 'default', apply: true })).toThrow(OtherStoreFolderError);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('hippo auth create on the marked folder exits 1 with the message and mints into no hippo.db', () => {
    writeFileSync(marker, 'postgres\n');
    const cwd = mkdtempSync(join(tmpdir(), 'hippo-marker-cwd-'));
    try {
      const run = spawnSync(process.execPath, [CLI, 'auth', 'create', '--global'], {
        cwd, encoding: 'utf8', env: { ...process.env, HIPPO_HOME: root },
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`This folder's memories live in the 'postgres' store, so hippo.db is not used here`);
      expect(run.stdout).not.toContain('plaintext');
      expect(dbFiles()).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
