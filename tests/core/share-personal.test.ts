// E10 lane A: a personal row never reaches the global store, by hand or by autoShare. Real stores, temp HIPPO_HOME.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { autoShare, shareMemory, transferScore } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { copyToGlobal, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

const TEAM = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';
const MINE = 'gotcha: the staging vpn drops idle sessions after ten minutes, reconnect first';

function globalContents(): string[] {
  return loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
}

async function refusal(fn: () => Promise<MemoryEntry | null>): Promise<BadRequestError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BadRequestError) return e;
    throw e;
  }
  throw new Error('expected a BadRequestError, got no throw');
}

describe('share and promote refuse personal rows', () => {
  let tmp: string;
  let hippoRoot: string;
  let mine: MemoryEntry;
  let team: MemoryEntry;
  let origHippoHome: string | undefined;

  beforeEach(() => {
    tmp = makeRoot('share-personal', { init: false });
    hippoRoot = join(tmp, 'proj', '.hippo');
    initTestStore(hippoRoot);
    origHippoHome = process.env.HIPPO_HOME;
    vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
    const opts = { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['error'], tenantId: 'default' };
    mine = createMemory(MINE, { ...opts, scope: 'personal:private:alice' });
    team = createMemory(TEAM, opts);
    writeEntry(hippoRoot, mine);
    writeEntry(hippoRoot, team);
  });

  afterEach(() => {
    if (origHippoHome !== undefined) vi.stubEnv('HIPPO_HOME', origHippoHome);
    else vi.stubEnv('HIPPO_HOME', undefined);
  });

  it('promote refuses a personal row with a 400 and the exact text; a team row still promotes', async () => {
    const err = await refusal(() => copyToGlobal(hippoRoot, mine.id, { owner: 'alice' }));
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      `Refusing to promote ${mine.id}: it is a personal memory and stays with its owner on this server.`,
    );
    expect((await copyToGlobal(hippoRoot, team.id)).content).toBe(TEAM);
    expect(globalContents()).toEqual([TEAM]);
  });

  it('share refuses a personal row with a 400 and the exact text; a team row still shares', async () => {
    const err = await refusal(() => shareMemory(...sharingStores(hippoRoot), mine.id, { tenantId: 'default' }));
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      `Refusing to share ${mine.id}: it is a personal memory and stays with its owner on this server.`,
    );
    expect((await shareMemory(...sharingStores(hippoRoot), team.id, { tenantId: 'default' }))?.content).toBe(TEAM);
    expect(globalContents()).toEqual([TEAM]);
  });

  it('autoShare skips the personal row and shares the team row in the same run', () => {
    expect(transferScore(mine)).toBeGreaterThanOrEqual(0.6);
    expect(transferScore(team)).toBeGreaterThanOrEqual(0.6);
    expect(autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS }).map((e) => e.content)).toEqual([TEAM]);
    expect(globalContents()).toEqual([TEAM]);
  });
});
