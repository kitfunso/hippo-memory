import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The section regex ended on `\z`, which JS reads as a literal "z": the gate cut
// the entry at its first "z" and passed any em dash after it.

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-em-dashes-in-release-notes.mjs');
const EM_DASH = String.fromCharCode(0x2014);

function runGate(changelog: string) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-emgate-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }));
    writeFileSync(join(root, 'CHANGELOG.md'), changelog);
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-em-dashes-in-release-notes.mjs', () => {
  it('catches an em dash that sits after a "z" in the current entry', () => {
    const r = runGate(`# Changelog\n\n## 2.0.0\n\n- A fix for the zero case ${EM_DASH} here.\n\n## 1.9.9\n\n- Old.\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EM-DASH detected');
  });

  it('reads a current entry that runs to the end of the file', () => {
    expect(runGate('# Changelog\n\n## 2.0.0\n\n- Clean.\n').status).toBe(0);
    const r = runGate(`# Changelog\n\n## 2.0.0\n\n- Not clean ${EM_DASH} here.\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EM-DASH detected');
  });

  it('ignores em dashes in older entries', () => {
    expect(runGate(`# Changelog\n\n## 2.0.0\n\n- Clean.\n\n## 1.9.9\n\n- Old ${EM_DASH} entry.\n`).status).toBe(0);
  });
});
