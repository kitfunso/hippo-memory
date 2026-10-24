import type { RuntimeSettings } from '../../base/config/config.js';
import { detectForwardClaim, type ForwardClaimMatch } from '../learn/forward-claim-detector.js';
import type { AppendAuditOpts, PlanningFallacyEvidence } from '../../store/port/types.js';
import type { PlanningFallacyOutput, PlanningFallacyWatching } from '../../base/records/planning-fallacy.js';

const TARGET_ID_CHARS = 100;

export type AutodebiasMode = 'off' | 'regex';

export interface ComputePlanningFallacyHintOptions {
  /** 'off' short-circuits to null before the regex gate; 'regex' when unset. */
  mode?: AutodebiasMode;
}

/** The mode the root's HIPPO_AUTODEBIAS sets: 'off' only when it was switched off. */
export function autodebiasMode(runtime: RuntimeSettings | undefined): AutodebiasMode {
  return runtime?.autodebias === false ? 'off' : 'regex';
}

/** The output a claim earns from its evidence, and the audit row that records the decision when there is one. */
export interface PlanningFallacyDecision {
  output: PlanningFallacyOutput;
  audit?: AppendAuditOpts;
}

/** The forward claim in a recall query; null when HIPPO_AUTODEBIAS=off, the query is empty or no claim matches. */
export function detectPlanningClaim(
  queryText: string,
  opts: ComputePlanningFallacyHintOptions = {},
): ForwardClaimMatch | null {
  // Checked FIRST so AUTODEBIAS=off pays zero regex cost.
  if ((opts.mode ?? 'regex') === 'off') return null;
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
    // Telemetry: forward-claim detected, ≥2 classes tied at best overlap. The watching variant lets the caller render
    // "watching but no baserate (tiebreak)"; the audit channel stays the source of truth.
    return watchingWithAudit(tenantId, actor, match, 'tiebreak', TIEBREAK_SUGGESTION);
  }
  if (!evidence.classTag) {
    // Telemetry: no class scored ≥ 1. High volume here means regex+token-overlap misses real forward-claims with no
    // class signal, the case for an embedding fallback.
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
  'No matching prediction class for this forward-claim. Tag your prediction with `hippo predict --class <name>` to ' +
  'start tracking this class.';

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
