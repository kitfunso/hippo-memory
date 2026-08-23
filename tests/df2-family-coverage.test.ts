import { describe, it, expect } from 'vitest';
import { extractFromText } from '../src/capture.js';

/**
 * Family coverage sweep (DF2).
 *
 * The adversarial corpus in df2-capture-coherence.test.ts proves the clause
 * scanner handles hard TEXT SHAPES. It could not catch a whole pattern family
 * silently ceasing to match - and one did: clause-bounding shortened
 * "The rule is every PR needs two approvals, no exceptions." to "every PR
 * needs two approvals", which then fell under the audit layer's 40-char
 * vagueness gate and was DROPPED. A rule that stored before this branch
 * stopped storing, and every shape-focused test stayed green.
 *
 * So this file asserts the complementary property: every pattern family still
 * EXTRACTS, and none of them duplicates text (the DECISION_PATTERNS offset
 * defect). Shape correctness and family coverage are different failures, and
 * only one of them was being tested.
 */
describe('DF2: every pattern family still extracts', () => {
  const cases: Array<[string, string]> = [
    ['rule/never', 'Never use --no-verify on git commits in this project.'],
    ['rule/always', 'Always run the migration before deploying, then verify.'],
    ['rule/must', 'You must not commit the .env file to this repository.'],
    ['rule/dont', "Don't ever force-push to master, it rewrites history."],
    ['rule/theruleis', 'The rule is every PR needs two approvals, no exceptions.'],
    ['rule/important', 'Important: rotate the token before the release ships.'],
    ['rule/makesure', 'Make sure to run the linter, then push the branch.'],
    ['rule/ensure', 'Ensure the cache is warm before benchmarking, then record.'],
    ['rule/rulecolon', 'Rule: every PR needs two approvals.'],
    ['rule/short', 'Always rotate the token before release.'],
    ['rule/decisioncolon', 'Decision: we use DuckDB for all analytics.'],
    ['decision/wedecided', 'We decided to pin the version to 1.35.0.'],
    ['decision/lets', "Let's go with SQLite for the store."],
    ['decision/decided', 'We decided to use Postgres for the primary store.'],
    ['pref/prefer', 'Prefer using SQLite instead of Postgres for local runs.'],
  ];

  // Shapes that extract NOTHING on this branch and extracted nothing on
  // master either. They are asserted, not skipped: an early `return` would
  // make them pass without checking anything, so a known-null shape quietly
  // starting to match - or a live one going dark - would be invisible. That
  // is the same vacuity trap as the mangled regex below. Codex P2, r8.
  const EXPECT_NULL: Array<[string, string]> = [
    ['decision/goingwith', "We're going with the batched writer approach."],
    ['pref/rather', 'I would rather batch the writes than lock the table.'],
    ['error/failed', 'The build failed because the token had expired.'],
    ['error/issuewas', 'The issue was the reserve loop did not dedupe entries.'],
    ['error/bugwas', 'The bug was the offset assumed group one started the match.'],
    ['error/causewas', 'The cause was a stale base branch in the worktree.'],
    ['rule/importantshort', 'Important: rotate the token first.'],
  ];

  for (const [name, text] of EXPECT_NULL) {
    it(`${name} is still a known non-match`, () => {
      const got = extractFromText(text)[0]?.content ?? null;
      expect(got, `${name} started matching - intended, or a silent change?`).toBeNull();
    });
  }

  // A word repeated back-to-back, e.g. "decided to to pin" - the signature of
  // the group-offset defect. Written as a literal so no escaping layer can
  // turn the backreference into control BYTES, which is exactly what happened
  // when this file was first generated: the assertion compiled to a pattern
  // over 0x08/0x01 that could never match, and the check passed vacuously.
  const DUPLICATED_WORD = /\b(\w+)\s+\1\b/;

  for (const [name, text] of cases) {
    it(`${name} extracts without duplication`, () => {
      const got = extractFromText(text)[0]?.content ?? null;
      expect(got, `${name} stopped extracting`).toBeTruthy();
      expect(got!, `${name} duplicated a word`).not.toMatch(DUPLICATED_WORD);
    });
  }

  it('the duplication assertion is not vacuous', () => {
    // Guards the guard. A regex mangled into control bytes still "passes"
    // every negative assertion above; only a positive case proves it works.
    expect('decided to to pin the version').toMatch(DUPLICATED_WORD);
    expect('go with  with SQLite').toMatch(DUPLICATED_WORD);
    expect('decided to pin the version').not.toMatch(DUPLICATED_WORD);
  });
});
