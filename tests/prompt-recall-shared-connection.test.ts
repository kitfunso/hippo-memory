// Z1's prompt-recall FTS query reopened the store getContext's ambient
// load had just opened and closed. Real SQLite stores in tmp dirs, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { getContext, type Context } from '../src/api.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import type { DatabaseSyncLike } from '../src/db.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/db-open-write-free.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};

const PROJECT = 'proj-a';

let tmpRoot: string;
let local: string;
let globalRoot: string;
let ctx: Context;

function enablePromptRecall(root: string) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    pinnedInject: { promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1 },
  }));
}

beforeEach(() => {
  _resetAblationCacheForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-f4-recall-connection-'));
  local = path.join(tmpRoot, 'local', '.hippo');
  globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  process.env.HIPPO_HOME = globalRoot;
  ctx = { hippoRoot: local, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  delete process.env.HIPPO_HOME;
  _resetAblationCacheForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('prompt recall reuses the ambient load connection', () => {
  it('runs the pinned-ambient query and the FTS recall query on the same connection, local and global', async () => {
    enablePromptRecall(local);
    writeEntry(local, { ...createMemory('the postgres migration script needs a rollback plan before deploy'), origin_project: PROJECT });
    writeEntry(globalRoot, { ...createMemory('a global postgres migration note about the rollback plan'), origin_project: PROJECT });

    const calls: Array<{ conn: unknown; sql: string }> = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSyncLike,
      ...args: [string]
    ) {
      calls.push({ conn: this, sql: args[0] });
      return originalPrepare.apply(this, args);
    });
    try {
      await getContext(ctx, {
        pinnedOnly: true,
        includeRecent: 5,
        currentProject: PROJECT,
        prompt: 'how should the postgres migration rollback plan work',
      });
    } finally {
      spy.mockRestore();
    }

    const ambientConns = new Set(calls.filter((c) => c.sql.includes('pinned = 1 AND')).map((c) => c.conn));
    const ftsConns = new Set(calls.filter((c) => c.sql.includes('memories_fts MATCH ?')).map((c) => c.conn));

    expect(ambientConns.size).toBe(2); // one per store, local + global
    expect(ftsConns.size).toBe(2);
    expect(ftsConns).toEqual(ambientConns);
  });
});
