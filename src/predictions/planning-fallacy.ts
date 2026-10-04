import { envAutodebiasOff } from '../env.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { appendAuditEvent } from '../audit.js';
import { detectForwardClaim, type ForwardClaimMatch } from '../forward-claim-detector.js';
import { computePredictionBaserate } from './store.js';

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
    // SAFETY: rows' shape matches the single `class_tag` column named in the SELECT above.
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
 * J3.2 orchestrator.
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
    opts.mode ?? (envAutodebiasOff() ? 'off' : 'regex');
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
    return watchingWithAudit(hippoRoot, tenantId, actor, match, 'tiebreak', TIEBREAK_SUGGESTION);
  }
  if (!resolution.classTag) {
    // Telemetry: forward-claim detected, no class scored ≥ 1.
    // This is the channel that drives the embedding-fallback decision
    // for J3.3 — high volume here = regex+token-overlap is missing
    // legitimate forward-claims that have NO obvious class signal.
    // v1.13.4: now ALSO returns a watching variant so the caller surface
    // can render a "watching but no baserate (no class match)" line.
    return watchingWithAudit(hippoRoot, tenantId, actor, match, 'no_class_match', NO_CLASS_MATCH_SUGGESTION);
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

  appendAuditEventOnce(hippoRoot, {
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

const TIEBREAK_SUGGESTION =
  'Multiple prediction classes tied on this query. Refine the query or rename overlapping classes to break the tie.';
const NO_CLASS_MATCH_SUGGESTION =
  'No matching prediction class for this forward-claim. Tag your prediction with `hippo predict --class <name>` to start tracking this class.';

/** One audit row on its own short-lived connection. */
function appendAuditEventOnce(hippoRoot: string, event: Parameters<typeof appendAuditEvent>[1]): void {
  const db = openHippoDb(hippoRoot);
  try {
    appendAuditEvent(db, event);
  } finally {
    closeHippoDb(db);
  }
}

function watchingWithAudit(
  hippoRoot: string,
  tenantId: string,
  actor: string,
  match: ForwardClaimMatch,
  reason: PlanningFallacyWatching['reason'],
  suggestion: string,
): PlanningFallacyOutput {
  appendAuditEventOnce(hippoRoot, {
    tenantId,
    actor,
    op: reason === 'tiebreak' ? 'recall_autodebias_hint_tiebreak' : 'recall_autodebias_hint_no_class_match',
    targetId: match.phrase.slice(0, 100),
    metadata: { detected_phrase: match.phrase, token_count: match.classQueryTokens.length },
  });
  return {
    watching: {
      detectedPhrase: match.phrase,
      reason,
      suggestion,
    },
  };
}
