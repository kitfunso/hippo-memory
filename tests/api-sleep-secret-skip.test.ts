/**
 * v1.25.0 (v39 post-ship tail #2) — SleepResult.secretSkipped observability.
 *
 * autoShare's secret veto used to be silent; api.sleep now surfaces the count
 * of shares the veto actually withheld. Real store + real sleep (no mocks),
 * per project convention. Store/HIPPO_HOME isolation pattern per
 * tests/api-sleep-phase-faults.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, adminActor, type Context } from '../src/api.js';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { getGlobalRoot } from '../src/shared.js';

// Same secret shape tests/secret-detect.test.ts proves trips detectSecret;
// pinned + error/gotcha tags push transferScore over the 0.6 auto-share bar.
const SECRET_ROW = 'service api key sk_vendor_deadbeef123456 for the ingest worker';
const CLEAN_ROW = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

describe('api.sleep secretSkipped counter', () => {
  let tmpDir: string;
  let globalTmp: string;
  let origHippoHome: string | undefined;
  let ctx: Context;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-sleep-secretskip-'));
    const hippoRoot = join(tmpDir, '.hippo');
    initStore(hippoRoot);
    globalTmp = mkdtempSync(join(tmpdir(), 'hippo-sleep-secretskip-global-'));
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalTmp;

    writeEntry(hippoRoot, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'], tenantId: 'default' }));
    writeEntry(hippoRoot, createMemory(CLEAN_ROW, { pinned: true, tags: ['error', 'gotcha'], tenantId: 'default' }));

    ctx = { hippoRoot, tenantId: 'default', actor: adminActor('test:secret-skip') };
  });

  afterEach(() => {
    if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
    else delete process.env.HIPPO_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(globalTmp, { recursive: true, force: true });
  });

  it('real sleep reports the withheld share and never leaks the secret row to global', async () => {
    const result = await sleep(ctx, {});
    expect(result.secretSkipped).toBe(1);
    expect(result.shared).toBeGreaterThanOrEqual(1);
    const globalContents = loadAllEntries(getGlobalRoot()).map((e) => e.content);
    expect(globalContents).toContain(CLEAN_ROW);
    expect(globalContents).not.toContain(SECRET_ROW);
  });

  it('dry run returns before phase 4: no counter, nothing shared', async () => {
    const result = await sleep(ctx, { dryRun: true });
    expect(result.secretSkipped).toBeUndefined();
    expect(result.shared).toBeUndefined();
    expect(loadAllEntries(getGlobalRoot())).toHaveLength(0);
  });

  it('noShare skips phase 4: no counter', async () => {
    const result = await sleep(ctx, { noShare: true });
    expect(result.secretSkipped).toBeUndefined();
    expect(result.shared).toBeUndefined();
  });
});
