// Each binary floor must name the first release that ships its schema (v53 expiring keys, v54 task owners), or an older binary can open a store it misreads.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-expiring-keys-floor.mjs');
const roots: string[] = [];

interface Floors { expiring: string; owner: string }

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function writeTree(root: string, version: string, floors: Floors, schema: number): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  writeFileSync(join(root, 'src', 'util/version.ts'), `export const PACKAGE_VERSION = '${version}';\nexport const EXPIRING_KEYS_MIN_BINARY = '${floors.expiring}';\nexport const TASK_OWNER_MIN_BINARY = '${floors.owner}';\n`);
  const list = Array.from({ length: schema - 50 }, (_, i) => `v${51 + i}`).join(', ');
  writeFileSync(join(root, 'src', 'db', 'migrations', 'index.ts'), `export const MIGRATIONS = [${list}];\n`);
}

/** A git repo at `version` with schema v54 in its tree; `tag` first commits a release shipping `schema` under that name. */
function makeRepo(version: string, floors: Floors, tag?: { name: string; schema: number }): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-floor-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'db', 'migrations'), { recursive: true });
  git(root, 'init', '-q');
  if (tag) {
    writeTree(root, tag.name, floors, tag.schema);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'release');
    git(root, 'tag', `v${tag.name}`);
  }
  writeTree(root, version, floors, 54);
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
    const r = runGate(makeRepo('1.1.0', { expiring: '1.1.0', owner: '1.1.0' }, { name: '1.0.0', schema: 52 }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1.1.0');
  });

  it('passes when the floor names a tagged release that ships v53', () => {
    const r = runGate(makeRepo('1.2.0', { expiring: '1.1.0', owner: '1.2.0' }, { name: '1.1.0', schema: 53 }));
    expect(r.status, r.stderr).toBe(0);
  });

  it('fails when the floor is above the package version', () => {
    const r = runGate(makeRepo('1.1.0', { expiring: '1.2.0', owner: '1.1.0' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('above the package version 1.1.0');
  });

  it('fails when the floor names a tagged release that predates v53', () => {
    const r = runGate(makeRepo('1.1.0', { expiring: '1.0.0', owner: '1.1.0' }, { name: '1.0.0', schema: 52 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.0.0 does not ship schema v53');
  });

  it('fails when a floor names an untagged version that is not the package version', () => {
    const r = runGate(makeRepo('1.2.0', { expiring: '1.1.5', owner: '1.2.0' }, { name: '1.0.0', schema: 52 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EXPIRING_KEYS_MIN_BINARY 1.1.5 names no release tag and is not the package version 1.2.0');
  });

  it('TASK_OWNER_MIN_BINARY above the package fails', () => {
    const r = runGate(makeRepo('1.1.0', { expiring: '1.1.0', owner: '1.2.0' }, { name: '1.0.0', schema: 52 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TASK_OWNER_MIN_BINARY 1.2.0 is above the package version 1.1.0');
  });

  it('TASK_OWNER_MIN_BINARY naming a tag without v54 fails', () => {
    const r = runGate(makeRepo('1.2.0', { expiring: '1.1.0', owner: '1.1.0' }, { name: '1.1.0', schema: 53 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.1.0 does not ship schema v54');
  });

  it('a checkout with no tags fails', () => {
    const r = runGate(makeRepo('1.1.0', { expiring: '1.1.0', owner: '1.1.0' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no git tags');
  });

  it('both floors valid passes', () => {
    const r = runGate(makeRepo('1.2.0', { expiring: '1.1.0', owner: '1.1.0' }, { name: '1.1.0', schema: 54 }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('TASK_OWNER_MIN_BINARY 1.1.0');
  });
});
