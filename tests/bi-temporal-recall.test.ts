import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { markRetrieved } from '../src/search.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function hippo(home: string, globalHome: string, cmd: string): string {
  return execSync(`node "${CLI}" ${cmd}`, {
    cwd: home,
    env: { ...process.env, HIPPO_HOME: globalHome },
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
}

describe('recall with bi-temporal filter', () => {
  it('default recall excludes superseded memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-btr-'));
    const globalHome = mkdtempSync(join(tmpdir(), 'hippo-btr-global-'));
    hippo(home, globalHome, 'init --no-hooks --no-schedule --no-learn');
    hippo(home, globalHome, 'remember "database is Postgres"');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot);
    expect(entries.length).toBe(1);
    const oldId = entries[0].id;
    hippo(home, globalHome, `supersede ${oldId} "database migrated to MySQL"`);
    const out = hippo(home, globalHome, 'recall database');
    expect(out).toContain('MySQL');
    expect(out).not.toContain('Postgres');
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('--include-superseded returns superseded with marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-btr-'));
    const globalHome = mkdtempSync(join(tmpdir(), 'hippo-btr-global-'));
    hippo(home, globalHome, 'init --no-hooks --no-schedule --no-learn');
    hippo(home, globalHome, 'remember "database is Postgres"');
    const hippoRoot = join(home, '.hippo');
    const entries = loadAllEntries(hippoRoot);
    expect(entries.length).toBe(1);
    const oldId = entries[0].id;
    hippo(home, globalHome, `supersede ${oldId} "database migrated to MySQL"`);
    const out = hippo(home, globalHome, 'recall database --include-superseded');
    expect(out).toContain('MySQL');
    expect(out).toContain('Postgres');
    expect(out).toContain('[superseded]');
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('markRetrieved is no-op for superseded memories', () => {
    const entry = createMemory('old fact here', { layer: Layer.Episodic });
    entry.superseded_by = 'mem_successor';
    const origCount = entry.retrieval_count;
    const origHalfLife = entry.half_life_days;
    const [updated] = markRetrieved([entry]);
    expect(updated.retrieval_count).toBe(origCount);
    expect(updated.half_life_days).toBe(origHalfLife);
  });
});
