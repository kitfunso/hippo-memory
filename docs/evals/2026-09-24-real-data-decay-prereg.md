# Real-data decay replay: pre-registration

**Date:** 2026-09-24. **Status:** DRAFT until the lock commit named below. No arm is scored before the lock.

## Question

On Keith's real memory history, does "smart decay" (a memory fades fast once a newer memory corrects it) show fewer wrong memories than plain time decay, without hiding the right ones? And does a 7-day or 365-day half-life help at all?

Round 1 answered this only on the synthetic E1 set. This replay uses real memories and real prompts.

## Data (all real, read-only copies)

- **Memories:** all 32 hippo stores on this box (`~/.hippo/hippo.db` and each project's `.hippo/hippo.db`), copied to scratch before reading.
- **Queries:** Keith's own prompts since 2026-08-01 from Claude Code transcripts (1,969), plus the `hippo recall "<q>"` commands in the same transcripts (135). Each query keeps its timestamp `t`.
- **Store as of `t`:** only memories with `created <= t`. Memories deleted since then are gone and cannot be replayed (limit, stated in the result).

## Labels: which memory was wrong, and from when

1. A script lists pairs (older, newer) from the same store with token Jaccard >= 0.25 and `newer.created > older.created`.
2. A Sonnet judge reads each pair and answers one of: `CORRECTS` (the newer one makes the older one wrong or out of date), `DUPLICATE`, `UNRELATED`. The judge sees no arm output.
3. `CORRECTS` gives a bad label: the older memory is **bad from `newer.created`**, and the newer one is its **fix**.
4. The existing `superseded_by` chains are added as bad labels too.
5. **Label check:** the author hand-reads 30 random `CORRECTS` labels before scoring. Under 80% agreement means no verdict, only the census.

Not used as labels: `confidence = 'stale'` and `memory_conflicts`. A 5-pair sample was 5/5 unrelated pairs (2026-09-24). A follow-up (2026-09-25) found both are old, already-fixed history: all 25 sampled conflict rows came from the pre-v0.26.0 detector and were resolved on 2026-04-20, and today's detector flags 0 conflicts on copies of both stores. Most `stale` rows were written by the 30-day age-out before #174. Neither field is a usable label.

## Arms (ranking only; hippo code is not changed)

Score = BM25 over the store as of `t`, times the arm's multiplier. Top 5 are "shown".

| Arm | Multiplier |
|---|---|
| B0 | 1 (no decay) |
| D365 | 0.5 ^ (age / 365), age = t - created |
| D7 | 0.5 ^ (age / 7) |
| AD (smart) | D365, times 0.1 when a cheap detector fires by `t`: a newer memory created <= t, Jaccard >= 0.25, whose text matches a correction regex (corrected, no longer, was wrong, instead of, reverted, replaced, back in scope, changed to) |
| PL (placebo) | D365, times 0.1 on random memories at AD's firing rate |

AD uses the cheap regex, not the judge, so the judge labels test it honestly. Past retrieval counts are unknown as of `t`, so age runs from `created` (limit, stated).

## Metrics

A query is **in play** when a bad-at-`t` memory sits in B0's top 20.

- **bad@5 (primary):** share of in-play queries with a bad-at-`t` memory in the top 5.
- **fix@5:** share of in-play queries whose fix exists at `t` and is in the top 5.
- **old-good kept:** across all queries, top-5 slots held by unlabeled memories older than 30 days, relative to B0. This measures how much good old memory an arm hides.

Intervals: 95% bootstrap, resampling bad memories (clusters), 2,000 draws.

## Decision rule (locked)

- **AD helps** when, against D365: bad@5 drops by at least 5 points with the interval excluding 0, fix@5 falls by no more than 2 points, and AD also beats PL on bad@5 with the interval excluding 0.
- The same rule judges **D7 against D365**, and it must also keep old-good within 5 points of D365.
- **Sample floor:** at least 30 distinct bad memories in play. Below that, no verdict: report the census and re-run on 2026-10-24.
- Noise yardstick: with 30 clusters, the SE on a share is about 9 points, so the smallest effect this can see is about 18 points.
- A pass changes no default. Any default change goes to Keith with this doc.

## Census (reported whatever the verdict)

Bad memories found; how many are pinned; days from going bad to a fix; how many never got one; the misfire rate of hippo's conflict detector on a 30-pair sample.

## Dry run before the lock

Run on a known pair from the author's store: a content decision made on 2026-09-12 and reversed on 2026-09-24 (text withheld, private). Use a query from after 2026-09-24. Confirm the judge says `CORRECTS`, the AD detector fires, and bad@5 differs between D365 and AD. If the detector does not fire, fix the regex before the lock, not after.

**Dry run result (2026-09-24, before lock):** judge label was `CORRECTS`. The literal 8-phrase regex did NOT fire on the newer memory's text: it says "correction:" (not "corrected"), "is wrong" (not "was wrong"), and "IN scope again" (not "back in scope"), so none of the eight literal phrases matched. Fixed by broadening three phrases to their natural variants, no new concepts added: `corrected` to `correct(ed|ion)`, `was wrong` to `(was|is) wrong`, `back in scope` to `(back )?in scope again`. Re-run: detector fires (matched "correction"). A topic query at t = 2026-09-24T18:00Z: the older memory sits at rank 2 in D365's top 5, and drops out of AD's top 5 (10x penalty applied). Mechanism confirmed working. Full regex: `correct(ed|ion)|no longer|(was|is) wrong|instead of|reverted|replaced|(back )?in scope again|changed to`.

## NOT DONE

- Exposure through the per-prompt hook (pinned plus recent): decay does not apply to pinned memories by design, so it needs its own study.
- Hippo's real scorer (embeddings, physics, strengthening) as of `t`: BM25 stands in.
