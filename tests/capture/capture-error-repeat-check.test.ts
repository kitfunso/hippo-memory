// capture-error's repeat check read every memory to compare a handful of
// auto-captured tags. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { captureToolFailure } from '../../src/surface/capture/capture-error.js';
import { failureTarget } from '../_helpers/failure-target.js';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/db/db-open-write-free.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};

const FULL_TABLE_SCAN = /FROM memories WHERE tenant_id = \? ORDER BY created ASC, id ASC/;

let root: string;

beforeEach(() => {
  root = makeRoot('f1-capture-repeat');
});

describe('capture-error repeat check does not read every memory', () => {
  it('a repeat is still caught, with no full-table read among the statements it runs', async () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      error: 'Exit code 2\nsrc/a.ts(12,3): error TS2304: Cannot find name foo',
    };
    expect(await captureToolFailure(failureTarget(root), payload)).toBe('stored');

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
      outcome = await captureToolFailure(failureTarget(root), {
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

    expect(sqliteSyncStore(root).lessonWrites.contentsWithTag('default', 'auto-captured')).toEqual([]);
  });
});
