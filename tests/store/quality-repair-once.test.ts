import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTECTED_ROWS as protect } from '../../src/base/memory/memory-audit.js';
import { DatabaseSync } from '../../src/db/sqlite.js';
import { getMeta } from '../../src/db/meta.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import {
  repairAutomaticMemories,
  repairQualityOnce as repairStoreOnce,
  writeEntry,
  loadAllEntries,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const CUT = 'Found local migration files to be';
const DOUBTFUL = 'When CI fails we retry once';

function seed(store: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = {
    ...createMemory(content, { source: 'capture', confidence: 'observed', layer: Layer.Episodic }),
    ...extra,
  };
  writeEntry(store, entry);
  return entry;
}
const ids = (store: string) =>
  loadAllEntries(store, 'default')
    .map((entry) => entry.id)
    .sort();
const repairQualityOnce = (files: { hippoRoot: string }, tenantId: string) => repairStoreOnce(files, tenantId, protect);
function flag(store: string): string {
  const db = new DatabaseSync(join(store, 'hippo.db'));
  try {
    return getMeta(db, 'quality_repair_auto');
  } finally {
    db.close();
  }
}

describe('repairQualityOnce', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('quality-once');
  });

  it("sets aside certain defects on the first run only, and never a person's words", () => {
    const bad = seed(root, CUT);
    const person = seed(root, CUT, { source: 'cli' });
    const first = repairQualityOnce({ hippoRoot: root }, 'default');
    expect(first?.appliedIds).toEqual([bad.id]);
    expect(existsSync(first!.backup!)).toBe(true);
    expect(ids(root)).toEqual([person.id]);
    expect(flag(root)).toBe('1');

    const later = seed(root, CUT);
    expect(repairQualityOnce({ hippoRoot: root }, 'default')).toBeNull();
    expect(ids(root)).toEqual([person.id, later.id].sort());
  });

  it('reads the tenant once per plan, and under its lock the apply reads only the rows it moves', () => {
    seed(root, CUT);
    const tenantPage = /FROM memories WHERE tenant_id = \? ORDER BY created/;
    const preview = recordStatements(() =>
      repairAutomaticMemories({ hippoRoot: root }, { tenantId: 'default', protect }),
    );
    expect(countMatching(preview.statements, tenantPage)).toBe(1);
    const { statements } = recordStatements(() =>
      repairAutomaticMemories({ hippoRoot: root }, { tenantId: 'default', protect, apply: true }),
    );
    const locked = statements.slice(statements.indexOf('BEGIN IMMEDIATE'));
    expect(countMatching(statements, tenantPage)).toBe(1);
    expect(statements).toContain('BEGIN IMMEDIATE');
    expect(countMatching(locked, tenantPage)).toBe(0);
    expect(countMatching(locked, /FROM memories WHERE id IN \(SELECT value FROM json_each\(\?\)\)/)).toBeGreaterThan(0);
  });

  it('marks a clean store done without a backup', () => {
    seed(
      root,
      'Keep test schema setup outside production migrations because production applies every sorted migration.',
    );
    expect(repairQualityOnce({ hippoRoot: root }, 'default')).toMatchObject({ appliedIds: [], backup: null });
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(flag(root)).toBe('1');
  });

  // The failed repair waits out the 5 s lock wait on the held write lock, which is the default test limit.
  it('leaves the store unmarked when the repair fails, so the next run tries again', () => {
    const bad = seed(root, CUT);
    const holder = new DatabaseSync(join(root, 'hippo.db'));
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect(() => repairQualityOnce({ hippoRoot: root }, 'default')).toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(flag(root)).toBe('');
    expect(repairQualityOnce({ hippoRoot: root }, 'default')?.appliedIds).toEqual([bad.id]);
  }, 30_000);

  it('leaves a store whose schema it cannot repair unmarked', () => {
    const bad = seed(root, CUT);
    const db = new DatabaseSync(join(root, 'hippo.db'));
    try {
      db.exec('DROP TABLE audit_log');
    } finally {
      db.close();
    }
    expect(repairQualityOnce({ hippoRoot: root }, 'default')).toMatchObject({ supported: false, appliedIds: [] });
    expect(flag(root)).toBe('');
    expect(ids(root)).toEqual([bad.id]);
  });
});

// In process each case runs under 0.5 s, so the 30 s process-project timeout is a 60x margin.
describe('the upgrade runs the repair once', () => {
  let dir: string;
  let local: string;
  let global: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = makeRoot('quality-once-cli', { init: false });
    local = join(dir, '.hippo');
    global = join(dir, 'global');
    initTestStore(local);
    initTestStore(global);
    env = {
      ...process.env,
      HIPPO_HOME: global,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: join(dir, 'AppData', 'Roaming'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
  });
  // In process, so coverage sees sleep and the daily runner; the runner's own steps still start real children.
  const cli = (...args: string[]) => runCliAs(args, { cwd: dir, env });

  it('hippo sleep cleans the project store once, after a dry run that changed nothing', async () => {
    const bad = seed(local, CUT);
    const doubtful = seed(local, DOUBTFUL);
    const dry = await cli('sleep', '--dry-run', '--no-learn');
    expect(dry.stdout).not.toContain('once after the upgrade');
    expect(flag(local)).toBe('');

    const first = await cli('sleep', '--no-learn');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Set aside 1 automatic memory with a certain defect, once after the upgrade');
    expect(first.stdout).toContain('Bring one back: hippo dormant restore <id>\n');
    expect(first.stdout).toContain('  1 more looks doubtful and was kept; hippo audit repair lists them.');
    expect(ids(local)).not.toContain(bad.id);
    expect(ids(local)).toContain(doubtful.id);

    seed(local, CUT);
    expect((await cli('sleep', '--no-learn')).stdout).not.toContain('once after the upgrade');
  });

  it('a store with only doubtful rows is reported without a "more"', async () => {
    seed(local, DOUBTFUL);
    seed(local, 'Always check which branch the PR merges into');
    const first = await cli('sleep', '--no-learn');
    expect(first.stdout).toContain(
      'Checked old automatic memories once after the upgrade: 2 look doubtful and were kept; hippo audit repair lists them.',
    );
    expect(flag(local)).toBe('1');
  });

  it('a failed repair warns, lets the sleep finish and runs again at the next sleep', async () => {
    const bad = seed(local, CUT);
    writeFileSync(join(local, 'backups'), 'not a folder');
    const failed = await cli('sleep', '--no-learn');
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain('memory quality repair skipped, tried again next time');
    expect(failed.stdout).toContain('Running consolidation');
    expect(flag(local)).toBe('');
    expect(ids(local)).toContain(bad.id);

    rmSync(join(local, 'backups'));
    expect((await cli('sleep', '--no-learn')).stdout).toContain('Set aside 1 automatic memory');
    expect(ids(local)).not.toContain(bad.id);
  });

  it('the daily runner cleans the global store once and names --global', async () => {
    const bad = seed(global, CUT);
    const first = await cli('daily-runner');
    expect(first.stdout).toContain('Set aside 1 automatic memory with a certain defect, once after the upgrade');
    expect(first.stdout).toContain('Bring one back: hippo dormant restore <id> --global');
    expect(ids(global)).not.toContain(bad.id);
    expect((await cli('daily-runner')).stdout).not.toContain('once after the upgrade');
  });
});
