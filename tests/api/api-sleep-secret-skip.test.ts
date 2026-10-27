/**
 * v1.25.0 (v39 post-ship tail #2) — SleepResult.secretSkipped observability.
 *
 * autoShare's secret veto used to be silent; api.sleep now surfaces the count
 * of shares the veto actually withheld. Real store + real sleep (no mocks),
 * per project convention. Store/HIPPO_HOME isolation pattern per
 * tests/api/api-sleep-phase-faults.test.ts.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { sleepWholeStore, adminActor } from '../../src/api/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { getGlobalRoot } from '../../src/host/global-store.js';
import { makeStore, makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { restoreRawTextAt } from '../_helpers/legacy-rows.js';
import { runSleep } from '../../src/api/sleep/sleep-run.js';
import { autoShare } from '../../src/domain/sharing/share.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';

const { writeEntry, apiCtx } = sessionPerTest();

// Same secret shape tests/util/secret-detect.test.ts proves trips detectSecret;
// pinned + error/gotcha tags push transferScore over the 0.6 auto-share bar.
const SECRET_ROW = 'service api key sk_vendor_deadbeef123456 for the ingest worker';
const CLEAN_ROW = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

describe('api.sleep secretSkipped counter', () => {
  let tmpDir: string;
  let globalTmp: string;
  let ctx: FullContext;
  let hippoRoot: string;
  let secret: MemoryEntry;

  beforeEach(() => {
    tmpDir = makeStore('sleep-secretskip').base;
    hippoRoot = join(tmpDir, '.hippo');
    globalTmp = makeRoot('sleep-secretskip-global', { init: false });
    vi.stubEnv('HIPPO_HOME', globalTmp);

    secret = createMemory(SECRET_ROW, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      pinned: true,
      tags: ['error', 'gotcha'],
      tenantId: 'default',
    });
    writeEntry(hippoRoot, secret);
    writeEntry(
      hippoRoot,
      createMemory(CLEAN_ROW, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        pinned: true,
        tags: ['error', 'gotcha'],
        tenantId: 'default',
      }),
    );

    ctx = apiCtx(hippoRoot, 'default', adminActor('test:secret-skip'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Writes store the stored form, so the veto sees a raw row only when one is left from before; plant it after
  // consolidation, whose replay rewrite would redact it.
  it('real sleep reports the withheld share and never leaks the secret row to global', async () => {
    const result = await runSleep(
      ctx,
      {},
      {
        autoShare: (...args) => {
          restoreRawTextAt(hippoRoot, [secret]);
          return autoShare(...args);
        },
      },
    );
    expect(result.secretSkipped).toBe(1);
    expect(result.shared).toBeGreaterThanOrEqual(1);
    const globalContents = loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
    expect(globalContents).toContain(CLEAN_ROW);
    expect(globalContents).not.toContain(SECRET_ROW);
  });

  it('real sleep redacts a raw older secret row before it shares it', async () => {
    restoreRawTextAt(hippoRoot, [secret]);
    const result = await sleepWholeStore(ctx, {});
    expect(result.secretSkipped).toBeUndefined();
    const globalContents = loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
    expect(globalContents).toContain('service api key [REDACTED] for the ingest worker');
    expect(globalContents.join(' ')).not.toContain('sk_vendor_');
  });

  it('dry run returns before phase 4: no counter, nothing shared', async () => {
    const result = await sleepWholeStore(ctx, { dryRun: true });
    expect(result.secretSkipped).toBeUndefined();
    expect(result.shared).toBeUndefined();
    expect(loadAllEntries(getGlobalRoot(), 'default')).toHaveLength(0);
  });

  it('noShare skips phase 4: no counter', async () => {
    const result = await sleepWholeStore(ctx, { noShare: true });
    expect(result.secretSkipped).toBeUndefined();
    expect(result.shared).toBeUndefined();
  });
});
