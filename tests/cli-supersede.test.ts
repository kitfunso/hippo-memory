import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry, loadAllEntries } from '../src/store/entry-reads.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { runCli } from '../src/cli.js';
import { initStore } from '../src/store/open.js';
import { runInProcess } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();
let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-ss-'));
  initStore(join(home, '.hippo'));
  vi.stubEnv('HIPPO_HOME', home);
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function hippo(...args: string[]): Promise<string> {
  const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.trim();
}

async function hippoErr(...args: string[]): Promise<string> {
  const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  return res.status === 0 ? '' : (res.stderr || res.stdout).trim();
}

describe('hippo supersede', () => {
  it('creates new memory and links old one via superseded_by', async () => {
    await hippo('remember', 'X is true');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot, 'default');
    expect(entries.length).toBeGreaterThan(0);
    const oldId = entries[0].id;

    const out = await hippo('supersede', oldId, 'X is false now');
    expect(out).toContain('Superseded');
    expect(out).toContain(oldId);

    const oldEntry = readEntry(hippoRoot, oldId);
    expect(oldEntry!.superseded_by).not.toBeNull();

    const newEntry = readEntry(hippoRoot, oldEntry!.superseded_by!);
    expect(newEntry).not.toBeNull();
    expect(newEntry!.content).toContain('X is false now');
    expect(newEntry!.superseded_by).toBeNull();

  });

  it('keeps the old row origin project and session on the new row', async () => {
    const hippoRoot = join(home, '.hippo');
    // The origin differs from the one this store would stamp, as a project row held in the global store does.
    const old = {
      ...createMemory('the billing service retries a failed charge three times', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      origin_project: 'proj-a',
      source_session_id: 'sess-old',
    };
    writeEntry(hippoRoot, old);

    await hippo('supersede', old.id, 'the billing service retries a failed charge five times');

    const next = readEntry(hippoRoot, readEntry(hippoRoot, old.id)!.superseded_by!);
    expect(next!.origin_project).toBe('proj-a');
    expect(next!.source_session_id).toBe('sess-old');
  });

  it('carries layer, tags and pin from the old row unless a flag overrides them', async () => {
    const hippoRoot = join(home, '.hippo');
    const seed = (content: string) => {
      const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['billing', 'retry'], pinned: true });
      writeEntry(hippoRoot, entry);
      return entry.id;
    };
    const successor = (id: string) => readEntry(hippoRoot, readEntry(hippoRoot, id)!.superseded_by!)!;

    const kept = seed('the billing service retries a failed charge three times');
    await hippo('supersede', kept, 'the billing service retries a failed charge five times');
    expect(successor(kept).tags).toEqual(['billing', 'retry']);
    expect(successor(kept).pinned).toBe(true);
    expect(successor(kept).layer).toBe('episodic');

    const changed = seed('the billing service pages after a failed charge retry');
    await hippo('supersede', changed, 'the billing service pages after two failed charge retries', '--tag', 'paging', '--layer', 'semantic');
    expect(successor(changed).tags).toEqual(['paging']);
    expect(successor(changed).layer).toBe('semantic');
  });

  it('errors if old id does not exist', async () => {
    const err = await hippoErr('supersede', 'mem_does_not_exist', 'anything here');
    expect(err).toContain('not found');
  });

  it('errors if old id is already superseded', async () => {
    await hippo('remember', 'first version of fact');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot, 'default');
    const aId = entries[0].id;
    await hippo('supersede', aId, 'second version of fact');
    const err = await hippoErr('supersede', aId, 'third version of fact');
    expect(err).toContain('already superseded');
  });
});
