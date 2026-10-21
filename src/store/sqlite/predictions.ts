// hippo.db's Predictions group: the queries the CLI and the MCP tools run.
import { DEFAULT_LIST_LIMIT } from '../../base/util/limits.js';
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { StoreFiles, OnHandle } from './open.js';
import { writeEntryRow } from './entry-writes.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { appendAuditEvents } from './audit.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { keysetAfter } from '../../db/sql.js';
import type { PredictionSave, Predictions } from '../port.js';
import type { Sync } from './served.js';
import { type ClosureState, VALID_CLOSURE_STATES } from '../../base/records/prediction.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { PredictionBaserate } from '../port/types.js';
import {
  predictionBaserateOf,
  type Prediction,
  type PredictionListQuery,
  type SavePredictionOptions,
} from '../port/objects.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** First-class prediction: an ex-ante claim closed against an outcome. The `predictions` table is the source of truth;
 * the memory row only mirrors the claim. Every helper requires tenantId; `trg_predictions_tenant_match_*` triggers
 * enforce the prediction's tenant matches the referenced memory's. `savePrediction` writes memory and prediction inside
 * `writeEntry`'s SAVEPOINT (via afterWrite), so a failure in either rolls back both. */

const DEFAULT_PREDICTION_PAGE_SIZE = DEFAULT_LIST_LIMIT;

const SELECT_COLUMNS = `id, memory_id, tenant_id, class_tag, claim_text,
  estimate_value, estimate_unit, target_date,
  actual_value, closure_state, closed_at, closure_note, created_at`;

interface ClosePredictionOptions {
  closureState: ClosureState;
  actualValue?: number;
  closureNote?: string;
}

interface ListPredictionsOptions {
  closureState?: ClosureState;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

// SAFETY: every read cast to this row selects SELECT_COLUMNS; scripts/check-row-casts.mjs proves it.
interface PredictionRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  class_tag: string;
  claim_text: string;
  estimate_value: number | null;
  estimate_unit: string | null;
  target_date: string | null;
  actual_value: number | null;
  closure_state: string;
  closed_at: string | null;
  closure_note: string | null;
  created_at: string;
}

function rowToPrediction(row: PredictionRow): Prediction {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    classTag: row.class_tag,
    claimText: row.claim_text,
    estimateValue: row.estimate_value,
    estimateUnit: row.estimate_unit,
    targetDate: row.target_date,
    actualValue: row.actual_value,
    // SAFETY: closure_state is DB-constrained to VALID_CLOSURE_STATES; this module is the only writer and always
    // inserts one of those literals.
    closureState: row.closure_state as ClosureState,
    closedAt: row.closed_at,
    closureNote: row.closure_note,
    createdAt: row.created_at,
  };
}

/** The store port's save on hippo.db: the mirror goes in as the port's writeEntry has it, tenant check included, and
 * its predictions row shares that write scope, so neither lands alone. */
function writePrediction(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  save: PredictionSave,
  actor: string,
): Prediction {
  assertTenantId('savePrediction', tenantId);
  const now = new Date().toISOString();

  // Captured for the return value; populated inside afterWrite hook so the INSERT and the memory write share a
  // SAVEPOINT.
  let savedRow: PredictionRow | undefined;

  writeEntryRow(db, files, { entry: save.mirror, actor }, (writeDb, memoryId) => {
    savedRow = insertPredictionRow(writeDb, memoryId, tenantId, save, { now, actor });
  });

  if (!savedRow) {
    // Cannot reach here without the afterWrite throwing first; defensive.
    throw new Error('savePrediction: afterWrite did not populate the row');
  }
  return rowToPrediction(savedRow);
}

/** Inserts, reloads and audits the predictions row inside writeEntry's SAVEPOINT. */
interface PredictionStamp {
  readonly now: string;
  readonly actor: string;
}

function insertPredictionRow(
  db: DatabaseSyncLike,
  memoryId: string,
  tenantId: string,
  opts: SavePredictionOptions,
  stamp: PredictionStamp,
): PredictionRow {
  const { now, actor } = stamp;
  const result = cachedStatement(
    db,
    `
        INSERT INTO predictions(
          memory_id, tenant_id, class_tag, claim_text,
          estimate_value, estimate_unit, target_date,
          actual_value, closure_state, closed_at, closure_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)
      `,
  ).run(
    memoryId,
    tenantId,
    opts.classTag,
    opts.claimText,
    opts.estimateValue ?? null,
    opts.estimateUnit ?? null,
    opts.targetDate ?? null,
    null, // actual_value — null until close
    now,
  );

  const predictionId = Number(result.lastInsertRowid ?? 0);
  const row = cachedStatement(
    db,
    `
        SELECT ${SELECT_COLUMNS}
        FROM predictions WHERE id = ?
      `,
  ).get(predictionId) as PredictionRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved prediction row');
  }

  auditPredictionCreate(db, { tenantId, actor, predictionId }, opts);
  return row;
}

