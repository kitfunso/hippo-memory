// An icacls.exe planted in the working folder, which may be a repo, must never run in place of the
// system's own.
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envSystemRoot } from '../../src/base/util/env.js';
import { restrictToCurrentUser } from '../../src/host/windows-acl.js';

// The stand-in is node itself, which runs its first argument (the target file) as a script.
const MARKER = 'stand-in-ran';
const SCRIPT = `process.getBuiltinModule('node:fs').writeFileSync('${MARKER}', 'x');`;

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-planted-'));
  home = process.cwd();
  copyFileSync(process.execPath, join(dir, 'icacls.exe'));
  writeFileSync(join(dir, 'target'), SCRIPT);
  // Some shells set this, which turns the working-folder search off and would hide the hole.
  vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(home);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('restrictToCurrentUser', () => {
  it('does not run an icacls.exe planted in the working folder', () => {
    restrictToCurrentUser(join(dir, 'target'), envSystemRoot());
    expect(existsSync(join(dir, MARKER))).toBe(false);
  });

  it('skips the ACL with a warn when SystemRoot is not an absolute path', () => {
    restrictToCurrentUser(join(dir, 'target'), 'Windows');
    expect(existsSync(join(dir, MARKER))).toBe(false);
    const written = vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    expect(written).toContain('SystemRoot is not an absolute path');
  });
});
