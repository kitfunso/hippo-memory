import { describe, expect, it } from 'vitest';

import { extractFromTexts } from '../../src/surface/capture/extract.js';

describe('capture coherence', () => {
  it('1. inversion pin: a prohibition keeps its keyword, not just the object', () => {
    const items = extractFromTexts(['Never use --no-verify on git commits in this project.']);
    expect(items).toHaveLength(1);
    expect(items[0].content.toLowerCase()).toContain('never');
    expect(items[0].content.toLowerCase()).not.toBe('use --no-verify on git commits in this project');
  });

  it('2. fragment self-rejects: clause-bounding shortens it, the write gate then drops it', () => {
    const items = extractFromTexts([
      'The captures had a few problems (two had never got entries), plus one documented exception.',
    ]);
    expect(items).toHaveLength(0);
  });

  it('3. a whole sentence keeps its consequence: the "so it is" tail stays attached', () => {
    const items = extractFromTexts(['I have never seen this test fail on master before, so it is probably a flake.']);
    expect(items.map((i) => i.content)).toEqual([
      'I have never seen this test fail on master before, so it is probably a flake',
    ]);
  });

  it('4. periods inside tokens survive clause-bounding', () => {
    const items = extractFromTexts(['Never edit capture.ts and audit.ts in the same commit without running npm test.']);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('capture.ts');
  });

  it('5. genuine rules keep their keyword — must-never and should-always corpus', () => {
    const mustNever = extractFromTexts(['You must never commit the .env file to the repository.']);
    expect(mustNever).toHaveLength(1);
    expect(mustNever[0].content.toLowerCase()).toContain('must never');
    expect(mustNever[0].content).toContain('.env');

    const shouldAlways = extractFromTexts(['We should always run the suite twice locally before merging any change.']);
    expect(shouldAlways).toHaveLength(1);
    expect(shouldAlways[0].content.toLowerCase()).toContain('always run the suite twice');
  });

  it('6. DECISION and ERROR sets follow the same semantic-vs-label split as RULE', () => {
    const decision = extractFromTexts(['We decided to pin the version to avoid a repeat of the outage.']);
    expect(decision).toHaveLength(1);
    expect(decision[0].category).toBe('decision');
    expect(decision[0].content.toLowerCase()).toContain('decided');

    const error = extractFromTexts(['The issue was that the reserve loop did not dedupe entries.']);
    expect(error).toHaveLength(1);
    expect(error[0].category).toBe('error');
    expect(error[0].content.toLowerCase()).toContain('reserve loop');

    const plan = extractFromTexts(['The plan is to ship the DF2 branch on Friday afternoon, pending QA signoff.']);
    expect(plan, 'a "the plan is to ..." memory must not vanish').toHaveLength(1);
    expect(plan[0].content.toLowerCase()).toContain('ship the df2 branch');
  });

  it('7. documented behaviour change: a short imperative is now captured', () => {
    const items = extractFromTexts(['Never force push to main.']);
    expect(items).toHaveLength(1);
    expect(items[0].content.toLowerCase()).toContain('never force push to main');
  });

  it('8. pattern-set coverage sweep: one post-fix case per pattern array', () => {
    const cases: Array<{
      array: string;
      text: string;
      category: string;
      mustContain: string;
      mustNotContain?: string;
    }> = [
      {
        array: 'DECISION',
        text: "Let's go with the SQLite-backed store for the local cache.",
        category: 'decision',
        mustContain: 'go with',
      },
      {
        array: 'RULE',
        text: 'Always run lint before pushing any change.',
        category: 'rule',
        mustContain: 'always run lint',
      },
      {
        array: 'ERROR',
        text: 'Error: the migration silently dropped the last batch of rows.',
        category: 'error',
        mustContain: 'migration silently dropped',
        mustNotContain: 'error:',
      },
      {
        array: 'PREFERENCE',
        text: 'Avoid using synchronous fs calls in the hot path.',
        category: 'preference',
        mustContain: 'avoid using synchronous fs calls',
      },
    ];

    for (const c of cases) {
      const items = extractFromTexts([c.text]);
      expect(items, `${c.array} array: expected exactly one item from "${c.text}"`).toHaveLength(1);
      expect(items[0].category).toBe(c.category);
      expect(items[0].content.toLowerCase()).toContain(c.mustContain);
      if (c.mustNotContain) {
        expect(
          items[0].content.toLowerCase(),
          `${c.array} array: label prefix must be dropped, not stored`,
        ).not.toContain(c.mustNotContain);
      }
    }
  });

  it('9. upper bound: a sentence of 500 chars or fewer is stored whole, a longer one is skipped, never cut', () => {
    const kept = `Always keep going ${'x'.repeat(400)} no matter what happens here today`;
    expect(extractFromTexts([kept]).map((i) => i.content)).toEqual([kept]);
    expect(extractFromTexts([`Always keep going ${'x'.repeat(500)} no matter what happens here today`])).toEqual([]);
  });

  it('17. ship gate: shorter-but-correct content must not fall under a downstream gate', () => {
    const plan = extractFromTexts(['The plan is to ship the DF2 branch on Friday afternoon, pending QA signoff.']);
    expect(plan, 'a "the plan is to ..." memory must not vanish').toHaveLength(1);

    const fix = extractFromTexts([
      'The fix was to bump the pool timeout to 30s, because the recycler defaults were too aggressive.',
    ]);
    expect(fix, 'a "the fix was to ..." memory must not vanish').toHaveLength(1);
    expect(fix[0].content).toContain('pool timeout');
  });

  it('18. ship gate: closing a literal uses the same shape test as opening', () => {
    const items = extractFromTexts(["Always pass 'user's a, b list' to the parser."]);
    expect(items).toHaveLength(1);
    expect(items[0].content, 'possessive inside a literal must not close it').toContain("'user's a, b list'");
  });

  it('16. quote roles no longer matter: ambiguous quotes keep the whole sentence', () => {
    for (const text of [
      "Always run 'echo a, b ';then verify.",
      "Always keep 'em enabled, then set ';foo, after restart.",
      "Always pass 'a, ('.trim() to the parser, then verify.",
    ]) {
      expect(extractFromTexts([text]).map((i) => i.content)).toEqual([text.slice(0, -1)]);
    }
    expect(extractFromTexts(['Never use --no-verify on git commits in this project.'])[0]?.content).toContain('Never');
  });

  it('11. clause scan ignores separators inside code delimiters', () => {
    const cases: Array<[string, string]> = [
      ['Always call build(x, y) before deploy.', 'build(x, y)'],
      ['Never pass {a: 1, b: 2} directly to the writer.', '{a: 1, b: 2}'],
      ['Never use arr[0, 1] indexing here.', 'arr[0, 1]'],
    ];
    for (const [text, mustContain] of cases) {
      const items = extractFromTexts([text]);
      expect(items, `expected a capture from "${text}"`).toHaveLength(1);
      expect(items[0].content, `code span must survive clause scanning`).toContain(mustContain);
    }
  });

  it('12. "the X is" and "the X was" behave identically', () => {
    const wasItems = extractFromTexts(['The issue was the config file was missing from the deploy bundle.']);
    const isItems = extractFromTexts(['The issue is the config file goes missing from the deploy bundle.']);
    expect(wasItems).toHaveLength(1);
    expect(isItems).toHaveLength(1);
    expect(wasItems[0].content.toLowerCase()).toContain('the issue was');
    expect(isItems[0].content.toLowerCase()).toContain('the issue is');
    expect(wasItems[0].content.toLowerCase()).toContain('config file');
    expect(isItems[0].content.toLowerCase()).toContain('config file');
  });

  it('13. adversarial prose corpus: real-world text shapes come through as whole sentences', () => {
    const corpus = [
      "Always ensure it's enabled, then restart the service.",
      "Never touch the user's config, it is generated.",
      'Always call build(x, y) before deploy, then tag it.',
      'Never pass {a: 1, b: 2} to the writer, it corrupts rows.',
      'Never edit capture.ts in the same commit as audit.ts, it confuses review.',
      'Always set the flag to "a, b" before running, then verify.',
      "Always pass 'a, b' to the parser, then validate.",
      "Never run 'rm -rf, x' in the deploy script, check first.",
      "Always keep 'em enabled, then restart the service.",
      "Never wait 'til the deploy finishes, check the logs first.",
      'We decided to pin the version to 1.35.0.',
      "Let's go with SQLite for the store.",
      "Always keep 'em enabled, then run '--force, after restart.",
      "Always preserve 'a, b ' exactly, then verify.",
      "Always preserve 'a, b ', then verify.",
      "Always preserve 'a, b'-style text, then verify.",
      "Always keep 'em enabled, then edit '.env, after restart.",
      "Always keep 'em enabled, then call parse('--force, after restart.",
      "Always run 'echo a, b ';then verify.",
      'Always run the suite twice, then deploy.',
    ];
    for (const text of corpus) {
      expect(
        extractFromTexts([text]).map((i) => i.content),
        text,
      ).toEqual([text.slice(0, -1)]);
    }
    for (const text of [
      "Always pass 'a, " + 'x'.repeat(600) + "' to the parser.",
      "Always keep 'em enabled, then " + 'y'.repeat(520) + " check user's config.",
    ]) {
      expect(extractFromTexts([text]), 'a sentence over 500 chars is skipped, never cut').toEqual([]);
    }
  });
});
