// capture-error's repeat check read every memory to compare a handful of
// auto-captured tags. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { initStore, writeEntry, loadContentsWithTag } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { captureToolFailure } from '../src/capture-error.js';
import type { DatabaseSyncLike } from '../src/db.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/db-open-write-free.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};

const FULL_TABLE_SCAN = /FROM memories WHERE tenant_id = \? ORDER BY created ASC, id ASC/;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-f1-capture-repeat-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('capture-error repeat check does not read every memory', () => {
  it('a repeat is still caught, with no full-table read among the statements it runs', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'npm run build' }, error: 'Exit code 2\nsrc/a.ts(12,3): error TS2304: Cannot find name foo' };
    expect(captureToolFailure(root, 'default', payload)).toBe('stored');

    const statements: string[] = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSyncLike,
      ...args: [string]
    ) {
      statements.push(args[0]);
      return originalPrepare.apply(this, args);
    });
    let outcome: string;
    try {
      outcome = captureToolFailure(root, 'default', {
        ...payload,
        error: 'Exit code 2\nsrc/a.ts(40,9): error TS2304: Cannot find name foo',
      });
    } finally {
      spy.mockRestore();
    }

    expect(outcome).toBe('duplicate');
    expect(statements.some((sql) => FULL_TABLE_SCAN.test(sql))).toBe(false);
  });

  it('a tag that merely contains the substring "auto-captured" is not treated as auto-captured', () => {
    const entry = createMemory('a memory whose tag looks like the auto-captured marker but is not', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['x"auto-captured'],
      tenantId: 'default',
    });
    writeEntry(root, entry);

    expect(loadContentsWithTag(root, 'default', 'auto-captured')).toEqual([]);
  });
});
