// The passes that must not delete an object's memory ask about the rows they hold, never for every linked id.
import { beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { saveDecision } from '../../src/domain/objects/decisions.js';
import { loadConfig } from '../../src/base/config/config.js';
import { iterateRowsWithObjects } from '../../src/store/sqlite/entry-reads.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { makeRoot } from '../_helpers/make-root.js';
import { memoriesBackingAmong, writeEntriesTogether } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

describe('the object backing reads', () => {
  let root: string;
  let backed: string[];
  let plain: string[];

  beforeEach(async () => {
    root = makeRoot('object-backing');
    const days = loadConfig(root).defaultHalfLifeDays;
    const live = await saveDecision(objectsAt(root), days, 'default', { decisionText: 'ship on tuesdays' });
    const old = await saveDecision(objectsAt(root), days, 'default', { decisionText: 'ship on mondays' });
    withDb(root, (db) => db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?").run(old.id));
    backed = [live.memoryId!, old.memoryId!];
    const notes = Array.from({ length: 3 }, (_, i) => createMemory(`plain note ${i}`));
    writeEntriesTogether(root, notes);
    plain = notes.map((e) => e.id);
  });

  it('answers only the asked ids that back an object, through each table index', () => {
    expect([...memoriesBackingAmong(root, [...plain, backed[0]])]).toEqual([backed[0]]);
    expect(memoriesBackingAmong(root, plain).size).toBe(0);
    const { statements } = recordStatements(() => memoriesBackingAmong(root, plain));
    const union = statements.find((sql) => sql.includes('UNION'))!;
    // SAFETY: EXPLAIN QUERY PLAN answers id, parent, notused and detail for each step.
    const plan = withDb(root, (db) => db.prepare(`EXPLAIN QUERY PLAN ${union}`).all() as Array<{ detail: string }>);
    expect(plan.map((p) => p.detail).filter((d) => /^SCAN (decisions|incidents|skills|predictions)\b/.test(d))).toEqual(
      [],
    );
  });

  it('flags each row of the half-life cursor with the object it backs, reading no object row', () => {
    const { result, reads } = recordStatements(() =>
      withDb(root, (db) => [...iterateRowsWithObjects(db)].map((r) => [r.entry.id, r.object] as const)),
    );
    const flags = new Map(result);
    expect([flags.get(backed[0]), flags.get(backed[1]), ...plain.map((id) => flags.get(id))]).toEqual([
      'live',
      'retired',
      null,
      null,
      null,
    ]);
    expect(reads.filter((r) => /FROM (decisions|incidents)\b/.test(r.sql) && !r.sql.includes('EXISTS'))).toEqual([]);
  });
});
