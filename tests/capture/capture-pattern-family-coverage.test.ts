import { describe, it, expect } from 'vitest';
import { extractFromTexts } from '../../src/surface/capture/extract.js';
import { isContentWorthStoring } from '../../src/base/memory/memory-quality.js';

describe('every pattern family still extracts', () => {
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
    ['error/issuewas', 'The issue was the reserve loop did not dedupe entries.'],
    ['decision/goingwith', "We're going with the batched writer approach."],
  ];

  const EXPECT_NULL: Array<[string, string]> = [
    ['pref/rather', 'I would rather batch the writes than lock the table.'],
    ['error/failed', 'The build failed because the token had expired.'],
    ['error/bugwas', 'The bug was the offset assumed group one started the match.'],
    ['error/causewas', 'The cause was a stale base branch in the worktree.'],
    ['rule/importantshort', 'Important: rotate the token first.'],
  ];

  for (const [name, text] of EXPECT_NULL) {
    it(`${name} is still a known non-match`, () => {
      const got = extractFromTexts([text])[0]?.content ?? null;
      expect(got, `${name} started matching - intended, or a silent change?`).toBeNull();
    });
  }

  const DUPLICATED_WORD = /\b(\w+)\s+\1\b/;

  for (const [name, text] of cases) {
    it(`${name} extracts without duplication`, () => {
      const got = extractFromTexts([text])[0]?.content ?? null;
      expect(got, `${name} stopped extracting`).toMatch(/\S/);
      expect(got!, `${name} duplicated a word`).not.toMatch(DUPLICATED_WORD);
    });
  }

  it('ship gate: chat acronyms do not buy a specificity bypass', () => {
    for (const junk of ['TODO fix this thing', 'LGTM ship it', 'FYI all done here', 'IIRC that was fine']) {
      expect(isContentWorthStoring(junk), `${junk} must stay rejected`).toBe(false);
    }
    for (const real of [
      'every PR needs two approvals',
      'the CI runs on every push here',
      'restart the DB pool after deploy',
    ]) {
      expect(isContentWorthStoring(real), `${real} must be stored`).toBe(true);
    }
    expect(isContentWorthStoring('FIXED SIGNALS')).toBe(false);
  });

  it('the duplication assertion is not vacuous', () => {
    expect('decided to to pin the version').toMatch(DUPLICATED_WORD);
    expect('go with  with SQLite').toMatch(DUPLICATED_WORD);
    expect('decided to pin the version').not.toMatch(DUPLICATED_WORD);
  });
});
