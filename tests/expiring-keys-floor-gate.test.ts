// EXPIRING_KEYS_MIN_BINARY must name the first release that ships schema v53, or a binary that ignores expiry can open a store holding expiring keys.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-expiring-keys-floor.mjs');
const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function writeTree(root: string, version: string, floor: string, hasV53: boolean): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  writeFileSync(join(root, 'src', 'version.ts'), `export const PACKAGE_VERSION = '${version}';\nexport const EXPIRING_KEYS_MIN_BINARY = '${floor}';\n`);
  writeFileSync(join(root, 'src', 'db', 'migrations', 'index.ts'), `export const MIGRATIONS = [v51, v52${hasV53 ? ', v53' : ''}];\n`);
}

/** A git repo at `version` with floor `floor` and v53 in its tree; `tag` first commits a release, with or without v53, under that name. */
function makeRepo(version: string, floor: string, tag?: { name: string; hasV53: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-floor-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'db', 'migrations'), { recursive: true });
  git(root, 'init', '-q');
  if (tag) {
    writeTree(root, tag.name, floor, tag.hasV53);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'release');
    git(root, 'tag', `v${tag.name}`);
  }
  writeTree(root, version, floor, true);
  return root;
}

function runGate(root: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-expiring-keys-floor.mjs', () => {
  it('passes when the floor is the package version and no release carries that tag yet', () => {
    const r = runGate(makeRepo('1.1.0', '1.1.0'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1.1.0');
  });

  it('passes when the floor names a tagged release that ships v53', () => {
    const r = runGate(makeRepo('1.2.0', '1.1.0', { name: '1.1.0', hasV53: true }));
    expect(r.status, r.stderr).toBe(0);
  });

  it('fails when the floor is above the package version', () => {
    const r = runGate(makeRepo('1.1.0', '1.2.0'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('above the package version 1.1.0');
  });

  it('fails when the floor names a tagged release that predates v53', () => {
    const r = runGate(makeRepo('1.1.0', '1.0.0', { name: '1.0.0', hasV53: false }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.0.0 does not ship schema v53');
  });
});
