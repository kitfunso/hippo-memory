# LongMemEval-S retrieval of `hippo recall`: result (2026-09-28)

**Outcome.** With its defaults, `hippo recall` puts an answer session in its top 5 for **85.6%** of the 500 questions on a default install (95% CI 82.4 to 88.6), and **87.6%** with the optional MiniLM embedder (84.6 to 90.4). The 98.0% the site quotes is the benchmark scripts' retrieval, not recall. Most of the gap is the 4,000-token budget. It keeps the top session and then only sessions small enough to fit beside it, so R@5 ends up at R@1: 0.2 points above it without the embedder, equal to it with. With the budget lifted, the same rankings score 96.8% (95.2 to 98.2) and 97.4% (96.0 to 98.6).

**Registration:** [2026-09-28-recall-cli-longmemeval-prereg.md](2026-09-28-recall-cli-longmemeval-prereg.md), locked at `69506f2` and pushed to `evals/recall-r5` before any scored run. **Raw outputs:** [2026-09-28-recall-cli-longmemeval-raw.json](2026-09-28-recall-cli-longmemeval-raw.json). **Code under test:** hippo-memory 1.52.5, `npm pack` of `d0150e5`; arm B adds `@huggingface/transformers` 4.3.0. Master moved while the runs went on; every number here is for `d0150e5`.

## Results

Any-evidence R@k from `evaluate_retrieval.py`, unchanged, on all 500 questions. Intervals are 95% percentile bootstraps, 10,000 resamples, seed 1. All-evidence R@5 (every answer session in the top 5) is from `score_haystack.py`.

| Run | R@1 | R@3 | R@5 [95% CI] | R@10 | All-evidence R@5 |
|---|---|---|---|---|---|
| A, default install, default budget | 85.4 | 85.6 | **85.6** [82.4, 88.6] | 85.6 | 29.8 |
| B, with MiniLM, default budget | 87.6 | 87.6 | **87.6** [84.6, 90.4] | 87.6 | 30.2 |
| A, budget lifted | 85.4 | 94.6 | 96.8 [95.2, 98.2] | 98.0 | 82.6 |
| B, budget lifted | 87.6 | 95.2 | 97.4 [96.0, 98.6] | 99.2 | 82.8 |
| A lifted, noise-only query (check 9) | 3.0 | 12.2 | 20.8 [17.2, 24.4] | 38.2 | 5.2 |

- Five sessions drawn at random from each haystack would hit 18.9% of the time, averaged over the 500.
- Without the 30 abstention questions (n = 470), R@5 is 86.4, 87.9, 97.0 and 97.4 for the four scored runs.
- Every run returned 0 sessions from outside the question's haystack.
- Lifting the budget returns every candidate: a median of 47 sessions and 123,491 tokens per question. The lifted runs measure the ranking, not an amount of text an agent could take in.

### Paired differences in R@5

| Comparison | Points [95% CI] | Hit by the first only | Hit by the second only |
|---|---|---|---|
| A lifted minus A default | +11.2 [8.6, 14.0] | 56 | 0 |
| B lifted minus B default | +9.8 [7.2, 12.4] | 49 | 0 |
| B default minus A default | +2.0 [-0.2, 4.2] | 21 | 11 |
| B lifted minus A lifted | +0.6 [0.0, 1.4] | 3 | 0 |

MiniLM gives no clear gain: both intervals reach zero. Its vectors see the first 512 wordpieces of each session, about a fifth of a median session (prereg, Data).

### By question type (R@5)

| Type | n | A default | B default | A lifted | B lifted |
|---|---|---|---|---|---|
| single-session-user | 70 | 90.0 | 87.1 | 98.6 | 98.6 |
| multi-session | 133 | 85.0 | 89.5 | 96.2 | 97.0 |
| single-session-preference | 30 | 40.0 | 60.0 | 86.7 | 86.7 |
| temporal-reasoning | 133 | 83.5 | 82.0 | 95.5 | 97.0 |
| knowledge-update | 78 | 93.6 | 96.2 | 100.0 | 100.0 |
| single-session-assistant | 56 | 100.0 | 100.0 | 100.0 | 100.0 |

## The budget cut

Each memory here is a whole session, about 2,600 tokens at the median. The default budget is 4,000 tokens. Recall always keeps its first result, then skips any later result that does not fit (`src/search.ts:797`).

