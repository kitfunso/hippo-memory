// hippo.db's prediction rows: the statements the Objects group runs for the prediction kind.
import { DEFAULT_LIST_LIMIT } from '../../../base/util/limits.js';
import { median } from '../../../base/util/stats.js';
import { BadRequestError, NotFoundError } from '../../../base/errors/api-errors.js';
import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { StoreFiles } from '../runtime/open.js';
import { writeEntryRow } from '../entries/entry-writes.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import { appendAuditEvents } from '../audit/audit.js';
import type { KeysetPosition } from '../../../base/util/keyset.js';
import { keysetAfter } from '../../../db/sql.js';
import { type ClosureState, VALID_CLOSURE_STATES } from '../../../base/records/prediction.js';
import { CLI_ACTOR } from '../../../base/scope/actor.js';
import type { PredictionBaserate } from '../../../base/ports/store/types.js';
import type {
  Prediction,
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
  SavePredictionOptions,
} from '../../../base/ports/store/objects.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { JsonObject } from '../../../base/util/json.js';
import { plural } from '../../../base/util/format.js';
import { handleStamp } from '../runtime/handle-clock.js';

// What the store says when a prediction is saved, closed or summed: audit metadata, refusal texts, baserate.

const present = (value: number | null | undefined): boolean => value !== undefined && value !== null;

/** The predict_create row's metadata: ids and flags, never the claim text. */
const predictionCreateMetadata = (
  predictionId: number,
  input: {
    readonly classTag: string;
    readonly estimateValue?: number | null;
    readonly targetDate?: string | null;
  },
): JsonObject => ({
  prediction_id: predictionId,
  class_tag: input.classTag,
  has_estimate: present(input.estimateValue),
  target_date: input.targetDate ?? null,
});

/** The predict_close row's metadata; a null actual counts as none, as the stored column does. */
const predictionCloseMetadata = (
  predictionId: number,
  close: {
    readonly closureState: string;
    readonly actualValue?: number | null;
  },
): JsonObject => ({
  prediction_id: predictionId,
  closure_state: close.closureState,
  has_actual: present(close.actualValue),
});

/** The refusal for a close that matched no open row: `closureState` is the row's state, or null when none exists. */
function closeMissError(tenantId: string, id: number, closureState: string | null): Error {
  if (closureState === null) {
    return new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  }
  return new BadRequestError(
    `closePrediction: prediction ${id} is already closed (state='${closureState}'); ` +
      'cannot re-close. Open predictions only.',
  );
}

/** One closed prediction as the baserate reads it: both values set. */
interface ClosedEstimate {
  readonly estimate: number;
  readonly actual: number;
}

function emptyBaserate(classTag: string): PredictionBaserate {
  const nulls = { meanEstimate: null, meanActual: null, meanRatio: null, p50Ratio: null, mae: null };
  return { classTag, nClosed: 0, nRatioEligible: 0, summary: '', ...nulls };
}

/** A class's stats over its closed rows, summed in the order given. Every store computes them here, so no two can
 * disagree on the arithmetic. */
function predictionBaserateOf(classTag: string, rows: readonly ClosedEstimate[]): PredictionBaserate {
  const nClosed = rows.length;
  if (nClosed === 0) return emptyBaserate(classTag);
  const ratios = rows.filter((r) => r.estimate > 0).map((r) => r.actual / r.estimate);
  const nRatioEligible = ratios.length;
  const mae = rows.reduce((s, r) => s + Math.abs(r.actual - r.estimate), 0) / nClosed;
  const meanRatio = nRatioEligible > 0 ? ratios.reduce((s, x) => s + x, 0) / nRatioEligible : null;
  const ratioPart =
    meanRatio !== null ? `averaged ${meanRatio.toFixed(2)}x actual` : 'no ratio-eligible rows (all estimates were 0)';
  return {
    classTag,
    nClosed,
    nRatioEligible,
    meanEstimate: rows.reduce((s, r) => s + r.estimate, 0) / nClosed,
    meanActual: rows.reduce((s, r) => s + r.actual, 0) / nClosed,
    meanRatio,
    p50Ratio: nRatioEligible > 0 ? median(ratios) : null,
    mae,
    summary: `Last ${plural(nClosed, 'estimate')} in class ${classTag} ${ratioPart} (MAE ${mae.toFixed(2)}).`,
  };
}

