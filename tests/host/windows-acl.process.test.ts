import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueLocalKey, localKeyPath } from '../../src/surface/server/local-key.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-acl-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.runIf(process.platform === 'win32')('server.key ACL on Windows', () => {
  it('is held by the current user alone, with nothing inherited', () => {
    issueLocalKey(root);
    const file = localKeyPath(root);
    const out = execFileSync('icacls', [file], { encoding: 'utf8' });
    const entries = out.split(/\r?\n/).filter((l) => /:\(/.test(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
    expect(entries[0]).not.toContain('(I)');
  });
});
