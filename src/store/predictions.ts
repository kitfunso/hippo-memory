/** First-class prediction: an ex-ante claim closed against an outcome. The `predictions` table is the source of truth; the memory row only mirrors the claim.
 * Every helper requires tenantId; `trg_predictions_tenant_match_*` triggers enforce the prediction's tenant matches the referenced memory's.
 * `savePrediction` writes memory and prediction inside `writeEntry`'s SAVEPOINT (via afterWrite), so a failure in either rolls back both. */

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import { withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { onHandle } from './open.js';
import { writeEntryAt } from './sqlite/entry-writes-group.js';
import { assertTenantId } from './tenant.js';
import { createMemory, Layer, type MemoryEntry, type MemoryKind } from '../core/memory.js';
import { appendAuditEvent } from './audit.js';
import { loadConfig } from '../core/config.js';
import { keysetAfter, type KeysetPosition } from '../util/keyset.js';
import type { PredictionSave } from './port.js';

const DEFAULT_PREDICTION_PAGE_SIZE = 100;

const SELECT_COLUMNS = `id, memory_id, tenant_id, class_tag, claim_text,
  estimate_value, estimate_unit, target_date,
  actual_value, closure_state, closed_at, closure_note, created_at`;

export type ClosureState = 'open' | 'closed' | 'closed-unknown';

export const VALID_CLOSURE_STATES: ReadonlySet<ClosureState> = new Set<ClosureState>([
  'open',
  'closed',
  'closed-unknown',
]);

export interface Prediction {
  id: number;
  /** Nullable: ON DELETE SET NULL allows memory deletion (forget /
   *  consolidate / archive) without breaking the prediction row. */
  memoryId: string | null;
  tenantId: string;
  classTag: string;
  claimText: string;
  estimateValue: number | null;
  estimateUnit: string | null;
  targetDate: string | null;
  actualValue: number | null;
  closureState: ClosureState;
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
}

export interface SavePredictionOpts {
  classTag: string;
  claimText: string;
  estimateValue?: number;
  estimateUnit?: string;
  targetDate?: string;
}

export interface ClosePredictionOpts {
  closureState: ClosureState;
  actualValue?: number;
  closureNote?: string;
}

export interface ListPredictionsOpts {
  closureState?: ClosureState;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

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
    // SAFETY: closure_state is DB-constrained to VALID_CLOSURE_STATES; this
    // module is the only writer and always inserts one of those literals.
    closureState: row.closure_state as ClosureState,
    closedAt: row.closed_at,
    closureNote: row.closure_note,
    createdAt: row.created_at,
  };
}

/** Create a prediction: memory mirror and predictions row land atomically inside `writeEntry`'s SAVEPOINT; any failure rolls back both.
 * The memory (tags `['prediction', classTag]`, kind 'distilled') surfaces in `hippo recall`; the predictions table feeds the planning-fallacy detector. */
export function savePrediction(
  hippoRoot: string,
  tenantId: string,
  opts: SavePredictionOpts,
  actor: string = 'cli',
): Prediction {
  assertTenantId('savePrediction', tenantId);
  if (!opts.classTag) throw new BadRequestError('savePrediction: classTag is required');
  if (!opts.claimText) throw new BadRequestError('savePrediction: claimText is required');

  const mirror = predictionMirror(tenantId, opts, loadConfig(hippoRoot).defaultHalfLifeDays);
  return writePrediction(hippoRoot, tenantId, { ...opts, mirror }, actor);
}

/** The memory row that mirrors a claim into recall, built here alone so every store keeps the same row for it. */
export function predictionMirror(tenantId: string, claim: SavePredictionOpts, baseHalfLifeDays: number): MemoryEntry {
  return createMemory(claim.claimText, {
    tags: ['prediction', claim.classTag],
    layer: Layer.Semantic,
    confidence: 'observed',
    source: 'prediction',
    // SAFETY: 'distilled' is a valid MemoryKind literal (see memory.ts).
    kind: 'distilled' as MemoryKind,
    baseHalfLifeDays,
    tenantId,
  });
}

