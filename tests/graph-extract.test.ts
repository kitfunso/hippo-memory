/**
 * E3.1 deterministic entity extraction - tests.
 * Docs: docs/plans/2026-06-01-e3-deterministic-extraction.md
 *
 * extractGraph rebuilds the graph from the consolidated E2 objects (decision/policy/
 * customer_note/project_brief -> entities + supersedes relations). Real DB, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { saveDecision, closeDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { saveProjectBrief } from '../src/project-briefs.js';
import { loadEntities, loadRelations, loadNeighborRelations, loadRelationsAmong } from '../src/graph/read.js';
import type { Entity } from '../src/graph/types.js';
import { extractGraph, extractGraphChunked } from '../src/graph-extract.js';
import { openHippoDb, closeHippoDb, getHippoDbPath, runWithRequestStores, type DatabaseSyncLike } from '../src/db.js';
import { WRITE_BUDGET, type WriteBudget } from '../src/write-budget.js';
import { makeRoot } from './_helpers/make-root.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: DatabaseSyncLike };
};

const yieldOnce = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A thread, not a timer: the rebuild's busy wait blocks this thread until the holder commits.
const HOLD_LOCK_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage('locked');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
db.exec('COMMIT');
db.close();
`;

/** The real clock with the hold a test picks, and a pause that yields once instead of waiting out the real gap. */
const budget = (holdMs: number, pause: WriteBudget['pause'] = yieldOnce): WriteBudget => ({ ...WRITE_BUDGET, holdMs, pause });

const GRAPH_WRITE_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(entities|relations)\b/i;

/** The graph-table writes `run` prepares, on any connection. */
function graphWritesDuring(run: () => void): string[] {
  const writes: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
    if (GRAPH_WRITE_SQL.test(sql)) writes.push(sql.trim());
    return prepare.call(this, sql);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return writes;
}

function callStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Counts the graph writer's BEGIN IMMEDIATEs, leaving out every other writer's. */
function countRebuildBegins() {
  let begins = 0;
  const exec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
    if (sql === 'BEGIN IMMEDIATE' && callStack().includes('runGraphRebuildTransaction')) begins++;
    exec.call(this, sql);
  });
  return { count: () => begins, restore: () => spy.mockRestore() };
}

/** A tenant's graph by natural key, leaving out ids and timestamps. */
function graphByKey(home: string, tenant = 'default') {
  const ents = loadEntities(home, tenant, { limit: 10_000 });
  const keyOf = (e: Entity) => `${e.entityType}|${e.sourceObjectType}:${e.sourceObjectId}`;
  const keyById = new Map(ents.map((e) => [e.id, keyOf(e)]));
  return {
    entities: ents.map((e) => `${keyOf(e)} ${e.name} ${e.memoryId} ${e.sourceKind}`).sort(),
    relations: loadRelations(home, tenant, { limit: 10_000 })
      .map((r) => `${keyById.get(r.fromEntityId)}>${keyById.get(r.toEntityId)} ${r.relType} ${r.memoryId} ${r.sourceKind} ${r.sourceObjectType}:${r.sourceObjectId}`)
      .sort(),
  };
}

function entityCount(home: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: COUNT(*) always returns exactly one row shaped { c: number };
    // better-sqlite3's .get() types as `unknown` with no query-shape knowledge.
    return (db.prepare(`SELECT COUNT(*) c FROM entities`).get() as { c: number }).c;
  }
  finally { closeHippoDb(db); }
}

