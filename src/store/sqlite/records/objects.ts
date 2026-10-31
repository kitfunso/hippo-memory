// hippo.db's half of the Objects store group: the binding and the reads of the typed objects and predictions.

import { type DatabaseSyncLike } from '../../../db/index.js';
import { escapeLike } from '../../../base/util/escape.js';
import { keysetAfter } from '../../../db/sql.js';
import { scopeAdmitSql } from '../runtime/rule-sql.js';
import {
  type BriefReceipt,
  type ObjectByKind,
  type ObjectKind,
  type Policy,
  type Skill,
} from '../../../base/records/object-types.js';
import type { Handles } from '../runtime/open.js';
import { answered, bound, type Bodies } from '../runtime/bound.js';
import type {
  ObjectCalls,
  ObjectListArgs,
  ObjectListQuery,
  Objects,
  PoliciesInForceQuery,
  SkillsByNameQuery,
} from '../../../base/records/objects.js';
import { rowSpec, type RowByKind } from './object-rows.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { listPredictions, readPrediction } from '../learning/predictions.js';
import { computePredictionBaserate } from '../learning/prediction-baserate.js';
import { closeAny, saveAny } from './object-writes.js';
import { objectTable, readRow } from './object-rows.js';

export function sqliteObjects({ on, files }: Handles): Objects {
  const objects: ObjectCalls = {
    ...bound(on, objectReadsBodies),
    closeObject: (...args) => answered(() => closeAny(on, ...args)),
    saveObject: (...args) => answered(() => saveAny(on, files, ...args)),
  };
  // SAFETY: each body picks its statement from the kind and the payload's shape, the pairs the
  // port's overloads name, so every overload gets the row its kind declares.
  return objects as Objects;
}

const objectReadsBodies: Bodies<Omit<ObjectCalls, 'closeObject' | 'saveObject'>> = {
  listObjects: listAny,
  objectById: (db, tenantId, kind, id) =>
    kind === 'prediction' ? readPrediction(db, tenantId, id) : rowById(db, tenantId, kind, id),
  briefReceipts,
  predictionBaserate: computePredictionBaserate,
};

function listAny(db: DatabaseSyncLike, ...[tenantId, kind, query]: ObjectListArgs) {
  if (kind === 'prediction') return listPredictions(db, tenantId, query);
  if ('asOf' in query) return policiesInForce(db, tenantId, query);
  if ('byName' in query) return skillsByName(db, tenantId, query);
  return listRows(db, tenantId, kind, query);
}

function rowById<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  id: number,
): ObjectByKind[K] | null {
  const row = readRow(db, kind, tenantId, id);
  return row ? rowSpec(kind).rowTo(row) : null;
}

function listRows<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  query: ObjectListQuery<K>,
): ObjectByKind[K][] {
  const spec = rowSpec(kind);
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.filter && spec.filterColumn) {
    clauses.push(`${spec.filterColumn} = ?`);
    params.push(query.filter);
  }
  if (query.memoryId !== undefined) {
    clauses.push('memory_id = ?');
    params.push(query.memoryId);
  }
  const after = keysetAfter('created_at', 'id', query.after);
  // SAFETY: the SELECT names spec.cols, the columns the kind's row declares, whatever the WHERE
  // clause holds.
  const rows = cachedStatement(
    db,
    `
    SELECT ${spec.cols} FROM ${objectTable(kind)}
    WHERE ${clauses.join(' AND ')}${after.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...params, ...after.params, query.limit) as RowByKind[K][];
  return rows.map((row) => spec.rowTo(row));
}

/**
 * The successor is joined in so a superseded version is kept only while the row that replaced it is
 * not yet in force.
 */
function policiesInForce(
  db: DatabaseSyncLike,
  tenantId: string,
  query: PoliciesInForceQuery,
): Policy[] {
  const { asOf, name } = query;
  const nameClause = name !== undefined ? 'AND p.policy_name = ?' : '';
  const params: Array<string | number> = [tenantId, asOf, asOf, asOf];
  if (name !== undefined) params.push(name);
  const rows = cachedStatement(
    db,
    `
      SELECT p.id, p.memory_id, p.tenant_id, p.policy_name, p.policy_text,
             p.valid_from, p.valid_to, p.version, p.status, p.superseded_by,
             p.superseded_at, p.change_summary, p.closed_at, p.created_at
      FROM policies p
      LEFT JOIN policies s ON s.id = p.superseded_by
      WHERE p.tenant_id = ? AND p.status != 'closed'
        AND p.valid_from <= ? AND (p.valid_to IS NULL OR ? < p.valid_to)
        AND (p.status = 'active' OR (s.id IS NOT NULL AND s.valid_from > ?))
        ${nameClause}
      ORDER BY p.valid_from DESC, p.id DESC
      LIMIT ?
    `,
  ).all(...params, query.limit) as RowByKind['policy'][];
  return rows.map(rowSpec('policy').rowTo);
}

function skillsByName(db: DatabaseSyncLike, tenantId: string, query: SkillsByNameQuery): Skill[] {
  // SAFETY: the SELECT names the skill row's own column list.
  const rows = cachedStatement(
    db,
    `
      SELECT ${rowSpec('skill').cols} FROM skills
      WHERE tenant_id = ? AND status = ?
      ORDER BY skill_name ASC, id ASC
      LIMIT ?
    `,
  ).all(tenantId, query.status, query.limit) as RowByKind['skill'][];
  return rows.map(rowSpec('skill').rowTo);
}

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
type BriefReceiptDbRow = BriefReceipt;

/** The quotes around the tag stop `path:hip` matching a memory tagged `path:hippo`. */
function briefReceipts(
  db: DatabaseSyncLike,
  tenantId: string,
  tag: string,
  limit: number,
): BriefReceipt[] {
  const admit = scopeAdmitSql('');
  return cachedStatement(
    db,
    `
      SELECT id, created, source, content FROM memories
      WHERE tenant_id = ?
        AND source != 'project_brief'
        AND LOWER(tags_json) LIKE ? ESCAPE '\\'
        AND ${admit.sql}
      ORDER BY created DESC, id DESC
      LIMIT ?
    `,
  ).all(tenantId, `%"${escapeLike(tag)}"%`, ...admit.params, limit) as BriefReceiptDbRow[];
}