/** The store port's save on hippo.db: the mirror goes in as the port's writeEntry has it, tenant
 * check included, and its predictions row shares that write scope, so neither lands alone. */
export function writePrediction(hippoRoot: string, tenantId: string, save: PredictionSave, actor: string): Prediction {
  assertTenantId('savePrediction', tenantId);
  const now = new Date().toISOString();

  // Captured for the return value; populated inside afterWrite hook so the
  // INSERT and the memory write share a SAVEPOINT.
  let savedRow: PredictionRow | undefined;

  writeEntryAt(hippoRoot, { entry: save.mirror, actor }, (db, memoryId) => {
    savedRow = insertPredictionRow(db, memoryId, tenantId, save, { now, actor });
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
  opts: SavePredictionOpts,
  stamp: PredictionStamp,
): PredictionRow {
  const { now, actor } = stamp;
  const result = db.prepare(`
        INSERT INTO predictions(
          memory_id, tenant_id, class_tag, claim_text,
          estimate_value, estimate_unit, target_date,
          actual_value, closure_state, closed_at, closure_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)
      `).run(
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
  // SAFETY: row's shape matches the columns named in the SELECT above.
  const row = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions WHERE id = ?
      `).get(predictionId) as PredictionRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved prediction row');
  }

  auditPredictionCreate(db, { tenantId, actor, predictionId }, opts);
  return row;
}

function auditPredictionCreate(
  db: DatabaseSyncLike,
  who: { tenantId: string; actor: string; predictionId: number },
  opts: SavePredictionOpts,
): void {
  // GDPR-light audit metadata: prediction_id + class_tag + flags only.
  // No claim_text in metadata; the predictions table holds it canonically.
  appendAuditEvent(db, {
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
  });
}

/** Close an open prediction. Updates the predictions row only; the memory mirror is not mutated (the predictions table is the source of truth).
 * Accuracy is computed from (estimateValue, actualValue) at query time. */
export function closePrediction(
  hippoRoot: string,
  tenantId: string,
  id: number,
  opts: ClosePredictionOpts,
  actor: string = 'cli',
): Prediction {
  assertTenantId('closePrediction', tenantId);
  if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
    throw new BadRequestError(
      `closePrediction: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ${opts.closureState}`,
    );
  }

  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => {
    const row = withWriteScope(db, 'close_prediction', () => closeOpenPredictionRow(db, tenantId, id, opts, { now, actor }));
    return rowToPrediction(row);
  });
}

/** Closes the row, reloads it and audits the close; the caller owns the transaction. */
function closeOpenPredictionRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: ClosePredictionOpts,
  stamp: PredictionStamp,
): PredictionRow {
  const { now, actor } = stamp;
  // closure_state='open' in the WHERE stops a retried close from overwriting
  // actual_value and auditing twice; zero changed rows means not found or already closed.
  const updateResult = db.prepare(`
        UPDATE predictions
        SET actual_value = ?, closure_state = ?, closed_at = ?, closure_note = ?
        WHERE id = ? AND tenant_id = ? AND closure_state = 'open'
      `).run(
    opts.actualValue ?? null,
    opts.closureState,
    now,
    opts.closureNote ?? null,
    id,
    tenantId,
  );

  if (updateResult.changes === 0) throwCloseMiss(db, tenantId, id);

  // SAFETY: row's shape matches the columns named in the SELECT above.
  const row = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions WHERE id = ? AND tenant_id = ?
      `).get(id, tenantId) as PredictionRow | undefined;

  if (!row) {
    throw new NotFoundError(`closePrediction: prediction ${id} not found after UPDATE`);
  }

  appendAuditEvent(db, {
    tenantId,
    actor,
    op: 'predict_close',
    targetId: String(id),
    metadata: {
      prediction_id: id,
      closure_state: opts.closureState,
      has_actual: opts.actualValue !== undefined && opts.actualValue !== null,
    },
  });
  return row;
}

function throwCloseMiss(db: DatabaseSyncLike, tenantId: string, id: number): never {
  // Distinguish 'not found' from 'already closed' so callers (CLI, HTTP) surface the right error.
  // SAFETY: row shape matches the single `closure_state` column named in the SELECT above.
  const existing = db.prepare(`
          SELECT closure_state FROM predictions WHERE id = ? AND tenant_id = ?
        `).get(id, tenantId) as { closure_state: string } | undefined;
  if (!existing) {
    throw new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  }
  throw new BadRequestError(
    `closePrediction: prediction ${id} is already closed (state='${existing.closure_state}'); ` +
    `cannot re-close. Open predictions only.`,
  );
}

export function loadPredictionById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Prediction | null {
  assertTenantId('loadPredictionById', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: row's shape matches the columns named in the SELECT above.
    const row = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM predictions WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId) as PredictionRow | undefined;
    return row ? rowToPrediction(row) : null;
  });
}

