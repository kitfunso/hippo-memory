/**
 * E2 prediction first-class object (v0.31 / docs/plans/2026-05-26-e2-prediction-object.md).
 *
 * Canonical store for ex-ante claims that can be closed against ex-post
 * outcomes. The `predictions` table holds every field (including
 * `claim_text`); a memory row mirrors the claim for recall/inspect surfaces
 * but is NOT the source of truth — ON DELETE SET NULL on memory_id means
 * memory deletion gracefully orphans the prediction without losing data.
 *
 * Tenant scoping: every helper requires tenantId. The schema's BEFORE INSERT
 * + BEFORE UPDATE triggers (`trg_predictions_tenant_match_*`) enforce that
 * `predictions.tenant_id` matches the referenced memory's tenant_id when
 * `memory_id IS NOT NULL`. Cross-tenant references are unrepresentable at
 * the schema level.
 *
 * Dual-write atomicity: `savePrediction` writes the memory + predictions
 * row inside `writeEntry`'s SAVEPOINT 'write_entry' (store/entry-writes.ts). The
 * afterWrite hook (store/entry-writes.ts) runs inside the same SAVEPOINT, so
 * a failure in either step rolls back both. Pattern matches supersede
 * (api.ts:1486) and the Slack/GitHub connectors.
 *
 * J3 (reference-class / planning-fallacy detector) reads from
 * `loadPredictionsByClass` to compute per-class base rates from
 * (estimate_value, actual_value) at query time. J3 is a follow-up episode;
 * this module ships the data layer.
 */

import { BadRequestError, NotFoundError } from '../api-errors.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { writeEntry } from '../store/entry-writes.js';
import { assertTenantId } from '../tenant.js';
import { createMemory, Layer, type MemoryKind } from '../memory.js';
import { appendAuditEvent } from '../audit.js';
import { loadConfig } from '../config.js';
import { keysetAfter, type KeysetPosition } from '../keyset.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new prediction. Writes a memory mirror + a predictions table
 * row atomically inside `writeEntry`'s SAVEPOINT 'write_entry'. On any
 * failure (audit write, predictions INSERT, trigger ABORT), the SAVEPOINT
 * rolls back — neither the memory row nor the predictions row lands.
 *
 * The memory is tagged `['prediction', classTag]` with `source='prediction'`
 * and `kind='distilled'`. It surfaces in `hippo recall` so the agent can
 * see open predictions naturally; the predictions table is the canonical
 * structured store used by J3.
 */
export function savePrediction(
  hippoRoot: string,
  tenantId: string,
  opts: SavePredictionOpts,
  actor: string = 'cli',
): Prediction {
  assertTenantId('savePrediction', tenantId);
  if (!opts.classTag) throw new BadRequestError('savePrediction: classTag is required');
  if (!opts.claimText) throw new BadRequestError('savePrediction: claimText is required');

  const now = new Date().toISOString();
  const mem = createMemory(opts.claimText, {
    tags: ['prediction', opts.classTag],
    layer: Layer.Semantic,
    confidence: 'observed',
    source: 'prediction',
    // SAFETY: 'distilled' is a valid MemoryKind literal (see memory.ts).
    kind: 'distilled' as MemoryKind,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    tenantId,
  });

  // Captured for the return value; populated inside afterWrite hook so the
  // INSERT and the memory write share a SAVEPOINT.
  let savedRow: PredictionRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      savedRow = insertPredictionRow(db, memoryId, tenantId, opts, now, actor);
    },
  });

  if (!savedRow) {
    // Cannot reach here without the afterWrite throwing first; defensive.
    throw new Error('savePrediction: afterWrite did not populate the row');
  }
  return rowToPrediction(savedRow);
}

