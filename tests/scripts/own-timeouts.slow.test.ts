// Parses every test file in the tree, which takes seconds on a CI runner, so it runs in the slow project.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { longTimeouts } from '../../scripts/check-test-env.mjs';

describe('own timeouts', () => {
  it('no test in the default run sets a timeout over 10 s for itself, so a test waits on an event instead', () => {
    expect(longTimeouts(join(import.meta.dirname, '..'))).toEqual([]);
  });
});