function auditPredictionCreate(
  db: DatabaseSyncLike,
  who: { tenantId: string; actor: string; predictionId: number },
  opts: SavePredictionOptions,
): void {
  // GDPR-light audit metadata: prediction_id + class_tag + flags only.
  // No claim_text in metadata; the predictions table holds it canonically.
  appendAuditEvents(db, [
    {
      tenantId: who.tenantId,
      actor: who.actor,
      op: 'predict_create',
      targetId: String(who.predictionId),
      metadata: {
        prediction_id: who.predictionId,
        class_tag: opts.classTag,
        has_estimate: opts.estimateValue !== undefined && opts.estimateValue !== null,
        target_date: opts.targetDate ?? null,
      },
    },
  ]);
}

/** Close an open prediction. Updates the predictions row only; the memory mirror is not mutated (the predictions table
 * is the source of truth). Accuracy is computed from (estimateValue, actualValue) at query time. */
function closePrediction(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: ClosePredictionOptions,
  actor: string = CLI_ACTOR,
): Prediction {
  assertTenantId('closePrediction', tenantId);
  if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
    throw new BadRequestError(
      `closePrediction: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ` +
        `${opts.closureState}`,
    );
  }
  const now = new Date().toISOString();
  const row = withWriteScope(db, 'close_prediction', () =>
    closeOpenPredictionRow(db, tenantId, id, opts, { now, actor }),
  );
  return rowToPrediction(row);
}

/** Closes the row, reloads it and audits the close; the caller owns the transaction. */
function closeOpenPredictionRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: ClosePredictionOptions,
  stamp: PredictionStamp,
): PredictionRow {
  const { now, actor } = stamp;
  // closure_state='open' in the WHERE stops a retried close from overwriting actual_value and auditing twice; zero
  // changed rows means not found or already closed.
  const updateResult = cachedStatement(
    db,
    `
        UPDATE predictions
        SET actual_value = ?, closure_state = ?, closed_at = ?, closure_note = ?
        WHERE id = ? AND tenant_id = ? AND closure_state = 'open'
      `,
  ).run(opts.actualValue ?? null, opts.closureState, now, opts.closureNote ?? null, id, tenantId);

  if (updateResult.changes === 0) throwCloseMiss(db, tenantId, id);

  const row = cachedStatement(
    db,
    `
        SELECT ${SELECT_COLUMNS}
        FROM predictions WHERE id = ? AND tenant_id = ?
      `,
  ).get(id, tenantId) as PredictionRow | undefined;

  if (!row) {
    throw new NotFoundError(`closePrediction: prediction ${id} not found after UPDATE`);
  }

  appendAuditEvents(db, [
    {
      tenantId,
      actor,
      op: 'predict_close',
      targetId: String(id),
      metadata: {
        prediction_id: id,
        closure_state: opts.closureState,
        has_actual: opts.actualValue !== undefined && opts.actualValue !== null,
      },
    },
  ]);
  return row;
}

function throwCloseMiss(db: DatabaseSyncLike, tenantId: string, id: number): never {
  // Distinguish 'not found' from 'already closed' so callers (CLI, HTTP) surface the right error.
  const existing = cachedStatement(
    db,
    `
          SELECT closure_state FROM predictions WHERE id = ? AND tenant_id = ?
        `,
  ).get(id, tenantId) as { closure_state: string } | undefined;
  if (!existing) {
    throw new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  }
  throw new BadRequestError(
    `closePrediction: prediction ${id} is already closed (state='${existing.closure_state}'); ` +
      `cannot re-close. Open predictions only.`,
  );
}

function loadPredictionById(db: DatabaseSyncLike, tenantId: string, id: number): Prediction | null {
  assertTenantId('loadPredictionById', tenantId);
  const row = cachedStatement(
    db,
    `
    SELECT ${SELECT_COLUMNS}
    FROM predictions WHERE id = ? AND tenant_id = ?
  `,
  ).get(id, tenantId) as PredictionRow | undefined;
  return row ? rowToPrediction(row) : null;
}

function loadPredictionsByClass(
  db: DatabaseSyncLike,
  tenantId: string,
  classTag: string,
  opts: ListPredictionsOptions = {},
): Prediction[] {
  assertTenantId('loadPredictionsByClass', tenantId);
  const limit = opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE;
  const after = keysetAfter('created_at', 'id', opts.after);
  let rows: PredictionRow[];
  if (opts.closureState) {
    if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
      throw new BadRequestError(
        `loadPredictionsByClass: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ` +
          `${opts.closureState}`,
      );
    }
    rows = cachedStatement(
      db,
      `
      SELECT ${SELECT_COLUMNS}
      FROM predictions
      WHERE tenant_id = ? AND class_tag = ? AND closure_state = ?${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    ).all(tenantId, classTag, opts.closureState, ...after.params, limit) as PredictionRow[];
  } else {
    rows = cachedStatement(
      db,
      `
      SELECT ${SELECT_COLUMNS}
      FROM predictions
      WHERE tenant_id = ? AND class_tag = ?${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    ).all(tenantId, classTag, ...after.params, limit) as PredictionRow[];
  }
  return rows.map(rowToPrediction);
}

