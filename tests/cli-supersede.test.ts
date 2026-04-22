import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readEntry, loadAllEntries } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function hippo(home: string, cmd: string): string {
  return execSync(`node "${CLI}" ${cmd}`, {
    cwd: home,
    env: { ...process.env, HIPPO_HOME: '' },
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
}

function hippoErr(home: string, cmd: string): string {
  try {
    execSync(`node "${CLI}" ${cmd}`, {
      cwd: home,
      env: { ...process.env, HIPPO_HOME: '' },
      encoding: 'utf8',
      timeout: 15000,
    });
    return '';
  } catch (e: any) {
    return (e.stderr || e.stdout || e.message || '').trim();
  }
}

describe('hippo supersede', () => {
  it('creates new memory and links old one via superseded_by', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule');
    hippo(home, 'remember "X is true"');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot);
    expect(entries.length).toBeGreaterThan(0);
    const oldId = entries[0].id;

    const out = hippo(home, `supersede ${oldId} "X is false now"`);
    expect(out).toContain('Superseded');
    expect(out).toContain(oldId);

    const oldEntry = readEntry(hippoRoot, oldId);
    expect(oldEntry!.superseded_by).not.toBeNull();

    const newEntry = readEntry(hippoRoot, oldEntry!.superseded_by!);
    expect(newEntry).not.toBeNull();
    expect(newEntry!.content).toContain('X is false now');
    expect(newEntry!.superseded_by).toBeNull();

    rmSync(home, { recursive: true, force: true });
  });

  it('errors if old id does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule');
    const err = hippoErr(home, 'supersede mem_does_not_exist "anything here"');
    expect(err).toContain('not found');
    rmSync(home, { recursive: true, force: true });
  });

  it('errors if old id is already superseded', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule');
    hippo(home, 'remember "first version of fact"');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot);
    const aId = entries[0].id;
    hippo(home, `supersede ${aId} "second version of fact"`);
    const err = hippoErr(home, `supersede ${aId} "third version of fact"`);
    expect(err).toContain('already superseded');
    rmSync(home, { recursive: true, force: true });
  });
});
