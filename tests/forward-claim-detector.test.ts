/**
 * J3.2 forward-claim detector — unit tests.
 *
 * Calibration: HIGH PRECISION, LOW RECALL. Patterns are intentionally
 * narrow; expect negative cases to outnumber positives. Documented in
 * src/forward-claim-detector.ts header.
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 1, Task 9).
 */

import { describe, it, expect } from 'vitest';
import { detectForwardClaim } from '../src/forward-claim-detector.js';

describe('detectForwardClaim — positive matches', () => {
  it('matches "will take" verb phrase', () => {
    const m = detectForwardClaim('this migration will take 3 days');
    expect(m).not.toBeNull();
    expect(m!.phrase.toLowerCase()).toContain('will take');
  });

  it('matches "should take" verb phrase', () => {
    const m = detectForwardClaim('the refactor should take a week');
    expect(m).not.toBeNull();
  });

  it('matches "ship by" verb phrase', () => {
    const m = detectForwardClaim('we should ship by Friday');
    expect(m).not.toBeNull();
  });

  it('matches "estimate <N>"', () => {
    const m = detectForwardClaim('estimate 5 days for the auth rewrite');
    expect(m).not.toBeNull();
    expect(m!.phrase.toLowerCase()).toContain('estimate');
  });

  it('matches "ETA 10 days"', () => {
    const m = detectForwardClaim('ETA: 10 days');
    expect(m).not.toBeNull();
  });

  it('matches "by next <day>"', () => {
    const m = detectForwardClaim('done by next Monday');
    expect(m).not.toBeNull();
  });

  it('matches "in ~2 weeks"', () => {
    const m = detectForwardClaim('in ~2 weeks');
    expect(m).not.toBeNull();
  });

  // Codex review round 1 caught: \b before ~ requires a word char
  // immediately preceding. These three cases previously failed silently.
  it('matches "~3 days for migration" (tilde at start of string)', () => {
    const m = detectForwardClaim('~3 days for migration');
    expect(m).not.toBeNull();
  });

  it('matches "estimate ~3 days" (tilde after whitespace)', () => {
    const m = detectForwardClaim('estimate ~3 days');
    expect(m).not.toBeNull();
  });

  it('matches "~5 hour build" (tilde after newline)', () => {
    const m = detectForwardClaim('build target:\n~5 hour build');
    expect(m).not.toBeNull();
  });

  it('matches "should finish by"', () => {
    const m = detectForwardClaim('should finish by Tuesday');
    expect(m).not.toBeNull();
  });

  it('matches "will take 1 hour"', () => {
    const m = detectForwardClaim('this will take 1 hour');
    expect(m).not.toBeNull();
  });

  it('case-insensitive', () => {
    const m = detectForwardClaim('Will Take 3 Days');
    expect(m).not.toBeNull();
  });
});

describe('detectForwardClaim — negative cases (no false positives)', () => {
  it('returns null for past-tense statement', () => {
    expect(detectForwardClaim('the migration took 3 days last week')).toBeNull();
  });

  it('returns null for query without quantifier', () => {
    expect(detectForwardClaim('what should I do?')).toBeNull();
  });

  it('returns null for "by friday" alone (no "next" prefix)', () => {
    expect(detectForwardClaim('by friday')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectForwardClaim('')).toBeNull();
  });

  it('returns null for unrelated knowledge query', () => {
    expect(detectForwardClaim('tell me about the auth flow')).toBeNull();
  });

  it('returns null for code snippet without forward verb', () => {
    expect(detectForwardClaim('useEffect cleanup function pattern')).toBeNull();
  });

  it('returns null for "BETAtesting" — word boundary respected on ETA', () => {
    expect(detectForwardClaim('BETAtesting documentation')).toBeNull();
  });

  // Codex round 2 P2: verb-only matches without a quantifier produced
  // cry-wolf hints on non-estimate queries. These cases used to match
  // and produce planning-fallacy hints when the query shared a token
  // with an existing prediction class.
  it('returns null for "who will take ownership of auth?" (no time quantifier)', () => {
    expect(detectForwardClaim('who will take ownership of auth?')).toBeNull();
  });

  it('returns null for "how does this ship in Docker?" (ship-in without duration)', () => {
    expect(detectForwardClaim('how does this ship in Docker?')).toBeNull();
  });

  it('returns null for "should ship by EOD" (no duration unit)', () => {
    expect(detectForwardClaim('should ship by EOD')).toBeNull();
  });

  it('returns null for "ship by close of business" (no duration unit)', () => {
    expect(detectForwardClaim('ship by close of business')).toBeNull();
  });

  it('returns null for "estimate ownership transfer" (no digit after estimate)', () => {
    expect(detectForwardClaim('estimate ownership transfer')).toBeNull();
  });
});

describe('detectForwardClaim — token extraction', () => {
  it('strips stop words and short tokens', () => {
    const m = detectForwardClaim('this auth migration will take 3 days');
    expect(m).not.toBeNull();
    // Should contain "auth" and "migration" (domain tokens), not "this" / "will" / "take"
    expect(m!.classQueryTokens).toContain('auth');
    expect(m!.classQueryTokens).toContain('migration');
    expect(m!.classQueryTokens).not.toContain('this');
    expect(m!.classQueryTokens).not.toContain('will');
    expect(m!.classQueryTokens).not.toContain('take');
  });

  it('drops pure-numeric tokens', () => {
    const m = detectForwardClaim('refactor will take 5 days');
    expect(m).not.toBeNull();
    expect(m!.classQueryTokens).toContain('refactor');
    expect(m!.classQueryTokens).not.toContain('5');
  });

  it('keeps tokens >= 3 chars only', () => {
    const m = detectForwardClaim('os will take 3 days');
    expect(m).not.toBeNull();
    // "os" is 2 chars — dropped
    expect(m!.classQueryTokens).not.toContain('os');
  });

  it('handles punctuation in query', () => {
    const m = detectForwardClaim('migration-effort: will take 3 days?');
    expect(m).not.toBeNull();
    expect(m!.classQueryTokens).toContain('migration');
    expect(m!.classQueryTokens).toContain('effort');
  });

  // Codex round 2 P3: duration units leaking into class tokens caused
  // wrong-class wins / ties when a tenant had a class containing 'days'
  // or 'weeks'. These tokens MUST drop from class resolution because
  // every forward-claim regex requires them as the quantifier suffix.
  it('strips duration units (days, weeks, etc.) from class tokens', () => {
    const m = detectForwardClaim('migration effort will take 3 days');
    expect(m).not.toBeNull();
    expect(m!.classQueryTokens).toContain('migration');
    expect(m!.classQueryTokens).toContain('effort');
    expect(m!.classQueryTokens).not.toContain('days');
    expect(m!.classQueryTokens).not.toContain('day');
  });

  it('strips week, month, hour, minute units too', () => {
    const m = detectForwardClaim('auth refactor will take 2 weeks');
    expect(m).not.toBeNull();
    expect(m!.classQueryTokens).not.toContain('weeks');
    expect(m!.classQueryTokens).not.toContain('week');
  });

  it('strips singular and plural duration units', () => {
    const m = detectForwardClaim('this should take 1 hour');
    expect(m).not.toBeNull();
    expect(m!.classQueryTokens).not.toContain('hour');
    expect(m!.classQueryTokens).not.toContain('hours');
  });
});
