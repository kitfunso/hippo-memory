import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry, readEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';

const savedCwd = process.cwd();
let home = '';

beforeEach(() => {
  home = makeStore('ss').base;
  vi.stubEnv('HIPPO_HOME', home);
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  removeDir(home);
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
    expect(entries.map((e) => e.content)).toEqual(['X is true']);
    const oldId = entries[0].id;

    const out = await hippo('supersede', oldId, 'X is false now');
    expect(out).toContain('Superseded');
    expect(out).toContain(oldId);

    const oldEntry = readEntry(hippoRoot, oldId);
    expect(oldEntry!.supersededBy).not.toBeNull();

    const newEntry = readEntry(hippoRoot, oldEntry!.supersededBy!);
    expect(newEntry).not.toBeNull();
    expect(newEntry!.content).toContain('X is false now');
    expect(newEntry!.supersededBy).toBeNull();
  });

  it('keeps the old row origin project and session on the new row', async () => {
    const hippoRoot = join(home, '.hippo');
    // The origin differs from the one this store would stamp, as a project row held in the global store does.
    const old = {
      ...createMemory('the billing service retries a failed charge three times', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      }),
      originProject: 'proj-a',
      sourceSessionId: 'sess-old',
    };
    writeEntry(hippoRoot, old);

    await hippo('supersede', old.id, 'the billing service retries a failed charge five times');

    const next = readEntry(hippoRoot, readEntry(hippoRoot, old.id)!.supersededBy!);
    expect(next!.originProject).toBe('proj-a');
    expect(next!.sourceSessionId).toBe('sess-old');
  });

  it('carries layer, tags and pin from the old row unless a flag overrides them', async () => {
    const hippoRoot = join(home, '.hippo');
    const seed = (content: string) => {
      const entry = createMemory(content, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: ['billing', 'retry'],
        pinned: true,
      });
      writeEntry(hippoRoot, entry);
      return entry.id;
    };
    const successor = (id: string) => readEntry(hippoRoot, readEntry(hippoRoot, id)!.supersededBy!)!;

    const kept = seed('the billing service retries a failed charge three times');
    await hippo('supersede', kept, 'the billing service retries a failed charge five times');
    expect(successor(kept).tags).toEqual(['billing', 'retry']);
    expect(successor(kept).pinned).toBe(true);
    expect(successor(kept).layer).toBe('episodic');

    const changed = seed('the billing service pages after a failed charge retry');
    await hippo(
      'supersede',
      changed,
      'the billing service pages after two failed charge retries',
      '--tag',
      'paging',
      '--layer',
      'semantic',
    );
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

describe('hippo unsupersede', () => {
  it('makes the old memory current again, names the successor it had and keeps it', async () => {
    await hippo('remember', 'X is true');
    const hippoRoot = join(home, '.hippo');
    const oldId = loadAllEntries(hippoRoot, 'default')[0].id;
    await hippo('supersede', oldId, 'X is false now');
    const newId = readEntry(hippoRoot, oldId)!.supersededBy!;

    const out = await hippo('unsupersede', oldId);

    expect(out).toBe(`✓ ${oldId} is current again (was replaced by ${newId})`);
    expect(readEntry(hippoRoot, oldId)!.supersededBy).toBeNull();
    expect(readEntry(hippoRoot, newId)!.content).toContain('X is false now');
  });

  it('errors on a memory that is not superseded, one that does not exist and a missing id', async () => {
    await hippo('remember', 'a current fact');
    const id = loadAllEntries(join(home, '.hippo'), 'default')[0].id;
    expect(await hippoErr('unsupersede', id)).toContain('not superseded');
    expect(await hippoErr('unsupersede', 'mem_does_not_exist')).toContain('not found');
    expect(await hippoErr('unsupersede')).toContain('Usage: hippo unsupersede <id>');
  });
});
