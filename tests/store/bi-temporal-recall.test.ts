import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { markRetrieved } from '../../src/core/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { runCliOut } from '../_helpers/run-cli-as.js';

async function hippo(home: string, globalHome: string, ...args: string[]): Promise<string> {
  return (await runCliOut(args, { cwd: home, env: { ...process.env, HIPPO_HOME: globalHome } })).trim();
}

describe('recall with bi-temporal filter', () => {
  it('default recall excludes superseded memories', async () => {
    const home = makeRoot('btr', { init: false });
    const globalHome = makeRoot('btr-global', { init: false });
    await hippo(home, globalHome, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, globalHome, 'remember', 'database is Postgres');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot, 'default');
    expect(entries.length).toBe(1);
    const oldId = entries[0].id;
    await hippo(home, globalHome, 'supersede', oldId, 'database migrated to MySQL');
    const out = await hippo(home, globalHome, 'recall', 'database');
    expect(out).toContain('MySQL');
    expect(out).not.toContain('Postgres');
  });

  it('--include-superseded returns superseded with marker', async () => {
    const home = makeRoot('btr', { init: false });
    const globalHome = makeRoot('btr-global', { init: false });
    await hippo(home, globalHome, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, globalHome, 'remember', 'database is Postgres');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot, 'default');
    expect(entries.length).toBe(1);
    const oldId = entries[0].id;
    await hippo(home, globalHome, 'supersede', oldId, 'database migrated to MySQL');
    const out = await hippo(home, globalHome, 'recall', 'database', '--include-superseded');
    expect(out).toContain('MySQL');
    expect(out).toContain('Postgres');
    expect(out).toContain('[superseded]');
  });

  it('markRetrieved is no-op for superseded memories', () => {
    const entry = createMemory('old fact here', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    entry.superseded_by = 'mem_successor';
    const origCount = entry.retrieval_count;
    const origHalfLife = entry.half_life_days;
    const [updated] = markRetrieved([entry]);
    expect(updated.retrieval_count).toBe(origCount);
    expect(updated.half_life_days).toBe(origHalfLife);
  });
});
