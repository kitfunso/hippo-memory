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
import { detectForwardClaim } from './forward-claim-detector.js';

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
   *  J3.2 orchestrator (computePlanningFallacyHint, below) calls this with
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
  if (!classTag) throw new Error('computePredictionBaserate: classTag is required');

  const db = openHippoDb(hippoRoot);
  try {
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
      if (emitAudit) {
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'predict_baserate',
          targetId: classTag,
          metadata: { class_tag: classTag, n_closed: 0 },
        });
      }
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

    if (emitAudit) {
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'predict_baserate',
        targetId: classTag,
        metadata: { class_tag: classTag, n_closed: nClosed },
      });
    }

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

// ---------------------------------------------------------------------------
// J3.2 — auto-injection of reference-class baserate on recall
// ---------------------------------------------------------------------------

/**
 * J3.2 surface delivered on `RecallResult.planningFallacyHint` when an
 * agent's recall query carries a forward-prediction phrase AND the closest
 * matching prediction class has closed historical data.
 *
 * The agent sees its track record at the moment of forecasting, anchoring
 * on the outside view (Lovallo-Kahneman 2003) rather than the inside-view
 * inside the planning fallacy.
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md.
 */
export interface PlanningFallacyHint {
  classTag: string;
  /** Verbatim PredictionBaserate.summary, e.g.
   *  "Last 5 estimates in class migration-effort averaged 2.10x actual (MAE 1.40)." */
  baserateSummary: string;
  /** Discriminator vs hypothetical future manual-override hints. */
  source: 'j3.2-auto';
  /** The regex match snippet that triggered detection. Lets the agent
   *  see WHY the hint appeared and self-correct if detection misfires
   *  (e.g. "I wasn't predicting; ignore"). */
  detectedPhrase: string;
  nClosed: number;
  /** Null only when every closed-row had estimate_value=0 (ratio undefined). */
  meanRatio: number | null;
}

/**
 * v1.13.4 / J3.2 follow-up — "watching" variant emitted when the
 * forward-claim regex matched but no PlanningFallacyHint baserate was
 * returned. Dogfood diary (docs/dogfood/2026-05-27-track-j-warnings.md)
 * Trial 2a confirmed the pre-v1.13.4 silent paths were the most common
 * real-world J3.2 failure mode: a natural-language query carries a
 * forward-claim phrase but its non-stopword tokens don't overlap with
 * any prediction class tag, so hippo silently emitted nothing despite
 * the regex match. The watching variant surfaces the detection event
 * + a one-line suggestion so the agent can either re-tag the prediction
 * or pass the suggestion through to the user.
 */
export interface PlanningFallacyWatching {
  /** The forward-claim phrase the detector matched (verbatim regex match snippet). */
  detectedPhrase: string;
  /** Why hippo couldn't produce a baserate hint despite the match.
   *  - 'no_class_match': no class scored >=1 on token overlap.
   *  - 'tiebreak': >=2 classes tied at the same best score (silent on ambiguity). */
  reason: 'no_class_match' | 'tiebreak';
  /** One-line agent-facing suggestion for how the user can give hippo
   *  enough signal to produce a baserate next time. */
  suggestion: string;
}

/**
 * v1.13.4 / J3.2 follow-up — richer return type for
 * `computePlanningFallacyOutput`. Carries EITHER `hint` (baserate
 * available) OR `watching` (regex fired, no baserate), or NEITHER (mode=off,
 * no queryText, no regex match, or nClosed=0 silent path). Never both.
 *
 * Existing `computePlanningFallacyHint` (preserved as a backward-compat
 * wrapper) returns only the hint variant; new code should call
 * `computePlanningFallacyOutput` directly to surface the watching variant.
 */
export interface PlanningFallacyOutput {
  hint?: PlanningFallacyHint;
  watching?: PlanningFallacyWatching;
}

export type AutodebiasMode = 'off' | 'regex';

export interface ComputePlanningFallacyHintOpts {
  /** Override env. When undefined, reads process.env.HIPPO_AUTODEBIAS at
   *  call time (per-call to allow test-time env toggling without module
   *  reload). 'off' short-circuits to null BEFORE the regex gate so the
   *  AUTODEBIAS=off path pays zero work. */
  mode?: AutodebiasMode;
  /** Actor for any audit emissions. Defaults to 'recall' (caller didn't
   *  specify). MUST thread through to the inner computePredictionBaserate
   *  call (passed as its `actor` arg) so MCP/HTTP-originated auto-hints
   *  carry the right attribution instead of the 'cli' default. */
  actor?: string;
}

