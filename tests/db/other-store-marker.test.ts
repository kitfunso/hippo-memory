// A hippo root holding the other-store marker refuses every hippo.db open, from the CLI as from a request, and never creates the file.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
} from '../../src/db/index.js';
import { repairAutomaticMemories } from '../../src/store/quality-repair.js';
import { repairProtection } from '../../src/api/auth/audit.js';
import * as serverEntry from '../../src/server.js';
import * as storeKit from '../../src/entry/store-kit.js';
import { initStore } from '../../src/store/open.js';
import { makeRoot } from '../_helpers/make-root.js';

const CLI = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'dist', 'cli.js');

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
  root = makeRoot('marker', { init: false });
  marker = join(root, OTHER_STORE_MARKER);
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

  it('tells an unreadable marker at warn, with the error class', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mkdirSync(marker);
      refusal(() => openHippoDb(root));
      const told = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('is unreadable'));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('[hippo] warn: ');
      expect(told[0]).toContain('errorClass=Error');
    } finally {
      stderr.mockRestore();
    }
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

  it('the store-kit entry exports the marker name and no entry exports the waiver', () => {
    expect(storeKit.OTHER_STORE_MARKER).toBe(OTHER_STORE_MARKER);
    for (const entry of [serverEntry, storeKit]) {
      expect('OtherStoreFolderError' in entry).toBe(false);
      expect('withSqliteAllowed' in entry).toBe(false);
    }
  });

  it('quality repair, which opens hippo.db itself to skip migrations, refuses and takes no backup', () => {
    initStore(root);
    writeFileSync(marker, 'postgres');
    const repair = { tenantId: 'default', apply: true, protect: repairProtection };
    expect(() => repairAutomaticMemories({ hippoRoot: root }, repair)).toThrow(OtherStoreFolderError);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('hippo auth create on the marked folder exits 1 with the message and mints into no hippo.db', () => {
    writeFileSync(marker, 'postgres\n');
    const cwd = makeRoot('marker-cwd', { init: false });
    const run = spawnSync(process.execPath, [CLI, 'auth', 'create', '--global'], {
      cwd, encoding: 'utf8', env: { ...process.env, HIPPO_HOME: root },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`This folder's memories live in the 'postgres' store, so hippo.db is not used here`);
    expect(run.stdout).not.toContain('plaintext');
    expect(dbFiles()).toEqual([]);
  });
});
