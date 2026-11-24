import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { listRecallEntriesInFolder } from '../../src/store/sqlite/fixtures.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { handleExplain } from '../../src/surface/cli/explain.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { runCli } from '../../src/cli.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry } = sessionPerTest();

const CLEAN = 'clean deploykey fact for everyone';
const PRIV_SLACK = 'private slack deploykey fact';
const PRIV_GITHUB = 'private github deploykey fact';
const LEGACY = 'legacy quarantined deploykey fact';

async function hippo(cwd: string, ...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('cli recall scope default-deny', () => {
  let home: string;
  let globalDir: string;

  beforeEach(async () => {
    home = makeRoot('recall-scope', { init: false });
    globalDir = join(home, 'global-hippo');
    vi.stubEnv('HIPPO_HOME', globalDir);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, 'remember', CLEAN);
    await hippo(home, 'remember', PRIV_SLACK, '--scope', 'slack:private:C1');
    await hippo(home, 'remember', PRIV_GITHUB, '--scope', 'github:private:owner/repo');
    await hippo(home, 'remember', LEGACY, '--scope', 'unknown:legacy');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-scope recall denies private and quarantine rows', async () => {
    const out = await hippo(home, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain(CLEAN);
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it('explicit --scope UNLOCKS the named scope on top of the default set (additive CLI semantics)', async () => {
    const out = await hippo(home, 'recall', 'deploykey', '--scope', 'slack:private:C1', '--limit', '10');
    expect(out).toContain(PRIV_SLACK);
    expect(out).toContain(CLEAN);
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it('JSON output excludes denied rows pre-candidate (SQL predicate before the window)', async () => {
    const raw = await hippo(home, 'recall', 'deploykey', '--json', '--limit', '10');
    // SAFETY: `hippo recall --json` on this CLI always prints the recall-result
    // envelope with `results` and `suppressionSummary` fields, per src/cli.ts.
    const parsed = JSON.parse(raw) as {
      results: Array<{ content?: string; entry?: { content?: string } }>;
      suppressionSummary: { totalCandidates: number; droppedPreRank: number };
    };
    const text = JSON.stringify(parsed.results);
    expect(text).not.toContain(PRIV_SLACK);
    expect(text).not.toContain(PRIV_GITHUB);
    expect(text).not.toContain(LEGACY);
    expect(parsed.suppressionSummary.totalCandidates).toBe(1);
    expect(parsed.suppressionSummary.droppedPreRank).toBe(0);
  });

  it('hasGlobal path (searchBothHybrid recallScope) filters global-store rows equally', async () => {
    initTestStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    writeEntry(
      globalDir,
      createMemory('global private deploykey note', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        scope: 'slack:private:CG',
      }),
    );

    const out = await hippo(home, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain('global clean deploykey note');
    expect(out).not.toContain('global private deploykey note');
    expect(out).not.toContain(PRIV_SLACK);
  });

  it('hasGlobal path: explicit --scope additively unlocks the requested private scope on the GLOBAL store too', async () => {
    initTestStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    writeEntry(
      globalDir,
      createMemory('global private deploykey note', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        scope: 'slack:private:CG',
      }),
    );

    const out = await hippo(home, 'recall', 'deploykey', '--scope', 'slack:private:CG', '--limit', '10');
    expect(out).toContain('global private deploykey note');
    expect(out).toContain('global clean deploykey note');
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
  });

  it('private rows cannot starve admitted rows out of the SQL candidate window', async () => {
    const hippoDir = join(home, '.hippo');
    const filler = Array.from({ length: 220 }, (_, i) =>
      createMemory(`windowstarve private filler row number ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        scope: 'slack:private:Cbulk',
      }),
    );
    writeEntriesTogether(hippoDir, [
      ...filler,
      createMemory('windowstarve admitted public row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    ]);

    const entries = listRecallEntriesInFolder(hippoDir, 'windowstarve', { tenantId: 'default' });
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('windowstarve admitted public row');
    expect(contents.some((c) => c.includes('private filler'))).toBe(false);

    const out = await hippo(home, 'recall', 'windowstarve', '--limit', '10');
    expect(out).toContain('windowstarve admitted public row');
    expect(out).not.toContain('private filler');
  });

  it('hippo explain applies the same rule and prints an honest note', async () => {
    const res = await runInProcess(() =>
      handleExplain({ hippoRoot: join(home, '.hippo'), tenantId: 'default', args: ['deploykey'], flags: {} }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(PRIV_SLACK);
    expect(res.stdout).not.toContain(PRIV_GITHUB);
    expect(res.stdout).not.toContain(LEGACY);
    expect(res.stderr).toMatch(/hidden by recall scope policy/);
  });
});
