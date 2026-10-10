import { envAutodebiasOff } from '../util/env.js';
import type { AppendAuditOpts } from '../store/audit.js';
import { detectForwardClaim, type ForwardClaimMatch } from '../learn/forward-claim-detector.js';
import type { PlanningFallacyEvidence } from '../store/planning-fallacy-evidence.js';

const TARGET_ID_CHARS = 100;

/** Surface delivered on `RecallResult.planningFallacyHint` when a recall query carries a forward-prediction phrase and the closest class has closed history,
 *  so the agent sees its own track record at the moment of forecasting. */
export interface PlanningFallacyHint {
  classTag: string;
  /** Verbatim PredictionBaserate.summary, e.g.
   *  "Last 5 estimates in class migration-effort averaged 2.10x actual (MAE 1.40)." */
  baserateSummary: string;
  /** Discriminator vs hypothetical future manual-override hints. */
  source: 'j3.2-auto';
  /** The regex match snippet that triggered detection, so the agent sees WHY the hint appeared and can self-correct if detection misfired. */
  detectedPhrase: string;
  nClosed: number;
  /** Null only when every closed-row had estimate_value=0 (ratio undefined). */
  meanRatio: number | null;
}

/** "Watching" variant emitted when the forward-claim regex matched but no baserate hint was returned (no prediction class tag overlaps the query's tokens).
 *  It surfaces the detection plus a one-line suggestion so the agent can re-tag the prediction or pass the suggestion to the user. */
export interface PlanningFallacyWatching {
  /** The forward-claim phrase the detector matched (verbatim regex match snippet). */
  detectedPhrase: string;
  /** Why hippo could not produce a baserate hint despite the match: 'no_class_match' (no class scored >=1 on token overlap)
   *  or 'tiebreak' (>=2 classes tied at the best score; silent on ambiguity). */
  reason: 'no_class_match' | 'tiebreak';
  /** One-line agent-facing suggestion for how the user can give hippo
   *  enough signal to produce a baserate next time. */
  suggestion: string;
}

/** What `decidePlanningFallacy` hands to recall: EITHER `hint` (baserate available) OR `watching` (regex fired, no baserate), or NEITHER (mode=off,
 *  no queryText, no regex match, or nClosed=0). Never both. */
export interface PlanningFallacyOutput {
  hint?: PlanningFallacyHint;
  watching?: PlanningFallacyWatching;
}

export type AutodebiasMode = 'off' | 'regex';

export interface ComputePlanningFallacyHintOpts {
  /** Override env; undefined reads process.env.HIPPO_AUTODEBIAS per call (so tests can toggle it).
   *  'off' short-circuits to null before the regex gate. */
  mode?: AutodebiasMode;
}

/** The output a claim earns from its evidence, and the audit row that records the decision when there is one. */
export interface PlanningFallacyDecision {
  output: PlanningFallacyOutput;
  audit?: AppendAuditOpts;
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
      targetId: match.phrase.slice(0, TARGET_ID_CHARS),
      metadata: { detected_phrase: match.phrase, token_count: match.classQueryTokens.length },
    },
  };
}
