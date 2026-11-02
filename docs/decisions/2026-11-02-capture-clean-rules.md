# Capture fixes cut rules at the extractor, and only repair runs the cut checks

Date: 2026-11-02
Status: accepted
Links: PR #1134 (squash `833bef49b`); plan `docs/plans/2026-11-01-capture-clean-rules-plan.html`; `changelog.d/fix-capture-clean-rules.md`; devrl episode `01M6C3H7K3GSCM8WMFMKY22FV8`

## Context
Hippo 3.1.0 capture split sentences before it removed bold markers. A line such as `- **Volume data.** Never backfill them.` became the row `** Never backfill them`. A sentence that started inside an aside became a row such as `main) Never push on Friday`. On the global store, 76 of 14,365 automatic rows had this damage.

## Constraints and evidence
- `HippoStore` is exported from `src/server.ts`, so `HeldText` in `src/base/ports/store/types.ts` is a published type. The new `pinned` field is optional.
- The repair must run once on stores that already hold `quality_repair_auto='1'`. The new meta key `quality_repair_gate` carries a gate version for that.
- Store-copy preview of the global store (19,425 rows, no `--apply`): 65 of 76 cut rows set aside, 0 valid rows set aside.
- The work took 17 fix rounds. Each design below was dropped on a reviewer's reproduction, not on taste.

## Decision
- The cut checks (`startsInsideCut`: a start inside bold or inside an aside) run only in repair and `hippo audit`, through `storedDefect`. The admission gate (`assessAutomaticMemory`) does not run them.
- Capture fixes the cut where it happens. It splits sentences on the uncut text, as 3.1.0 does, then maps the breaks through the removed `**` pairs. It skips a sentence only when an unclosed `(` comes before it, an aside-closing `)` is in it, and words follow that `)`.
- Line joins are 3.1.0's: `continues()` reads the raw previous line.
- Duplicate checks pair the old reading (no bold removal) and the new reading of the same input by source range. A pair needs full coverage: the edges differ only by `*`, whitespace or sentence punctuation. A held old row then blocks only its own clean copy, unless repair will set that row aside.
- Both capture paths scrub each item again after extraction, and drop the copies the scrub makes.

## Alternatives considered
- Cut checks in the admission gate: dropped after rounds 4 to 7. Each round found one more literal `**` shape (`2**10`, `**kwargs`, `**/*.ts`, `(n+1)** 2`) that the gate refused, so valid rules from capture, autolearn, learn and the DAG summary were lost.
- Join sentences across brackets: dropped after two rounds. It changed the sentence units that every later step reads, so rules after an unclosed `(` and closed multi-sentence asides broke.
- Join lines inside a code span: dropped after rounds 13 to 15. Stray backticks, apostrophes typed as backticks and a closing backtick before a letter each merged rules that 3.1.0 kept apart. The wrapped span it fixed is also a 3.1.0 limit.
- Guess the old form of a twin one shape at a time: dropped after four rounds of misses. Pairing by position and then by category also failed; full source coverage replaced both.
- Split sentences on the cut text: dropped in round 17. The segmenter breaks `**.Always` but not `n.Always`, so removing bold first merged two rules.

## Consequences
- Repair reads only the text. A rare valid automatic row from any source can be set aside, such as one that starts with `** is the power operator`. Each set-aside row is backed up and comes back with `hippo dormant restore <id>`.
- Repair misses 11 of the 76 measured rows (cuts right after a word, one code-span case, two merged rows that go to review).
- Rows that 3.1.0 stored with an unmasked email stay unmasked. The scrub protects new captures only.

## Reconsider when
- A user reports a valid row set aside: move the repair to a 3.1.0 provenance marker, or send uncertain flags to review.
- A later capture change touches sentence splitting: re-run the old/new pairing tests, because twins depend on source ranges.
