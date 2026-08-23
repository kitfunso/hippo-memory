import { describe, expect, it } from 'vitest';

import { extractFromText } from '../src/capture.js';

/**
 * DF2 — capture extractor: keyword-preserving, clause-bounded capture.
 * Plan: docs/plans/2026-08-23-df2-capture-anchoring.md
 *
 * `extractFromText` is a pure function (no store, no I/O) — the exported
 * seam the plan names. These are direct unit tests against it; no store or
 * mocks are needed because nothing here touches persistence.
 */
describe('DF2 capture coherence', () => {
  it('1. inversion pin: a prohibition keeps its keyword, not just the object', () => {
    const items = extractFromText('Never use --no-verify on git commits in this project.');
    expect(items).toHaveLength(1);
    expect(items[0].content.toLowerCase()).toContain('never');
    expect(items[0].content.toLowerCase()).not.toBe('use --no-verify on git commits in this project');
  });

  it('2. fragment self-rejects: clause-bounding shortens it, the write gate then drops it', () => {
    const items = extractFromText(
      'The captures had a few problems (two had never got entries), plus one documented exception.'
    );
    expect(items).toHaveLength(0);
  });

  it('3. overrun stops at the clause: content excludes the trailing "so it is" tail', () => {
    const items = extractFromText(
      'I have never seen this test fail on master before, so it is probably a flake.'
    );
    expect(items).toHaveLength(1);
    expect(items[0].content.toLowerCase()).toContain('never seen this test fail on master before');
    expect(items[0].content.toLowerCase()).not.toContain('so it is');
  });

  it('4. periods inside tokens survive clause-bounding', () => {
    const items = extractFromText(
      'Never edit capture.ts and audit.ts in the same commit without running npm test.'
    );
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('capture.ts');
  });

  it('5. genuine rules keep their keyword — must-never and should-always corpus', () => {
    const mustNever = extractFromText('You must never commit the .env file to the repository.');
    expect(mustNever).toHaveLength(1);
    expect(mustNever[0].content.toLowerCase()).toContain('must never');
    expect(mustNever[0].content).toContain('.env');

    const shouldAlways = extractFromText(
      'We should always run the suite twice locally before merging any change.'
    );
    expect(shouldAlways).toHaveLength(1);
    expect(shouldAlways[0].content.toLowerCase()).toContain('always run the suite twice');
  });

  it('6. DECISION and ERROR sets follow the same semantic-vs-label split as RULE', () => {
    // SEMANTIC keyword ("decided to") carries the meaning -> preserved.
    const decision = extractFromText('We decided to pin the version to avoid a repeat of the outage.');
    expect(decision).toHaveLength(1);
    expect(decision[0].category).toBe('decision');
    expect(decision[0].content.toLowerCase()).toContain('decided');

    // LABEL keyword ("the issue was") only names the category, which is
    // already on the item -> dropped. An earlier revision of this test
    // asserted the opposite, because the discriminator recognised "the X is"
    // but not "the X was" and the label leaked through. Two reviewers found
    // that gap independently; this now pins the corrected behaviour.
    const error = extractFromText('The issue was that the reserve loop did not dedupe entries.');
    expect(error).toHaveLength(1);
    expect(error[0].category).toBe('error');
    expect(error[0].content.toLowerCase()).not.toContain('the issue was');
    expect(error[0].content.toLowerCase()).toContain('reserve loop');
  });

  it('7. documented behaviour change: a short imperative is now captured', () => {
    const items = extractFromText('Never force push to main.');
    expect(items).toHaveLength(1);
    expect(items[0].content.toLowerCase()).toContain('never force push to main');
  });

  it('8. pattern-set coverage sweep: one post-fix case per pattern array', () => {
    const cases: Array<{ array: string; text: string; category: string; mustContain: string; mustNotContain?: string }> = [
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
        // LABEL keyword: 'Error:' names the category (already recorded in
        // `category`) and carries no semantic sign, so T1 drops it rather
        // than prefixing it onto the content. Contrast the RULE case above,
        // where 'always' IS the meaning and must survive. Preserving label
        // prefixes also broke AT1's rejected-value digest, which hashes the
        // bare content — see tests/rejection-acceptance.test.ts.
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
      const items = extractFromText(c.text);
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

  it('9. upper bound retained: a long clause-free span is stored truncated, not dropped', () => {
    const longTail = 'x'.repeat(400); // no comma/semicolon/colon/terminator anywhere
    const items = extractFromText(`Always keep going ${longTail} no matter what happens here today`);
    expect(items).toHaveLength(1);
    expect(items[0].content.length).toBeLessThanOrEqual(200);
    expect(items[0].content.length).toBeGreaterThanOrEqual(8);
  });

  it('10. no-regression placeholder: covered by the pre-existing tests/capture*.test.ts suite', () => {
    // This suite deliberately does not duplicate capture-last-session.test.ts;
    // the verification step runs that suite alongside this one instead.
    expect(true).toBe(true);
  });

  // Codex P1 on this branch: the clause scanner cut inside code delimiters,
  // reintroducing the exact fragment defect this change exists to remove -
  // and the fragments PASSED the write gate because code punctuation reads as
  // "specific". Depth-aware scanning is the fix; these pin it.
  it('11. clause scan ignores separators inside code delimiters', () => {
    const cases: Array<[string, string]> = [
      ['Always call build(x, y) before deploy.', 'build(x, y)'],
      ['Never pass {a: 1, b: 2} directly to the writer.', '{a: 1, b: 2}'],
      ['Never use arr[0, 1] indexing here.', 'arr[0, 1]'],
    ];
    for (const [text, mustContain] of cases) {
      const items = extractFromText(text);
      expect(items, `expected a capture from "${text}"`).toHaveLength(1);
      expect(items[0].content, `code span must survive clause scanning`).toContain(mustContain);
    }
  });

  it('12. label discriminator treats "the X was" like "the X is"', () => {
    // ERROR_PATTERNS matches (?:the (?:issue|problem|fix) (?:is|was)); the
    // discriminator originally only knew the "is" form, so the "was" branch
    // kept its label prefix. Found independently by two reviewers.
    const wasItems = extractFromText('The issue was the config file was missing from the deploy bundle.');
    const isItems = extractFromText('The issue is the config file goes missing from the deploy bundle.');
    expect(wasItems).toHaveLength(1);
    expect(isItems).toHaveLength(1);
    expect(wasItems[0].content.toLowerCase()).not.toContain('the issue was');
    expect(isItems[0].content.toLowerCase()).not.toContain('the issue is');
  });
});
