// autoShare writes every candidate to the global store in one transaction, from the rows it already holds.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { autoShare } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';

const TOPICS = ['powershell', 'sqlite', 'docker', 'cron', 'rsync', 'ssh'];

describe('autoShare batching', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hippo-autoshare-batch-'));
    vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
    // The first open migrates the store, which would count as writes in whichever call comes first.
    initTestStore(getGlobalRoot());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function shareFrom(topics: readonly string[]) {
    const hippoRoot = join(tmp, `proj${topics.length}`, '.hippo');
    initTestStore(hippoRoot);
    for (const topic of topics) {
      writeEntry(
        hippoRoot,
        createMemory(`gotcha: ${topic} needs the explicit flag or the command silently does nothing`, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          tags: ['error'],
          tenantId: 'default',
        }),
      );
    }
    const { result, statements } = await recordStatementsAsync(() =>
      autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS }),
    );
    expect(loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content)).toEqual(
      expect.arrayContaining(result.map((e) => e.content)),
    );
    return { shared: result.length, globalWrites: countMatching(statements, /^BEGIN IMMEDIATE$/) };
  }

  it('commits one write transaction however many rows it shares', async () => {
    const one = await shareFrom(TOPICS.slice(0, 1));
    const many = await shareFrom(TOPICS.slice(1));
    expect(one.shared).toBe(1);
    expect(many.shared).toBe(TOPICS.length - 1);
    expect(many.globalWrites).toBe(one.globalWrites);
  });
});