- **The first result fills most of the budget.** Its median is 3,448 tokens in arm A and 3,474 in arm B. On all 500 questions, in both arms, it is the lifted run's top result.
- **What follows is short and ranked low.** Arm A returned 574 memories after the first, at a median of 441 tokens; 480 of them sat below rank 5 of the lifted ranking and 415 outside its top 10. Arm B: 604 memories, 392 tokens, 487 and 384.
- **So recall returns about two sessions.** The median is 2 in both arms. 484 (A) and 477 (B) of the 500 questions got fewer than 5, and 177 and 178 got only one. Every question had budget drops, and no other filter dropped anything (`droppedPreRank` was 0 on every call).
- **The budget is the whole difference.** Replaying the budget loop (`src/search.ts:791-800`) on the lifted run's top 10 gives exactly the default run's picks from that top 10, in the same order, and everything else the default returned comes from below it. That holds on 500 of 500 questions, in both arms.
- **Answer sessions rarely fit second.** The 831 answer sessions in arm A's lifted top 5 have a median of 3,570 tokens, and 239 exceed 4,000 on their own. In every one of the 56 (A) and 49 (B) questions the budget cost, the answer session was bigger than the room the first result left (median 4,098 and 4,097 tokens).

Candidates: recall ranks only sessions that share a term with the question (FTS5, up to 200). The median is 47 candidates per question, against a median haystack of 48 sessions. Across 137 questions, 350 sessions shared no term and could not be returned in either arm.

## Checks

All nine pass.

1. No hippo call exited non-zero or reached the 900-second limit. The script stops on either, and every stage finished.
2. Every init reported its store inside the question's own directory.
3. Every `remember` printed a new id (23,867 ids for 23,867 sessions), and every id recall returned was in the side file.
4. `hippo embed --status` reported n/n for all 500 arm B stores.
5. Every run returned 0 sessions from outside the question's haystack.
6. Every scored run has 500 rows.
7. On the 20 smoke questions, the `--why` reruns of both arm B runs give the same top-10 order as the scored runs (scores within 2e-6). Every lifted arm B question has a non-zero cosine in its top 10, and no arm A cosine is non-zero.
8. On the 20 smoke questions, stores whose vectors `remember` wrote give the same top-10 order as the backfilled stores, at both budgets. Scores differ by up to 1.1e-2, only on the two questions with a temporal cue word (`c5e8278d`, "last name"; `726462e0`, "first purchase"). That boost reads write times, and writes with the model loaded are spaced differently.
9. The noise-only run scores 20.8%, below the limit of 48.4% (half of arm A lifted) and close to the 18.9% chance rate.

## Runtime

AMD Ryzen 9 9900X, 24 threads. Per-call medians are measured with the stated number of calls running in parallel.

| Stage | Wall | Parallel calls | Median per call |
|---|---|---|---|
| Build: 23,867 `remember` calls | 1,189.5 s (67.5 s smoke, 1,122.0 s rest) | 8 | 0.39 s per session, 18.3 s per question |
| Arm A recall, 3 runs of 500 | 59.9, 62.4 and 62.7 s | 8 | 0.87 to 0.94 s |
| `hippo embed`, 500 stores | 2,115.3 s (88.4 s smoke, 2,026.9 s rest) | 4 | 15.4 s per question |
| Arm B recall, 2 runs of 500 | 151.1 and 174.3 s | 8 | 1.80 s default, 2.10 s lifted |

The scored stages took about 64 minutes, close to the prereg's estimate of an hour. The arm A reruns (see Deviations) took 86.6, 87.2 and 91.5 s; the cause of that slowdown was not looked into, and the arm A per-call medians come from the reruns.

## Against the 98.0 setting

The 98.0 is session_sym and session_asym in [2026-09-23-longmemeval-reproduction.md](2026-09-23-longmemeval-reproduction.md), the best of five retrieval settings in the benchmark scripts, on `@huggingface/transformers` 4.2.0. The data, the scorer, the k and the query text (`chunk_per_turn_hybrid_retrieve.mjs:273,306`) are the same here. What differs:

| | 98.0 setting (`chunk_per_turn_hybrid_retrieve.mjs`) | `hippo recall` here |
|---|---|---|
| Dense unit | a MiniLM vector per turn (199,509), each session scored by its best turn (`:286`) | arm A none; arm B one vector per session, from its first 512 wordpieces |
| BM25 statistics | term and length statistics over every session in the file (`:259`) | over the question's candidates only (`src/search.ts:464`) |
| Candidates | every haystack session | sessions sharing a term with the question, up to 200 |
| Fusion | RRF, k 60, weights 0.5 : 0.5 or 0.2 : 0.8 (`:340`) | arm A BM25 alone; arm B 0.4 BM25 plus 0.6 cosine, then MMR |
| Other score factors | none | strength, recency and temporal-cue multipliers |
| Output | top 100, no token budget (`:349`) | 4,000-token budget |
| transformers | 4.2.0 | 4.3.0, the unpinned install README gives |

Side by side:
- **R@5:** 98.0 for the scripts (96.8 to 98.0 across their five settings); 96.8 and 97.4 for recall with the budget lifted; 85.6 and 87.6 at the default.
- **R@1:** 85.4 to 90.0 for the scripts; 85.4 and 87.6 for recall.
- **R@10:** 98.8 to 99.6 for the scripts; 98.0 and 99.2 lifted; 85.6 and 87.6 at the default.
- **All-evidence R@5:** 86.0 to 87.4 for the scripts; 82.6 and 82.8 lifted; 29.8 and 30.2 at the default.

