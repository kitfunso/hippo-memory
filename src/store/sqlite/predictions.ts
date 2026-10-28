// hippo.db's prediction rows: the statements the Objects group runs for the prediction kind.

import { refuseSecretKeys } from '../../base/errors/secret-keys.js';
import { redactSecretsStrict, storedOrNull } from '../../base/util/secret-detect.js';
import { DEFAULT_LIST_LIMIT } from '../../base/util/limits.js';
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { StoreFiles } from './open.js';
import { writeEntryRow } from './entry-writes.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { appendAuditEvents } from './audit.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { keysetAfter } from '../../db/sql.js';
import { type ClosureState, VALID_CLOSURE_STATES } from '../../base/records/prediction.js';
import type {
  Prediction,
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
  SavePredictionOptions,
} from '../../base/ports/store/objects.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { JsonObject } from '../../base/util/json.js';
import { handleStamp } from './handle-clock.js';

// What the store says when a prediction is saved or closed: audit metadata and refusal texts.

const present = (value: number | null | undefined): boolean =>
  value !== undefined && value !== null;

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

/** The refusal for a close that matched no open row: `closureState` is the row's state, or null
 * when none exists. */
function closeMissError(tenantId: string, id: number, closureState: string | null): Error {
  if (closureState === null) {
    return new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  }
  return new BadRequestError(
    `closePrediction: prediction ${id} is already closed (state='${closureState}'); ` +
      'cannot re-close. Open predictions only.',
  );
}

/** First-class prediction: an ex-ante claim closed against an outcome. The `predictions` table
 * is the source of truth; the memory row only mirrors the claim. Every helper requires tenantId;
 * `trg_predictions_tenant_match_*` triggers enforce the prediction's tenant matches the
 * referenced memory's. `savePrediction` writes memory and prediction inside `writeEntry`'s
 * SAVEPOINT (via afterWrite), so a failure in either rolls back both. */

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

// SAFETY: every read cast to this row selects SELECT_COLUMNS; scripts/check-row-casts.mjs proves
// it.
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
    // SAFETY: closure_state is DB-constrained to VALID_CLOSURE_STATES; this module is the only
    // writer and always inserts one of those literals.
    closureState: row.closure_state as ClosureState,
    closedAt: row.closed_at,
    closureNote: row.closure_note,
    createdAt: row.created_at,
  };
}

/** The store port's save on hippo.db: the mirror goes in as the port's writeEntry has it, tenant
 * check included, and its predictions row shares that write scope, so neither lands alone. */
export function writePrediction(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  save: PredictionSave,
): Prediction {
  assertTenantId('savePrediction', tenantId);
  refuseSecretKeys({ classTag: save.classTag });
  const now = handleStamp(db);
  const { actor } = save;

  // Captured for the return value; populated inside afterWrite hook so the INSERT and the memory
  // write share a SAVEPOINT.
  let savedRow: PredictionRow | undefined;

  writeEntryRow(db, files, { entry: save.mirror, actor }, (writeDb, memoryId) => {
    savedRow = insertPredictionRow(writeDb, {
      memoryId,
      tenantId,
      opts: save,
      stamp: { now, actor },
    });
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

interface InsertPredictionRowOptions {
  readonly memoryId: string;
  readonly tenantId: string;
  readonly opts: SavePredictionOptions;
  readonly stamp: PredictionStamp;
}

function insertPredictionRow(
  db: DatabaseSyncLike,
  { memoryId, tenantId, opts, stamp }: InsertPredictionRowOptions,
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
    redactSecretsStrict(opts.claimText),
    opts.estimateValue ?? null,
    storedOrNull(opts.estimateUnit),
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

/** Close an open prediction. Updates the predictions row only; the memory mirror is not mutated
 * (the predictions table is the source of truth). Accuracy is computed from (estimateValue,
 * actualValue) at query time. */
export function closePrediction(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: PredictionClose,
): Prediction {
  assertTenantId('closePrediction', tenantId);
  if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
    throw new BadRequestError(
      `closePrediction: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ` +
        `${opts.closureState}`,
    );
  }
  const now = handleStamp(db);
  const row = withWriteScope(db, 'close_prediction', () =>
    closeOpenPredictionRow(db, { tenantId, id, opts, stamp: { now, actor: opts.actor } }),
  );
  return rowToPrediction(row);
}

interface CloseOpenPredictionRowOptions {
  readonly tenantId: string;
  readonly id: number;
  readonly opts: PredictionClose;
  readonly stamp: PredictionStamp;
}

/** Closes the row, reloads it and audits the close; the caller owns the transaction. */
function closeOpenPredictionRow(
  db: DatabaseSyncLike,
  { tenantId, id, opts, stamp }: CloseOpenPredictionRowOptions,
): PredictionRow {
  const { now, actor } = stamp;
  // closure_state='open' in the WHERE stops a retried close from overwriting actual_value and
  // auditing twice; zero changed rows means not found or already closed.
  const updateResult = cachedStatement(
    db,
    `
        UPDATE predictions
        SET actual_value = ?, closure_state = ?, closed_at = ?, closure_note = ?
        WHERE id = ? AND tenant_id = ? AND closure_state = 'open'
      `,
  ).run(
    opts.actualValue ?? null,
    opts.closureState,
    now,
    storedOrNull(opts.closureNote),
    id,
    tenantId,
  );

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

export function readPrediction(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
): Prediction | null {
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

/** Every prediction in the tenant, open and closed, across all classes: the `status=all` list
 * without a class. */
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

/** One page of the tenant's predictions: the open ones, every one, or one class's, as the query
 * names. */
export function listPredictions(
  db: DatabaseSyncLike,
  tenantId: string,
  { classTag, closureState, limit, after }: PredictionListQuery,
): Prediction[] {
  if (closureState === 'open') return listOpenPredictions(db, tenantId, { classTag, limit, after });
  if (classTag === undefined) return listAllPredictions(db, tenantId, { limit, after });
  return listPredictionsByClass(db, tenantId, classTag, { closureState, limit, after });
}
