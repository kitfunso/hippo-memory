import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repairQualityOnce } from '../src/cli/quality-repair.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { DatabaseSync } from '../src/db/sqlite.js';
import { getMeta } from '../src/db/meta.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { Layer, type MemoryEntry } from '../src/core/memory.js';

const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');
const CUT = 'Found local migration files to be';
const DOUBTFUL = 'When CI fails we retry once';

function seed(store: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { source: 'capture', confidence: 'observed', layer: Layer.Episodic }), ...extra };
  writeEntry(store, entry);
  return entry;
}
const ids = (store: string) => loadAllEntries(store).map((entry) => entry.id).sort();
function flag(store: string): string {
  const db = new DatabaseSync(join(store, 'hippo.db'));
  try { return getMeta(db, 'quality_repair_auto'); } finally { db.close(); }
}

describe('repairQualityOnce', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-quality-once-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('sets aside certain defects on the first run only, and never a person\'s words', () => {
    const bad = seed(root, CUT);
    const person = seed(root, CUT, { source: 'cli' });
    const first = repairQualityOnce(root, 'default');
    expect(first?.appliedIds).toEqual([bad.id]);
    expect(existsSync(first!.backup!)).toBe(true);
    expect(ids(root)).toEqual([person.id]);
    expect(flag(root)).toBe('1');

    const later = seed(root, CUT);
    expect(repairQualityOnce(root, 'default')).toBeNull();
    expect(ids(root)).toEqual([person.id, later.id].sort());
  });

  it('marks a clean store done without a backup', () => {
    seed(root, 'Keep test schema setup outside production migrations because production applies every sorted migration.');
    expect(repairQualityOnce(root, 'default')).toMatchObject({ appliedIds: [], backup: null });
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(flag(root)).toBe('1');
  });

  it('leaves the store unmarked when the repair fails, so the next run tries again', () => {
    const bad = seed(root, CUT);
    const holder = new DatabaseSync(join(root, 'hippo.db'));
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect(() => repairQualityOnce(root, 'default')).toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(flag(root)).toBe('');
    expect(repairQualityOnce(root, 'default')?.appliedIds).toEqual([bad.id]);
  }, 30000);

  it('leaves a store whose schema it cannot repair unmarked', () => {
    const bad = seed(root, CUT);
    const db = new DatabaseSync(join(root, 'hippo.db'));
    try { db.exec('DROP TABLE audit_log'); } finally { db.close(); }
    expect(repairQualityOnce(root, 'default')).toMatchObject({ supported: false, appliedIds: [] });
    expect(flag(root)).toBe('');
    expect(ids(root)).toEqual([bad.id]);
  });
});

describe('the upgrade runs the repair once', () => {
  let dir: string;
  let local: string;
  let global: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hippo-quality-once-cli-'));
    local = join(dir, '.hippo');
    global = join(dir, 'global');
    initStore(local);
    initStore(global);
    env = { ...process.env, HIPPO_HOME: global, HOME: dir, USERPROFILE: dir, APPDATA: join(dir, 'AppData', 'Roaming'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: dir, env, encoding: 'utf8' });

  it('hippo sleep cleans the project store once, after a dry run that changed nothing', () => {
    const bad = seed(local, CUT);
    const doubtful = seed(local, DOUBTFUL);
    const dry = cli('sleep', '--dry-run', '--no-learn');
    expect(dry.stdout).not.toContain('once after the upgrade');
    expect(flag(local)).toBe('');

    const first = cli('sleep', '--no-learn');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Set aside 1 automatic memory with a certain defect, once after the upgrade');
    expect(first.stdout).toContain('Bring one back: hippo dormant restore <id>\n');
    expect(first.stdout).toContain('  1 more looks doubtful and was kept; hippo audit repair lists them.');
    expect(ids(local)).not.toContain(bad.id);
    expect(ids(local)).toContain(doubtful.id);

    seed(local, CUT);
    expect(cli('sleep', '--no-learn').stdout).not.toContain('once after the upgrade');
  }, 60000);

  it('a store with only doubtful rows is reported without a "more"', () => {
    seed(local, DOUBTFUL);
    seed(local, 'Always check which branch the PR merges into');
    const first = cli('sleep', '--no-learn');
    expect(first.stdout).toContain('Checked old automatic memories once after the upgrade: 2 look doubtful and were kept; hippo audit repair lists them.');
    expect(flag(local)).toBe('1');
  }, 60000);

  it('a failed repair warns, lets the sleep finish and runs again at the next sleep', () => {
    const bad = seed(local, CUT);
    writeFileSync(join(local, 'backups'), 'not a folder');
    const failed = cli('sleep', '--no-learn');
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain('memory quality repair skipped, tried again next time');
    expect(failed.stdout).toContain('Running consolidation');
    expect(flag(local)).toBe('');
    expect(ids(local)).toContain(bad.id);

    rmSync(join(local, 'backups'));
    expect(cli('sleep', '--no-learn').stdout).toContain('Set aside 1 automatic memory');
    expect(ids(local)).not.toContain(bad.id);
  }, 60000);

  it('the daily runner cleans the global store once and names --global', () => {
    const bad = seed(global, CUT);
    const first = cli('daily-runner');
    expect(first.stdout).toContain('Set aside 1 automatic memory with a certain defect, once after the upgrade');
    expect(first.stdout).toContain('Bring one back: hippo dormant restore <id> --global');
    expect(ids(global)).not.toContain(bad.id);
    expect(cli('daily-runner').stdout).not.toContain('once after the upgrade');
  }, 60000);
});
