import { FORWARD_CLAIM_STOPWORDS } from '../../base/util/stopwords.js';
import { CJK_LETTERS } from '../../base/util/tokenize.js';

const DURATION_TAIL =
  String.raw`(?:about|around|~|≈)?\s*(?:\d+|a|an|one)\s*` +
  String.raw`(?:day|week|month|hour|hr|min(?:ute)?|sec(?:ond)?)s?\b`;

const FORWARD_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`\b(?:will|should|gonna|going\s+to)\s+take\s+${DURATION_TAIL}`, 'i'),
  new RegExp(
    String.raw`\bship(?:ping|s)?\s+(?:by|in)\s+(?:(?:about|around)\s+)?(?:next\s+)?` +
      String.raw`(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`,
    'i',
  ),
  /\bestimate(?:d)?\s+(?:at\s+)?(?:~|≈|about|around)?\s*\d+/i,
  /\b(?:by|in|within)\s+(?:about|around|~)?\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  /\bETA\s*(?:is|:)?\s*\d+/i,
  /\b(?:by|before)\s+next\s+(?:week|month|sprint|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /(?<=^|\s)~\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  new RegExp(
    String.raw`\bshould\s+(?:be|ship|finish|complete|land)\s+(?:by|in|within)\s+(?:(?:about|around)\s+)?(?:next\s+)?` +
      String.raw`(?:${DURATION_TAIL}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`,
    'i',
  ),
];

export interface ForwardClaimMatch {
  phrase: string;
  classQueryTokens: string[];
}

/**
 * Detect whether a recall query carries a forward-prediction phrase; returns the first-match
 * phrase plus class-resolution tokens, else null. Token extraction runs only on a match, so
 * non-forward queries pay nothing beyond the regex gate. */
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

const NOT_CLASS_WORD = new RegExp(String.raw`[^a-z0-9\s_${CJK_LETTERS}-]`, 'gu');

function extractClassQueryTokens(queryText: string): string[] {
  return (
    queryText
      .toLowerCase()
      // Strip everything that's not alphanum, CJK, whitespace, hyphen or underscore.
      .replace(NOT_CLASS_WORD, ' ')
      // Split on whitespace, hyphen and underscore, matching the class-tag split in resolveClass.
      .split(/[\s_-]+/)
      .filter((t) => t.length >= 3 && !FORWARD_CLAIM_STOPWORDS.has(t) && !/^\d+$/.test(t))
  );
}