/** First-class prediction: an ex-ante claim closed against an outcome. The `predictions` table is the source of truth;
 * the memory row only mirrors the claim. Every helper requires tenantId; `trg_predictions_tenant_match_*` triggers
 * enforce the prediction's tenant matches the referenced memory's. `savePrediction` writes memory and prediction inside
 * `writeEntry`'s SAVEPOINT (via afterWrite), so a failure in either rolls back both. */

const DEFAULT_PREDICTION_PAGE_SIZE = DEFAULT_LIST_LIMIT;

const SELECT_COLUMNS = `id, memory_id, tenant_id, class_tag, claim_text,
  estimate_value, estimate_unit, target_date,
  actual_value, closure_state, closed_at, closure_note, created_at`;

interface ListPredictionsOptions {
  closureState?: ClosureState;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

// SAFETY: every read cast to this row selects SELECT_COLUMNS; scripts/checks/check-row-casts.mjs proves it.
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
export function writePrediction(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  save: PredictionSave,
): Prediction {
  assertTenantId('savePrediction', tenantId);
  const now = handleStamp(db);
  const { actor } = save;

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
      metadata: predictionCreateMetadata(who.predictionId, opts),
    },
  ]);
}

/** Close an open prediction. Updates the predictions row only; the memory mirror is not mutated (the predictions table
 * is the source of truth). Accuracy is computed from (estimateValue, actualValue) at query time. */
export function closePrediction(db: DatabaseSyncLike, tenantId: string, id: number, opts: PredictionClose): Prediction {
  assertTenantId('closePrediction', tenantId);
  if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
    throw new BadRequestError(
      `closePrediction: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ` +
        `${opts.closureState}`,
    );
  }
  const now = handleStamp(db);
  const row = withWriteScope(db, 'close_prediction', () =>
    closeOpenPredictionRow(db, tenantId, id, opts, { now, actor: opts.actor }),
  );
  return rowToPrediction(row);
}

/** Closes the row, reloads it and audits the close; the caller owns the transaction. */
function closeOpenPredictionRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: PredictionClose,
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
      metadata: predictionCloseMetadata(id, opts),
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
  throw closeMissError(tenantId, id, existing?.closure_state ?? null);
}

export function readPrediction(db: DatabaseSyncLike, tenantId: string, id: number): Prediction | null {
  assertTenantId('readPrediction', tenantId);
  const row = cachedStatement(
    db,
    `
    SELECT ${SELECT_COLUMNS}
    FROM predictions WHERE id = ? AND tenant_id = ?
  `,
  ).get(id, tenantId) as PredictionRow | undefined;
  return row ? rowToPrediction(row) : null;
}

function listPredictionsByClass(
  db: DatabaseSyncLike,
  tenantId: string,
  classTag: string,
  opts: ListPredictionsOptions = {},
): Prediction[] {
  assertTenantId('listPredictionsByClass', tenantId);
  const limit = opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE;
  const after = keysetAfter('created_at', 'id', opts.after);
  let rows: PredictionRow[];
  if (opts.closureState) {
    if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
      throw new BadRequestError(
        `listPredictionsByClass: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ` +
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
function listAllPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('listAllPredictions', tenantId);
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
// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
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

function listOpenPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('listOpenPredictions', tenantId);
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
export function listPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  { classTag, closureState, limit, after }: PredictionListQuery,
): Prediction[] {
  if (closureState === 'open') return listOpenPredictions(db, tenantId, { classTag, limit, after });
  if (classTag === undefined) return listAllPredictions(db, tenantId, { limit, after });
  return listPredictionsByClass(db, tenantId, classTag, { closureState, limit, after });
}