export function loadPredictionsByClass(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  opts: ListPredictionsOpts = {},
): Prediction[] {
  assertTenantId('loadPredictionsByClass', tenantId);
  const limit = opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE;
  const after = keysetAfter('created_at', 'id', opts.after);
  return onHandle(hippoRoot, (db) => {
    let rows: PredictionRow[];
    if (opts.closureState) {
      if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
        throw new BadRequestError(
          `loadPredictionsByClass: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ${opts.closureState}`,
        );
      }
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = ?${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, opts.closureState, ...after.params, limit) as PredictionRow[];
    } else {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ?${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, ...after.params, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  });
}

/** Every prediction in the tenant, open and closed, across all classes: the `status=all` list without a class. */
export function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('loadAllPredictions', tenantId);
  const after = keysetAfter('created_at', 'id', opts.after);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: rows' shape matches the columns named in the SELECT.
    const rows = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM predictions
      WHERE tenant_id = ?${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, ...after.params, opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE) as PredictionRow[];
    return rows.map(rowToPrediction);
  });
}

export interface PredictionBaserate {
  classTag: string;
  /** Count of closed predictions with a numeric actual_value (excludes
   *  open + closed-unknown). The denominator for MAE. */
  nClosed: number;
  /** Count of closed rows where estimate_value > 0 (i.e. ratio is defined).
   *  Subset of nClosed used for meanRatio + p50Ratio. */
  nRatioEligible: number;
  meanEstimate: number | null;
  meanActual: number | null;
  /** mean(actual / estimate) over the nRatioEligible subset. Null when
   *  nRatioEligible = 0 (e.g. all closed predictions had estimate=0). */
  meanRatio: number | null;
  /** Median ratio over the nRatioEligible subset. */
  p50Ratio: number | null;
  /** Mean absolute error = mean(|actual - estimate|) over the nClosed set. */
  mae: number | null;
  /** Human-readable summary string for direct surface in CLI / MCP / HTTP.
   *  Empty when nClosed = 0. */
  summary: string;
}

/** One closed prediction as the baserate reads it: both values set. */
export interface BaserateRow {
  estimate_value: number;
  actual_value: number;
}

/** Base-rate stats for closed predictions in a class (Lovallo-Kahneman inside-vs-outside view): closure_state='closed' with estimate and actual non-null;
 * closed-unknown and open are excluded. Audit-emit is built in here, not at the 3 call sites, so callers cannot drift. */
