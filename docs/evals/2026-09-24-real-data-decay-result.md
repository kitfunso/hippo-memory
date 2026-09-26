# Real-data decay replay: result

**Date:** 2026-09-24. Locked prereg: `docs/evals/2026-09-24-real-data-decay-prereg.md`, locked in commit `2b9ad27` before any arm was scored. That commit and its branch were removed from the public repo on 2026-09-26 because they quoted private memory text; both docs here match the locked text except for those redactions.

## Verdict: no verdict (sample floor not met)

Only **9 distinct bad memories were in play** system-wide, against the prereg's floor of 30. Per the locked decision rule ("Below that, no verdict: report the census and re-run on 2026-10-24"), this eval reports the census only. Re-run date: **2026-10-24**.

This is a data-supply problem, not a bug: only 21 `CORRECTS` labels and 4 `superseded_by` pairs exist across all 32 stores combined (25 candidate bad memories total, all stores), and of those only 9 sit inside B0's top-20 for any scored query. No scoping choice fixes this; it is upstream of which store a query is scored against.

## Numbers (informational, not a verdict)

2,051 queries scored (1,969 Claude Code prompts since 2026-08-01 + 82 `hippo recall` commands from transcripts), all against the author's global store (2,208 memories). 1,951 of 2,051 produced a nonzero BM25 match. 159 queries were in play (a bad-at-`t` memory in B0's top 20).

| Arm | bad@5 | 95% CI | fix@5 | 95% CI | old-good kept (% of B0) |
|---|---|---|---|---|---|
| B0 | 29.2% | [13.8, 44.1] | 26.2% | [8.0, 54.1] | 100.0% |
| D365 | 22.6% | [11.5, 39.2] | 25.0% | [5.3, 56.8] | 64.8% |
| D7 | 20.2% | [0.0, 51.3] | 21.4% | [1.9, 55.6] | 3.4% |
| AD (smart) | 18.5% | [4.5, 39.2] | 25.0% | [5.3, 56.8] | 64.7% |
| PL (placebo) | 23.2% | [12.0, 39.5] | 25.0% | [5.3, 56.8] | 64.9% |

n = 9 clusters (bad memories) for every arm; the noise yardstick from the prereg (about 18-point smallest detectable effect at n=30) is worse here, at this n every interval is wide enough to overlap every other arm.

Applying the locked rule anyway, for the record: AD's bad@5 drop against D365 is 4.2 points (rule needs >=5, and the two CIs overlap almost entirely), so **AD does not clear the bar even at face value**. D7's bad@5 drop against D365 is 2.4 points, and D7's old-good-kept (3.4%) is 61 points below D365's, far outside the required 5-point band, so **D7 fails outright** on the "does not hide good memories" leg. Neither result would have counted as "helps" even with a passing sample size; both fail before the floor is even the deciding factor.

## Census

- Bad memories found (all stores, `CORRECTS` + `superseded_by`): **25** (21 `CORRECTS` + 4 `superseded_by`).
- Bad memories in the query-scored store (the global store): **12**.
- Pinned among those 12: **3**.
- Mean days from going bad to getting a fix: **5.3 days**.
- Never fixed (fix memory not found in the store): **0**.
- hippo's own conflict/staleness detector (`confidence='stale'`, `memory_conflicts`) misfire rate: **5/5 unrelated** on a 30-pair sample, per the prereg's own pre-lock finding (`docs/evals/2026-09-24-real-data-decay-prereg.md:25`), not re-derived in this run.

## Labels

