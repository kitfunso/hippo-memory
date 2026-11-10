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
 * 6. a superseding saveDecision weakens the replaced memory in the same write and halves its half-life once,
 *    however often it is weakened; a named memory that is missing or another tenant's refuses the whole save
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  loadDecisions,
  resolveActiveDecisionIdByMemory,
  type SaveDecisionOptions,
  DECISION,
} from '../../src/domain/objects/decisions.js';
import { ConflictError, NotFoundError } from '../../src/base/errors/api-errors.js';
import { mapApiError } from '../../src/api/error-reply.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/host/config-file.js';
import { closeObject } from '../../src/domain/objects/lifecycle.js';
import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import { saveDecision } from '../../src/entry/testing.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, readEntry, objectsAt } = sessionPerTest();

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
  } finally {
    closeHippoDb(db);
  }
}

describe('decisions store (first-class object)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('decisions');
  });

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
      expect(memRow?.content).toContain('use Postgres');
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
    const prior = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'ship on fridays',
    });
    const db = openHippoDb(home);
    try {
      // The trigger stands in for a concurrent writer: the preflight sees an active row, the UPDATE changes nothing.
      db.exec(
        `CREATE TRIGGER lose_supersede_race BEFORE UPDATE OF status ON decisions BEGIN SELECT RAISE(IGNORE); END`,
      );
    } finally {
      closeHippoDb(db);
    }
    let thrown: unknown;
    try {
      await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        decisionText: 'ship on tuesdays',
        supersedesDecisionId: prior.id,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(mapApiError(thrown).status).toBe(409);
    expect(countRows(home, 'decisions')).toBe(1);
  });

  it('saveDecision without context: bare memory content, has_context false', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'adopt trunk-based dev',
    });
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
    const a = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'active-1',
    });
    const b = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'to-close',
    });
    const c = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'to-supersede',
    });
    await closeObject(objectsAt(home), DECISION, { tenantId: 'default', id: b.id, actor: CLI_ACTOR, now: evalNow() });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'successor',
      supersedesDecisionId: c.id,
    });

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
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'first-class',
    });
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
    const sup = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'old',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      decisionText: 'new',
      supersedesDecisionId: sup.id,
    });
    expect(await resolveActiveDecisionIdByMemory(objectsAt(home), 'default', sup.memoryId!)).toBeNull();
  });

  const save = (opts: SaveDecisionOptions, tenantId = 'default') =>
    saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenantId, opts);
  const plainMemory = (tags: string[], tenantId = 'default') =>
    createMemory('use Postgres', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags,
      confidence: 'verified',
      source: 'decision',
      tenantId,
    });
  const lastAuditId = () => {
    const db = openHippoDb(home);
    try {
      return getRow<{ id: number }>(db, 'SELECT MAX(id) AS id FROM audit_log').id;
    } finally {
      closeHippoDb(db);
    }
  };
  const counts = () => ['decisions', 'memories', 'audit_log'].map((table) => countRows(home, table));

  it('a superseding save weakens the replaced memory once, and weakening it again halves nothing more', async () => {
    const first = await save({ decisionText: 'use Postgres' });
    const before = readEntry(home, first.memoryId!)!;

    await save({ decisionText: 'use SQLite', supersedesDecisionId: first.id });
    const weakened = readEntry(home, first.memoryId!)!;
    await save({ decisionText: 'use DuckDB', weakensMemoryId: first.memoryId! });
    const again = readEntry(home, first.memoryId!)!;

    expect(weakened.halfLifeDays).toBe(Math.floor(before.halfLifeDays / 2));
    expect(again.halfLifeDays).toBe(weakened.halfLifeDays);
    expect(again.confidence).toBe('stale');
    expect(again.tags.filter((tag) => tag === 'superseded')).toHaveLength(1);
  });

  it('a fresh verified memory that already carries the superseded tag is halved once when a save names it', async () => {
    const copied = plainMemory(['decision', 'superseded']);
    writeEntry(home, copied);

    await save({ decisionText: 'use SQLite', weakensMemoryId: copied.id });
    const weakened = readEntry(home, copied.id)!;

    expect(weakened.halfLifeDays).toBe(Math.floor(copied.halfLifeDays / 2));
    expect(weakened.confidence).toBe('stale');
    expect(weakened.tags.filter((tag) => tag === 'superseded')).toHaveLength(1);
  });

  it('a named memory is weakened in the save, its remember row after the new mirror remember row', async () => {
    const old = plainMemory(['billing']);
    writeEntry(home, old);
    const mark = lastAuditId();

    const saved = await save({ decisionText: 'use SQLite', weakensMemoryId: old.id });

    const db = openHippoDb(home);
    try {
      const rows = allRows<{ op: string; target_id: string }>(
        db,
        `SELECT op, target_id FROM audit_log WHERE id > ? ORDER BY id`,
        mark,
      );
      expect(rows).toEqual([
        { op: 'decision_create', target_id: String(saved.id) },
        { op: 'remember', target_id: saved.memoryId },
        { op: 'remember', target_id: old.id },
      ]);
    } finally {
      closeHippoDb(db);
    }
    expect(readEntry(home, old.id)).toMatchObject({ confidence: 'stale', tags: ['billing', 'superseded'] });
  });

  it('a decision whose mirror memory was deleted still supersedes, and the memory stays gone', async () => {
    const first = await save({ decisionText: 'use Postgres' });
    expect(deleteEntry(home, first.memoryId!)).toBe(true);

    const second = await save({ decisionText: 'use SQLite', supersedesDecisionId: first.id });

    expect(second.status).toBe('active');
    expect(countRows(home, 'memories')).toBe(1);
    expect((await loadDecisions(objectsAt(home), 'default', { status: 'superseded' })).map((d) => d.id)).toEqual([
      first.id,
    ]);
  });

  it('a decision with no mirror memory id still supersedes and weakens nothing', async () => {
    const first = await save({ decisionText: 'use Postgres' });
    const before = readEntry(home, first.memoryId!)!;
    const db = openHippoDb(home);
    try {
      db.prepare('UPDATE decisions SET memory_id = NULL WHERE id = ?').run(first.id);
    } finally {
      closeHippoDb(db);
    }

    await save({ decisionText: 'use SQLite', supersedesDecisionId: first.id });

    expect(readEntry(home, first.memoryId!)).toMatchObject({
      confidence: before.confidence,
      halfLifeDays: before.halfLifeDays,
      tags: before.tags,
    });
    expect((await loadDecisions(objectsAt(home), 'default', { status: 'superseded' })).map((d) => d.id)).toEqual([
      first.id,
    ]);
  });

  it('a named memory that does not exist refuses the whole save and writes nothing', async () => {
    const first = await save({ decisionText: 'use Postgres' });
    const before = counts();

    const refused = save({ decisionText: 'use SQLite', supersedesDecisionId: first.id, weakensMemoryId: 'mem_absent' });

    await expect(refused).rejects.toThrow(new NotFoundError('memory not found: mem_absent'));
    expect(counts()).toEqual(before);
    expect((await loadDecisions(objectsAt(home), 'default', { status: 'active' })).map((d) => d.id)).toEqual([
      first.id,
    ]);
  });

  it("another tenant's memory named by a save refuses it and is left as it was", async () => {
    const foreign = plainMemory(['decision'], 'other-tenant');
    writeEntry(home, foreign);
    const before = counts();

    const refused = save({ decisionText: 'use SQLite', weakensMemoryId: foreign.id });

    await expect(refused).rejects.toThrow(new NotFoundError(`memory not found: ${foreign.id}`));
    expect(counts()).toEqual(before);
    expect(readEntry(home, foreign.id)).toMatchObject({ confidence: 'verified', halfLifeDays: foreign.halfLifeDays });
  });
});
