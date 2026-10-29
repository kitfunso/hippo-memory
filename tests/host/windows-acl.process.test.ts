import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envSystemRoot } from '../../src/base/util/env.js';
import { restrictToCurrentUser } from '../../src/host/windows-acl.js';
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

describe.runIf(process.platform === 'win32')('server.key ACL on Windows', () => {
  it('is held by the current user alone, with nothing inherited', () => {
    issueLocalKey(root);
    const entries = aclEntries(localKeyPath(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
    expect(entries[0]).not.toContain('(I)');
  });

  // A key written in place keeps the old file's explicit grants; the SID names Everyone in any locale.
  it('drops an explicit grant another account already holds', () => {
    const file = join(root, 'server.key');
    writeFileSync(file, 'x');
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
    restrictToCurrentUser(file, envSystemRoot());
    const entries = aclEntries(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
  });
});
