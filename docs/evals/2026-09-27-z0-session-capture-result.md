# Z0 SessionEnd capture extractor: result

**Date:** 2026-09-27. **Status:** COMPLETED. **Verdict: NO VERDICT.** The two labellers agreed on 70 of 100 items, under the locked 80% floor. On the primary labels the new extractor also misses the 0.60 useful-rate bar (0.48). Nothing ships; this doc is the deliverable.

Prereg: `docs/evals/2026-09-27-z0-session-capture-prereg.md`, locked at `b4547f9`. Extractor frozen at `26444bf` (branch `fix/capture-extractor`) before the one held-out run. The module, its tests, the glossary term and the changelog fragment are removed in the same commit as this doc, as the prereg requires when the extractor does not pass. `26444bf` stays in the branch history so the next attempt starts from it.

## Held-out (the verdict)

73 held-out sessions. Primary labels (Opus, whole pool, text only, arm hidden):

| arm | memories | useful | useful rate | 95% Wilson | per session mean / max | sessions with none |
|---|---|---|---|---|---|---|
| A0 old (tail, `extractFromText`) | 70 | 4 | 0.057 | 0.022 to 0.138 | 0.96 / 6 | 37 |
| A1 new, tail window | 23 | 11 | 0.478 | 0.292 to 0.670 | 0.32 / 3 | 57 |
| A2 new, whole session | 97 | 33 | 0.340 | 0.254 to 0.439 | 1.33 / 3 | 32 |

Pool: 170 distinct texts (20 written by both A1 and A2; none shared with A0).

| rule | needed | got | holds |
|---|---|---|---|
| 1. A1 memories | at least 15 | 23 | yes |
| 2. label agreement | at least 80% | 70% | **no** |
| 3. A1 useful rate | at least 0.60 | 0.478 | **no** |
| 4. A1 minus A0 rate | at least 0.25 | 0.421 | yes |
| 5. A1 useful count vs A0 | at least 0.8 x 4 | 11 | yes |
| 6. max memories per session | at most 3 | 3 | yes |

Rule 2 fails, so the locked outcome is no verdict. Rule 3 would fail it even with agreement.

**Window.** The tail stays. A2 needed its own rate to be at least 0.60 and within 0.05 of A1's; it got 0.340.

`has_why` among useful memories: A0 1 of 4, A1 6 of 11, A2 24 of 33 (reported only).

## Label check

Sonnet labelled a fixed-seed random 100 of the pool, blind to arm and to the Opus labels. Raw agreement 0.70, Cohen's kappa 0.39. Every disagreement went one way: Sonnet said useful and Opus said not useful (30 items); the reverse never happened. So the two agree on what is junk and split on the middle band: statements that are true and general but thin, or that name a subject only by "the fix" or "the cause".

For contrast only, not a verdict: on the sample items, Sonnet called 12 of 45 A0 texts useful, 4 of 9 A1 texts, and 37 of 54 A2 texts. A lenient reader would rank the whole-session arm first. The rubric as written did not produce one reading of "useful", which is the first thing the next attempt must fix.

## Error analysis (after scoring, A1's 12 not-useful memories)

Read after the one score; categories only, no corpus text.

- **Subject hidden behind a definite noun (5).** "The cause was...", "The fix is...", "Root cause is...": the lesson cue fires, but "the fix" names no component, so the memory cannot stand alone. The DEICTIC gate catches "It" and "This" but not "The fix".
- **Agent narration without a first-person pronoun (3).** Status lines that open with a past participle or a bare past-tense verb: the assistant-"I" gate misses passive and subjectless narration.
- **True at the time, not durable (2).** A one-off repo state phrased with "never", and a process note whose object is a bare pronoun.
- **Too vague or off-task (2).** A one-line style maxim with no subject, and a product remark.

Against the old arm the gain is real on both labellers: A0 wrote 70 memories and Opus found 4 useful; A1 wrote 23 and found 11. The rule set fixes the root cause the prereg named (subject and reason dropped by keyword-anchored clause cuts), but it still admits memories whose subject is a pronoun-like noun phrase.

## What the next attempt should take from this

1. Fix the rubric first. Give the labellers worked examples of the middle band ("The fix is X" with no component; a true general maxim), and check agreement on the tune split before the freeze, as Z3 did.
2. Add a gate for subjectless definite leads ("the fix/cause/issue/problem ... is") unless the sentence also names a code token (backticked name, file, flag or issue number), and for subjectless agent status lines.
3. Re-register, tune on the existing tune split, and score on sessions after 2026-09-27. The held-out split here has been read for error analysis and is spent.
4. The whole-session window is not ruled out: under the lenient reader it scored best. It needs its own arm once the tail extractor passes.

## Disclosures

- The rules were tuned on the 62 tune sessions only. Before the freeze, held-out was profiled for counts (70 old-arm memories, per-session spread) and no held-out text was read.
- One user wrote every session in the corpus.
- No corpus text is quoted in this doc; the category examples above are generic phrase shapes.

## Regenerate

Private, outside the repo, against a build of `26444bf` and a copy of the `09343e8` dist: `node run-arms.mjs heldout <dist>`, `node pool.mjs`, then the two label files, then `node score.mjs`. Parity check (new dist vs the tuned prototype on tune): 124 runs, 0 diffs.
