import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueLocalKey, localKeyPath } from '../../src/surface/server/local-key.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-acl-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const aclEntries = (file: string): string[] =>
  execFileSync('icacls', [file], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => /:\(/.test(l));
// The SID names Everyone in any locale.
const grantEveryone = (file: string): void => {
  execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
};
const expectCurrentUserOnly = (file: string): void => {
  const entries = aclEntries(file);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
};

describe.runIf(process.platform === 'win32')('server.key ACL on Windows', () => {
  it('is held by the current user alone, with nothing inherited', () => {
    issueLocalKey(root);
    const entries = aclEntries(localKeyPath(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
    expect(entries[0]).not.toContain('(I)');
  });

  it('keeps none of the grants an old key file held', () => {
    writeFileSync(localKeyPath(root), 'old');
    grantEveryone(localKeyPath(root));
    issueLocalKey(root);
    expectCurrentUserOnly(localKeyPath(root));
  });

  // A key written in place would land in the inode the other link shares, under that link's grants.
  it('writes a new private file over a hard link, so the other link never holds the key', () => {
    const other = join(root, 'other.txt');
    writeFileSync(other, 'old');
    grantEveryone(other);
    linkSync(other, localKeyPath(root));
    issueLocalKey(root);
    expectCurrentUserOnly(localKeyPath(root));
    expect(readFileSync(other, 'utf8')).not.toContain(readFileSync(localKeyPath(root), 'utf8').trim());
  });
});
