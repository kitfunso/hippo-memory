# LongMemEval-S retrieval of `hippo recall`: re-run on 1.64.0 (2026-10-06)

**Outcome.** The scores hold. Releases 1.53.0 to 1.64.0 changed capture, task state and the server, so the [2026-09-28 run](2026-09-28-recall-cli-longmemeval-result.md) was repeated on the 1.64.0 package as published to npm. Without the embedder, every R@k is unchanged: **85.6%** R@5 at the default budget and 96.8% with it lifted. With the MiniLM embedder, default R@5 is **87.8%** (95% CI 84.8 to 90.6), against 87.6%; that is one question of 500. The lifted run is unchanged at 97.4%.

**Registration:** the same [prereg](2026-09-28-recall-cli-longmemeval-prereg.md), script and data file (SHA-256 checked against the prereg). **Code under test:** hippo-memory 1.64.0 from npm in both arms; arm B adds `@huggingface/transformers` 4.3.1, against 4.3.0 on 28 Sep, because the README's install is unpinned.

## Results

Any-evidence R@k from `evaluate_retrieval.py`; all-evidence R@5 from `score_haystack.py`. Intervals as on 28 Sep (10,000 paired bootstrap resamples, seed 1). The 28 Sep figure follows in parentheses where it differs.

| Run | R@1 | R@3 | R@5 [95% CI] | R@10 | All-evidence R@5 |
|---|---|---|---|---|---|
| A, default install, default budget | 85.4 | 85.6 | **85.6** [82.4, 88.6] | 85.6 | 29.6 (29.8) |
| B, with MiniLM, default budget | 87.8 (87.6) | 87.8 (87.6) | **87.8** [84.8, 90.6] (87.6) | 87.8 (87.6) | 30.2 |
| A, budget lifted | 85.4 | 94.6 | 96.8 [95.2, 98.2] | 98.0 | 82.6 |
| B, budget lifted | 87.8 (87.6) | 95.2 | 97.4 [96.0, 98.6] | 99.2 | 82.6 (82.8) |
| A lifted, noise-only query (check 9) | 2.8 (3.0) | 12.4 (12.2) | 20.8 [17.4, 24.4] | 38.6 (38.2) | 5.2 |

- The extra arm B hit is a single-session-user question: that type goes from 87.1 to 88.6. Every other type matches 28 Sep in all four scored runs.
- Paired R@5, B default minus A default: +2.2 points [0.0, 4.4], 21 questions hit by B only and 10 by A only (28 Sep: +2.0 [-0.2, 4.2], 21 and 11). The interval still reaches zero, so MiniLM still gives no clear gain.
- Lifting the budget: +11.2 [8.6, 14.0] in arm A, as before; +9.6 [7.0, 12.2] in arm B (28 Sep +9.8).
- The budget still decides the default runs: a median of 2 sessions returned in both arms, and 487 (A) and 481 (B) of 500 questions got fewer than 5 (28 Sep: 484 and 477).

## Checks

Checks 1 to 6 and 9 pass. Every run has 500 rows and returned no session from outside its haystack; `hippo embed --status` reported n/n for all 500 arm B stores; the noise-only run (20.8) sits near the 18.9% chance rate and below the 48.4 limit. Checks 7 and 8 (the 20-question `--why` and write-time runs) were not repeated.

## Deviations

- **The first embed attempt failed.** The model was not yet cached, and four `hippo embed` processes made the first download at once. The model did not load, every memory came back unembedded, and `hippo embed` still exited 0 with "Done. 0 new embeddings created". The script's coverage check stopped the stage. One single-process `hippo embed` then fetched the model, and the stage was re-run; a store without its `embed.json` is rebuilt from a fresh copy, so every arm B vector comes from the loaded model. The exit 0 is a core bug: the local provider turns a model-load failure into an empty vector (`src/local-embedding.ts:172`), and `hippo embed` reports success while memories stay unembedded (`src/cli/maintenance.ts:158`).
- **A slower machine.** The re-run ran on a work laptop, not the 28 Sep box: build 3,944 s, arm A recall about 130 s a run, embed 3,541 s, arm B recall about 350 s a run. Recall is deterministic apart from the recency drift noted on 28 Sep, so speed does not change the scores.

## Reproduce

The prereg's Reproduce block with `$HA` and `$HB` pointing at `npm install hippo-memory@1.64.0` (arm B also `npm install @huggingface/transformers`), then the 28 Sep result's `evaluate_retrieval.py`, `score_haystack.py` and `checks` lines. Run one `hippo embed` in a single store before the embed stage, so the model download does not race.
