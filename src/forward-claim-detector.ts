/**
 * J3.2 forward-claim detector — pure-function regex set + token extraction.
 *
 * No DB. No state. No dependencies beyond stdlib regex + String.
 *
 * The detector's job is to decide whether a recall query carries a
 * forward-prediction phrase ("will take ~3 days", "ship by Friday",
 * "ETA in 2 weeks"). Calibration is intentionally HIGH-PRECISION /
 * LOW-RECALL: better to fire on 20% of real forward-claims than 80% with
 * 40% noise. Cry-wolf failure dominates planning-fallacy hint UX (Lovallo-
 * Kahneman 2003 inside-vs-outside view).
 *
 * Iteration signal: the `recall_autodebias_hint_no_class_match` audit op
 * (emitted by computePlanningFallacyHint when a phrase matches but no class
 * resolves) is the telemetry channel for deciding whether to add an
 * embedding-based detector in J3.3.
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 1).
 */

/**
 * Patterns ship-locked at v1.13.x. Each pattern is intentionally narrow —
 * adding a pattern should require evidence from the
 * `recall_autodebias_hint_no_class_match` audit channel that real forward-
 * claims are slipping through, NOT speculative "this might match more".
 *
 * Word boundaries (`\b`) are mandatory: prevent `~5 days` inside
 * `~5 days_ago` from matching, and prevent `ETA` substring matches inside
 * a longer token (e.g. `BETAtesting`).
 */
// Reused fragment for ALL duration-suffix patterns. Requires a digit + unit
// so 'will take ownership' / 'ship in Docker' (no time component) don't
// match. Codex round 2 P2: patterns that allowed verb-only matches fired
// on every-day non-estimate queries that happened to share a class-token.
// Accepts `<N> unit` (3 days), `a/an unit` (a week — implicit 1), and
// `one unit` so natural English forward-claims aren't lost.
const DURATION_TAIL = String.raw`(?:about|around|~|≈)?\s*(?:\d+|a|an|one)\s*(?:day|week|month|hour|hr|min(?:ute)?|sec(?:ond)?)s?\b`;

const FORWARD_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // Verb + duration tail. Old pattern `/\b(?:will|should...) take\b/i`
  // matched `who will take ownership of auth?` because there was no
  // quantifier requirement. Now requires `<verb> take <N> <unit>`.
  new RegExp(String.raw`\b(?:will|should|gonna|going\s+to)\s+take\s+${DURATION_TAIL}`, 'i'),
  // Ship + by/in + duration-or-day. Old pattern `/\bship(?:ping)?\s+(?:by|in)\b/i`
  // matched `how does this ship in Docker?`. Now requires either a
  // duration tail OR a literal day-of-week reference.
  new RegExp(String.raw`\bship(?:ping|s)?\s+(?:by|in)\s+(?:(?:about|around)\s+)?(?:next\s+)?(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`, 'i'),
  /\bestimate(?:d)?\s+(?:at\s+)?(?:~|≈|about|around)?\s*\d+/i,
  /\b(?:by|in|within)\s+(?:about|around|~)?\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  /\bETA\s*(?:is|:)?\s*\d+/i,
  /\b(?:by|before)\s+next\s+(?:week|month|sprint|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  // Standalone tilde duration: '~3 days for migration', 'estimate ~3 days'.
  // Lookbehind asserts start-of-string OR whitespace before the tilde
  // because \b before ~ requires a word char immediately preceding (~ is
  // not a word character), so /\b~/ would only match in 'foo~3 days'
  // (malformed) and silently miss the legitimate cases. Codex review
  // round 1 catch.
  /(?<=^|\s)~\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  // Should + verb + duration tail. Same tightening as the leading 'will
  // take' rule: 'should ship by EOD' must include a quantifier.
  new RegExp(String.raw`\bshould\s+(?:be|ship|finish|complete|land)\s+(?:by|in|within)\s+(?:(?:about|around)\s+)?(?:next\s+)?(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`, 'i'),
];

/**
 * Pronouns + function words + modal verbs the regex set already gates on.
 * Dropped before class-resolution so the overlap signal comes from
 * domain tokens ("migration", "auth", "refactor") rather than connectives.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'in', 'on', 'at', 'of',
  'by', 'with', 'my', 'your', 'our', 'their', 'its', 'it', 'this', 'that',
  'these', 'those', 'will', 'should', 'can', 'i', 'we', 'they', 'he', 'she',
  'is', 'be', 'was', 'are', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
  'from', 'as', 'so', 'than', 'then',
  // Verbs that appear inside FORWARD_CLAIM_PATTERNS themselves — they're
  // signal for the regex gate but NOT signal for class resolution (you
  // wouldn't name a prediction class "take" or "ship"). Listing here so
  // they don't pollute the classQueryTokens overlap score.
  'take', 'taken', 'takes', 'ship', 'ships', 'finish', 'complete', 'land',
  'eta', 'estimate', 'estimated', 'next', 'about', 'around',
  // Duration units appear in every forward-claim phrase by design (the
  // regex set REQUIRES a `<N> <unit>` quantifier after the verb). Letting
  // them through to class resolution lets a class tag containing 'days'
  // win or tie on the unit token instead of the domain token. Codex round
  // 2 P3 catch.
  'day', 'days', 'week', 'weeks', 'month', 'months',
  'hour', 'hours', 'hr', 'hrs',
  'min', 'mins', 'minute', 'minutes', 'sec', 'secs', 'second', 'seconds',
]);

export interface ForwardClaimMatch {
  /** The regex match snippet, e.g. "will take" or "~3 days". Surfaced
   *  to the calling agent in `PlanningFallacyHint.detectedPhrase` so they
   *  see WHY the hint appeared. */
  phrase: string;
  /** Lower-cased non-stop-word tokens (len >= 3, alpha or alphanumeric)
   *  extracted from the FULL query, NOT just the match. Used by the
   *  orchestrator's class resolver to score overlap with class_tag tokens. */
  classQueryTokens: string[];
}

/**
 * Detect whether a recall query carries a forward-prediction phrase.
 *
 * @returns first-match phrase + extracted class-resolution tokens when
 *   any pattern matches; null otherwise. Token extraction runs only on a
 *   match — non-forward queries pay zero work beyond the regex gate.
 */
export function detectForwardClaim(queryText: string): ForwardClaimMatch | null {
  if (!queryText) return null;
  for (const pat of FORWARD_CLAIM_PATTERNS) {
    const m = queryText.match(pat);
    if (m) {
      const tokens = extractClassQueryTokens(queryText);
      return { phrase: m[0], classQueryTokens: tokens };
    }
  }
  return null;
}

function extractClassQueryTokens(queryText: string): string[] {
  return queryText
    .toLowerCase()
    // Strip everything that's not alphanum or whitespace or hyphen / underscore.
    .replace(/[^a-z0-9\s_-]/g, ' ')
    // Split on whitespace AND hyphen AND underscore so `migration-effort`
    // produces ['migration', 'effort'] — matching the class-tag split
    // pattern in resolveClassFromTokens (split on /[-_\s]+/).
    .split(/[\s_-]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}