export function computePredictionBaserate(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  actor: string = 'cli',
  /** False skips the predict_baserate audit so that channel only records deliberate
   *  baserate calls, not every recall the planning-fallacy orchestrator inspects. */
  emitAudit: boolean = true,
): PredictionBaserate {
  assertTenantId('computePredictionBaserate', tenantId);
  if (!classTag) throw new BadRequestError('computePredictionBaserate: classTag is required');

  return onHandle(hippoRoot, (db) => {
    // Ordered by id because the float sums differ with row order, and another store must reach the same figures.
    // SAFETY: rows' shape matches the two columns named in the SELECT above.
    const rows = db.prepare(`
      SELECT estimate_value, actual_value
      FROM predictions
      WHERE tenant_id = ?
        AND class_tag = ?
        AND closure_state = 'closed'
        AND estimate_value IS NOT NULL
        AND actual_value IS NOT NULL
      ORDER BY id
    `).all(tenantId, classTag) as BaserateRow[];

    const baserate = predictionBaserateOf(classTag, rows);
    // An empty class is audited too, since an agent probing one is a signal; the recall path passes false and audits its own hint.
    if (emitAudit) auditBaserateRead(db, tenantId, actor, classTag, baserate.nClosed);
    return baserate;
  });
}

function auditBaserateRead(db: DatabaseSyncLike, tenantId: string, actor: string, classTag: string, nClosed: number): void {
  appendAuditEvent(db, {
    tenantId,
    actor,
    op: 'predict_baserate',
    targetId: classTag,
    metadata: { class_tag: classTag, n_closed: nClosed },
  });
}

/** A class's stats over its closed rows, summed in the order given. Every store computes them here, so no two can disagree on the arithmetic. */
export function predictionBaserateOf(classTag: string, rows: readonly BaserateRow[]): PredictionBaserate {
  const nClosed = rows.length;
  if (nClosed === 0) {
    return { classTag, nClosed: 0, nRatioEligible: 0, meanEstimate: null, meanActual: null, meanRatio: null, p50Ratio: null, mae: null, summary: '' };
  }
  const ratioEligible = rows.filter((r) => r.estimate_value > 0);
  const nRatioEligible = ratioEligible.length;

  const meanEstimate = rows.reduce((s, r) => s + r.estimate_value, 0) / nClosed;
  const meanActual = rows.reduce((s, r) => s + r.actual_value, 0) / nClosed;
  const mae = rows.reduce((s, r) => s + Math.abs(r.actual_value - r.estimate_value), 0) / nClosed;

  let meanRatio: number | null = null;
  let p50Ratio: number | null = null;
  if (nRatioEligible > 0) {
    const ratios = ratioEligible.map((r) => r.actual_value / r.estimate_value);
    meanRatio = ratios.reduce((s, x) => s + x, 0) / nRatioEligible;
    const sorted = ratios.slice().sort((a, b) => a - b);
    p50Ratio = nRatioEligible % 2 === 1
      ? sorted[(nRatioEligible - 1) / 2]
      : (sorted[nRatioEligible / 2 - 1] + sorted[nRatioEligible / 2]) / 2;
  }

  const ratioPart = meanRatio !== null
    ? `averaged ${meanRatio.toFixed(2)}x actual`
    : 'no ratio-eligible rows (all estimates were 0)';
  const summary = `Last ${nClosed} estimate${nClosed === 1 ? '' : 's'} in class ${classTag} ${ratioPart} (MAE ${mae.toFixed(2)}).`;

  return {
    classTag,
    nClosed,
    nRatioEligible,
    meanEstimate,
    meanActual,
    meanRatio,
    p50Ratio,
    mae,
    summary,
  };
}

export function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('loadOpenPredictions', tenantId);
  const limit = opts.limit ?? DEFAULT_PREDICTION_PAGE_SIZE;
  const after = keysetAfter('created_at', 'id', opts.after);
  return onHandle(hippoRoot, (db) => {
    let rows: PredictionRow[];
    if (opts.classTag) {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = 'open'${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.classTag, ...after.params, limit) as PredictionRow[];
    } else {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM predictions
        WHERE tenant_id = ? AND closure_state = 'open'${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, ...after.params, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  });
}
