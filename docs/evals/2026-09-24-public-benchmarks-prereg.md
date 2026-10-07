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

## Amendment 3 (2026-09-28, before any agent run): DolphinBench, hippo against BM25 behind an agent

**Why.** LoCoMo and LongMemEval-S hand retrieved text to a model and ask one question. DolphinBench (clone at `81cb6f8`, Apache-2.0) gives a coding agent a persona's long history, then 600 requests to carry out through mock apps, and grades the app calls. That is closer to how hippo is used: an agent acting on a long history, with memory reaching it through a hook. Nothing here costs money: the agent runs on the Claude subscription, the judge on the ChatGPT plan.

**Plan and code:** `benchmarks/public/dolphinbench/`, added in this commit. `dolphinbench-feasibility.md` holds the plan and deviations D1 to D7, `dolphinbench-runbook.md` the commands. Every stage runs committed files: a real-agent run refuses to start while an adapter file, `hippo-mem0-server.mjs` or `evidence_recall.py` has uncommitted changes, and records the last commit that changed them. Each run record carries the sha256 of those files and of the hippo `dist/*.js` it loads, so a resume refuses changed code and the pilot and full-run records can be diffed. `compare` refuses unless every recorded hash matches both that commit and the file it runs.

**Deviations from the official protocol:** no agent turn at ingestion, so Claude's native memory stays empty (D1); the judge model runs through codex (D2); no submission package (D3); the runner's paid-run guard is set in memory (D4); the per-prompt search hook is written for this benchmark (D5); "now" for hippo's ranking is the latest memory plus one day (D6); WSL on this PC, not the reference workers (D7). Added since the plan: the agent runs as the normal WSL user, with a fresh home, config and working directory per test (D8); effort is pinned to medium by `CLAUDE_CODE_EFFORT_LEVEL`, where the official run used the default, recorded as medium (D9).

**Arms,** both through `hippo-mem0-server.mjs` from hippo v1.52.3 (GitHub tag, commit `fcd432e`), embeddings off, over one read-only store per persona holding every history message verbatim, dated at its session (Morgan 3,400, Alex 5,011, Riley 5,128 memories):
- `hippo`: hippo's ranking at the shipped 365-day default;
- `bm25`: BM25 alone on the same store.

The server runs with `--read-only` on a loopback address, so no route can write to the store. The store's hash is also checked after every test, and a changed hash stops the arm. The server, the agent and the judge start from an allowlisted environment, and a run refuses to start while any `HIPPO_*` or `DOLPHINBENCH_*` variable or a model or effort override is set, so nothing outside the record can change hippo's ranking, the agent's model or the judge.

**Agent, identical in both arms:** Claude Code 2.1.259, the version the official workers pin; Claude Sonnet 5 at medium effort; the official run's built-in tools plus the benchmark's app tools; no native memory. Memory reaches the agent two ways (D5): a UserPromptSubmit hook that searches with the request, date prefix removed, and injects the top 10; and a `search_memories` tool for further searches. Neither can write.

**Judge:** gpt-5.6-sol at medium effort, the official judge model, through codex (D2). Re-judged through this route, 59 of 60 public verdicts came out the same. Each judge call writes to a file unique to its persona, arm and test, deleted before the call, so a judge that exits without output fails the grade and can never return an older verdict. The judge's kind, model and codex version go in each run's record, and `check` fails any grade from another judge.

**Stages:**
1. **Smoke,** 1 test per arm. Passes on the runbook's list: exit 0 and `GATE: PASS`, no failed or closed attempt, the hook's memory context found in Claude's own session file, and every main-thread message from Sonnet 5 at medium effort, read from the stream and the same file. Helper models Claude Code calls on its own are recorded apart, with their tokens. A setup fix after a failed smoke is allowed and listed in the result.
2. **Pilot,** Morgan tests 1 to 20 per arm. No verdict: 20 tests cannot separate the arms. It reports pass counts beside the official Sonnet 5 rows for the same tests (built-in 9, Mem0 9, Honcho 8 passed), with latency and tokens. The gate to stage 3 is integrity only, and `check` prints it as one line, `GATE: PASS` or `GATE: FAIL`. Its parts: every test complete; no token in any file, the judge's work files included, where a real run checked with the token unset fails as not scanned; the hook's context in Claude's session file for every graded attempt the agent acted on; every main-thread message from Sonnet 5 at medium effort; every grade from the pinned judge. Three alarms hold in the pilot only: no test whose hook found no memory, no benchmark file path in any tool call or tool result, and at most 1 test per arm closed by the adapter. Every dataset hit and every Bash, Read, Grep and Glob call is read by hand, for reads outside the test's working directory. If the gate fails, or either arm passes fewer than 3 of 20, every attempt of both arms is read before stage 3. At most one pilot rerun follows, under a new label, and each change it needed is published as a diff in the result. If the rerun's gate fails too, stage 3 does not run and the result says why. The pilot's scores never decide whether stage 3 runs.
3. **Full run,** all 200 tests of each persona, 600 per arm, under a new label, with the pilot's code and settings. Pilot tests are rerun, not reused. Every model Claude reports for an attempt is recorded with its tokens, sub-agents and helpers included, and helper models are reported per arm. The full-run gate is the pilot's integrity parts (complete, token, memory context, model, judge) without the alarms, which become the rules below. Three rules hold during the run. A test with no failed attempt whose attempts ended before the agent's first turn is rerun later in the arm, not graded, within the cap of 9 counted attempts. An arm whose adapter-closed tests exceed 2% of its 600 (more than 12, over all personas) pauses: the run stops and is published as paused, with no reading, and is not rerun under a new label. A test whose tool calls or tool results touch the benchmark's files fails in its arm and is listed. After any setup change in stage 2, the result also reports the primary comparison without Morgan tests 1 to 20.

