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
import { initStore, writeEntry, readEntry, loadAllEntries, replaceDetectedConflicts, listMemoryConflicts, resolveConflict, HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY } from '../src/store.js';
import { createMemory, deriveHalfLife, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions } from '../src/memory.js';
import { migrateDefaultHalfLife, storeHalfLifeBase, planHalfLifeMigration, LEGACY_TYPED_HALF_LIFE } from '../src/half-life-migration.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { consolidate } from '../src/consolidate.js';
import { saveDecision, closeDecision } from '../src/decisions.js';
import { saveIncident, resolveIncident } from '../src/incidents.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { supersede, adminActor } from '../src/api.js';

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
/** Deletes the store's record of where its half-lives stand, as a hippo that predates `keys` left it. */
function unrecord(root: string, ...keys: string[]): void {
  const db = openHippoDb(root);
  try {
    for (const key of keys) db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
  } finally {
    closeHippoDb(db);
  }
}
/** A store as a pre-1.46 hippo left it: memories on the 7-day base and no recorded base. */
function legacyStore(entries: ReturnType<typeof createMemory>[]): string {
  const root = store();
  for (const e of entries) writeEntry(root, e);
  unrecord(root, HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY);
  return root;
}
const legacy = (content: string, options: Partial<CreateMemoryOptions> = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });
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

