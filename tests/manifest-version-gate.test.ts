import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The gate excluded package-lock.json wholesale, so a release whose lockfile
// still named the previous version printed OK (v1.38.9).

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-manifest-versions.mjs');

interface Overrides {
  lockVersion?: string | null;
  lockRootVersion?: string | null;
  omitLockfile?: boolean;
}

/** A minimal repo the gate accepts: every manifest it reads, all at `version`. */
function makeRepo(version: string, overrides: Overrides = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-vgate-'));
  mkdirSync(join(root, 'extensions', 'openclaw-plugin'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const path of ['package.json', 'openclaw.plugin.json', 'extensions/openclaw-plugin/package.json', 'extensions/openclaw-plugin/openclaw.plugin.json']) {
    writeFileSync(join(root, path), JSON.stringify({ name: 'fixture', version }));
  }
  writeFileSync(join(root, 'src', 'version.ts'), `export const PACKAGE_VERSION = '${version}';\n`);
  if (!overrides.omitLockfile) {
    const lock: Record<string, unknown> = {
      name: 'fixture',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: overrides.lockRootVersion ?? version }, 'node_modules/left-pad': { version: '1.3.0' } },
    };
    if (overrides.lockVersion !== null) lock['version'] = overrides.lockVersion ?? version;
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
    // node_modules/left-pad sits at 1.3.0 in every fixture above and never drifts
    // the gate; that is the part of the file the old exclusion was right about.
    const root = makeRepo('2.0.0');
    try {
      expect(runGate(root).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the lockfile is absent or has no version field', () => {
    for (const overrides of [{ omitLockfile: true }, { lockVersion: null }] as Overrides[]) {
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
});
