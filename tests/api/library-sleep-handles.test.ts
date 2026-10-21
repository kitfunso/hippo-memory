// The package's sleep and consolidate run on one handle per store, as `hippo sleep` does: a pass that opened its own
// would make each close SQLite's last, which checkpoints and deletes the WAL.
import { describe, expect, it, vi } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { consolidate, sleep } from '../../src/index.js';
import { DatabaseSync, type DatabaseSyncLike } from '../../src/db/sqlite.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

/** Distinct connections that ran a statement while `run` ran. */
async function connectionsDuring(run: () => Promise<object>): Promise<number> {
  const seen = new Set<unknown>();
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSyncLike, sql) {
    seen.add(this);
    return prepare.call(this, sql);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return seen.size;
}

function seeded(label: string, rows: number): string {
  const root = makeRoot(label);
  for (let i = 0; i < rows; i++) writeEntry(root, createMemory(`release note ${i} about the ${i % 4} build lane`));
  return root;
}

// Two: the pass's handle, and the one its flush opens while that handle is inside a transaction.
describe('the package sleep and consolidate open two connections, however many rows the store holds', () => {
  it.each([5, 40])('consolidate(folder) over %i rows', async (rows) => {
    const root = seeded('lib-consolidate', rows);
    expect(await connectionsDuring(() => consolidate(root))).toBe(2);
  });

  it.each([5, 40])('sleep over %i rows', async (rows) => {
    const root = seeded('lib-sleep', rows);
    vi.stubEnv('HIPPO_HOME', makeRoot('lib-sleep-global'));
    try {
      expect(await connectionsDuring(() => sleep(apiCtx(root), { noShare: true }))).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
