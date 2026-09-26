# Public memory benchmarks: pre-registration (2026-09-24)

**Status:** LOCKED before any scored run. Scored runs cost API money and run on the founder's machine. This file fixes what runs, how it is scored and what gets published, before anyone sees a number.

## Why

Mem0 publishes scores on four runs: LoCoMo, LongMemEval-S, BEAM-1M and BEAM-10M. Hippo publishes retrieval recall on two of these (LongMemEval R@5, LoCoMo evidence recall) and answer accuracy on none, so the two cannot be compared.

The benchmarks come from independent authors. The runner that scores them, `mem0ai/memory-benchmarks`, is Mem0's own. A vendor's runner can favour its vendor, through:
- the grading prompt;
- how many memories reach the answering model;
- which question categories count;
- which runs get reported.

So this plan never relies on Mem0's runner alone.

## What was found before registering (read from the cloned repositories)

- **The runner:** `mem0ai/memory-benchmarks`, commit `4b61c5d` (14 May 2026), Apache-2.0.
  - It reaches a memory system through three HTTP calls: `POST /memories`, `POST /search` and `DELETE /memories`.
  - It retrieves up to 200 memories per question (`top_k` 200) and shows up to 200 to the answering model (`ANSWERER_MEMORY_LIMIT = 200`).
  - It runs LoCoMo on categories 1 to 4 only. Category 5, the adversarial questions, is excluded by default.
- **Mem0's published result files (`results/platform/`) differ from the README:**
  - The README says gpt-4o answers and judges. The LoCoMo and BEAM result files record `gpt-5` as both answerer and judge, through Azure. The LongMemEval file records no models.
  - The LoCoMo file shows 91.56% (1410 of 1540) at top 200. The README states 92.5%.
- **Official scorers from the benchmark authors:**
  - LongMemEval: `xiaowu0162/LongMemEval`, `src/evaluation/evaluate_qa.py`. A gpt-4o yes/no judge with a separate prompt for each question type.
  - LoCoMo: `snap-research/locomo`, `task_eval/evaluation.py`. Token F1 per category, with no model in the loop.
  - BEAM: no official scorer was located yet. Its rubric scoring comes only from Mem0's runner until one is found.

## Systems (arms)

Every arm runs through Mem0's runner unchanged, in its `oss` mode, pointed at a local server. Only the server behind the three calls differs.

| Arm | What answers `/memories` and `/search` |
|---|---|
| `hippo` | `benchmarks/public/hippo-mem0-server.mjs`. Each message is stored verbatim as a hippo memory, dated with the session date the runner sends. Search is hippo's `hybridSearch`, with the lifecycle as shipped and "now" set to one day after the user's latest session. Local embeddings are used if installed; the run records whether they were. |
| `bm25` | The same server and the same stored messages, ranked by BM25 alone. This is the "simple search" baseline. |
| `mem0-oss` | Mem0's own open-source server from the runner's `docker-compose.yml`, run by us with its default configuration. |

Not run, and why:
- **Full context:** the runner cannot pass a whole conversation. Mem0's 2025 paper reports it at 72.90 on LoCoMo.
- **Mem0's cloud product:** it is paid, and the published numbers already stand for it, labelled as Mem0's own.

## Answering and judging models

The same for every arm: `gpt-5` for both, matching Mem0's published result files, run through the runner's `--answerer-model` and `--judge-model`. If `gpt-5` is unavailable or too costly on the day, `gpt-4o` is used for every arm and every table says so. Models are never mixed across arms.

## Scores reported

1. **Mem0's runner:** accuracy at cutoffs 10, 20, 50 and 200, per category, as the runner prints it.
2. **The authors' scorers,** applied to the same generated answers:
   - LongMemEval: `evaluate_qa.py` with gpt-4o;
   - LoCoMo: `evaluation.py` F1.
3. **Retrieval cost:** memories and tokens passed to the answering model per question, and search latency.

**Primary comparison:** `hippo` against `bm25` and against `mem0-oss`, on each benchmark, at top 200 and top 50, using the authors' scorer where one exists. Differences are paired by question, with a bootstrap 95% interval (`src/eval-stats.ts`).

## Order and cost gate

1. **A dry run with no API calls,** in the sandbox: LoCoMo conversation 0, `--predict-only` (ingest and search only). This checks the server end to end.
2. **Trial:** LoCoMo, all three arms, gpt-4o-mini for answering and judging. About $10 to $15 in total (an estimate, not a quote).
3. **Full pass:** the four benchmarks with the registered models. Priced from the trial's measured tokens before it starts.
4. **The decay setting** is whatever hippo ships on the run date, recorded in every table. A decay-off `hippo` arm is reported as a sensitivity check only. It is not a verdict.

