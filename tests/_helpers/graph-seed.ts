// Seeds one graph row on its own connection, for tests that are not inside a rebuild transaction.
import type { InsertEntityOpts, InsertRelationOpts, Entity, Relation } from '../../src/store/graph-rows.js';
import { insertEntityRow, insertRelationRow } from '../../src/store/graph-writes.js';
import { onHandle } from '../../src/store/open.js';

export function insertEntityAt(hippoRoot: string, tenantId: string, opts: InsertEntityOpts): Entity {
  return onHandle(hippoRoot, (db) => insertEntityRow(db, tenantId, opts));
}

export function insertRelationAt(hippoRoot: string, tenantId: string, opts: InsertRelationOpts): Relation {
  return onHandle(hippoRoot, (db) => insertRelationRow(db, tenantId, opts));
}
