# Public benchmarks at the 365-day default: result (2026-09-25)

**Registration:** `2026-09-24-public-benchmarks-prereg.md`, Amendment 2, committed at `0ca551c` before any run. **Raw data:** `benchmarks/public/results/2026-09-25-lane-r/`. No model calls, no money spent.

**Outcome: at 365 days hippo matches plain BM25 on both public benchmarks.** On LoCoMo the 7-day default trailed BM25 by 6.9 points at top 10; at 365 days the gap is 1.0 point, inside the ±3 pp band. On LongMemEval-S every arm is level with BM25.

## Setup

- **Runner:** Mem0's `mem0ai/memory-benchmarks` at `4b61c5d`, unchanged, `--predict-only`, top_k 200. Sessions dated as the datasets give them.
- **Server:** `benchmarks/public/hippo-mem0-server.mjs` on one master build. Embeddings off on every arm (`/health` reports `embeddings: false`).
- **Arms:** `hippo@365` (default); `hippo@7` (`--half-life-days 7`); `decay-off` (`HIPPO_ABLATE_DECAY=1`, sensitivity only); `bm25`.
- **Scoring:** `evidence_recall.py` (LoCoMo, categories 1 to 4, 1,531 questions with evidence) and `longmemeval_evidence_recall.py` (LongMemEval-S: share of `has_answer` turns in the top k; 479 of 500 questions, the 21 abstention questions have no evidence turns). Paired bootstrap, 4,000 draws.
- **Sanity check, passed:** `hippo@7`, `decay-off` and `bm25` reproduce the 2026-09-24 dry run exactly at top 10 (46.2, 52.8, 53.1).

## Primary comparison: hippo@365 minus bm25, evidence recall at top 10

| Benchmark | hippo@365 | bm25 | Difference [95% CI] | Reading |
|---|---|---|---|---|
| LoCoMo | 52.1 | 53.1 | -1.0 [-2.0, -0.0] | matches |
| LongMemEval-S | 82.8 | 83.0 | -0.2 [-1.0, +0.7] | matches |

## Secondary

LoCoMo, each arm minus bm25:

| k | hippo@365 | hippo@7 | decay-off |
|---|---|---|---|
| 10 | -1.0 [-2.0, -0.0] | -6.9 [-8.5, -5.4] | -0.3 [-1.0, +0.4] |
| 50 | -1.3 [-2.0, -0.6] | -2.1 [-3.0, -1.3] | -0.7 [-1.2, -0.2] |
| 200 | -0.6 [-1.1, +0.0] | -0.2 [-0.9, +0.5] | -0.2 [-0.6, +0.2] |

LongMemEval-S, each arm minus bm25 at top 10: hippo@365 -0.2 [-1.0, +0.7]; hippo@7 -0.3 [-1.8, +1.2]; decay-off -0.2 [-1.0, +0.6]. At top 200 every arm finds 99.7%.

LongMemEval-S knowledge-update (72 questions, named in advance), top 10: hippo@365 93.3, hippo@7 91.9, decay-off 94.0, bm25 95.4.

## What it shows

- The 7-day harm on LoCoMo is gone at 365 days: the default change closes 5.9 of the 6.9 points.
- LongMemEval-S cannot separate any arm, 7 days included. Its haystacks leave decay little to act on at these budgets.
- Hippo does not beat BM25 on either benchmark. These benchmarks ingest once and ask once, so the lifecycle (strengthening, outcome feedback) has nothing to act on; they test retrieval only.

## Limits and deviations

- Lane R is retrieval only. Answers are Lane A, below.
- No embeddings on any arm.
- Server fixes needed to run on Windows: the server's `dist/` imports now use file URLs, and embeddings are opt-in (`--embeddings 1`). Neither changes what is measured.

## Lane A (answers, Claude Sonnet, not comparable with Mem0's published numbers)

**Raw data:** `benchmarks/public/results/2026-09-25-lane-a/`. Method as Amendment 1: top 10 memories, Mem0's prompts, 40 questions per answering subagent with matched batches, blind shuffled judging at 80 per judge.