## Published whatever the result

- **Published:** every arm's runner output, the scorers' outputs, the server code, all configs and models, and the commands to reproduce.
- **If `hippo` loses to `bm25` or `mem0-oss`, that is published the same way.**
- **Scope of any claim:** these benchmarks ingest once and ask once. Nothing ages, is reused or is marked wrong, so hippo's lifecycle is not tested. Any claim from them is limited to retrieval for answering, at the budgets run.

## Amendment 1 (2026-09-24, before any answer is generated): Sonnet trial in the sandbox

**Why.** The sandbox has no OpenAI access, and the founder asked for a trial now. This amendment adds a trial. It does not replace the registered run, which still happens on the founder's machine with the registered models.

- **Answering and judging:** Claude Sonnet, run as Claude Code subagents, instead of gpt-4o-mini. **Not comparable** with Mem0's published numbers.
- **Prompts:** Mem0's own `get_answer_generation_prompt` and `get_judge_prompt`, from `benchmarks/locomo/prompts.py` at `4b61c5d`. They are built from the `--predict-only` retrieval already collected (`2026-09-24-public-benchmarks-dryrun.md`).
- **Arms:** `hippo` as shipped (the 7-day default) and `bm25`.
- **Cutoff:** top 10, where the retrieval check separated the arms.
- **Sample:** 400 LoCoMo questions (categories 1 to 4), drawn with seed 1 and stratified by category.
- **Batching.** Each answering subagent handles 40 questions from one arm. Arm A's batch i and arm B's batch i hold the same questions, so any carry-over between questions inside one agent affects both arms alike. Judges see a shuffled mix of both arms with no arm label.
- **Scoring:** judge accuracy and the LoCoMo authors' F1. hippo minus bm25 is paired by question, with a 95% bootstrap interval.
- **Published whatever the result:** `docs/evals/2026-09-24-public-benchmarks-sonnet-trial.md`.

## Amendment 2 (2026-09-25, before any run at 365 days): the new default, and LongMemEval-S

**Why.** The decay decision (`2026-09-24-decay-default-result.md`) moved the default to 365 days on master, and the Sonnet trial's own next step was to re-run once that landed. The paper needs public-benchmark evidence for the default it now reports. Paid models stay out: the registered gpt-5 run still waits, and nothing here costs money.

**Arms,** all through `hippo-mem0-server.mjs` on one master build, no embeddings on any arm (recorded per run):
- `hippo@365`: hippo's ranking at the new default;
- `hippo@7`: the same ranking with a 7-day base half-life (the 1.45.0 default), set by an eval-only `--half-life-days` server flag;
- `decay-off`: `hippo@365` with `HIPPO_ABLATE_DECAY=1`, a sensitivity check only;
- `bm25`: BM25 alone.

**Lane R, retrieval (no model calls).** Mem0's runner at `4b61c5d`, unchanged, `--predict-only`:
- LoCoMo, categories 1 to 4, all questions with evidence turns: evidence recall at top 10, 50 and 200 (`evidence_recall.py`).
- LongMemEval-S, all 500 questions, sessions dated as in the dataset: the share of each question's evidence turns (`has_answer`) whose text appears in the top 10, 50 and 200 memories. Reported overall and per question type; **knowledge-update** is named in advance as the type where superseded facts occur.

**Lane A, answers (Sonnet, as Amendment 1).** Same prompts, cutoff, batching and blind judging as Amendment 1, arms `hippo@365` and `bm25`:
- LoCoMo: the same 400-question sample (seed 1), so the Amendment 1 answers for `hippo@7` and `bm25` pair with it;
- LongMemEval-S: all 500 questions, Mem0's LongMemEval answer and judge prompts at `4b61c5d`.

**Primary comparison:** `hippo@365` minus `bm25`, paired by question, 95% bootstrap interval (4,000 draws), on LoCoMo evidence recall at top 10 and LongMemEval-S evidence recall at top 10. Reading, fixed now: **beats** if the lower bound is above 0 and the estimate is at least +3 pp; **trails** if the upper bound is below 0 and the estimate is at most -3 pp; **matches** if the whole interval lies inside ±3 pp; otherwise **unresolved**. Everything else is secondary and labelled so.

**Scope stays as registered:** these benchmarks ingest once and ask once, apart from the dated sessions, so they test retrieval for answering, not the lifecycle. Every result is published in `docs/evals/2026-09-25-public-benchmarks-365.md`, whichever way it goes.
