/**
 * Changing the default half-life moves memories still on the old base, once,
 * with the ids in the audit log. Memories hippo shortened, or that carry
 * their own half-life, keep theirs. A dry run writes nothing. A new store
 * starts on the current default; a store written before the base was
 * recorded reads as the legacy 7-day base and moves at the next sleep.
 * Real stores, no mocks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore, writeEntry, loadAllEntries, HALF_LIFE_BASE_META_KEY } from '../src/store.js';
import { createMemory, deriveHalfLife, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { migrateDefaultHalfLife, storeHalfLifeBase, planHalfLifeMigration } from '../src/half-life-migration.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { consolidate } from '../src/consolidate.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function store(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hl-')), '.hippo');
  dirs.push(path.dirname(root));
  initStore(root);
  return root;
}
/** A store as a pre-1.46 hippo left it: memories on the 7-day base and no recorded base. */
function legacyStore(entries: ReturnType<typeof createMemory>[]): string {
  const root = store();
  for (const e of entries) writeEntry(root, e);
  const db = openHippoDb(root);
  try {
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(HALF_LIFE_BASE_META_KEY);
  } finally {
    closeHippoDb(db);
  }
  return root;
}
const legacy = (content: string, options: Parameters<typeof createMemory>[1] = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });
function byContent(root: string): Map<string, number> {
  return new Map(loadAllEntries(root).map((e) => [e.content, e.half_life_days]));
}

describe('default half-life migration', () => {
  it('a new store starts on the current default and a pre-1.46 store reads as 7 days', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(365);
    expect(storeHalfLifeBase(store())).toBe(365);
    expect(storeHalfLifeBase(legacyStore([legacy('the staging deploy needs the VPN')]))).toBe(7);
  });

  it('moves only memories still on the old base, once, and logs their ids', () => {
    const plain = legacy('the staging deploy needs the VPN to reach the health check');
    const error = legacy('npm install fails in billing; use pnpm', { tags: ['error'] });
    const shortened = legacy('an invalidated memory hippo already halved');
    shortened.half_life_days = 3;
    const fixed = legacy('decision: we release on Tuesdays');
    fixed.half_life_days = 90;
    const root = legacyStore([plain, error, shortened, fixed]);

    const r = migrateDefaultHalfLife(root, 365);
    expect(r).toMatchObject({ from: 7, to: 365, rescaled: 2, kept: 2, dryRun: false });

    const hl = byContent(root);
    expect(hl.get(plain.content)).toBe(deriveHalfLife(365, plain));
    expect(hl.get(error.content)).toBe(730);
    expect(hl.get(shortened.content)).toBe(3);
    expect(hl.get(fixed.content)).toBe(90);
    expect(storeHalfLifeBase(root)).toBe(365);

    expect(migrateDefaultHalfLife(root, 365).rescaled).toBe(0);

    const db = openHippoDb(root);
    try {
      // SAFETY: SELECT of one TEXT column.
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'half_life_migrate'`).all() as { metadata_json: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ from: 7, to: 365 });
      expect(JSON.parse(rows[0]!.metadata_json).ids.sort()).toEqual([plain.id, error.id].sort());
    } finally {
      closeHippoDb(db);
    }
  });

  it('moves recalled memories with their recall bonus, and logs the old half-life', () => {
    const recalled = legacy('the billing cron runs at 02:00 UTC');
    recalled.retrieval_count = 3;
    recalled.half_life_days = 7 + 2 * 3;
    const overBonus = legacy('a memory with more half-life than its recalls explain');
    overBonus.retrieval_count = 1;
    overBonus.half_life_days = 7 + 2 * 2;
    const invalidated = legacy('an invalidated memory whose halved value lands on the grid', { tags: ['invalidated'] });
    const root = legacyStore([recalled, overBonus, invalidated]);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ rescaled: 1, kept: 2 });
    const hl = byContent(root);
    expect(hl.get(recalled.content)).toBe(365 + 6);
    expect(hl.get(overBonus.content)).toBe(11);
    expect(hl.get(invalidated.content)).toBe(7);

    const db = openHippoDb(root);
    try {
      // SAFETY: SELECT of one TEXT column.
      const row = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'half_life_migrate'`).get() as { metadata_json: string };
      expect(JSON.parse(row.metadata_json).oldHalfLives).toEqual({ [recalled.id]: 13 });
    } finally {
      closeHippoDb(db);
    }
  });

  it('a dry-run sleep previews decay at the new base', async () => {
    const old = legacy('the staging deploy needs the VPN to reach the health check');
    old.created = old.last_retrieved = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const root = legacyStore([old]);
    const preview = await consolidate(root, { dryRun: true });
    const real = await consolidate(root);
    expect([preview.removed, preview.dormant]).toEqual([real.removed, real.dormant]);
    expect(real.removed + real.dormant).toBe(0);
  });

  it('can be undone by migrating back', () => {
    const plain = legacy('the staging deploy needs the VPN to reach the health check');
    const root = legacyStore([plain]);
    migrateDefaultHalfLife(root, 365);
    migrateDefaultHalfLife(root, 7);
    expect(byContent(root).get(plain.content)).toBe(7);
    expect(storeHalfLifeBase(root)).toBe(7);
  });

  it('a dry run and an unchanged default write nothing', () => {
    const root = legacyStore([legacy('the staging deploy needs the VPN to reach the health check')]);
    expect(migrateDefaultHalfLife(root, 365, { dryRun: true })).toMatchObject({ rescaled: 1, dryRun: true });
    expect([...byContent(root).values()]).toEqual([7]);
    expect(storeHalfLifeBase(root)).toBe(7);
    expect(migrateDefaultHalfLife(root, 7)).toMatchObject({ rescaled: 0 });
    expect(planHalfLifeMigration(loadAllEntries(root), 7, 7)).toEqual([]);
  });

  it('sleep moves a pre-1.46 store to the new default before decaying', async () => {
    const root = legacyStore([legacy('the staging deploy needs the VPN to reach the health check')]);
    const result = await consolidate(root);
    expect(result.details.join('\n')).toMatch(/moved 1 memories from the 7-day to the 365-day half-life/);
    // Sleep's replay pass may lengthen it further (+2 days per replay).
    expect([...byContent(root).values()][0]).toBeGreaterThanOrEqual(365);
  });

  it('sleep leaves a store alone when its own defaultHalfLifeDays matches its base', async () => {
    const root = legacyStore([legacy('the staging deploy needs the VPN to reach the health check')]);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 7 }));
    const result = await consolidate(root);
    expect(result.details.join('\n')).not.toMatch(/half-life/);
    expect([...byContent(root).values()][0]).toBeLessThan(20);
  });
});
