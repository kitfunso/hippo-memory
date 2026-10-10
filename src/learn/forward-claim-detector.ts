/** Forward-claim detector: a pure regex set plus token extraction deciding whether a recall query carries a forward-prediction phrase.
 *  Calibration is HIGH-PRECISION / LOW-RECALL, since cry-wolf noise dominates hint UX; `recall_autodebias_hint_no_class_match` audits are the telemetry. */

/** Each pattern is deliberately narrow (add one only on audit evidence); word boundaries are mandatory so `ETA` never matches inside `BETAtesting`. */
// Shared duration suffix: needs a digit + unit (`<N> unit`, `a/an unit`, `one unit`) so 'will take ownership' and 'ship in Docker' do not match.
const DURATION_TAIL = String.raw`(?:about|around|~|≈)?\s*(?:\d+|a|an|one)\s*(?:day|week|month|hour|hr|min(?:ute)?|sec(?:ond)?)s?\b`;

const FORWARD_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // Verb + duration tail: requires `<verb> take <N> <unit>`, because a bare `will take` matched `who will take ownership of auth?`.
  new RegExp(String.raw`\b(?:will|should|gonna|going\s+to)\s+take\s+${DURATION_TAIL}`, 'i'),
  // Ship + by/in + duration-or-day: a bare `ship in` matched `how does this ship in Docker?`, so a duration tail or literal day-of-week is required.
  new RegExp(String.raw`\bship(?:ping|s)?\s+(?:by|in)\s+(?:(?:about|around)\s+)?(?:next\s+)?(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`, 'i'),
  /\bestimate(?:d)?\s+(?:at\s+)?(?:~|≈|about|around)?\s*\d+/i,
  /\b(?:by|in|within)\s+(?:about|around|~)?\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  /\bETA\s*(?:is|:)?\s*\d+/i,
  /\b(?:by|before)\s+next\s+(?:week|month|sprint|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  // Standalone tilde duration ('~3 days for migration'): the lookbehind asserts start-of-string or whitespace because `\b` before `~` needs a word char
  // and /\b~/ would only match 'foo~3 days', silently missing the real cases.
  /(?<=^|\s)~\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  // Should + verb + duration tail. Same tightening as the leading 'will
  // take' rule: 'should ship by EOD' must include a quantifier.
  new RegExp(String.raw`\bshould\s+(?:be|ship|finish|complete|land)\s+(?:by|in|within)\s+(?:(?:about|around)\s+)?(?:next\s+)?(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`, 'i'),
];

/** Pronouns, function words and modal verbs the regex set already gates on; dropped before class resolution so overlap comes from domain tokens. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'in', 'on', 'at', 'of',
  'by', 'with', 'my', 'your', 'our', 'their', 'its', 'it', 'this', 'that',
  'these', 'those', 'will', 'should', 'can', 'i', 'we', 'they', 'he', 'she',
  'is', 'be', 'was', 'are', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
  'from', 'as', 'so', 'than', 'then',
  // Verbs inside FORWARD_CLAIM_PATTERNS gate the regex but are no signal for class resolution; listing them keeps them out of the classQueryTokens overlap.
  'take', 'taken', 'takes', 'ship', 'ships', 'finish', 'complete', 'land',
  'eta', 'estimate', 'estimated', 'next', 'about', 'around',
  // Every forward-claim phrase contains a duration unit by design; letting it through would let a class tag containing 'days' win or tie on the unit.
  'day', 'days', 'week', 'weeks', 'month', 'months',
  'hour', 'hours', 'hr', 'hrs',
  'min', 'mins', 'minute', 'minutes', 'sec', 'secs', 'second', 'seconds',
]);

export interface ForwardClaimMatch {
  /** The regex match snippet (e.g. "will take"), surfaced in `PlanningFallacyHint.detectedPhrase` so the agent sees WHY the hint appeared. */
  phrase: string;
  /** Lower-cased non-stop-word tokens (len >= 3) from the FULL query, not just the match; the class resolver scores them against class_tag tokens. */
  classQueryTokens: string[];
}

/** Detect whether a recall query carries a forward-prediction phrase; returns the first-match phrase plus class-resolution tokens, else null.
 *  Token extraction runs only on a match, so non-forward queries pay nothing beyond the regex gate. */
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
    // Split on whitespace, hyphen and underscore so `migration-effort` yields ['migration', 'effort'], matching the class-tag split in resolveClassFromTokens.
    .split(/[\s_-]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}
