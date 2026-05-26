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
 * row inside `writeEntry`'s SAVEPOINT 'write_entry' (store.ts:1196). The
 * afterWrite hook (store.ts:1199-1201) runs inside the same SAVEPOINT, so
 * a failure in either step rolls back both. Pattern matches supersede
 * (api.ts:1486) and the Slack/GitHub connectors.
 *
 * J3 (reference-class / planning-fallacy detector) reads from
 * `loadPredictionsByClass` to compute per-class base rates from
 * (estimate_value, actual_value) at query time. J3 is a follow-up episode;
 * this module ships the data layer.
 */

import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, type MemoryKind } from './memory.js';
import { appendAuditEvent } from './audit.js';

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
  if (!opts.classTag) throw new Error('savePrediction: classTag is required');
  if (!opts.claimText) throw new Error('savePrediction: claimText is required');

  const now = new Date().toISOString();
  const mem = createMemory(opts.claimText, {
    tags: ['prediction', opts.classTag],
    layer: Layer.Semantic,
    confidence: 'observed',
    source: 'prediction',
    kind: 'distilled' as MemoryKind,
    tenantId,
  });

  // Captured for the return value; populated inside afterWrite hook so the
  // INSERT and the memory write share a SAVEPOINT.
  let savedRow: PredictionRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
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
      const row = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions WHERE id = ?
      `).get(predictionId) as PredictionRow | undefined;

      if (!row) {
        throw new Error('Failed to reload saved prediction row');
      }
      savedRow = row;

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
    },
  });

  if (!savedRow) {
    // Cannot reach here without the afterWrite throwing first; defensive.
    throw new Error('savePrediction: afterWrite did not populate the row');
  }
  return rowToPrediction(savedRow);
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
    throw new Error(
      `closePrediction: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ${opts.closureState}`,
    );
  }

  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
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

      if (updateResult.changes === 0) {
        // Distinguish "not found" from "already closed" so callers (CLI, HTTP)
        // can surface the right error to the user.
        const existing = db.prepare(`
          SELECT closure_state FROM predictions WHERE id = ? AND tenant_id = ?
        `).get(id, tenantId) as { closure_state: string } | undefined;
        if (!existing) {
          throw new Error(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closePrediction: prediction ${id} is already closed (state='${existing.closure_state}'); ` +
          `cannot re-close. Open predictions only.`,
        );
      }

      const row = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions WHERE id = ? AND tenant_id = ?
      `).get(id, tenantId) as PredictionRow | undefined;

      if (!row) {
        throw new Error(`closePrediction: prediction ${id} not found after UPDATE`);
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

export function loadPredictionById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Prediction | null {
  assertTenantId('loadPredictionById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
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
  const db = openHippoDb(hippoRoot);
  try {
    let rows: PredictionRow[];
    if (opts.closureState) {
      if (!VALID_CLOSURE_STATES.has(opts.closureState)) {
        throw new Error(
          `loadPredictionsByClass: closureState must be one of ${Array.from(VALID_CLOSURE_STATES).join('|')}; got ${opts.closureState}`,
        );
      }
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, opts.closureState, limit) as PredictionRow[];
    } else {
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, classTag, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  } finally {
    closeHippoDb(db);
  }
}

export function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number } = {},
): Prediction[] {
  assertTenantId('loadOpenPredictions', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    let rows: PredictionRow[];
    if (opts.classTag) {
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND class_tag = ? AND closure_state = 'open'
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.classTag, limit) as PredictionRow[];
    } else {
      rows = db.prepare(`
        SELECT id, memory_id, tenant_id, class_tag, claim_text,
               estimate_value, estimate_unit, target_date,
               actual_value, closure_state, closed_at, closure_note, created_at
        FROM predictions
        WHERE tenant_id = ? AND closure_state = 'open'
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, limit) as PredictionRow[];
    }
    return rows.map(rowToPrediction);
  } finally {
    closeHippoDb(db);
  }
}