/** Rewrites memory `id` as a typed writer pinned it before it took the default: 90 days plus 2 per recall. */
function pinTo90(root: string, id: string, recalls = 0): void {
  writeEntry(root, { ...readEntry(root, id, 'default')!, retrieval_count: recalls, half_life_days: LEGACY_TYPED_HALF_LIFE + 2 * recalls });
}
function halfLifeOf(root: string, id: string): number {
  return readEntry(root, id, 'default')!.half_life_days;
}
function migrateAudits(root: string): unknown[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: SELECT of one TEXT column.
    const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'half_life_migrate'`).all() as { metadata_json: string }[];
    return rows.map((r) => JSON.parse(r.metadata_json));
  } finally {
    closeHippoDb(db);
  }
}

describe('memories of decisions, incidents and other objects pinned to 90 days', () => {
  it('move to the default with their recall bonus, once, and log their old half-lives', () => {
    const root = store();
    const decision = saveDecision(root, 'default', { decisionText: 'we release on Tuesdays after the staging soak' }).memoryId!;
    const note = saveCustomerNote(root, 'default', { customer: 'Acme', note: 'renewal is due in March' }).memoryId!;
    pinTo90(root, decision);
    pinTo90(root, note, 3);
    const ordinary = createMemory('the staging deploy needs the VPN to reach the health check', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, ordinary);
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ from: 365, to: 365, rescaled: 0, typed: 2, kept: 1 });
    expect(halfLifeOf(root, decision)).toBe(365);
    expect(halfLifeOf(root, note)).toBe(365 + 6);
    expect(halfLifeOf(root, ordinary.id)).toBe(365);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ rescaled: 0, typed: 0 });
    const audits = migrateAudits(root);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ from: 90, to: 365, oldHalfLives: { [decision]: 90, [note]: 96 } });
  });

  it('keep a half-life hippo shortened or a user set by hand', () => {
    const root = store();
    const superseded = saveDecision(root, 'default', { decisionText: 'use REST for all public APIs' }).memoryId!;
    const handSet = saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!;
    const old = readEntry(root, superseded, 'default')!;
    writeEntry(root, { ...old, half_life_days: 45, confidence: 'stale', tags: [...old.tags, 'superseded'] });
    writeEntry(root, { ...readEntry(root, handSet, 'default')!, half_life_days: 200 });
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ typed: 0, kept: 2 });
    expect(halfLifeOf(root, superseded)).toBe(45);
    expect(halfLifeOf(root, handSet)).toBe(200);
  });

  it('keep the memory of a superseded or closed object, but move a resolved incident', () => {
    const root = store();
    const old = saveDecision(root, 'default', { decisionText: 'use REST for all public APIs' });
    saveDecision(root, 'default', { decisionText: 'use gRPC for internal APIs', supersedesDecisionId: old.id });
    const closed = saveDecision(root, 'default', { decisionText: 'freeze deploys on Fridays' });
    closeDecision(root, 'default', closed.id);
    const incident = saveIncident(root, 'default', { incidentText: 'the billing cron charged twice on the 1st' });
    resolveIncident(root, 'default', incident.id, 'made the charge idempotent');
    for (const id of [old.memoryId!, closed.memoryId!, incident.memoryId!]) pinTo90(root, id);
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ typed: 1 });
    expect(halfLifeOf(root, old.memoryId!)).toBe(90);
    expect(halfLifeOf(root, closed.memoryId!)).toBe(90);
    expect(halfLifeOf(root, incident.memoryId!)).toBe(365);
  });

  it('sleep moves them to a configured default along with ordinary memories', async () => {
    const root = store();
    const decision = saveDecision(root, 'default', { decisionText: 'we release on Tuesdays after the staging soak' }).memoryId!;
    pinTo90(root, decision);
    const ordinary = createMemory('the staging deploy needs the VPN to reach the health check', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, ordinary);
    unrecord(root, TYPED_HALF_LIFE_META_KEY);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 730 }));

    const details = (await consolidate(root)).details.join('\n');
    expect(details).toMatch(/moved 1 memories from the 365-day to the 730-day half-life/);
    expect(details).toMatch(/moved 1 memories of decisions, incidents and other objects from the 90-day to the 730-day half-life/);
    // Sleep's replay pass may lengthen them further (+2 days per replay).
    expect(halfLifeOf(root, decision)).toBeGreaterThanOrEqual(730);
    expect(halfLifeOf(root, ordinary.id)).toBeGreaterThanOrEqual(730);
  });

  it('are told apart from a supersede copy that kept the source but was written on the 7-day base', () => {
    const copy = legacy('we release on Tuesdays now, not Mondays', { source: 'decision' });
    const pinned = legacy('use Postgres for all new services', { source: 'decision' });
    const root = store();
    writeEntry(root, copy);
    writeEntry(root, pinned);
    pinTo90(root, pinned.id);
    unrecord(root, HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ from: 7, to: 365, rescaled: 1, typed: 1, kept: 0 });
    expect(halfLifeOf(root, copy.id)).toBe(365);
    expect(halfLifeOf(root, pinned.id)).toBe(365);
  });

  it('leave a supersede copy on the base, even one whose recalls give it the pinned shape', () => {
    const root = store();
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 30 }));
    migrateDefaultHalfLife(root, 30);
    const decision = saveDecision(root, 'default', { decisionText: 'we release on Mondays' }).memoryId!;
    const copy = supersede({ hippoRoot: root, tenantId: 'default', actor: adminActor('test') }, decision, 'we release on Tuesdays now').newId;
    writeEntry(root, { ...readEntry(root, copy, 'default')!, retrieval_count: 40, half_life_days: 30 + 2 * 40 });
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    migrateDefaultHalfLife(root, 30);
    expect(halfLifeOf(root, copy)).toBe(30 + 2 * 40);
  });

  it("keep an object's memory hippo shortened, even when its recalls read as base-written", () => {
    const root = store();
    const decision = saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!;
    // A conflict loser: resolveConflict halved 90 + 2 * 38 and left no tag.
    writeEntry(root, { ...readEntry(root, decision, 'default')!, retrieval_count: 38, half_life_days: (90 + 2 * 38) / 2 });
    unrecord(root, HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ from: 7, rescaled: 0, typed: 0 });
    expect(halfLifeOf(root, decision)).toBe(83);
  });

  it('move a row that reads as both base-written and pinned once, by the typed plan', () => {
    const root = store();
    migrateDefaultHalfLife(root, 100);
    const both = createMemory('use gRPC for internal APIs', { source: 'decision', baseHalfLifeDays: 100 });
    writeEntry(root, { ...both, retrieval_count: 5, half_life_days: 90 + 2 * 5 });
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ from: 100, rescaled: 0, typed: 1, kept: 0 });
    expect(halfLifeOf(root, both.id)).toBe(365 + 10);
    expect(migrateAudits(root)).toEqual([expect.objectContaining({ from: 90, to: 365 })]);
  });

  it('a new store never moves one, even one set to 90 days by hand', () => {
    const root = store();
    const decision = saveDecision(root, 'default', { decisionText: 'we release on Tuesdays after the staging soak' }).memoryId!;
    pinTo90(root, decision);
    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ rescaled: 0, typed: 0 });
    expect(halfLifeOf(root, decision)).toBe(90);
  });

  it('keep the memory that lost a conflict, even when an odd recall count halves it onto the pinned shape, and move the winner', () => {
    const root = store();
    const loser = saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!;
    const winner = saveDecision(root, 'default', { decisionText: 'use MySQL for all new services' }).memoryId!;
    pinTo90(root, loser, 47);
    pinTo90(root, winner);
    replaceDetectedConflicts(root, [{ memory_a_id: loser, memory_b_id: winner, reason: 'contradiction', score: 0.9 }]);
    resolveConflict(root, listMemoryConflicts(root)[0]!.id, winner);
    unrecord(root, TYPED_HALF_LIFE_META_KEY);
    expect(halfLifeOf(root, loser)).toBe(92);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ typed: 1 });
    expect(halfLifeOf(root, loser)).toBe(92);
    expect(halfLifeOf(root, winner)).toBe(365);
  });

  it('keep both memories of a conflict resolved before the audit log named a winner', () => {
    const root = store();
    const a = saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!;
    const b = saveDecision(root, 'default', { decisionText: 'use MySQL for all new services' }).memoryId!;
    pinTo90(root, a, 1);
    pinTo90(root, b);
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO memory_conflicts(memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at) VALUES (?, ?, 'contradiction', 0.9, 'resolved', datetime('now'), datetime('now'))`).run(a, b);
    } finally {
      closeHippoDb(db);
    }
    unrecord(root, TYPED_HALF_LIFE_META_KEY);

    expect(migrateDefaultHalfLife(root, 365)).toMatchObject({ typed: 0 });
    expect(halfLifeOf(root, a)).toBe(92);
    expect(halfLifeOf(root, b)).toBe(90);
  });

  it('written between the upgrade and the first sleep, stay on 90 days until it moves them, through a config change', () => {
    const root = store();
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 30 }));
    migrateDefaultHalfLife(root, 30);
    unrecord(root, TYPED_HALF_LIFE_META_KEY);
    const plain = createMemory('the staging deploy needs the VPN to reach the health check', { baseHalfLifeDays: 30 });
    writeEntry(root, plain);
    const decision = saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!;
    const recalled = saveDecision(root, 'default', { decisionText: 'use gRPC for internal APIs' }).memoryId!;
    expect(halfLifeOf(root, decision)).toBe(90);
    pinTo90(root, recalled, 40);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 60 }));

    expect(migrateDefaultHalfLife(root, 60)).toMatchObject({ from: 30, rescaled: 1, typed: 2 });
    expect(halfLifeOf(root, decision)).toBe(60);
    expect(halfLifeOf(root, recalled)).toBe(60 + 80);
    expect(halfLifeOf(root, plain.id)).toBe(60);
    expect(halfLifeOf(root, saveDecision(root, 'default', { decisionText: 'freeze deploys on Fridays' }).memoryId!)).toBe(60);
  });

  it('written to a store with no memories yet, take the configured default at once', () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hl-')), '.hippo');
    dirs.push(path.dirname(root));
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 30 }));
    expect(halfLifeOf(root, saveDecision(root, 'default', { decisionText: 'use Postgres for all new services' }).memoryId!)).toBe(30);
  });
});
