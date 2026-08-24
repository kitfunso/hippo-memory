# C5: the CLI cutoff line never fires

Episode `01M0SB83EW4JF1RCFC1GAWTAQN`. Roadmap Track C, C5.

## Problem, measured on the live v1.37.0 binary

`hippo recall` drops almost every candidate and tells the caller nothing. Six
measurements, three queries, two budgets:

| query | budget | returned | totalCandidates | droppedByBudget | droppedPreRank |
|---|---|---|---|---|---|
| test | 20 | 1 | 192 | 0 | 0 |
| test | 100 | 6 | 192 | 0 | 0 |
| memory | 20 | 1 | 400 | 0 | 0 |
| memory | 100 | 3 | 400 | 0 | 0 |
| the | 20 | 1 | 400 | 0 | 0 |
| the | 100 | 1 | 400 | 0 | 0 |

397 of 400 candidates vanish with every counter at zero. The print is guarded
on `clauses.length > 0` (`cli.ts:1998`), so the `Cutoff:` line never appears.

C5 exists to stop an agent treating a truncated set as the whole picture. On
the CLI path - the one agents actually use - that failure is still shipping.

## Why the counters are zero

`cmdRecall` computes `droppedByBudget` from the post-search `--limit` slice
(`cli.ts:1547`, `results.length - limit`). But `results` arrives from the
search call ALREADY ranked and truncated to a handful, so `limit <
results.length` is false and the counter stays 0. The counter runs after the
cut it is meant to measure.

`api.recall` measures the same concept correctly (`api.ts:783`,
`entries.length - baseSlice.length`) because it slices the full candidate list
itself. Two pipelines, one correct, and only the correct one has tests
(`api-recall-suppression-summary`, `http-recall-suppression-summary`). Nothing
tests the CLI path's summary - which is why this survived two refinement
rounds of C5.

## The accounting decision, stated explicitly

`cli.ts:977-980` documents a v1 convention: *"Search-engine internal drops
(scored-to-zero rows that hybridSearch/physicsSearch returns fewer of) are NOT
counted in v1 - they are part of the rank step, not a filter."*

That convention is why the gap is unreported. This plan CHANGES it for
`droppedByBudget` only: rank-step drops are counted as budget drops.

Rationale: `dropped_pre_rank` keeps its meaning exactly (filters, not ranking),
so the documented distinction survives. What changes is that "loaded 400,
showed 3" stops being invisible. The user-facing failure is real whichever
bucket is philosophically correct - an agent seeing 3 of 400 with no signal is
the exact WYSIATI harm C5 was built to prevent.

## The invariant (this is the acceptance criterion)

For every recall, the candidate accounting must close:

    totalCandidates == droppedPreRank + droppedByBudget + returned

Today it does not: 400 != 0 + 0 + 3. This is falsifiable, easy to assert, and
catches arithmetic slips that prose review would not.

Care needed: `droppedPreRankCountCmd` accumulates at BOTH pre-search sites
(`cli.ts:998, 1021, 1026` on the entry lists) and post-search sites (`1270,
1528, 1541` on `results`). The new budget count must not double-count those.

## Tasks

- **T1** Compute `droppedByBudgetCountCmd` so the invariant closes: everything
  lost that was not attributed to a pre-rank filter. Keep the existing
  `--limit` slice drop included.
- **T2** Update the v1 convention comment to state the new accounting, and WHY
  (the line never fired otherwise). A stale comment is how this stayed hidden.
- **T3** Tests: the invariant asserted over several budgets against a real
  store; a test that the `Cutoff:` line actually PRINTS on a truncated CLI
  recall (the specific gap - no existing test drives the CLI summary).

## Success criteria

1. The invariant holds across at least three budget/query combinations.
2. `hippo recall <q> --budget <small> --why` prints a `Cutoff:` line naming
   the dropped count.
3. `droppedPreRank` semantics unchanged; the api and http paths untouched and
   their existing tests still pass.
4. Full suite green.

## Not in scope

- Changing `api.recall` or the http path. They already report correctly.
- Re-tuning what the search engine drops. This is about REPORTING the drop.