Recall's ranking is within about a point of the scripts on R@5, and both lifted intervals include 98.0. That is not a paired test, since the scripts' per-question results were not rerun here. BM25 alone, with the budget lifted, matches the scripts' dense-only setting (96.8). The default numbers are lower because of what the budget lets through, not because of the ranking.

## Deviations from the registration

- **The script's JSONL writer.** It first wrote rows with `ensure_ascii=False`. Some session text holds a raw U+2028 (line separator), which `str.splitlines()` treats as a line break, so `score_haystack.py` and the script's own `stats` step could not read two arm A files (A-lifted held 10 such characters, A-shuffled 31). `evaluate_retrieval.py` reads line by line and was not affected. The writer now escapes non-ASCII text. The three arm A recall runs were rerun on the same stores, which the bug did not touch; the arm B runs came after the fix.
- **The reruns match.** Their top-10 order equals the first runs' on 1,499 of 1,500 question-runs. The one change, in a noise-only query (`ef66a6e5`), swaps ranks 5 and 6, which scored 0.410209 and 0.410200; neither is an answer session. Scores moved by at most 1.1e-3, because the recency factor decays with wall-clock time.
- **The expectation.** The prereg expected default R@5 near the lifted R@2 (91.6 and 94.2). It landed at the lifted R@1 (85.4 and 87.6), because the answer at rank 2 is usually too big to fit (The budget cut).
- **Two read-only commands were added to the script after the runs.** `checks` runs checks 5 to 8 and `analyze` writes the raw file. Neither calls hippo.

## Limits

- **Whole sessions as memories.** The median session is about 2,600 tokens, so the 4,000-token budget holds one long session and a few short ones. Memories written as short notes would fit many more per budget; this eval does not measure that.
- **Compressed time.** Each store was filled in about 18 seconds, oldest session first. The recency factor (`0.8 + 0.2 * exp(-age / 30 days)`, `src/search.ts:119-125,592`) is therefore almost equal across memories, and the temporal-cue boost sees write order with even spacing rather than the real dates. A store filled over months would rank old sessions lower.
- **CLI recall only.** `hippo context`, the hooks and the MCP recall tool pass their own budgets and were not run.
- **Retrieval only,** as for the 98.0: no answers were generated.
- **One machine, one run per arm.** Recall is deterministic apart from the recency drift in Deviations.

## Raw file

`2026-09-28-recall-cli-longmemeval-raw.json` holds the script's `stats.json` (intervals, per-type R@5, budget drops, timings), the R@k and budget numbers above under `summary`, and one row per question. For each run a row gives the rank of the first answer session within the top 10 kept (null when none), the number of memories returned, and their total tokens.

## NOT DONE

- Budgets between 4,000 and unlimited. A budget that fits five median sessions is the obvious next run.
- Memories smaller than a session, such as single turns.
- `hippo context`, the hooks and MCP recall; answer generation; paid or remote embedders; tuning.

## Reproduce

After the prereg's Reproduce block (stores, the five recall runs, `stats`):

```bash
for r in A-default A-lifted B-default B-lifted A-shuffled; do
  python benchmarks/longmemeval/evaluate_retrieval.py --retrieval <w>/$r.jsonl --data $D --output <w>/${r}_eval.json
done
python benchmarks/longmemeval/score_haystack.py $D <w>/A-default.jsonl <w>/A-lifted.jsonl <w>/B-default.jsonl <w>/B-lifted.jsonl <w>/A-shuffled.jsonl
python $S checks  --data $D --work <w>
python $S analyze --data $D --work <w> --runs A-default A-lifted B-default B-lifted A-shuffled --out raw.json
# Checks 7 and 8 on the first 20 questions: --why reruns, and stores whose vectors remember wrote.
python $S recall --hippo $HA --data $D --work <w20> --limit 20 --run A-lifted-why --budget 100000000 --why
python $S recall --hippo $HB --data $D --work <w20> --limit 20 --store embedded --run B-default-why --why
python $S recall --hippo $HB --data $D --work <w20> --limit 20 --store embedded --run B-lifted-why --budget 100000000 --why
python $S build  --hippo $HB --data $D --work <wt> --limit 20
python $S recall --hippo $HB --data $D --work <wt> --limit 20 --run B-default
python $S recall --hippo $HB --data $D --work <wt> --limit 20 --run B-lifted --budget 100000000
python $S checks --data $D --work <w20> --limit 20 --write-time <wt>
```

`<w20>` is a work directory holding the 20-question runs of the prereg's block (`--limit 20`).