**Primary comparison:** `hippo` minus `bm25` in pass rate over the 600 tests, paired by test, with the public benchmarks' bootstrap (`boot` in `evidence_recall.py`: 4,000 draws, seed 1, 95% interval). A test passes when it has checks, every one passes, it touched no benchmark file and the adapter did not close it. An attempt fails when the agent took a turn and the run still ended without a usable result. An attempt whose stream ends on a usage or rate limit is waited out and never counts. One that ends before the agent's first turn is retried; after 3 of those in one pass, a test with no failed attempt is rerun later in the arm, not graded. A test is closed after 3 failed attempts, after 9 attempts that failed or ended before a turn, counted over all passes and resumes, or at once when a usable attempt's transcript or app calls cannot be matched. A closed test fails in its arm and is listed. Reading, as in Amendment 2 and checked in this order: **beats** if the lower bound is above 0 and the estimate is at least +3 pp; **trails** if the upper bound is below 0 and the estimate is at most -3 pp; **matches** if the interval lies within ±3 pp, ends included; otherwise **unresolved**. `dolphin_hippo.py compare` prints the reading. It refuses a paused run, a failing gate (which needs 200 grades per arm and persona), and records that differ across arms or personas, come from another agent or judge, or whose file hashes differ from the recorded commit.

**What this run can detect.** Paired by test, the three official Sonnet 5 rows disagree on 27.8% to 29.3% of the 600 tests (computed from the public evidence files, sha256 checked against `official-results.json`). At that rate the 95% interval's half-width is about 4.3 pp, and the smallest difference found with 80% power is about 6 pp. **Matches** would need the arms to disagree on fewer than about 14% of tests, so it will almost surely not fire. **Unresolved** means the run could not tell the arms apart, never that they are equivalent.

**Secondary, labelled so:** the same comparison per persona, without Morgan tests 1 to 20 (the pilot's tests), and without the tests either arm closed; tests won by each arm; closed tests with their reasons and tests graded after a retry, listed per arm; mean latency, from the graded attempt's own `duration_ms`, with usage-limit waits and retries reported apart; tokens per test, from the graded attempt, and API-equivalent cost over every attempt; memory searches per test; helper models and their tokens per arm. The leaderboard's Sonnet 5 rows (built-in 158, Mem0 194, Honcho 215 of 600) appear for context only: under D1 they are not comparable.

**Scope.** One agent run per test per arm, so the interval includes the agent's own run-to-run variation. The hook is the adapter's, not hippo's shipped hook (D5). Any claim is limited to hippo's ranking against BM25 as the memory behind this agent. This is not a leaderboard entry (D3). Benchmark-file access is detected, not prevented (D8). The review's probes found two misses: the other arm's live hook file read by a relative path, which the detector now catches through `hooks/<persona>/`, and `grep -rh` over /home, which prints no path and stays a miss. The structural fix is the driver's `run_as_user` (`claude_driver.py:521-531`) with a user that cannot read `/home/<user>` or /mnt/c, set up with one sudo; until then the pilot's hand read of every local tool call is the check, and the full run has only the detector.

**Published whatever the result:** `docs/evals/2026-09-28-dolphinbench-result.md`, with every grade file, the `check` and `compare` output, the smoke and pilot results, the commands, and the transcripts as a compressed archive.

## Amendment 4 (2026-10-07, before any BEAM run): BEAM retrieval, hippo against BM25

**Why.** Other memory systems now publish BEAM results, and hippo has none. BEAM's own score needs a paid answerer and judge, so that lane waits for a yes on its cost. The retrieval lane costs nothing and gives a first read.

**Arms,** as Amendment 2, through `hippo-mem0-server.mjs` on one master build, embeddings off on both: `hippo@365` (the default) and `bm25`.

**Lane R, retrieval (no model calls).** Mem0's runner at `4b61c5d`, unchanged, `--predict-only`, top_k 200, every conversation at every tier: 100K (20 conversations), 500K (35), 1M (35), 10M (10), from `Mohammadta/BEAM` and `Mohammadta/BEAM-10M` on Hugging Face. A question's source turns are the turn ids in its `source_chat_ids` (a list, or a dict of lists for contradiction, knowledge-update and temporal questions). Abstention questions have none and are dropped. Four 1M conversations (indices 4, 25, 32, 33) restart their turn ids part way, so some ids name two turns; a question citing such an id is dropped from both arms and the count reported. The metric is the share of a question's source turns whose stored text appears in the top 10, 50 and 200 memories (`beam_evidence_recall.py`), reported per tier, overall and per question type. **Knowledge-update** is named in advance, as in Amendment 2.

**Primary comparison:** `hippo@365` minus `bm25`, paired by question, 95% bootstrap interval (4,000 draws, seed 1), evidence recall at top 10, read separately at 1M and at 10M, the tiers with the most for a memory to sort. Same reading as Amendment 2. Everything else is secondary and labelled so.

**Checks:** both arms score the same questions at each tier, and the runner logs no failed chunk in either arm.

**Not comparable** to the LLM-judged BEAM scores other systems publish: this measures what retrieval hands the answerer, not the answer.

**Published whatever the result:** `docs/evals/2026-10-07-beam-retrieval.md`, raw output in `benchmarks/public/results/2026-10-07-beam-lane-r/`.
