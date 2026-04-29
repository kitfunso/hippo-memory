import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { remember } from '../src/api.js';

describe('remember.afterWrite is transactional', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-after-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rolls back the memory row when afterWrite throws', () => {
    expect(() =>
      remember({ hippoRoot: root, tenantId: 'default', actor: 'test' }, {
        content: 'doomed',
        afterWrite: () => { throw new Error('boom'); },
      }),
    ).toThrow(/boom/);
    expect(loadAllEntries(root).filter((e) => e.content === 'doomed')).toHaveLength(0);
  });
});
