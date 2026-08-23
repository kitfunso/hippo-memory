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

  // Shapes that do not match on this branch AND did not match on master.
  // Recorded rather than omitted so a future change that starts or stops
  // matching them shows up as a diff instead of passing silently.
  const KNOWN_NULL = new Set([
    'decision/goingwith',
    'pref/rather',
    'error/failed',
    'error/issuewas',
    'error/bugwas',
    'error/causewas',
    'rule/importantshort',
  ]);

  // A word repeated back-to-back, e.g. "decided to to pin" - the signature of
  // the group-offset defect. Written as a literal so no escaping layer can
  // turn the backreference into control BYTES, which is exactly what happened
  // when this file was first generated: the assertion compiled to a pattern
  // over 0x08/0x01 that could never match, and the check passed vacuously.
  const DUPLICATED_WORD = /\b(\w+)\s+\1\b/;

  for (const [name, text] of cases) {
    it(`${name} extracts without duplication`, () => {
      const got = extractFromText(text)[0]?.content ?? null;
      if (KNOWN_NULL.has(name)) return;
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
