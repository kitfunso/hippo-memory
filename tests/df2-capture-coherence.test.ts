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

  /**
   * DOCUMENTED BOUNDARY: locally undecidable quote roles.
   *
   * These assert what the scanner CURRENTLY does on inputs where no local
   * rule can be correct, so a future change to the predicate shows up as a
   * failure here instead of passing silently.
   *
   * The proof is a measured pair. These two quotes have byte-identical
   * neighbours and opposite correct answers:
   *
   *   "run 'echo a, b ';then"   prev=" " next=";" after="t"  -> must CLOSE
   *   "set ';foo, after"        prev=" " next=";" after="f"  -> must NOT
   *
   * Same for prev="(" next="." after=letter, which is a closer in
   * "'a, ('.trim()" and an opener in "parse('.env". Deciding these needs to
   * know whether an earlier quote was an elision or a real opener - global
   * pairing, not neighbour inspection - and pairing itself needs a notion of
   * what a literal "looks like". Twelve review rounds converged here.
   *
   * The scanner favours the shapes that occur in real memory text (quoted
   * shell commands, flags, filenames) and accepts the mirrored ones as a
   * bounded cost: a slightly overlong or slightly short capture, never a
   * semantic inversion, which is the defect this branch exists to fix.
   */
  it('16. known boundary: locally undecidable quote roles are pinned, not fixed', () => {
    // favoured: a quoted shell command closes at the semicolon
    expect(extractFromText("Always run 'echo a, b ';then verify.")[0]?.content)
      .toContain("'echo a, b '");
    // mirrored shape, accepted cost: the clause boundary is swallowed
    expect(extractFromText("Always keep 'em enabled, then set ';foo, after restart.")[0]?.content)
      .toContain("';foo");
    // mirrored shape, accepted cost: a literal ending in an open delimiter
    expect(extractFromText("Always pass 'a, ('.trim() to the parser, then verify.")[0]?.content)
      .toBe("Always pass 'a");
    // and the thing that must NEVER regress, whatever the quote rules do
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

  // STRUCTURAL GUARD — three rounds of defects in this scanner earned it.
  // Each round, adversarial review supplied a prose shape I had not imagined
  // (code delimiters, then apostrophes). Pinning individual cases as they are
  // found is a losing game; this sweep exercises the scanner against the
  // messy realities of English-plus-code in one place, so the NEXT unimagined
  // shape fails here rather than in review.
  it('13. adversarial prose corpus: clause bounding holds across real-world text shapes', () => {
    // `mustNotContain` is optional: a few shapes are purely positive, where
    // the whole literal must survive and no substring of the CORRECT output
    // is a valid negative. Inventing one there would assert nothing, which
    // is the vacuity trap this file already carries a guard against.
    const corpus: Array<{ text: string; mustContain: string; mustNotContain?: string }> = [
      // contractions and possessives (codex P1, round 2)
      { text: "Always ensure it's enabled, then restart the service.",
        mustContain: "it's enabled", mustNotContain: 'restart the service' },
      { text: "Never touch the user's config, it is generated.",
        mustContain: "user's config", mustNotContain: 'it is generated' },
      // code delimiters (codex P1, round 1)
      { text: 'Always call build(x, y) before deploy, then tag it.',
        mustContain: 'build(x, y)', mustNotContain: 'then tag it' },
      { text: 'Never pass {a: 1, b: 2} to the writer, it corrupts rows.',
        mustContain: '{a: 1, b: 2}', mustNotContain: 'it corrupts rows' },
      // periods inside tokens
      { text: 'Never edit capture.ts in the same commit as audit.ts, it confuses review.',
        mustContain: 'capture.ts', mustNotContain: 'confuses review' },
      // double-quoted string containing a separator
      { text: 'Always set the flag to "a, b" before running, then verify.',
        mustContain: '"a, b"', mustNotContain: 'then verify' },
      // single-quoted literals containing a separator. An earlier revision
      // ignored the apostrophe entirely and CUT here, storing "Always pass
      // 'a" - which passes the write gate because code punctuation reads as
      // "specific". I had asserted in a code comment that cutting early was
      // "the safe direction" without testing it; codex proved otherwise.
      { text: "Always pass 'a, b' to the parser, then validate.",
        mustContain: "'a, b'", mustNotContain: 'then validate' },
      // NB: the trailing clause must be a token that is not a substring of
      // the kept text - "ever" is inside "Never" and made this assertion
      // vacuous on the first attempt.
      { text: "Never run 'rm -rf, x' in the deploy script, check first.",
        mustContain: "'rm -rf, x'", mustNotContain: 'check first' },
      // elided forms - a leading apostrophe with NO closer. A word-boundary
      // heuristic alone opened quote mode here and never left it, disabling
      // bounding for the rest of the capture. Fixed by verifying the pairing
      // (a closer must exist) rather than guessing from position.
      { text: "Always keep 'em enabled, then restart the service.",
        mustContain: "'em enabled", mustNotContain: 'restart the service' },
      { text: "Never wait 'til the deploy finishes, check the logs first.",
        mustContain: "'til the deploy finishes", mustNotContain: 'check the logs' },
      // a quoted literal whose closer sits past the patterns' 500-char
      // content cap. The scanner used to see only the truncated match, so the
      // closer was invisible and the opener read as prose - it cut inside the
      // literal at the first comma. Fixed by widening the scanner's INPUT to
      // the untruncated sentence; no predicate could have seen this.
      { text: "Always pass '" + 'a, ' + 'x'.repeat(600) + "' to the parser.",
        mustContain: "Always pass 'a, xxx", mustNotContain: "pass 'a'" },
      // DECISION_PATTERNS carry an UNCAPTURED subject before group 1, so an
      // offset derived as match.index + prefix.length lands inside the
      // keyword and duplicates text. Read group 2's real offset instead.
      { text: 'We decided to pin the version to 1.35.0.',
        mustContain: 'decided to pin the version', mustNotContain: 'to to' },
      { text: "Let's go with SQLite for the store.",
        mustContain: 'go with SQLite', mustNotContain: 'with  with' },
      // an elision plus an unrelated IN-WORD apostrophe far downstream. Any
      // apostrophe would satisfy a bare pairing check, re-opening quote mode
      // on the elision; a closer-SHAPED partner does not exist here.
      { text: "Always keep 'em enabled, then " + 'y'.repeat(520) + " check user's config.",
        mustContain: "'em enabled", mustNotContain: 'yyyy' },
      // an elision plus an unmatched quoted token starting with punctuation.
      // "not followed by a letter" alone accepts the quote before --force as
      // a closer, pairing it with 'em and swallowing the clause boundary.
      { text: "Always keep 'em enabled, then run '--force, after restart.",
        mustContain: "'em enabled", mustNotContain: '--force' },
      // a literal whose closer trails whitespace - prev is a SPACE, yet it is
      // a genuine closer, so a tight-before-only rule rejects it.
      { text: "Always preserve 'a, b ' exactly, then verify.",
        mustContain: "'a, b '", mustNotContain: 'then verify' },
      // a literal ending in whitespace and followed by CLAUSE punctuation -
      // whitespace before the closer and a comma after it, so any rule
      // phrased around the preceding character rejects a genuine closer.
      { text: "Always preserve 'a, b ', then verify.",
        mustContain: "'a, b '", mustNotContain: 'then verify' },
      // THE PAIR THAT PROVES THE RULE NEEDS BOTH NEIGHBOURS. Identical
      // following character, opposite roles - only the preceding side
      // differs, so no forward-only test can separate them.
      { text: "Always preserve 'a, b'-style text, then verify.",
        mustContain: "'a, b'-style", mustNotContain: 'then verify' },
      { text: "Always keep 'em enabled, then edit '.env, after restart.",
        mustContain: "'em enabled", mustNotContain: '.env' },
      // an opener sitting tight against an OPENING delimiter. Non-whitespace
      // before it, but "parse('" is an opener position, not a closer.
      { text: "Always keep 'em enabled, then call parse('--force, after restart.",
        mustContain: "'em enabled", mustNotContain: 'parse' },
      // a closer before punctuation that does NOT join tokens. A semicolon
      // ends the literal whatever follows it, unlike the dot in '.env.
      { text: "Always run 'echo a, b ';then verify.",
        mustContain: "'echo a, b '" },
      // plain prose, no traps
      { text: 'Always run the suite twice, then deploy.',
        mustContain: 'run the suite twice', mustNotContain: 'then deploy' },
    ];
    for (const c of corpus) {
      const items = extractFromText(c.text);
      expect(items, `expected a capture from "${c.text}"`).toHaveLength(1);
      const content = items[0].content;
      expect(content, `must keep: ${c.mustContain}`).toContain(c.mustContain);
      if (c.mustNotContain !== undefined) {
        expect(content, `must bound before: ${c.mustNotContain}`).not.toContain(c.mustNotContain);
      }
    }
  });
});
