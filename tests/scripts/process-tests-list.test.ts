import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { longTimeouts, misnamedTests } from '../../scripts/check-test-env.mjs';

describe('test file names', () => {
  it('put every test in the vitest project its code needs, so a process or server test gets 30 s', () => {
    expect(misnamedTests(join(import.meta.dirname, '..'))).toEqual([]);
  });
});

describe('own timeouts', () => {
  it('no test in the default run sets a timeout over 10 s for itself, so a test waits on an event instead', () => {
    expect(longTimeouts(join(import.meta.dirname, '..'))).toEqual([]);
  });
});
