import { describe, expect, it } from 'vitest';

import { extractFromText } from '../src/capture/extract.js';

/**
 * DF2 — capture extractor: keyword-preserving, clause-bounded capture.
 * Plan: docs/plans/2026-08-23-df2-capture-anchoring.md
 *
 * `extractFromText` is a pure function (no store, no I/O) — the exported
 * seam the plan names. These are direct unit tests against it; no store or
 * mocks are needed because nothing here touches persistence.
 */
describe('capture coherence', () => {
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

  it('3. a whole sentence keeps its consequence: the "so it is" tail stays attached', () => {
    const items = extractFromText(
      'I have never seen this test fail on master before, so it is probably a flake.'
    );
    expect(items.map((i) => i.content)).toEqual(['I have never seen this test fail on master before, so it is probably a flake']);
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

    // COLON labels ("decision:", "error:") are dropped - they name the
    // category, which is already on the item. "the X is/was" is KEPT.
    //
    // This reverses an earlier revision of this test, and the reversal is the
    // point: dropping "the X is/was" too left the residue starting with
    // "to ", which isFragment rejects outright, so "The plan is to ship on
    // Friday" and "The fix was to bump the pool timeout" stored NOTHING where
    // every prior version stored them. Silent loss on two high-traffic
    // patterns, found only at the ship gate. The AT1 rejected-value evidence
    // that motivated label-dropping involved colon labels exclusively
    // (tests/rejection-acceptance.test.ts still passes), so the narrow rule
    // keeps that guarantee without the collateral loss.
    const error = extractFromText('The issue was that the reserve loop did not dedupe entries.');
    expect(error).toHaveLength(1);
    expect(error[0].category).toBe('error');
    expect(error[0].content.toLowerCase()).toContain('reserve loop');

    // the regression this narrowing exists to prevent
    const plan = extractFromText('The plan is to ship the DF2 branch on Friday afternoon, pending QA signoff.');
    expect(plan, 'a "the plan is to ..." memory must not vanish').toHaveLength(1);
    expect(plan[0].content.toLowerCase()).toContain('ship the df2 branch');
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

  it('9. upper bound: a sentence of 500 chars or fewer is stored whole, a longer one is skipped, never cut', () => {
    const kept = `Always keep going ${'x'.repeat(400)} no matter what happens here today`;
    expect(extractFromText(kept).map((i) => i.content)).toEqual([kept]);
    expect(extractFromText(`Always keep going ${'x'.repeat(500)} no matter what happens here today`)).toEqual([]);
  });

  /**
   * Ship-gate findings. Every case here is a regression this branch
   * introduced against master, each verified by running BOTH versions - not
   * inferred. All three survived twelve codex rounds and five reviewers,
   * because they live at the interaction between the new scanner and gates
   * nobody re-swept.
   */
  it('17. ship gate: shorter-but-correct content must not fall under a downstream gate', () => {
    // isFragment rejects content starting with "to " under 50 chars. Dropping
    // the "the X is/was" label left exactly that residue, so these stored
    // NOTHING while master stored them. Absence of a memory is invisible -
    // no error, no log, nothing to notice in the field.
    const plan = extractFromText('The plan is to ship the DF2 branch on Friday afternoon, pending QA signoff.');
    expect(plan, 'a "the plan is to ..." memory must not vanish').toHaveLength(1);

    const fix = extractFromText('The fix was to bump the pool timeout to 30s, because the recycler defaults were too aggressive.');
    expect(fix, 'a "the fix was to ..." memory must not vanish').toHaveLength(1);
    expect(fix[0].content).toContain('pool timeout');
  });

  it('18. ship gate: closing a literal uses the same shape test as opening', () => {
    // The open decision took twelve rounds of care; the close accepted any
    // bare quote. So a possessive INSIDE a literal closed it early and the
    // comma after read as a clause boundary - a mid-literal fragment that
    // then passes the write gate, the exact defect this branch removes, on
    // ordinary prose master handles correctly.
    const items = extractFromText("Always pass 'user's a, b list' to the parser.");
    expect(items).toHaveLength(1);
    expect(items[0].content, 'possessive inside a literal must not close it')
      .toContain("'user's a, b list'");
  });

  // Whole-sentence capture never decides where a quote opens or closes, so the shapes the clause scanner could not resolve come through intact.
  it('16. quote roles no longer matter: ambiguous quotes keep the whole sentence', () => {
    for (const text of [
      "Always run 'echo a, b ';then verify.",
      "Always keep 'em enabled, then set ';foo, after restart.",
      "Always pass 'a, ('.trim() to the parser, then verify.",
    ]) expect(extractFromText(text).map((i) => i.content)).toEqual([text.slice(0, -1)]);
    expect(extractFromText('Never use --no-verify on git commits in this project.')[0]?.content)
      .toContain('Never');
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

  it('12. "the X is" and "the X was" behave identically', () => {
    // The original defect two reviewers found was an INCONSISTENCY: the
    // discriminator knew "the X is" but not "the X was", so one kept its
    // label and the other dropped it. Consistency was the requirement; which
    // way to resolve it was the open choice.
    //
    // It was first resolved by dropping BOTH, which turned out to cause
    // silent data loss (see test 6) because the residue starts with "to ".
    // It is now resolved by KEEPING both. The invariant the reviewers
    // actually asked for - identical handling - still holds, and is what
    // this test pins.
    const wasItems = extractFromText('The issue was the config file was missing from the deploy bundle.');
    const isItems = extractFromText('The issue is the config file goes missing from the deploy bundle.');
    expect(wasItems).toHaveLength(1);
    expect(isItems).toHaveLength(1);
    expect(wasItems[0].content.toLowerCase()).toContain('the issue was');
    expect(isItems[0].content.toLowerCase()).toContain('the issue is');
    // both keep their content, neither is truncated to the label
    expect(wasItems[0].content.toLowerCase()).toContain('config file');
    expect(isItems[0].content.toLowerCase()).toContain('config file');
  });

  // Commas, brackets and apostrophes inside a sentence must not cut it.
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
      expect(extractFromText(text).map((i) => i.content), text).toEqual([text.slice(0, -1)]);
    }
    for (const text of [
      "Always pass '" + 'a, ' + 'x'.repeat(600) + "' to the parser.",
      "Always keep 'em enabled, then " + 'y'.repeat(520) + " check user's config.",
    ]) expect(extractFromText(text), 'a sentence over 500 chars is skipped, never cut').toEqual([]);
  });
});
