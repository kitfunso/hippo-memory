// The z0 batch teardown's Z0_BATCH_KEEP folder check: a diagnosis copy lands only under the real temp folder, never in the run's own temp root or C:/z0-runs.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepDir } from './fixtures/z0-batch/harness.js';

describe('Z0_BATCH_KEEP', () => {
  const realTmp = process.env.HIPPO_TEST_REAL_TMP ?? '';
  const runTmp = process.env.HIPPO_TEST_TMP_RUN ?? '';

  it('is unset or empty: nothing is kept', () => {
    expect(keepDir(undefined)).toBeUndefined();
    expect(keepDir('')).toBeUndefined();
  });

  it('a folder under the real temp folder and outside the run\'s temp root is kept', () => {
    expect(realTmp).not.toBe('');
    // keepDir answers through any junction, and TEMP may be one.
    expect(keepDir(join(realTmp, 'z0-keep-probe'))?.toLowerCase()).toBe(join(realpathSync.native(realTmp), 'z0-keep-probe').toLowerCase());
  });

  it('a relative folder, one outside the real temp folder, under C:/z0-runs, the run\'s temp root or a folder in it, or the temp folder itself is refused, naming it', () => {
    expect(runTmp).not.toBe('');
    for (const keep of ['relative-keep', join(parse(realTmp).root, 'z0-keep-probe'), 'C:/z0-runs/keep', runTmp, join(tmpdir(), 'keep'), realTmp]) {
      expect(() => keepDir(keep), keep).toThrow(/^Z0_BATCH_KEEP=.* is refused/);
    }
  });
});