/** Every prediction in the tenant, open and closed, across all classes: the `status=all` list without a class. */
function loadAllPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('loadAllPredictions', tenantId);
  const after = keysetAfter('created_at', 'id', opts.after);
  const rows = cachedStatement(
    db,
    `
    SELECT ${SELECT_COLUMNS}
    FROM predictions
    WHERE tenant_id = ?${after.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(tenantId, ...after.params, opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE) as PredictionRow[];
  return rows.map(rowToPrediction);
}

/** One closed prediction as the baserate reads it: both values set. */
// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface BaserateRow {
  estimate_value: number;
  actual_value: number;
}

/** Base-rate stats for closed predictions in a class (Lovallo-Kahneman inside-vs-outside view): closure_state='closed'
 * with estimate and actual non-null; closed-unknown and open are excluded. Audit-emit is built in here, not at the 3
 * call sites, so callers cannot drift. */
export function computePredictionBaserate(
  db: DatabaseSyncLike,
  tenantId: string,
  classTag: string,
  actor: string = CLI_ACTOR,
  /** False skips the predict_baserate audit so that channel only records deliberate baserate calls, not every recall
   *  the planning-fallacy orchestrator inspects. */
  emitAudit: boolean = true,
): PredictionBaserate {
  assertTenantId('computePredictionBaserate', tenantId);
  if (!classTag) throw new BadRequestError('computePredictionBaserate: classTag is required');
  // Ordered by id because the float sums differ with row order, and another store must reach the same figures.
  const rows = cachedStatement(
    db,
    `
    SELECT estimate_value, actual_value
    FROM predictions
    WHERE tenant_id = ?
      AND class_tag = ?
      AND closure_state = 'closed'
      AND estimate_value IS NOT NULL
      AND actual_value IS NOT NULL
    ORDER BY id
  `,
  ).all(tenantId, classTag) as BaserateRow[];

  const baserate = predictionBaserateOf(
    classTag,
    rows.map((r) => ({ estimate: r.estimate_value, actual: r.actual_value })),
  );
  // An empty class is audited too, since an agent probing one is a signal; the recall path passes false and audits its
  // own hint.
  if (emitAudit) auditBaserateRead(db, tenantId, actor, classTag, baserate.nClosed);
  return baserate;
}

function auditBaserateRead(
  db: DatabaseSyncLike,
  tenantId: string,
  actor: string,
  classTag: string,
  nClosed: number,
): void {
  appendAuditEvents(db, [
    {
      tenantId,
      actor,
      op: 'predict_baserate',
      targetId: classTag,
      metadata: { class_tag: classTag, n_closed: nClosed },
    },
  ]);
}

function loadOpenPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('loadOpenPredictions', tenantId);
  const limit = opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE;
  const after = keysetAfter('created_at', 'id', opts.after);
  let rows: PredictionRow[];
  if (opts.classTag) {
    rows = cachedStatement(
      db,
      `
      SELECT ${SELECT_COLUMNS}
      FROM predictions
      WHERE tenant_id = ? AND class_tag = ? AND closure_state = 'open'${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    ).all(tenantId, opts.classTag, ...after.params, limit) as PredictionRow[];
  } else {
    rows = cachedStatement(
      db,
      `
      SELECT ${SELECT_COLUMNS}
      FROM predictions
      WHERE tenant_id = ? AND closure_state = 'open'${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    ).all(tenantId, ...after.params, limit) as PredictionRow[];
  }
  return rows.map(rowToPrediction);
}

/** One page of the tenant's predictions: the open ones, every one, or one class's, as the query names. */
function listPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  { classTag, closureState, limit, after }: PredictionListQuery,
): Prediction[] {
  if (closureState === 'open') return loadOpenPredictions(db, tenantId, { classTag, limit, after });
  if (classTag === undefined) return loadAllPredictions(db, tenantId, { limit, after });
  return loadPredictionsByClass(db, tenantId, classTag, { closureState, limit, after });
}

const predictionsBodies: Bodies<Omit<Predictions, 'savePrediction'>> = {
  closePrediction: closePrediction,
  predictionById: loadPredictionById,
  listPredictions: listPredictions,
  predictionBaserate: computePredictionBaserate,
};

// The save writes the prediction's mirror, so it alone opens the store with its mirror folders.
const predictionSaveBodies: FileBodies<Pick<Predictions, 'savePrediction'>> = { savePrediction: writePrediction };

export function sqlitePredictions(on: OnHandle): Sync<Predictions> {
  return { ...bound(on, predictionsBodies), ...boundWithFiles(on, predictionSaveBodies, openStore) };
}
