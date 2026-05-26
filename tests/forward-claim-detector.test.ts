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
});
