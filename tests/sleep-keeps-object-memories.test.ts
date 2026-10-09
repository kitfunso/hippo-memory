// Every automatic delete (sleep's dedupe, audit and consolidation flush, and the automatic deleteEntry that `hippo audit --fix`
// also calls) leaves a memory that backs a decision, incident or other object in place: deleting it would null the object's link.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, type Context } from '../src/api/index.js';
import { auditMemories } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { saveDecision } from '../src/objects/decisions.js';
import { deduplicateStore } from '../src/consolidate/dedupe.js';
import { saveIncident } from '../src/objects/incidents.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { batchWriteAndDelete, deleteEntry, memoriesBackingObjects } from '../src/store/delete-and-batch.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-object-memories-'));
  roots.push(root);
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }));
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ctxFor = (hippoRoot: string): Context => ({ hippoRoot, tenantId: 'default', actor: { subject: 'object-memories-test', role: 'admin' } });

function run(root: string, sql: string, ...params: string[]): void {
  const db = openHippoDb(root);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeHippoDb(db);
  }
}

function linkOf(root: string, table: string, objectId: number): string | null {
  const db = openHippoDb(root);
  try {
    // SAFETY: row's shape matches the single memory_id column named in the SELECT.
    return (db.prepare(`SELECT memory_id FROM ${table} WHERE id = ?`).get(objectId) as { memory_id: string | null }).memory_id;
  } finally {
    closeHippoDb(db);
  }
}

const SAVERS = [
  ['decision', 'decisions', (root: string) => saveDecision(root, 'default', { decisionText: 'we release on Tuesdays after the staging soak' })],
  ['incident', 'incidents', (root: string) => saveIncident(root, 'default', { incidentText: 'the billing cron charged twice on the 1st' })],
] as const;

describe.each(SAVERS)('a memory that backs a %s', (_kind, table, save) => {
  it('outlives a stronger copy of its text through sleep dedupe, and the link holds', async () => {
    const root = newRoot();
    const object = save(root);
    const backing = readEntry(root, object.memoryId!)!;
    const copy = { ...createMemory(backing.content), strength: 1, retrieval_count: 9 };
    writeEntry(root, copy);
    run(root, `UPDATE memories SET strength = 0.2 WHERE id = ?`, backing.id);

    const dry = await sleep(ctxFor(root), { dryRun: true, noShare: true });
    expect(dry.deduped?.removed ?? 0).toBe(0);
    await sleep(ctxFor(root), { noShare: true });

    expect(readEntry(root, backing.id)).not.toBeNull();
    expect(linkOf(root, table, object.id)).toBe(backing.id);
  });

  it('outlives the sleep quality audit when its text reads as junk, and only warns', async () => {
    const root = newRoot();
    const object = save(root);
    run(root, `UPDATE memories SET content = 'nope' WHERE id = ?`, object.memoryId!);

    const backingSet = memoriesBackingObjects(root);
    expect(auditMemories(loadAllEntries(root), backingSet).issues).toMatchObject([
      { memoryId: object.memoryId, severity: 'warning', reason: expect.stringContaining('backs an object') },
    ]);
    const result = await sleep(ctxFor(root), { noShare: true });

    expect(result.audit?.errorsRemoved ?? 0).toBe(0);
    expect(readEntry(root, object.memoryId!)).not.toBeNull();
    expect(linkOf(root, table, object.id)).toBe(object.memoryId);
  });

  it('is refused by an automatic delete and removed by an explicit one', () => {
    const root = newRoot();
    const object = save(root);

    expect(deleteEntry(root, object.memoryId!, { automatic: true })).toBe(false);
    expect(readEntry(root, object.memoryId!)).not.toBeNull();
    expect(deleteEntry(root, object.memoryId!)).toBe(true);
  });

  it('is skipped by the consolidation flush, as a delete and as a dormant move', () => {
    const root = newRoot();
    const object = save(root);
    const plain = createMemory('the staging cluster restarts on sundays');
    writeEntry(root, plain);
    const backing = readEntry(root, object.memoryId!)!;
    const move = { entry: backing, strength: 0.01, reason: 'decay' as const, dormantAt: new Date().toISOString() };

    expect(batchWriteAndDelete(root, [], [backing.id, plain.id])).toEqual([plain.id]);
    expect(batchWriteAndDelete(root, [], [], { dormant: [move] })).toEqual([]);
    expect(readEntry(root, backing.id)).not.toBeNull();
    expect(linkOf(root, table, object.id)).toBe(backing.id);
  });
});

it('control: a plain weaker copy is still removed by dedupe', () => {
  const root = newRoot();
  const text = 'the build cache lives in /var/cache/hippo on the CI runners';
  const keeper = { ...createMemory(text), strength: 1 };
  const copy = { ...createMemory(text), strength: 0.2 };
  writeEntry(root, keeper);
  writeEntry(root, copy);

  expect(deduplicateStore(root).removed).toBe(1);
  expect(readEntry(root, copy.id)).toBeNull();
});