/** Inserts, reloads and audits the predictions row inside writeEntry's SAVEPOINT. */
function insertPredictionRow(
  db: DatabaseSyncLike,
  memoryId: string,
  tenantId: string,
  opts: SavePredictionOpts,
  now: string,
  actor: string,
): PredictionRow {
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
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions WHERE id = ?
      `).get(predictionId) as PredictionRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved prediction row');
  }

  // GDPR-light audit metadata: prediction_id + class_tag + flags only.
  // No claim_text in metadata; the predictions table holds it canonically.
  appendAuditEvent(db, {
    tenantId,
    actor,
    op: 'predict_create',
    targetId: String(predictionId),
    metadata: {
      prediction_id: predictionId,
      class_tag: opts.classTag,
      has_estimate: opts.estimateValue !== undefined && opts.estimateValue !== null,
      target_date: opts.targetDate ?? null,
    },
  });
  return row;
}

/**
 * Close an existing open prediction. Updates the predictions row only;
 * the memory mirror is NOT mutated in v1 (predictions table is canonical).
 * J3 computes accuracy (clean vs regressed) from (estimateValue,
 * actualValue) at query time.
 */
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
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = closeOpenPredictionRow(db, tenantId, id, opts, now, actor);
      db.exec('COMMIT');
      return rowToPrediction(row);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

/** Closes the row, reloads it and audits the close; the caller owns the transaction. */
function closeOpenPredictionRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  opts: ClosePredictionOpts,
  now: string,
  actor: string,
): PredictionRow {
  // Codex review finding 2026-05-26: WHERE clause requires
  // closure_state='open' so duplicate close requests / retries against
  // an already-closed prediction return a clear error instead of
  // silently overwriting actual_value + emitting a duplicate
  // predict_close audit row. Zero changed rows → caller decides
  // whether it's a "not found" or "already closed" case based on the
  // load-then-close pattern.
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
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
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
  // Distinguish "not found" from "already closed" so callers (CLI, HTTP)
  // can surface the right error to the user.
  // SAFETY: row shape matches the single `closure_state` column named
  // in the SELECT above.
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
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: row's shape matches the columns named in the SELECT above.
    const row = db.prepare(`
      SELECT id, memory_id, tenant_id, class_tag, claim_text,
             estimate_value, estimate_unit, target_date,
             actual_value, closure_state, closed_at, closure_note, created_at
      FROM predictions WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId) as PredictionRow | undefined;
    return row ? rowToPrediction(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadPredictionsByClass(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  opts: ListPredictionsOpts = {},
): Prediction[] {
  assertTenantId('loadPredictionsByClass', tenantId);
  const limit = opts.limit ?? 100;
  const after = keysetAfter('created_at', 'id', opts.after);
  const db = openHippoDb(hippoRoot);
  try {
    let rows: PredictionRow[];
    if (opts.closureState) {
      if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
        throw new BadRequestError(
          `loadPredictionsByClass: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ${opts.closureState}`,
        );
      }
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = ?${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, opts.closureState, ...after.params, limit) as PredictionRow[];
    } else {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ?${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, ...after.params, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  } finally {
    closeHippoDb(db);
  }
}

/** Every prediction in the tenant, open and closed, across all classes: the `status=all` list without a class. */
export function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  assertTenantId('loadAllPredictions', tenantId);
  const after = keysetAfter('created_at', 'id', opts.after);
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: rows' shape matches the columns named in the SELECT.
    const rows = db.prepare(`
      SELECT id, memory_id, tenant_id, class_tag, claim_text,
             estimate_value, estimate_unit, target_date,
             actual_value, closure_state, closed_at, closure_note, created_at
      FROM predictions
      WHERE tenant_id = ?${after.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, ...after.params, opts.limit ?? 100) as PredictionRow[];
    return rows.map(rowToPrediction);
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// v0.31 / J3 — reference-class / planning-fallacy detector
// ---------------------------------------------------------------------------

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

interface BaserateRow {
  estimate_value: number;
  actual_value: number;
}

/**
 * Compute base-rate stats for closed predictions in a class. Used by J3
 * reference-class / planning-fallacy detector. Direct application of
 * Lovallo-Kahneman (2003) inside-vs-outside view.
 *
 * Filter: closure_state='closed' AND estimate_value IS NOT NULL AND
 * actual_value IS NOT NULL. Excludes closed-unknown (no actual to
 * compare against) and open (not yet resolved).
 *
 * Audit-emit is BUILT IN here (single source of truth, no caller-site
 * drift risk). Plan-eng-critic round 1 HIGH recommendation: emit inside
 * helper, not at 3 call sites.
 */
export function computePredictionBaserate(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  actor: string = 'cli',
  /** v0.32 / J3.2 — when false, skip the predict_baserate audit emit. The
   *  J3.2 orchestrator (computePlanningFallacyOutput, below) calls this with
   *  emitAudit=false and emits its own `recall_autodebias_hint` audit row
   *  instead, so the predict_baserate channel stays scoped to deliberate
   *  CLI / HTTP / MCP predict-baserate calls and does NOT pollute on every
   *  recall containing a forward-claim phrase. Default true preserves the
   *  v1.13.0 J3 audit semantics for the 3 direct callers (cmdPredict
   *  baserate, /v1/predictions/stats route, hippo_predict_baserate MCP
   *  handler) — none of them pass this argument. */
  emitAudit: boolean = true,
): PredictionBaserate {
  assertTenantId('computePredictionBaserate', tenantId);
  if (!classTag) throw new BadRequestError('computePredictionBaserate: classTag is required');

  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: rows' shape matches the two columns named in the SELECT above.
    const rows = db.prepare(`
      SELECT estimate_value, actual_value
      FROM predictions
      WHERE tenant_id = ?
        AND class_tag = ?
        AND closure_state = 'closed'
        AND estimate_value IS NOT NULL
        AND actual_value IS NOT NULL
    `).all(tenantId, classTag) as BaserateRow[];

    const nClosed = rows.length;
    if (nClosed === 0) {
      // Audit zero-result reads too — agents probing empty classes is
      // a signal worth recording. Skipped when emitAudit=false (J3.2
      // orchestrator path; its own recall_autodebias_hint audit fires
      // only when nClosed > 0 anyway, so no signal is lost).
      if (emitAudit) auditBaserateRead(db, tenantId, actor, classTag, 0);
      return {
        classTag,
        nClosed: 0,
        nRatioEligible: 0,
        meanEstimate: null,
        meanActual: null,
        meanRatio: null,
        p50Ratio: null,
        mae: null,
        summary: '',
      };
    }

    const baserate = baserateFromRows(classTag, rows);
    if (emitAudit) auditBaserateRead(db, tenantId, actor, classTag, nClosed);
    return baserate;
  } finally {
    closeHippoDb(db);
  }
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

/** Stats over a non-empty set of closed rows. */
function baserateFromRows(classTag: string, rows: BaserateRow[]): PredictionBaserate {
  const nClosed = rows.length;
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
  const limit = opts.limit ?? 100;
  const after = keysetAfter('created_at', 'id', opts.after);
  const db = openHippoDb(hippoRoot);
  try {
    let rows: PredictionRow[];
    if (opts.classTag) {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = 'open'${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.classTag, ...after.params, limit) as PredictionRow[];
    } else {
      // SAFETY: rows' shape matches the columns named in the SELECT above.
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND closure_state = 'open'${after.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, ...after.params, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  } finally {
    closeHippoDb(db);
  }
}
