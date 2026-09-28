# LongMemEval-S retrieval of `hippo recall`: pre-registration

**Date:** 2026-09-28. **Status:** LOCKED by the commit that adds this file. Nothing was scored before the lock except the one-question dry run that [AUTHORING.md](AUTHORING.md) lesson 2 requires (question `e47becba`, results at the end).

## Question

The README and the site lead with 98.0% R@5 on LongMemEval-S. That number comes from the benchmark scripts, which index every turn, fuse BM25 and MiniLM rankings with RRF and keep each session's best turn. It is not `hippo recall` ([2026-09-23-longmemeval-reproduction.md](2026-09-23-longmemeval-reproduction.md)). On the same 500 questions, with the same scorer and the same k, what does `hippo recall` score when a user fills a store the way hippo is filled today and calls recall with its defaults?

**Mechanism claim.** `hippo recall "<question>"` ranks the question's own haystack, stored as one memory per session through `hippo remember`, and returns what fits its 4,000-token budget. R@5 asks whether an answer session is among the first five memories it returns.

## Data

- `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, the file behind the 98.0.
- All 500 questions, including the 30 abstention (`_abs`) questions, as in the 98.0: single-session-user 70, multi-session 133, single-session-preference 30, temporal-reasoning 133, knowledge-update 78, single-session-assistant 56.
- Each question has its own haystack of 38 to 62 sessions, 23,867 in all. The median session is 10,407 characters, about 2,600 tokens by hippo's estimate (characters / 4).
- MiniLM's tokenizer stops at 512 wordpieces (`model_max_length` in its `tokenizer_config.json`; Transformers.js truncates there). Of the 19,195 distinct sessions, 93.8% are longer than that; the median is 2,258 wordpieces, so arm B's vectors see about the first fifth of a typical session.

## Installs under test

Both arms install the same package: `npm pack` of this branch's base commit `d0150e5` (hippo-memory 1.52.5), installed into an empty prefix with `npm install <tarball>`. The package postinstall is skipped (`HIPPO_SKIP_POSTINSTALL=1`). It only prints setup hints and repairs a Codex wrapper, and neither touches a store.

| Arm | Install | Embedder |
|---|---|---|
| A, default | the tarball alone; hippo has no runtime dependencies | none, so recall ranks by BM25 only |
| B, MiniLM | the tarball plus `npm i @huggingface/transformers`, unpinned, as README line 29 tells users | `Xenova/all-MiniLM-L6-v2` (the config default), fetched once from the Hugging Face hub into the package cache; no `HIPPO_MODEL_CACHE` |

The unpinned install resolved to `@huggingface/transformers` 4.3.0 with onnxruntime-node 1.30.0. The dry run downloaded `onnx/model.onnx`, the fp32 weights.

## Isolation

Every hippo call runs with cwd `<q>/work`, `HIPPO_HOME=<q>/global`, and `HOME` and `USERPROFILE` set to `<q>/home`, fresh for each question. The environment holds only `PATH`, `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR` and `LANG`. No `HIPPO_*`, `XDG_*`, `ANTHROPIC_API_KEY` or other key reaches hippo. Everything is local and free.

## How a haystack becomes a store (the write path)

- `hippo init --no-hooks --no-schedule --no-learn`. The flags skip patching agent files, the daily OS task, and seeding from git history and agent MEMORY.md files (`src/cli.ts:688-716`). The script stops unless init reports `<q>/work/.hippo`.
- One `hippo remember -` per haystack session, with the session text on stdin. The text is the session's turn contents joined by newlines, the same session document the 98.0 session BM25 index uses (`chunk_per_turn_bm25_index.mjs:90`). No tags, dates, ids or role labels are added.
- Order: by `haystack_dates`, oldest first, ties in file order. 211 of the 500 haystacks are not in date order in the file. A user's store fills in the order conversations happen, and hippo stamps `created` at write time, which recall's recency factor and its temporal-cue boost read (`src/search.ts:119-182`).
- A session repeated inside a haystack (13 haystacks) is stored once per appearance.
- No `hippo sleep`, consolidation or dedupe runs between the writes and the recall.
- Mapping back: `remember` prints `Remembered [<id>]`, and the script keeps `id -> session id` in a side file. Nothing inside the store names a session. On this file, no haystack session id appears in any session's text, so the one leak channel AUTHORING.md lesson 1 warns about is closed.

**Arm B vectors.** `hippo embed` runs on a copy of the arm A store, which is what a user who installs the embedder after writing does. A user who installs it first gets the same vectors from `remember` at write time. The script requires `hippo embed --status` to report n/n for every question.

## What is scored

- **Primary, both arms:** `hippo recall "<question>" --json`, with no other flag. That is budget 4,000 (`src/cli.ts:1109`), `minResults` 1, MMR on with lambda 0.7 (used only when vectors exist), physics off (`src/physics-config.ts:42`) and no global memories, so recall takes the `hybridSearch` branch at `src/cli.ts:1325`. `--json` changes the output format only.
- **Secondary, both arms:** the same call with `--budget 100000000`. That lifts the cut, so recall returns everything it ranks, in rank order. It separates ranking quality from the budget cut.
- The query is the question text alone, as in the 98.0 scripts (`chunk_per_turn_hybrid_retrieve.mjs:273,306`).
- Each recall runs on a fresh copy of the store, because recall strengthens what it returns and writes a trace.
- Candidates: recall first takes the store's FTS5 matches for any query term, up to 200, then ranks them (`src/store.ts:263`, `src/store.ts:956-972`). A session sharing no term with the question is never a candidate, in either arm.

## (a) Source-read

- `src/cli.ts:1102` `cmdRecall(hippoRoot, query, flags)`: budget `parseBudgetFlag(flags['budget'], 4000)` (1109); candidates from `loadRecallSearchEntries(hippoRoot, query, undefined, tenantId, ...)` (1143); global candidates only when `isInitialized(globalRoot)` (1144); physics only when `config.physics.enabled !== false` (1219-1220); MMR from config (1222-1226); multihop from config (1239); the `hybridSearch` branch (1325); JSON rows `{id, score, strength, tokens, tags, content, layer}` (2090-2101).
- `src/store.ts:2410` `loadRecallSearchEntries(hippoRoot, query, limit = DEFAULT_SEARCH_CANDIDATE_LIMIT, ...)`, limit 200 (263); the FTS5 OR match ordered by bm25 (956-972).
- `src/search.ts:364` `hybridSearch(query, entries, options)`: budget 4000, `minResults` 1, embedding weight 0.6, MMR on with lambda 0.7 (424-432); the budget loop (791-800); `recencyBoost` (119-125); `temporalBoost` (168-182).
- `src/config.ts:172-175` MMR on, lambda 0.7; `src/config.ts:201-203` multihop off; `src/physics-config.ts:42` physics off.
- `src/scope.ts:8` `detectScope()` reads only `HIPPO_SCOPE`, `GSTACK_SKILL` and `OPENCLAW_SKILL`. All three are kept out, so no scope boost applies.
- `src/embeddings.ts:219-224`: a model that fails to load returns null and recall carries on with BM25 alone; `src/embeddings.ts:360`: mean pooling, normalized.
- `src/cli.ts:656` `cmdInit(hippoRoot, flags)`: hooks, the schedule, and git and MEMORY.md seeding sit behind the three flags (688-716).
- `benchmarks/longmemeval/evaluate_retrieval.py:45` `check_session_hit(retrieved_memories, answer_session_ids, top_k)`; `src/eval-stats.ts:137` `pairedBootstrap(diffs, opts)`.

## Scorer, metric and k

- `benchmarks/longmemeval/evaluate_retrieval.py`, unchanged: session level, any evidence. A question is a hit at k when any of its answer session ids is among the first k memories recall returned. Fewer than k memories, or none, counts as a miss at k.
- Primary k is 5. R@1, R@3, R@10 and per-type R@5 come from the same scorer, and `score_haystack.py` adds all-evidence R@5 and the count of retrieved ids outside each question's haystack.
- Intervals: 95% percentile bootstrap over the 500 questions with `pairedBootstrap` (`src/eval-stats.ts:137`), 10,000 resamples, seed 1. Differences between runs are paired on the same questions.

## The budget cut

At the default budget recall keeps the first result, then any later result that still fits (`src/search.ts:797`). The median session is about 2,600 tokens, so the budget can cut results before rank 5, and short sessions from lower down can take the freed places. For each arm, from the default and lifted runs, the result reports:

- memories returned at the default budget (median, and the number of questions that got fewer than 5);
- `suppressionSummary.droppedByBudget`, and `droppedPreRank`, the sum of every other filter's drops (`src/cli.ts:1146-1148`);
- the paired R@5 difference, lifted minus default, and the questions only the lifted run hits.

## Checks, and what counts as a failure

A question that misses at k is a retrieval failure and counts in the score. A run is invalid, and no number from it is quoted, if any of these happens:

1. A hippo call exits non-zero or runs past 900 seconds. There are no retries.
2. Init reports a store outside the question's own directory.
3. A `remember` prints no new id, or recall returns an id the side file does not hold.
4. Arm B embedding coverage is below n/n for any question.
5. Any retrieved session lies outside its question's haystack.
6. A scored run has fewer than 500 rows.
7. **Arm B used its vectors and arm A had none.** Recall silently falls back to BM25 when the model fails to load (`src/embeddings.ts:219-224`). On the 20 smoke questions, `--why` reruns of both arm B runs must give the same top-10 order as the scored runs, and each question's lifted `--why` results must include a non-zero cosine. Arm A's lifted `--why` cosines must all be zero.
8. **Write-time vectors match backfilled ones.** On the 20 smoke questions, stores built with the arm B install, vectors written by `remember`, must give the same top-10 session order as the backfilled stores. If they do not, arm B is rebuilt that way for all 500 questions and that run is reported.
9. **Noise-only baseline (AUTHORING.md lesson 1).** Arm A at the lifted budget, with each haystack queried by the question 250 places away in the file. Its R@5 must stay below half of arm A's lifted R@5. The chance rate for 5 random sessions is reported beside it. If this fails, the result reports a suspected leak and quotes no number.

An invalid run is fixed in the script, rerun from scratch for the affected arm, and the result says so.

## Retraction conditions

A published number is retracted and rerun, and the retraction logged in `docs/RETRACTION.md`, if any of these turns up later:

- the harness fed recall anything but the question text, or stored anything but the session text;
- an id mapped to the wrong session;
- an arm B question ran without its vectors;
- a store held memories from outside its own haystack (hooks, a global store, a real home directory);
- the scorer differs from the one behind the 98.0.

## Runtime

A 20-question smoke (the first 20 questions in the file) runs first and sets the estimate for the full run. The full run reuses the smoke's stores, since build and embed skip a question already done. Reported: wall clock per stage (build, embed, each recall run) with the worker count (8 for build and recall, 4 for embed), and median seconds per `remember` and per `recall` call, on a 24-thread desktop CPU (Ryzen 9 9900X). If the CLI is too slow for 500 questions, the fallback is the function the CLI's recall calls, with the CLI's defaults, and the result will say so. The dry run's timings (below) put the whole run at about an hour, so no fallback is planned.

## Published whatever the result

Both arms go into the result doc beside this file, whatever they show, with a plain comparison against the 98.0 setting. The PR lists the README and site lines that should quote the new numbers and does not edit them.

## (b) Dry run before the lock (`e47becba`, single-session-user, one question)

"What degree did I graduate with?" Its haystack holds 53 sessions; 50 share a term with the question and become candidates.

- **Arm A, default budget:** 3 memories, 3,846 tokens: the top session (3,261 tokens), then two short ones from lower down (102 and 483 tokens). 47 of the 50 candidates were dropped by the budget, and `droppedPreRank` was 0. The answer session ranks second with the budget lifted, at 4,490 tokens, so the budget cut it. Miss at k=5.
- **Arm A, budget lifted:** all 50 candidates returned; the answer is at rank 2. Hit.
- **Arm B:** the same pattern: a miss at the default budget, and a hit at rank 3 with the budget lifted. `--why` shows non-zero cosines, so the vectors were used, and MMR reorders the list (rank 3 scores 0.300, rank 2 scores 0.250). The answer session's cosine with the question is only 0.016. That session is 4,026 wordpieces long and first mentions graduating 1,356 wordpieces in, past the 512 the model reads. Recomputing the cosine directly with Transformers.js gives the same value, 0.0164.
- **Write-time against backfilled vectors:** the same top-10 session order at both budgets, scores within 3e-5.
- **Timing:** `remember` 0.31 s per session with arm A and 1.37 s with vectors written at write time (the model loads in every process); `hippo embed` 7 s per question; `recall` 0.45 s for arm A and 1.1 s for arm B.
- `--why` does not change the ranking: the same order and scores as the plain call, in both arms.

**Expected, not a gate:** at the default budget recall returns about 2 or 3 sessions, so default R@5 should sit near the lifted run's R@2, well below 98.0.

## NOT DONE

- Answer generation or QA accuracy. This measures retrieval only, like the 98.0.
- Budgets other than 4,000 and unlimited. `hippo context`, the hooks and the MCP recall tool pass their own budgets and are not measured here.
- Paid or remote embedders. Free and local only.
- Tuning. Each arm has one configuration, fixed above.

## Reproduce

```bash
D=data/lme_s/longmemeval_s_cleaned.json   # SHA-256 above
S=benchmarks/longmemeval/recall_cli_haystack.py
npm run build && npm pack --pack-destination <pkg>
HIPPO_SKIP_POSTINSTALL=1 npm --prefix <A> install <pkg>/hippo-memory-1.52.5.tgz
HIPPO_SKIP_POSTINSTALL=1 npm --prefix <B> install <pkg>/hippo-memory-1.52.5.tgz @huggingface/transformers
HA=<A>/node_modules/hippo-memory/bin/hippo.js; HB=<B>/node_modules/hippo-memory/bin/hippo.js
python $S build  --hippo $HA --data $D --work <w>
python $S recall --hippo $HA --data $D --work <w> --run A-default
python $S recall --hippo $HA --data $D --work <w> --run A-lifted --budget 100000000
python $S recall --hippo $HA --data $D --work <w> --run A-shuffled --budget 100000000 --shuffle
python $S embed  --hippo $HB --data $D --work <w> --workers 4
python $S recall --hippo $HB --data $D --work <w> --store embedded --run B-default
python $S recall --hippo $HB --data $D --work <w> --store embedded --run B-lifted --budget 100000000
python $S stats --data $D --work <w> --runs A-default A-lifted A-shuffled B-default B-lifted \
  --pairs B-default:A-default B-lifted:A-lifted A-lifted:A-default B-lifted:B-default --out stats.json
python benchmarks/longmemeval/evaluate_retrieval.py --retrieval <w>/A-default.jsonl --data $D --output A-default_eval.json
python benchmarks/longmemeval/score_haystack.py $D <w>/*.jsonl
```
