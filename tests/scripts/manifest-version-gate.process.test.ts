import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'checks', 'check-manifest-versions.mjs');
const SYNC = join(import.meta.dirname, '..', '..', 'scripts', 'sync-version.mjs');

interface Overrides {
  lockVersion?: string | null;
  lockRootVersion?: string | null;
  omitLockfile?: boolean;
  rawLockfile?: string;
}

interface LockFixture {
  name: string;
  lockfileVersion: number;
  packages: Record<string, { name?: string; version: string }>;
  version?: string;
}

function makeRepo(version: string, overrides: Overrides = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-vgate-'));
  mkdirSync(join(root, 'extensions', 'openclaw-plugin'), { recursive: true });
  mkdirSync(join(root, 'extensions', 'kiro-power'), { recursive: true });
  mkdirSync(join(root, 'extensions', 'cursor-plugin', '.cursor-plugin'), { recursive: true });
  mkdirSync(join(root, 'extensions', 'vscode'), { recursive: true });
  mkdirSync(join(root, 'src', 'base', 'util'), { recursive: true });
  for (const path of [
    'package.json',
    'openclaw.plugin.json',
    'extensions/openclaw-plugin/package.json',
    'extensions/openclaw-plugin/openclaw.plugin.json',
    'server.json',
    'gemini-extension.json',
    'extensions/kiro-power/plugin.json',
    'extensions/cursor-plugin/.cursor-plugin/plugin.json',
    'extensions/vscode/package.json',
  ]) {
    writeFileSync(join(root, path), JSON.stringify({ name: 'fixture', version }));
  }
  writeFileSync(join(root, 'src', 'base', 'util', 'version.ts'), `export const PACKAGE_VERSION = '${version}';\n`);
  if (overrides.rawLockfile !== undefined) {
    writeFileSync(join(root, 'package-lock.json'), overrides.rawLockfile);
  } else if (!overrides.omitLockfile) {
    const lock: LockFixture = {
      name: 'fixture',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: overrides.lockRootVersion ?? version },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    };
    if (overrides.lockVersion !== null) lock.version = overrides.lockVersion ?? version;
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  }
  return root;
}

function runGate(root: string) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('check-manifest-versions.mjs and the lockfile', () => {
  it('passes when the lockfile matches, and says it checked it', () => {
    const root = makeRepo('2.0.0');
    try {
      const r = runGate(root);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('package-lock.json root fields');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the lockfile .version still names the previous release', () => {
    const root = makeRepo('2.0.0', { lockVersion: '1.9.9' });
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('package-lock.json .version: 1.9.9 (expected 2.0.0)');
      expect(r.stderr).toContain('npm install --package-lock-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when only .packages[""].version drifted', () => {
    const root = makeRepo('2.0.0', { lockRootVersion: '1.9.9' });
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('package-lock.json .packages[""].version: 1.9.9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not read the dependency entries, which carry their own versions', () => {
    const root = makeRepo('2.0.0');
    try {
      expect(runGate(root).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a server.json package entry has no version or an old one', () => {
    for (const pkg of [{ identifier: 'fixture' }, { identifier: 'fixture', version: '1.9.9' }]) {
      const root = makeRepo('2.0.0');
      try {
        writeFileSync(
          join(root, 'server.json'),
          JSON.stringify({ name: 'fixture', version: '2.0.0', packages: [pkg] }),
        );
        const r = runGate(root);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`server.json packages[0]: ${pkg.version ?? '(no version field)'} (expected 2.0.0)`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('fails when the lockfile is absent or has no version field', () => {
    const cases: Overrides[] = [{ omitLockfile: true }, { lockVersion: null }];
    for (const overrides of cases) {
      const root = makeRepo('2.0.0', overrides);
      try {
        const r = runGate(root);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('package-lock.json');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('fails on a lockfile that parses to null or to a non-object', () => {
    for (const raw of ['null', '[]', '"1.0.0"', '{}']) {
      const root = makeRepo('2.0.0', { rawLockfile: raw });
      try {
        const r = runGate(root);
        expect(r.status, `raw=${raw} stdout=${r.stdout}`).toBe(1);
        expect(r.stderr).toContain('package-lock.json .version: (no version field)');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('sync-version.mjs', () => {
  it('sets every site `npm version` leaves behind, so the gate passes', () => {
    const root = makeRepo('2.0.0', { lockVersion: '2.1.0', lockRootVersion: '2.1.0' });
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.1.0' }));
      const sync = spawnSync(process.execPath, [SYNC], { cwd: root, encoding: 'utf-8' });
      expect(sync.status, sync.stderr).toBe(0);
      const r = runGate(root);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