interface ClassResolution {
  classTag: string | null;
  /** True when ≥2 classes tied at the best overlap score AND best ≥ 1.
   *  Caller emits `recall_autodebias_hint_tiebreak` audit and returns
   *  null hint (silent — prevents the "show wrong class half the time"
   *  failure mode the alphabetical-tiebreak alternative would create). */
  tiebreak: boolean;
}

/**
 * Resolve a query-token set to a unique best-matching class_tag for the
 * tenant. Scores by lower-cased token overlap; requires best score ≥ 1
 * AND strictly greater than the 2nd-best score.
 *
 * Indexed via idx_predictions_tenant_class (db.ts:1015) → O(log n) seek
 * plus a small DISTINCT scan over the per-tenant class-tag set.
 *
 * Scope behaviour (v1 design choice, independent-review-critic round 1
 * MED): class_tag selection is TENANT-GLOBAL, NOT scope-filtered against
 * the recall's opts.scope. The class_tag is an aggregator label across
 * historical predictions in the class, not a per-memory scope-bound
 * property. A no-scope recall CAN surface a class_tag from a privately-
 * scoped prediction's class in PlanningFallacyHint.classTag — by design,
 * because base-rate reasoning needs the full historical sample.
 * Implications:
 *   - The hint payload itself carries no memory content (only the aggregate
 *     summary string + numeric stats), so memory bodies do not leak.
 *   - The class_tag NAME is the side-channel. If sensitive labels are a
 *     concern, callers should either use opaque class names (e.g. hashes
 *     or numeric tokens) or set HIPPO_AUTODEBIAS=off.
 *   - tests/api-recall-autodebias.test.ts locks this with an explicit
 *     test asserting that scope-set predictions surface via no-scope
 *     recalls (so future "fix" attempts that scope-filter trip CI).
 */
