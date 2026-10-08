import { envAutodebiasOff } from '../env.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import type { AppendAuditOpts } from '../audit.js';
import { detectForwardClaim, type ForwardClaimMatch } from '../forward-claim-detector.js';
import { computePredictionBaserate, type PredictionBaserate } from './store.js';

// ---------------------------------------------------------------------------
// Auto-injection of reference-class baserate on recall
// ---------------------------------------------------------------------------

/**
 * Surface delivered on `RecallResult.planningFallacyHint` when an
 * agent's recall query carries a forward-prediction phrase AND the closest
 * matching prediction class has closed historical data.
 *
 * The agent sees its track record at the moment of forecasting, anchoring
 * on the outside view (Lovallo-Kahneman 2003) rather than the inside-view
 * inside the planning fallacy.
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
 * "Watching" variant emitted when the forward-claim regex matched but no
 * PlanningFallacyHint baserate was returned. Silence was the most common
 * real-world failure: a natural-language query carries a
 * forward-claim phrase but its non-stopword tokens don't overlap with
 * any prediction class tag, so hippo emitted nothing despite
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
 * What `decidePlanningFallacy` hands to recall. Carries EITHER `hint` (baserate
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
}

export interface ClassResolution {
  classTag: string | null;
  /** True when ≥2 classes tied at the best overlap score AND best ≥ 1.
   *  Caller emits `recall_autodebias_hint_tiebreak` audit and returns
   *  null hint (silent — prevents the "show wrong class half the time"
   *  failure mode the alphabetical-tiebreak alternative would create). */
  tiebreak: boolean;
}

/** The prediction class a forward claim resolves to, and that class's closed-prediction stats when one resolved. */
export interface PlanningFallacyEvidence extends ClassResolution {
  readonly baserate: PredictionBaserate | null;
}

/** The output a claim earns from its evidence, and the audit row that records the decision when there is one. */
export interface PlanningFallacyDecision {
  output: PlanningFallacyOutput;
  audit?: AppendAuditOpts;
}

/**
 * Resolve a query-token set to a unique best-matching class_tag for the
 * tenant. Scores by lower-cased token overlap; requires best score ≥ 1
 * AND strictly greater than the 2nd-best score.
 *
 * Indexed via idx_predictions_tenant_class (db.ts:1015) → O(log n) seek
 * plus a small DISTINCT scan over the per-tenant class-tag set.
 *
 * Scope behaviour (deliberate): class_tag selection is TENANT-GLOBAL,
 * NOT scope-filtered against
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
export function resolveClassFromTokens(
  hippoRoot: string,
  tenantId: string,
  queryTokens: readonly string[],
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

/** The forward claim in a recall query; null when HIPPO_AUTODEBIAS=off, the query is empty or no claim matches. */
export function detectPlanningClaim(queryText: string, opts: ComputePlanningFallacyHintOpts = {}): ForwardClaimMatch | null {
  // Env read FIRST so AUTODEBIAS=off pays zero regex cost; read per call so tests can toggle it without a module reload.
  const mode: AutodebiasMode =
    opts.mode ?? (envAutodebiasOff() ? 'off' : 'regex');
  if (mode === 'off') return null;
  if (!queryText) return null;
  return detectForwardClaim(queryText);
}

/** Resolves a claim's tokens to one class and reads its baserate, writing no audit row. */
export function planningFallacyEvidenceAt(hippoRoot: string, tenantId: string, classQueryTokens: readonly string[]): PlanningFallacyEvidence {
  const resolution = resolveClassFromTokens(hippoRoot, tenantId, classQueryTokens);
  // emitAudit=false: the recall_autodebias_hint row carries n_closed and mean_ratio, so predict_baserate stays off.
  const baserate = resolution.classTag ? computePredictionBaserate(hippoRoot, tenantId, resolution.classTag, 'recall', false) : null;
  return { ...resolution, baserate };
}

/** The hint, the watching variant or nothing for a claim and its class evidence; reads and writes nothing itself. */
export function decidePlanningFallacy(
  match: ForwardClaimMatch,
  evidence: PlanningFallacyEvidence,
  tenantId: string,
  actor: string,
): PlanningFallacyDecision {
  if (evidence.tiebreak) {
    // Telemetry: forward-claim detected, ≥2 classes tied at best overlap. The watching variant lets the
    // caller render "watching but no baserate (tiebreak)"; the audit channel stays the source of truth.
    return watchingWithAudit(tenantId, actor, match, 'tiebreak', TIEBREAK_SUGGESTION);
  }
  if (!evidence.classTag) {
    // Telemetry: no class scored ≥ 1. High volume here means regex+token-overlap misses real forward-claims
    // with no class signal, the case for an embedding fallback.
    return watchingWithAudit(tenantId, actor, match, 'no_class_match', NO_CLASS_MATCH_SUGGESTION);
  }
  const baserate = evidence.baserate;
  if (!baserate || baserate.nClosed === 0) return { output: {} }; // Silent — wait for closed data.
  return {
    output: {
      hint: {
        classTag: evidence.classTag,
        baserateSummary: baserate.summary,
        source: 'j3.2-auto',
        detectedPhrase: match.phrase,
        nClosed: baserate.nClosed,
        meanRatio: baserate.meanRatio,
      },
    },
    audit: {
      tenantId,
      actor,
      op: 'recall_autodebias_hint',
      targetId: evidence.classTag,
      metadata: {
        class_tag: evidence.classTag,
        detected_phrase: match.phrase,
        n_closed: baserate.nClosed,
        mean_ratio: baserate.meanRatio,
      },
    },
  };
}

const TIEBREAK_SUGGESTION =
  'Multiple prediction classes tied on this query. Refine the query or rename overlapping classes to break the tie.';
const NO_CLASS_MATCH_SUGGESTION =
  'No matching prediction class for this forward-claim. Tag your prediction with `hippo predict --class <name>` to start tracking this class.';

function watchingWithAudit(
  tenantId: string,
  actor: string,
  match: ForwardClaimMatch,
  reason: PlanningFallacyWatching['reason'],
  suggestion: string,
): PlanningFallacyDecision {
  return {
    output: {
      watching: {
        detectedPhrase: match.phrase,
        reason,
        suggestion,
      },
    },
    audit: {
      tenantId,
      actor,
      op: reason === 'tiebreak' ? 'recall_autodebias_hint_tiebreak' : 'recall_autodebias_hint_no_class_match',
      targetId: match.phrase.slice(0, 100),
      metadata: { detected_phrase: match.phrase, token_count: match.classQueryTokens.length },
    },
  };
}
