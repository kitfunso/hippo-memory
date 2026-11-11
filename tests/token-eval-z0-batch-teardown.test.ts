// The z0 batch teardown's Z0_BATCH_KEEP folder check: a diagnosis copy lands only under the real temp folder, never in the run's own temp root or C:/z0-runs.
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepDir } from './fixtures/z0-batch/harness.js';

describe('Z0_BATCH_KEEP', () => {
  const realTmp = process.env.HIPPO_TEST_REAL_TMP ?? '';

  it('is unset or empty: nothing is kept', () => {
    expect(keepDir(undefined)).toBeUndefined();
    expect(keepDir('')).toBeUndefined();
  });

  it('a folder under the real temp folder and outside the run\'s temp root is kept', () => {
    expect(realTmp).not.toBe('');
    expect(keepDir(join(realTmp, 'z0-keep-probe'))?.toLowerCase()).toBe(resolve(realTmp, 'z0-keep-probe').toLowerCase());
  });

  it('a relative folder, one outside the real temp folder, under C:/z0-runs, inside the run\'s temp root, or the temp folder itself is refused, naming it', () => {
    for (const keep of ['relative-keep', join(parse(realTmp).root, 'z0-keep-probe'), 'C:/z0-runs/keep', join(tmpdir(), 'keep'), realTmp]) {
      expect(() => keepDir(keep), keep).toThrow(/^Z0_BATCH_KEEP=.* is refused/);
    }
  });
});