describe('graph extraction (E3.1 deterministic, from consolidated E2 objects)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('graph-extract'); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('extracts entities (4 types) + a supersedes relation; excludes closed; idempotent', () => {
    // decision v1 -> superseded by v2 (active)
    const d1 = saveDecision(home, 'default', { decisionText: 'Adopt Postgres' });
    saveDecision(home, 'default', { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
    // a closed decision (must be excluded)
    const dc = saveDecision(home, 'default', { decisionText: 'Retired idea' });
    closeDecision(home, 'default', dc.id);
    // one of each other type
    savePolicy(home, 'default', { policyName: 'Data retention', policyText: 'Delete logs after 90 days' });
    saveCustomerNote(home, 'default', { customer: 'Acme Corp', note: 'renewal in Q3' });
    saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'agent-memory lib' });

    const r = extractGraph(home, 'default');
    expect(r.byType).toEqual({ decision: 2, policy: 1, customer: 1, project: 1 }); // dc excluded
    expect(r.entities).toBe(5);
    expect(r.relations).toBe(1);
    expect(r.truncated).toEqual([]);

    const ents = loadEntities(home, 'default', { limit: 100 });
    expect(ents.length).toBe(5);
    expect(ents.filter((e) => e.entityType === 'decision').length).toBe(2);
    expect(ents.some((e) => e.entityType === 'policy' && e.name === 'Data retention')).toBe(true);
    expect(ents.some((e) => e.entityType === 'customer' && e.name === 'Acme Corp')).toBe(true);
    expect(ents.some((e) => e.entityType === 'project' && e.name === 'hippo')).toBe(true);
    expect(ents.some((e) => e.name === 'Retired idea')).toBe(false); // closed excluded

    // the supersedes relation: v2 supersedes v1
    const e1 = ents.find((e) => e.name === 'Adopt Postgres')!;
    const e2 = ents.find((e) => e.name === 'Adopt Postgres (managed)')!;
    const rels = loadRelations(home, 'default', { limit: 100 });
    expect(rels.length).toBe(1);
    expect(rels[0].relType).toBe('supersedes');
    expect(rels[0].fromEntityId).toBe(e2.id); // successor
    expect(rels[0].toEntityId).toBe(e1.id);   // superseded

    // idempotent: re-running rebuilds to the same graph (no duplication)
    const r2 = extractGraph(home, 'default');
    expect(r2.entities).toBe(5);
    expect(r2.relations).toBe(1);
    expect(loadEntities(home, 'default', { limit: 100 }).length).toBe(5);
    expect(loadRelations(home, 'default', { limit: 100 }).length).toBe(1);
  });

  it('KEEPS an active E2 object whose source memory was forgotten (v38 E2-provenance): memory_id NULL, source_object set', () => {
    // v38: extraction anchors provenance to the authoritative E2 object, so an in-force
    // decision STAYS in the graph after its mirror is forgotten (memory_id -> NULL), now
    // anchored via source_object_type/id.
    const dn = saveDecision(home, 'default', { decisionText: 'Will lose its memory' });
    deleteEntry(home, dn.memoryId!); // distilled delete is allowed; decisions.memory_id -> NULL
    saveDecision(home, 'default', { decisionText: 'Keeps its memory' });
    const r = extractGraph(home, 'default');
    expect(r.byType.decision).toBe(2); // BOTH extracted (the forgotten-mirror one survives)
    const ents = loadEntities(home, 'default', { limit: 100 });
    const names = ents.map((e) => e.name);
    expect(names).toContain('Keeps its memory');
    expect(names).toContain('Will lose its memory');
    const lost = ents.find((e) => e.name === 'Will lose its memory')!;
    expect(lost.memoryId).toBeNull();
    expect(lost.sourceObjectType).toBe('decision');
    expect(lost.sourceObjectId).toBe(dn.id);
  });

  it('skips a supersedes relation when the successor is not extracted (closed)', () => {
    // d1 superseded by d2, then d2 closed -> d1 superseded (extracted), d2 closed (not)
    const d1 = saveDecision(home, 'default', { decisionText: 'orig' });
    const d2 = saveDecision(home, 'default', { decisionText: 'replacement', supersedesDecisionId: d1.id });
    closeDecision(home, 'default', d2.id);
    const r = extractGraph(home, 'default');
    // d1 (superseded) extracted; d2 (closed) excluded -> no relation (successor missing)
    expect(r.byType.decision).toBe(1);
    expect(r.relations).toBe(0);
  });

  it('rebuild reflects current state: a brand-new object appears, a closed one disappears, on re-extract', () => {
    const d = saveDecision(home, 'default', { decisionText: 'first' });
    extractGraph(home, 'default');
    expect(entityCount(home)).toBe(1);
    saveDecision(home, 'default', { decisionText: 'second' });
    closeDecision(home, 'default', d.id);
    const r = extractGraph(home, 'default');
    expect(r.byType.decision).toBe(1); // 'second' present, 'first' (now closed) gone
    expect(loadEntities(home, 'default', { limit: 100 }).map((e) => e.name)).toEqual(['second']);
  });

  it('truncates an over-cap E2 name instead of throwing + bricking the rebuild (codex/independent-review)', () => {
    // decisionText is uncapped at source; a >512-char one must NOT throw in insertEntity
    // (which would leave the cleared graph empty + unrebuildable). It is truncated.
    const longText = 'D' + 'x'.repeat(700);
    saveDecision(home, 'default', { decisionText: longText });
    saveDecision(home, 'default', { decisionText: 'short one' });
    const r = extractGraph(home, 'default'); // must not throw
    expect(r.byType.decision).toBe(2);
    const ents = loadEntities(home, 'default', { limit: 100 });
    const longEnt = ents.find((e) => e.name.startsWith('Dxxx'))!;
    expect(longEnt).toBeDefined();
    expect(longEnt.name.length).toBeLessThanOrEqual(512);
    // re-run still works (not bricked)
    expect(() => extractGraph(home, 'default')).not.toThrow();
    expect(loadEntities(home, 'default', { limit: 100 }).length).toBe(2);
  });

  it('trims leading whitespace before capping (codex R2: a long whitespace-prefix name must not brick)', () => {
    const d = saveDecision(home, 'default', { decisionText: 'placeholder' });
    // Inject a name whose first 512 chars are whitespace (slice-without-trim would
    // yield a whitespace-only label -> insertEntity trims to '' -> throws -> brick).
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE decisions SET decision_text = ? WHERE id = ?`).run(' '.repeat(600) + 'real decision', d.id);
    } finally { closeHippoDb(db); }
    const r = extractGraph(home, 'default'); // must not throw
    expect(r.byType.decision).toBe(1);
    const ent = loadEntities(home, 'default', { limit: 100 })[0];
    expect(ent.name).toBe('real decision'); // trimmed, non-empty
    expect(() => extractGraph(home, 'default')).not.toThrow(); // not bricked
  });

  it('empty store extracts to an empty graph (no crash)', () => {
    const r = extractGraph(home, 'default');
    expect(r).toEqual({ entities: 0, relations: 0, references: 0, byType: { decision: 0, policy: 0, customer: 0, project: 0 }, truncated: [] });
  });

  it('a rerun on unchanged objects prepares no write to entities or relations', () => {
    const d1 = saveDecision(home, 'default', { decisionText: 'Adopt Postgres' });
    saveDecision(home, 'default', { decisionText: 'Adopt Postgres (managed) under RetryPolicy', supersedesDecisionId: d1.id });
    deleteEntry(home, saveDecision(home, 'default', { decisionText: 'RetryPolicy covers search too' }).memoryId!);
    savePolicy(home, 'default', { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    saveCustomerNote(home, 'default', { customer: 'Acme Corp', note: 'renewal in Q3, wants RetryPolicy' });
    saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'agent-memory lib for Acme Corp' });
    const first = extractGraph(home, 'default');
    expect(first.references).toBeGreaterThan(0);

    expect(graphWritesDuring(() => extractGraph(home, 'default'))).toEqual([]);
  });

  it('renaming a policy three decisions reference keeps its entity id and all three references', () => {
    const pol = savePolicy(home, 'default', { policyName: 'Retry Policy', policyText: 'retry 3x' });
    for (const team of ['billing', 'search', 'checkout']) saveDecision(home, 'default', { decisionText: `${team} adopts Retry Policy v2` });
    extractGraph(home, 'default');
    const before = loadEntities(home, 'default', { entityType: 'policy', limit: 10 })[0];
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE policies SET policy_name = ? WHERE id = ?`).run('Retry Policy v2', pol.id);
    } finally { closeHippoDb(db); }

    extractGraph(home, 'default');

    const after = loadEntities(home, 'default', { entityType: 'policy', limit: 10 });
    expect(after.map((e) => [e.id, e.name])).toEqual([[before.id, 'Retry Policy v2']]);
    const refs = loadRelations(home, 'default', { limit: 100 }).filter((r) => r.relType === 'references');
    expect(refs.map((r) => r.toEntityId)).toEqual([before.id, before.id, before.id]);
  });

  it('a chunked rebuild commits in several transactions and ends where one transaction would', async () => {
    savePolicy(home, 'default', { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    let prev: number | undefined;
    for (let i = 0; i < 40; i++) {
      prev = saveDecision(home, 'default', { decisionText: `Call ${i} adopts RetryPolicy`, supersedesDecisionId: i % 10 === 9 ? prev : undefined }).id;
    }
    const copy = `${home}-copy`;
    cpSync(home, copy, { recursive: true });
    try {
      const begins = countRebuildBegins();
      const chunked = await extractGraphChunked(home, 'default', budget(0)).finally(begins.restore);

      expect(begins.count()).toBeGreaterThanOrEqual(2);
      expect(chunked).toEqual(extractGraph(copy, 'default'));
      expect(graphByKey(home)).toEqual(graphByKey(copy));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('a mirrorless object closed between the load and its chunk gets no entity row', async () => {
    // Loaders return newest first, so the older decision's insert lands in a later chunk than the newer one's.
    const older = saveDecision(home, 'default', { decisionText: 'Older call, mirror forgotten' });
    deleteEntry(home, older.memoryId!);
    saveDecision(home, 'default', { decisionText: 'Newer call' });
    let pauses = 0;
    const closeOlderOnce = async (): Promise<void> => {
      if (pauses++ === 0) closeDecision(home, 'default', older.id);
      await yieldOnce();
    };

    const r = await extractGraphChunked(home, 'default', budget(0, closeOlderOnce));

    expect(pauses).toBeGreaterThan(0);
    expect(loadEntities(home, 'default', { limit: 10 }).map((e) => e.name)).toEqual(['Newer call']);
    expect(r.skipped).toBe(1);
  });

  it('an incremental rebuild keeps unchanged rows, so the new entity and relation sort first in the graph reads', () => {
    savePolicy(home, 'default', { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    saveDecision(home, 'default', { decisionText: 'D1 adopts RetryPolicy' });
    extractGraph(home, 'default');
    saveDecision(home, 'default', { decisionText: 'D2 adopts RetryPolicy' });

    extractGraph(home, 'default');

    const ents = loadEntities(home, 'default', { limit: 10 });
    expect(ents.map((e) => e.name)).toEqual(['D2 adopts RetryPolicy', 'RetryPolicy', 'D1 adopts RetryPolicy']);
    const [d2, pol, d1] = ents;
    const fromNames = (rels: { fromEntityId: number }[]) => rels.map((r) => ents.find((e) => e.id === r.fromEntityId)?.name);
    const newestFirst = ['D2 adopts RetryPolicy', 'D1 adopts RetryPolicy'];
    expect(fromNames(loadRelations(home, 'default', { limit: 10 }))).toEqual(newestFirst);
    expect(fromNames(loadNeighborRelations(home, 'default', [pol.id]))).toEqual(newestFirst);
    expect(fromNames(loadRelationsAmong(home, 'default', [d1.id, d2.id, pol.id]))).toEqual(newestFirst);
  });

  it('a chunked rebuild inside a server request waits out a writer that holds the lock between chunks', async () => {
    savePolicy(home, 'default', { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    for (let i = 0; i < 10; i++) saveDecision(home, 'default', { decisionText: `Call ${i} adopts RetryPolicy` });
    let exited: Promise<unknown[]> | undefined;
    const holdsOnFirstPause = budget(0, async () => {
      if (exited) return yieldOnce();
      const holder = new Worker(HOLD_LOCK_WORKER, { eval: true, workerData: { file: getHippoDbPath(home), ms: 400 } });
      exited = once(holder, 'exit');
      await once(holder, 'message');
    });

    const r = await runWithRequestStores(() => extractGraphChunked(home, 'default', holdsOnFirstPause), { busyWaitMs: 250 });

    expect(exited).toBeDefined();
    expect(await exited).toEqual([0]);
    expect(r.entities).toBe(11);
  });
});
