import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { misnamedTests } from '../../scripts/check-test-env.mjs';

describe('test file names', () => {
  it('put every test in the vitest project its code needs, so a process or server test gets 30 s', () => {
    expect(misnamedTests(join(import.meta.dirname, '..'))).toEqual([]);
  });
});