**LongMemEval-S** (500 questions, both arms answered in this run; `scripts/score_lme.py`):

| Type | n | hippo@365 | bm25 | Difference [95% CI] |
|---|---|---|---|---|
| All | 500 | 79.2 | 79.0 | +0.2 [-1.8, +2.2] |
| knowledge-update | 78 | 97.4 | 96.2 | +1.3 [+0.0, +3.8] |
| temporal-reasoning | 133 | 81.2 | 79.7 | +1.5 [-2.3, +6.0] |
| multi-session | 133 | 54.1 | 55.6 | -1.5 [-6.0, +3.0] |
| single-session-user | 70 | 92.9 | 92.9 | +0.0 [-4.3, +4.3] |
| single-session-assistant | 56 | 100.0 | 100.0 | +0.0 [+0.0, +0.0] |
| single-session-preference | 30 | 63.3 | 63.3 | +0.0 [-13.3, +13.3] |

**LoCoMo** (the 400-question seed-1 sample; bm25 re-answered and both arms judged blind together, deviation 3; `scripts/score_locomo.py --rerun`, output in `locomo/bm25-rerun/scores.txt`). Mean answer length: hippo@365 11.3 words, bm25 10.5.

| Category | n | Judge: hippo@365 | Judge: bm25 | Difference [95% CI] | F1 difference [95% CI] |
|---|---|---|---|---|---|
| All | 400 | 71.2 | 71.8 | -0.5 [-3.5, +2.5] | -1.0 [-3.1, +1.1] |
| single-hop | 219 | 74.0 | 74.0 | +0.0 [-3.7, +3.7] | -0.6 [-3.5, +2.2] |
| multi-hop | 73 | 61.6 | 67.1 | -5.5 [-15.1, +4.1] | -1.4 [-5.1, +2.8] |
| temporal | 83 | 74.7 | 68.7 | +6.0 [+1.2, +12.0] | +0.0 [-4.6, +4.7] |
| open-domain | 25 | 64.0 | 76.0 | -12.0 [-24.0, +0.0] | -6.7 [-18.7, +2.0] |

Read with the Amendment 2 rule, overall judge accuracy is **unresolved**: the estimate is near zero but the interval reaches -3.5. Per-category rows are secondary and small. The same bm25 answers' old Amendment 1 verdicts sit 3.0 points below this re-judge ([-5.8, -0.2]), so a Sonnet judge moves by about 3 points between runs; that is why arms are only compared inside one blind judging pass. Against Amendment 1's hippo@7 answers, hippo@365 gains 9.0 F1 points [+6.6, +11.5] (secondary, different answering runs).

**Deviations:**
1. One answering batch died on a server-side rate limit and was re-answered by a fresh agent; concurrency capped at 4 from then on.
2. A stray duplicate judge notification; no data impact (40 of 40 verified).
3. The first LoCoMo pairing reused Amendment 1's bm25 answers. The new hippo@365 answers averaged 11.3 words against 14.7, and token F1 rewards brevity, so that pairing's F1 gain (+5.9) is answer style, not retrieval. The bm25 answers were regenerated with the identical procedure and judged blind with hippo@365 (800 items, seed-7 shuffle); the table above is that pass. The first pairing's files are kept and are not reported as a result.
4. The rerun was interrupted by the weekly usage limit after batches 0 to 3; batches 4 to 9 were answered after the reset. The 800 blind judgements (10 judges of 80) ran on 2026-09-26, at most four at a time. The original subagent briefs were not saved, so later answer and judge briefs were rebuilt around the same self-contained prompt files.
5. Two orchestrator sessions ran the blind judging at the same time from the same seed-7 key, and each wrote the same ten verdict files. Every file on disk holds one blind judge's complete 80 verdicts, so the set is a valid single pass, but the provenance per batch is mixed; this also explains the batch-0 lines (j0042, j0071) that changed after writing. One session scored before its last two batches were overwritten (bm25 72.0, difference -0.8 [-3.8, +2.2]); the table uses the final files. The reading is unresolved either way.
