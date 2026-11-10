// sleepWholeStore under the store's sleep claim: a sleep refused by a holder runs nothing and writes nothing, a dry run
// is never refused, and a sleep that fails gives the claim back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { remember, sleepWholeStore } from '../../src/api/index.js';
import { takeFileLock } from '../../src/host/file-lock.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import type { FullContext } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { sleepRuns } from '../_helpers/sleep-runs.js';

const { apiCtx } = sessionPerTest();
const holders: { release: () => void }[] = [];

afterEach(() => {
  for (const holder of holders.splice(0)) holder.release();
  vi.unstubAllEnvs();
});

/** A store with one row, and a sleep claim held by a connection of its own, as another process would hold it. */
async function heldStore(): Promise<{ home: string; ctx: FullContext }> {
  const home = makeRoot('one-sleep');
  // Auto-share writes to the global store, which HIPPO_HOME names.
  vi.stubEnv('HIPPO_HOME', home);
  const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
  await remember(ctx, { content: 'a row for the sleep to look at', kind: 'distilled' });
  const take = takeFileLock(join(home, 'sleep.lock.db'));
  if (take.kind !== 'taken') throw new Error(`test setup: the claim was already ${take.kind}`);
  holders.push(take.lock);
  return { home, ctx };
}

function auditOps(home: string): string[] {
  const db = openHippoDb(home);
  try {
    return listAuditEvents(db, { tenantId: '__host__', op: 'consolidate' }).map((row) => row.op);
  } finally {
    closeHippoDb(db);
  }
}

describe('one sleep per store', () => {
  it('refuses a sleep while another holds the claim, with every count 0 and no audit row', async () => {
    const { home, ctx } = await heldStore();

    const result = await sleepWholeStore(ctx, { noShare: true });

    expect(result).toEqual({
      active: 0,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
      alreadyRunning: { since: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) },
    });
    expect(sleepRuns(home)).toBe(0);
    expect(auditOps(home)).toEqual([]);
  });

  it('never refuses a dry run, which writes nothing', async () => {
    const { ctx } = await heldStore();

    const result = await sleepWholeStore(ctx, { dryRun: true });

    expect(result.alreadyRunning).toBeUndefined();
    expect(result).toMatchObject({ dryRun: true, active: 1 });
  });

  it('gives the claim back when the sleep fails', async () => {
    const home = makeRoot('one-sleep');
    vi.stubEnv('HIPPO_HOME', home);
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    const { consolidation } = ctx.store;
    const failing: FullContext = {
      ...ctx,
      store: {
        ...ctx.store,
        consolidation: { ...consolidation, begin: () => Promise.reject(new Error('the store went away')) },
      },
    };

    await expect(sleepWholeStore(failing, { noShare: true })).rejects.toThrow('the store went away');

    expect(await consolidation.claimSleep!()).toEqual({ kind: 'taken' });
    await consolidation.releaseSleep!();
  });

  it('keeps the sleep result when giving the claim back fails once, and the next claim is taken', async () => {
    const home = makeRoot('one-sleep');
    vi.stubEnv('HIPPO_HOME', home);
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    const { consolidation } = ctx.store;
    let releases = 0;
    const flaky: FullContext = {
      ...ctx,
      store: {
        ...ctx.store,
        consolidation: {
          ...consolidation,
          releaseSleep: () =>
            ++releases === 1 ? Promise.reject(new Error('the worker dropped the call')) : consolidation.releaseSleep!(),
        },
      },
    };

    const result = await sleepWholeStore(flaky, { noShare: true });

    expect(result.alreadyRunning).toBeUndefined();
    expect(releases).toBe(2);
    expect(await consolidation.claimSleep!()).toEqual({ kind: 'taken' });
    await consolidation.releaseSleep!();
  });
});