function resolveClassFromTokens(
  hippoRoot: string,
  tenantId: string,
  queryTokens: string[],
): ClassResolution {
  if (queryTokens.length === 0) return { classTag: null, tiebreak: false };
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(
      `SELECT DISTINCT class_tag FROM predictions WHERE tenant_id = ?`,
    ).all(tenantId) as Array<{ class_tag: string }>;

    const querySet = new Set(queryTokens);
    let bestScore = 0;
    let bestClass: string | null = null;
    let secondBest = 0;
    for (const { class_tag } of rows) {
      const classTokens = class_tag
        .toLowerCase()
        .split(/[-_\s]+/)
        .filter((t) => t.length >= 3);
      let score = 0;
      for (const t of classTokens) if (querySet.has(t)) score++;
      if (score > bestScore) {
        secondBest = bestScore;
        bestScore = score;
        bestClass = class_tag;
      } else if (score === bestScore && score > 0) {
        // Tie at current best — bump secondBest. Do NOT update bestClass
        // (alphabetical tiebreak would pick wrong class on ambiguous query
        // like "migration will take 3 days" between migration-effort vs
        // migration-risk; silent on tie instead).
        secondBest = score;
      } else if (score > secondBest) {
        secondBest = score;
      }
    }
    if (bestScore < 1) return { classTag: null, tiebreak: false };
    if (bestScore === secondBest) return { classTag: null, tiebreak: true };
    return { classTag: bestClass, tiebreak: false };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * J3.2 orchestrator (v1.13.4: richer return type — see computePlanningFallacyHint
 * below for the backward-compat wrapper that returns only the hint variant).
 *
 * Composes the forward-claim detector + class resolver + baserate compute,
 * with telemetry-grade audit emission at every decision point (success,
 * no-class-match, tiebreak).
 *
 * Returns `{}` (neither hint nor watching) on:
 *   - mode === 'off' (env-disabled; pays only the env read, skips regex)
 *   - empty queryText
 *   - no forward-claim regex match
 *   - resolved class has nClosed=0 (no historical data yet; silent)
 *
 * Returns `{ watching: ... }` on (v1.13.4 NEW — was silent null pre-1.13.4):
 *   - resolver returns no class (no overlap ≥ 1; emits no_class_match audit)
 *   - resolver returns tiebreak (≥2 classes tied at best; emits tiebreak audit)
 *
 * Returns `{ hint: ... }` on success: calls computePredictionBaserate(...,
 * emitAudit=false) so the predict_baserate audit channel stays scoped to
 * deliberate predict-baserate calls (the orchestrator's own recall_autodebias_hint
 * audit carries n_closed + mean_ratio in metadata so no telemetry is lost),
 * then emits recall_autodebias_hint audit + returns the hint.
 *
 * Latency budget (plan §Latency): ~50us regex-only on miss; ~750-850us
 * on full match+resolve+baserate path. Well under 50ms target.
 */
export function computePlanningFallacyOutput(
  hippoRoot: string,
  tenantId: string,
  queryText: string,
  opts: ComputePlanningFallacyHintOpts = {},
): PlanningFallacyOutput {
  // Env read FIRST so AUTODEBIAS=off pays zero regex cost. Per-call read
  // (rather than module-load cache) is deliberate: tests env-toggle this
  // via process.env mutation without module reload.
  const mode: AutodebiasMode =
    opts.mode ?? (process.env.HIPPO_AUTODEBIAS === 'off' ? 'off' : 'regex');
  if (mode === 'off') return {};
  if (!queryText) return {};

  const match = detectForwardClaim(queryText);
  if (!match) return {};

  const actor = opts.actor ?? 'recall';

  const resolution = resolveClassFromTokens(hippoRoot, tenantId, match.classQueryTokens);
  if (resolution.tiebreak) {
    // Telemetry: forward-claim detected, ≥2 classes tied at best overlap.
    // v1.13.4: now ALSO returns a watching variant so the caller surface
    // can render a "watching but no baserate (tiebreak)" line. Audit emission
    // unchanged (the audit channel is the telemetry-grade source of truth).
    const db = openHippoDb(hippoRoot);
    try {
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'recall_autodebias_hint_tiebreak',
        targetId: match.phrase.slice(0, 100),
        metadata: { detected_phrase: match.phrase, token_count: match.classQueryTokens.length },
      });
    } finally {
      closeHippoDb(db);
    }
    return {
      watching: {
        detectedPhrase: match.phrase,
        reason: 'tiebreak',
        suggestion:
          'Multiple prediction classes tied on this query. Refine the query or rename overlapping classes to break the tie.',
      },
    };
  }
  if (!resolution.classTag) {
    // Telemetry: forward-claim detected, no class scored ≥ 1.
    // This is the channel that drives the embedding-fallback decision
    // for J3.3 — high volume here = regex+token-overlap is missing
    // legitimate forward-claims that have NO obvious class signal.
    // v1.13.4: now ALSO returns a watching variant so the caller surface
    // can render a "watching but no baserate (no class match)" line.
    const db = openHippoDb(hippoRoot);
    try {
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'recall_autodebias_hint_no_class_match',
        targetId: match.phrase.slice(0, 100),
        metadata: { detected_phrase: match.phrase, token_count: match.classQueryTokens.length },
      });
    } finally {
      closeHippoDb(db);
    }
    return {
      watching: {
        detectedPhrase: match.phrase,
        reason: 'no_class_match',
        suggestion:
          'No matching prediction class for this forward-claim. Tag your prediction with `hippo predict --class <name>` to start tracking this class.',
      },
    };
  }

  // emitAudit=false: avoid double-write to predict_baserate channel.
  // The recall_autodebias_hint audit below carries n_closed + mean_ratio.
  const baserate = computePredictionBaserate(
    hippoRoot,
    tenantId,
    resolution.classTag,
    actor,
    /*emitAudit=*/ false,
  );
  if (baserate.nClosed === 0) return {}; // Silent — wait for closed data.

  const db = openHippoDb(hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'recall_autodebias_hint',
      targetId: resolution.classTag,
      metadata: {
        class_tag: resolution.classTag,
        detected_phrase: match.phrase,
        n_closed: baserate.nClosed,
        mean_ratio: baserate.meanRatio,
      },
    });
  } finally {
    closeHippoDb(db);
  }

  return {
    hint: {
      classTag: resolution.classTag,
      baserateSummary: baserate.summary,
      source: 'j3.2-auto',
      detectedPhrase: match.phrase,
      nClosed: baserate.nClosed,
      meanRatio: baserate.meanRatio,
    },
  };
}

/**
 * v1.13.4 backward-compat wrapper: thin shim around
 * computePlanningFallacyOutput that returns only the hint variant.
 * Existing callers (api.recall, cmdRecall, MCP handler) that don't yet
 * consume the watching variant continue to work unchanged.
 *
 * New callers that want to surface the silent no-class-match / tiebreak
 * paths to users should call computePlanningFallacyOutput directly.
 */
export function computePlanningFallacyHint(
  hippoRoot: string,
  tenantId: string,
  queryText: string,
  opts: ComputePlanningFallacyHintOpts = {},
): PlanningFallacyHint | null {
  return computePlanningFallacyOutput(hippoRoot, tenantId, queryText, opts).hint ?? null;
}
