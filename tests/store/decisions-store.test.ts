/**
 * E2 decision first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-28-e2-decision-object.md
 *
 * Covers what only decisions have; the shared lifecycle rules run per kind in typed-object-store.test.ts.
 * 1. saveDecision creates both the memory mirror and the decisions row
 * 2. a supersede that loses its race after the preflight is a ConflictError (409)
 * 3. saveDecision without context: bare memory content, has_context false
 * 4. loadDecisions status filter; status 'active' excludes non-active
 * 5. resolveActiveDecisionIdByMemory (row id first-class, null legacy/superseded)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  saveDecision,
  closeDecision,
  loadDecisions,
  resolveActiveDecisionIdByMemory,
} from '../../src/objects/decisions.js';
import { ConflictError } from '../../src/core/api-errors.js';
import { mapApiError } from '../../src/api/error-reply.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/core/config.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Typed wrappers around DatabaseSyncLike's untyped get/all and JSON.parse.
 * Every call site below supplies T for a SELECT column list (or JSON
 * payload written by saveDecision/audit logging under test) directly at
 * the call, so the shape is established there, not assumed blind.
 */
function getRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T {
  // SAFETY: see doc comment above.
  return db.prepare(sql).get(...params) as T;
}
function getRowMaybe<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: see doc comment above; undefined only when get() finds no row.
  return db.prepare(sql).get(...params) as T | undefined;
}
function allRows<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T[] {
  // SAFETY: see doc comment above.
  return db.prepare(sql).all(...params) as T[];
}
function parseJson<T>(text: string): T {
  // SAFETY: see doc comment above.
  return JSON.parse(text) as T;
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    return getRow<{ c: number }>(db, `SELECT COUNT(*) as c FROM ${table}`).c;
  } finally { closeHippoDb(db); }
}

describe('decisions store (first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('decisions'); });
  afterEach(() => safeRmSync(home));

  it('saveDecision creates both memory and decisions row + decision_create audit', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'use Postgres',
      context: 'scale and JSONB',
    });
    expect(d.id).toBe(1); // the first row in a fresh AUTOINCREMENT table
    expect(d.memoryId).not.toBeNull();
    expect(d.tenantId).toBe('default');
    expect(d.decisionText).toBe('use Postgres');
    expect(d.context).toBe('scale and JSONB');
    expect(d.status).toBe('active');
    expect(d.supersededBy).toBeNull();
    expect(d.supersededAt).toBeNull();
    expect(d.closedAt).toBeNull();

    const db = openHippoDb(home);
    try {
      const memRow = getRowMaybe<{ content: string; tags_json: string; source: string }>(
        db,
        `SELECT content, tags_json, source FROM memories WHERE id = ?`,
        d.memoryId!,
      );
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('use Postgres');
      expect(memRow!.content).toContain('Context: scale and JSONB');
      expect(memRow!.source).toBe('decision');
      expect(parseJson<string[]>(memRow!.tags_json)).toContain('decision');

      const rows = allRows<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'decision_create' AND target_id = ?`,
        String(d.id),
      );
      expect(rows.length).toBe(1);
      const meta = parseJson<{ decision_id: number; has_context: boolean }>(rows[0].metadata_json);
      expect(meta.has_context).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('a supersede that loses its race after the preflight is a ConflictError (409), like the other five save paths', async () => {
    const prior = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'ship on fridays' });
    const db = openHippoDb(home);
    try {
      // The trigger stands in for a concurrent writer: the preflight sees an active row, the UPDATE changes nothing.
      db.exec(`CREATE TRIGGER lose_supersede_race BEFORE UPDATE OF status ON decisions BEGIN SELECT RAISE(IGNORE); END`);
    } finally { closeHippoDb(db); }
    let thrown: unknown;
    try {
      await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'ship on tuesdays', supersedesDecisionId: prior.id });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(mapApiError(thrown).status).toBe(409);
    expect(countRows(home, 'decisions')).toBe(1);
  });

  it('saveDecision without context: bare memory content, has_context false', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'adopt trunk-based dev' });
    expect(d.context).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = getRow<{ content: string }>(db, `SELECT content FROM memories WHERE id = ?`, d.memoryId!);
      expect(memRow.content).toBe('adopt trunk-based dev');
      const rows = allRows<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'decision_create' AND target_id = ?`,
        String(d.id),
      );
      expect(parseJson<{ has_context: boolean }>(rows[0].metadata_json).has_context).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('loadDecisions status filter; status active excludes non-active', async () => {
    const a = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'active-1' });
    const b = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'to-close' });
    const c = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'to-supersede' });
    await closeDecision(objectsAt(home), 'default', b.id);
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'successor', supersedesDecisionId: c.id });

    const active = await loadDecisions(objectsAt(home), 'default', { status: 'active' });
    expect(active.every((x) => x.status === 'active')).toBe(true);
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);

    const closed = await loadDecisions(objectsAt(home), 'default', { status: 'closed' });
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(b.id);

    const superseded = await loadDecisions(objectsAt(home), 'default', { status: 'superseded' });
    expect(superseded.length).toBe(1);
    expect(superseded[0].id).toBe(c.id);

    const all = await loadDecisions(objectsAt(home), 'default');
    expect(all.length).toBe(4);
  });

  it('resolveActiveDecisionIdByMemory: row id for first-class, null for legacy/superseded', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'first-class' });
    expect(await resolveActiveDecisionIdByMemory(objectsAt(home), 'default', d.memoryId!)).toBe(d.id);

    // A legacy decision-tagged memory with NO decisions row
    const legacy = createMemory('legacy decision memory', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['decision'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
      tenantId: 'default',
    });
    writeEntry(home, legacy);
    expect(await resolveActiveDecisionIdByMemory(objectsAt(home), 'default', legacy.id)).toBeNull();

    // A superseded decision's memory no longer resolves (status != active)
    const sup = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'old' });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { decisionText: 'new', supersedesDecisionId: sup.id });
    expect(await resolveActiveDecisionIdByMemory(objectsAt(home), 'default', sup.memoryId!)).toBeNull();
  });
});