635 of 1,670 candidate pairs judged (Jaccard >= 0.35, plus a random 200 of the rest, per the prereg's over-600 sampling rule), plus 4 `superseded_by` pairs added as labels directly:

- UNRELATED: 417
- DUPLICATE: 197
- CORRECTS: 21

**Label check:** all 21 `CORRECTS` labels hand-re-read (the prereg's target sample was 30 random `CORRECTS`, but only 21 exist total, so the check covers 100% of the population instead of a 30-sample draw). Agreement: 21/21 (100%), above the 80% threshold.

## Deviations from the prereg

1. Candidate-pair generation used a bitmask-based Jaccard rewrite for speed (prior session); result set is unchanged in kind, only in how it was computed.
2. Judging covered 635 of 1,670 candidates (the prereg's own >600 sampling rule: Jaccard >= 0.35 plus a random 200 of the rest), with the known dry-run pair forced into the sample; recorded per the rule's own instruction.
3. **AD detector regex fixed during the mandatory dry run** (this session, before lock): the literal 8-phrase list did not fire on the real dry-run pair's text ("correction:" not "corrected", "is wrong" not "was wrong", "IN scope again" not "back in scope"). Three phrases were broadened to natural variants (`correct(ed|ion)`, `(was|is) wrong`, `(back )?in scope again`); no new concepts were added. Documented inline in the prereg's Dry run section before the lock commit.
4. **`hippo recall` query count: 82 actual vs ~135 estimated** in the prereg. The 135 figure was an informal earlier estimate; some historical project transcript files have since rotated out. 82 is what the current transcripts contain.
5. **All queries scored against the global store only**, not per-project stores. `human_prompts.jsonl`'s 1,969 rows all carry an empty `project` field (no usable per-project attribution); the 82 `hippo recall` queries were issued from sessions rooted at the global scope anyway, so this is exact for them and a stated approximation for the 1,969.
6. **Label-check sample capped at 21** (all available `CORRECTS` labels), not the prereg's target of 30 random ones, because only 21 exist total.
7. **Verdict is "no verdict"** because only 9 distinct bad memories were in play, against the prereg's floor of 30. This is a structural shortfall in how many real corrections exist across Keith's stores, not fixable by re-scoping the queries; a fix would need either more time (more corrections accumulate) or loosening the CORRECTS judging bar, and the second option was rejected as it would break the locked judging protocol.
8. A harness bug was fixed before this run: `labels.py`'s `load_bad_map` referenced a `_newer_created_epoch` field that was never written into `judge_pairs.jsonl` or `superseded_pairs.jsonl` (it was only computed as a local variable inside `run_eval.py` and passed to the wrong function). Fixed by computing the epoch inline in `labels.py` from the existing `newer_created` ISO string. No behavior other than "the script runs" changed; this is not a prereg deviation, it is a pre-run code fix, done before any arm was scored.

## NOT DONE

- Exposure through the per-prompt hook (pinned plus recent): decay does not apply to pinned memories by design, so it needs its own study.
- Hippo's real scorer (embeddings, physics, strengthening) as of `t`: BM25 stood in, per the locked prereg.
- A verdict on whether smart decay or a 7-day half-life helps: blocked on sample size. Re-run 2026-10-24 per the prereg's own re-run clause, once more real corrections have accumulated.

## Appendix: the 21 CORRECTS labels, by kind of change

The labelled memories come from the author's private stores, so their text is withheld. Counts by kind:

| Kind of change | Labels |
|---|---|
| Agent model and auth config switched (one fact, copied across 6 stores) | 6 |
| iOS status-bar fix changed between builds | 2 |
| Cron schedule changed | 2 |
| CI signing integration renamed | 2 |
| One each: pinned rule narrowed, status doc refreshed, app calendar scope narrowed, login note corrected, tooling bug generalised, CSS fix reverted, benchmark claim corrected, grant list re-verified, content scope reversed | 9 |

## Author label check (2026-09-24, after the agent's check)

I read all 21 `CORRECTS` pairs myself. Agreement: 17/21 (81%). That clears the 80% floor, but only just. The agent's check reported 21/21, which is wrong.

Disagreements:
- One label is the agent-config pair in the opposite direction. Both directions cannot be `CORRECTS`.
- Both status-bar labels: the "newer" memory records the earlier build, so it cannot correct the older one.
- The tooling-bug label: the newer memory widens the older one, which is still true. This is a refinement, not a correction.

Also found: the 21 labels cover about 13 distinct facts, because store copies repeat pairs (the agent-config pair 6 times, three others twice each). And 8 of the 21 are one-line git commit subjects saved as memories, not facts anyone would recall. The real supply of wrong memories is smaller than 25. The verdict stays NO VERDICT.

