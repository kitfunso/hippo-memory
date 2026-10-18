// Seeds one graph row on its own connection, for tests that are not inside a rebuild transaction.
import type { InsertEntityOptions, InsertRelationOptions } from '../../src/store/graph-rows.js';
import type { Entity, Relation } from '../../src/store/port/graph-reads.js';
import { insertEntityRow, insertRelationRow } from '../../src/store/graph-writes.js';
import { onHandle } from '../../src/store/open.js';

export function insertEntityAt(hippoRoot: string, tenantId: string, opts: InsertEntityOptions): Entity {
  return onHandle(hippoRoot, (db) => insertEntityRow(db, tenantId, opts));
}

export function insertRelationAt(hippoRoot: string, tenantId: string, opts: InsertRelationOptions): Relation {
  return onHandle(hippoRoot, (db) => insertRelationRow(db, tenantId, opts));
}
