import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readEntry, loadAllEntries, writeEntry } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function hippo(home: string, cmd: string): string {
  return execSync(`node "${CLI}" ${cmd}`, {
    cwd: home,
    env: { ...process.env, HIPPO_HOME: home },
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
}

function hippoErr(home: string, cmd: string): string {
  try {
    execSync(`node "${CLI}" ${cmd}`, {
      cwd: home,
      env: { ...process.env, HIPPO_HOME: home },
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
    hippo(home, 'init --no-hooks --no-schedule --no-learn');
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

  it('keeps the old row origin project and session on the new row', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule --no-learn');
    const hippoRoot = join(home, '.hippo');
    // The origin differs from the one this store would stamp, as a project row held in the global store does.
    const old = {
      ...createMemory('the billing service retries a failed charge three times', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      origin_project: 'proj-a',
      source_session_id: 'sess-old',
    };
    writeEntry(hippoRoot, old);

    hippo(home, `supersede ${old.id} "the billing service retries a failed charge five times"`);

    const next = readEntry(hippoRoot, readEntry(hippoRoot, old.id)!.superseded_by!);
    expect(next!.origin_project).toBe('proj-a');
    expect(next!.source_session_id).toBe('sess-old');
    rmSync(home, { recursive: true, force: true });
  });

  it('carries layer, tags and pin from the old row unless a flag overrides them', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule --no-learn');
    const hippoRoot = join(home, '.hippo');
    const seed = (content: string) => {
      const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['billing', 'retry'], pinned: true });
      writeEntry(hippoRoot, entry);
      return entry.id;
    };
    const successor = (id: string) => readEntry(hippoRoot, readEntry(hippoRoot, id)!.superseded_by!)!;

    const kept = seed('the billing service retries a failed charge three times');
    hippo(home, `supersede ${kept} "the billing service retries a failed charge five times"`);
    expect(successor(kept).tags).toEqual(['billing', 'retry']);
    expect(successor(kept).pinned).toBe(true);
    expect(successor(kept).layer).toBe('episodic');

    const changed = seed('the billing service pages after a failed charge retry');
    hippo(home, `supersede ${changed} "the billing service pages after two failed charge retries" --tag paging --layer semantic`);
    expect(successor(changed).tags).toEqual(['paging']);
    expect(successor(changed).layer).toBe('semantic');
    rmSync(home, { recursive: true, force: true });
  });

  it('errors if old id does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule --no-learn');
    const err = hippoErr(home, 'supersede mem_does_not_exist "anything here"');
    expect(err).toContain('not found');
    rmSync(home, { recursive: true, force: true });
  });

  it('errors if old id is already superseded', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
    hippo(home, 'init --no-hooks --no-schedule --no-learn');
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
