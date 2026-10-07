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

## Amendment 4 (2026-09-28, before any Mem0 call): the Mem0 arm on LoCoMo, on the Claude subscription

**Why.** The registered comparison with `mem0-oss` has not run. The status line above says scored runs cost API money, and they need not. Mem0's server needs a model to extract memories and the runner needs one to answer and judge; all three can run through `claude -p` on the Claude subscription, which costs nothing beyond its usage limit. This amendment runs the `mem0-oss` arm on LoCoMo now. The status line's cost note holds for the registered gpt-5 run only, which is unchanged and still waits.

**Code:** `benchmarks/public/mem0/`, added in this commit: `claude_llm.py` (the `claude -p` caller, and an OpenAI-compatible proxy over it), `mem0_server.py` (the runner's Mem0 server with session dates), `config.yaml`, `run_runner.py` (the runner with a longer timeout) and `h2h.py` (answering, judging and scoring).

**The `mem0-oss` arm.** The runner's own Mem0 server, `docker/mem0/main.py` at `4b61c5d`, with the Mem0 library its image installs: `mem0ai` 1.0.11 at commit `5e941e2` (the head of Mem0's pull request #4805, branch `feat/v3-pipeline`, since deleted), in a Python 3.12 virtual environment instead of the image. Mem0's add pipeline, extraction prompt and search run unchanged. The runner sends one turn per `add` and Mem0 makes one extraction call per `add`: 5,882 calls for the ten conversations. Five changes, each needed to run it without paid APIs:
1. **Extraction model:** Claude Sonnet 5 at low effort through the proxy, instead of `gpt-4o-mini`. `claude -p` has no JSON mode and no temperature setting, so the proxy asks again when a reply holds no JSON object, at most 3 times, and waits out usage limits. Every call is logged. Sonnet 5 is the larger model; if the swap changes Mem0's extraction, it is expected to help it.
2. **Embedder:** `nomic-embed-text` through Ollama (model id `0a109f422b47`), the runner's own local option (`configs/ollama.yaml`), instead of `text-embedding-3-small`.
3. **Vector store:** Qdrant 1.19.1 (image digest `sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10`), as in the runner's compose file, on a fresh volume.
4. **Session dates:** the runner sends each turn's session date as `timestamp` and the runner's server drops it, so Mem0 would date every memory on the day of ingestion and resolve "last week" against 2026. `mem0_server.py` passes the date through two inputs Mem0 already has: `metadata.created_at`, which Mem0 stores as the memory's date, and the extraction prompt's Observation Date. hippo's server already dates every memory at its session, so without this change the comparison would favour hippo.
5. **Timeouts:** the runner's 300 s timeout to the server becomes 12 h (`run_runner.py`), and the OpenAI client inside the server stops retrying. Otherwise a wait on a usage limit would make the runner send a turn again, and Mem0 would store it twice.

The runner itself runs unchanged, `--backend oss --predict-only --top-k 200`, over the ten conversations.

**`hippo@365` and `bm25` arms:** Lane R's retrieval, unchanged (`2026-09-25-public-benchmarks-365.md`): the runner's `--predict-only` output at top 200, embeddings off.

**Answering and judging, identical for the three arms:** Claude Sonnet 5 at medium effort, one `claude -p` call per answer and one per verdict, with the runner's prompts and parsing at `4b61c5d` (`run.py:529-556`): the answer prompt with an empty system prompt, the text after the last `ANSWER:`, and the judge's JSON `label`, counted correct only when it reads CORRECT. `claude -p` adds about 590 tokens of its own to every call (account and environment lines, the model name, today's date), the same for every arm. Answers are made in one shuffled pass that interleaves the arms, verdicts in one shuffled pass over every answer with no arm label. Lane A's subagents answered 40 questions each; this run makes one call per answer, so its answers do not pair with Lane A's.

**Sample and cutoffs:** Lane A's 400 LoCoMo questions (seed 1, categories 1 to 4), at top 200, 50 and 10.

**Primary comparison, as registered:** `hippo@365` minus `mem0-oss` in the LoCoMo authors' F1, paired by question, 95% bootstrap (`boot` in `evidence_recall.py`: 4,000 draws, seed 1), at top 200 and at top 50. Each is read with Amendment 2's rule, in its order: **beats**, **trails**, **matches**, otherwise **unresolved**. **Secondary, labelled so:** judge accuracy; `bm25` minus `mem0-oss`; `hippo@365` minus `bm25`; top 10; F1 per category; memories and input tokens per answer.

**Integrity gate, checked before any answer is made.** Mem0 treats a failed extraction as nothing to remember and carries on, so a failure would shrink its store with no error. The gate: no `fail` event in the proxy's log; no "LLM extraction failed", "Error parsing extraction response" or "Failed to embed memory text" line in the server's log; and `total_chunks_failed` 0 for every conversation. A conversation that fails is deleted and ingested again under a new user id, and the result lists it. The dry run adds a few turns of conversation 0 under its own user id, which no question searches. A setup fix after the dry run is allowed and listed in the result.

**LongMemEval-S:** the `mem0-oss` arm is not run there. Its 500 questions each carry their own history: 124,333 add calls at the runner's two messages per call (counted with the runner's `pair_turns`), 21 times LoCoMo's, too many for the subscription. hippo's LongMemEval-S results stay against BM25 only.

**Published whatever the result:** `docs/evals/2026-09-28-mem0-head-to-head-result.md`, with the answers, the verdicts, the judge key, the score output, a summary of every call log, the code, the versions and the commands. If `hippo@365` trails `mem0-oss`, that is published the same way.

**Scope:** as registered, LoCoMo ingests once and asks once, so this tests retrieval for answering, not the lifecycle. Mem0 runs here with another extraction model and embedder than in its own published runs, and every arm with another answering and judging model, so no number here is comparable with Mem0's published numbers.

## Amendment 5 (2026-09-28, before any answer is made): Mem0's keyword search on, the gate in code, scores bound to the answers

**Why.** Four codex reviews, each run during a full ingestion and before any answer, found gaps. The first, of the Amendment 4 code (`d63449d`, with the search fix `3b6b882`), found Mem0 searching without its keyword score. Mem0's hybrid search adds a BM25 keyword score to the vector score and its entity boosts, and its BM25 encoder needs `fastembed`, which sits in `mem0ai`'s optional extras. The runner's image installs `mem0ai` with no extras (`docker/mem0/requirements.txt` at `4b61c5d`), and so did this run, so Mem0 logged one warning per store when the encoder failed to load, which it then never tries again (`qdrant.py:84-97`), and searched with the vector score and entity boosts alone. It also found that the gate was not enforced before answering, that it missed replies Mem0 reads as holding no memories, and four weaker points in the scoring script. The second, of `1a7c274`, found three losses Mem0 logs no higher than DEBUG, a proxy deadline that did not cover every wait, question files checked by count alone, answers not bound to the retrieval they came from, a duplicate check that can drop a memory's speaker unseen, a recovery rule the new gate would always fail, and three weaker points in the scoring script. The third, of `a680152`, found that the gate failed two recoveries Mem0 completes on its own, that a record holding U+2028, U+0085 or U+2029 would break the readers of the logs and result files, that the gate read a correct empty BM25 encoding as a missing one, that counts over all users could hide one user's loss or a memory moved to another user, that nothing checked the retrieved memories against the store, that the judge-reply parse took a label from inside other text where the runner asks again, and two inaccurate lines in this amendment. The fourth, of `6526c92`, found that the gate failed Mem0's batch-search recovery when Qdrant's error text runs onto two more lines, that a kill while writing the judge key would block judging, that Mem0 can lose entity links with no log, that a stored BM25 vector with terms was never checked against its text, that a saved answer or verdict was not tied to a logged reply, and three inaccurate lines in this amendment. This amendment was revised the same day after the second, third and fourth reviews, each time before any answer. Each change below gives Mem0 its full method, makes a loss visible or tightens a check; none changes what hippo's arms retrieve.

**The `mem0-oss` arm** (commits `0fce9bf` and `738e7e6`):
1. **BM25 on:** `fastembed` 0.8.1 in Mem0's environment, with the BM25 model `Qdrant/bm25` at revision `22b8d2af71a76161e18dd432d2cee0eefa66e412`. This runs Mem0 with the full search its code has, which its image would not; it is expected to help Mem0. `mem0_server.py` refuses to start without the encoder.
2. **Entity store built at startup:** Mem0 creates its entity collection on the first add. Ten first adds at once raced to create it, and one lost its entity links to an HTTP 409. The server now builds the store and both BM25 encoders once, before any add.
3. **Quiet losses logged:** Mem0 drops a failed entity embedding (`main.py:739-749`), a failed entity link (`782-783`) and a failed keyword search (`qdrant.py:424-426`) with no log above DEBUG. `mem0_server.py` logs each at WARNING, so the gate sees it, and leaves Mem0's handling as it was. A failed embedding inside a batch logs at INFO, because Mem0 then embeds that batch's texts one at a time, and a text that still fails logs at WARNING.
4. **One deadline per call:** each proxy call gives up 11 h after it starts, counting slot waits, runs, usage-limit waits and the sleeps between failed attempts, so it fails inside the 12 h client timeouts and a client never resends a live add.
5. **Fresh starts:** the first full ingestion was stopped after 1,276 of the 5,882 extraction calls, with BM25 off; the second after 2,238, before any question was searched, when the second review found the quiet losses. From the second, only counts were read. Both are kept and not used. The third ingestion runs the code of `738e7e6` on a fresh Qdrant volume that no test touched, with a fresh history database.
6. **Recovery**, replacing Amendment 4's: a failed gate is never overridden. The cause is found, fixed and listed in the result, and ingestion starts again in full on a fresh Qdrant volume and history database, the failed run's files moved aside and kept. One conversation is never ingested again on its own: its extra calls and adds would break the gate's totals.

**The integrity gate, now code** (`gate.py`, run in Mem0's environment once ingestion ends). It replaces Amendment 4's gate and is stricter:
- the proxy's log: no `fail` event, and exactly one successful extraction call per turn, 5,882 in all;
- every successful reply parses, with Mem0's own `remove_code_blocks` and `extract_json`, to a `memory` list whose items all carry text. Mem0 logs an ERROR for a reply it cannot parse and remembers nothing from it (`main.py:601-614`), remembers nothing from an empty reply or a JSON object with no `memory` key and logs nothing, and skips an item without text with no log while keeping the others;
- the server's and the runner's logs: no line holding WARNING, ERROR, CRITICAL, Warning, Exception or Traceback, where Amendment 4 named three messages. The runner's client retries a failed search and after its last retry writes the question's file with no memories; each attempt logs at WARNING or ERROR, so this check catches it. One line is exempt and counted: Mem0's WARNING that a batch search failed and it is running the queries one at a time (`qdrant.py:394-396`), with the two lines `qdrant_client` puts below it for an HTTP error, `Raw response content:` and the body (`exceptions.py:37-38`), and every line after those is checked; a query that fails again ends the entity linking it serves with another WARNING, which fails the gate. Codex's two harmless examples, fastembed's warning that it could not save model metadata and a 404 for a favicon, still fail it; neither was in the third ingestion's logs when this was written;
- every request Mem0 made to Qdrant and to the proxy answered 2xx, except two batch requests Mem0 redoes piece by piece, each counted: a batch search (`POST /collections/*/points/query/batch`), redone one query at a time as above, and a batch insert of memories (`PUT /collections/locomo_mem0/points`), redone one memory at a time, where a memory that fails again logs an ERROR (`main.py:686-692`). Failed requests to Ollama are counted but allowed, since Mem0 redoes a failed batch embedding one text at a time and a text that still fails logs a WARNING;
- the server answered 5,882 adds and 1,540 searches with 200, and no request with anything other than 2xx;
- every conversation's checkpoint: all its turns processed, none failed, and ten distinct user ids;
- exactly the 1,540 question files LoCoMo's categories 1 to 4 call for, each holding, under its own name, the question LoCoMo asks there, its conversation and category, that question as the search query, and its conversation's user id, and retrieving only memories that user has stored, with the same id, text and date;
- Qdrant: every stored memory carries the hash of its own text and exactly the BM25 terms and weights `Qdrant/bm25` gives its text, which the gate encodes again as Mem0 does at insert (`qdrant.py:182-186`); a memory with no terms passes only if its text encodes to none, as punctuation alone does. The stored users are exactly the ten ingested. Counted over all users, no text is stored more often than the replies extracted it, and every extracted text is stored at least once, since Mem0 skips a text only when a copy is already stored;
- per user, since Mem0 skips a text only when the same user holds a copy (`main.py:634-652`): one user holds every memory of each reply, every memory is dated at a session of its user's conversation, and every memory's `attributed_to` is one a reply gave for that text. The proxy's log does not say which user a call served, and Mem0's extraction prompt holds that user's stored memories, so a reply cannot be tied to its user exactly. A lost memory is therefore missed here when another user holds every memory of the same reply. Such a loss leaves fewer stored copies of its text than extracted ones, so it falls among the skipped copies the information line counts, and that count bounds it from above. The per-user line also reports, as information, the replies whose memories more than one user holds;
- every user has entity links;
- information only, not a condition: Mem0's duplicate check compares a user's texts alone, so a skipped copy's `attributed_to` and its turn's date are not kept. The gate counts the skipped copies, those from more than one turn, and those whose `attributed_to` no stored copy has. Changing that check would change Mem0, so it stays. The gate also counts the memories whose text names an entity, found with Mem0's own `extract_entities_batch` on the same text (`main.py:718-719`), that no entity links. Mem0 updates a matched entity from its search result, so two names in one add that match the same stored entity keep only the second's new links (`main.py:769-781`), with no log. That is Mem0's method and stays; Amendment 6 covers a larger loss of links.

The gate writes `gate.json` with SHA-256 hashes of the three logs and every predicted file, whole or not at all: a kill mid-write leaves the old file or none. `h2h.py answer` and `h2h.py score` stop unless it passed and the hashes still match.

**Scores bound to the answers** (`h2h.py`):
1. The judge and score stages require exactly the 3,600 (arm, cutoff, question) keys of the design, not only their count, and any stage stops on a key seen twice.
2. Each answer holds the SHA-256 of the prompt it answered. Answering resumes, and judging and scoring run, only if every answer's prompt matches the one its arm's retrieval file gives now, so answers from two retrievals cannot mix, even behind a new passing gate, and only if every answer is the one parsed from a reply the call log holds for that prompt, found by the call's tag and the prompt's hash.
3. The blind judge key holds each answer's SHA-256 and is written whole or not at all. Each verdict holds the SHA-256 of its judge prompt, which holds the question, LoCoMo's answer and the answer judged, and carries a CORRECT or WRONG label. Judging resumes, and scoring runs, only if every verdict matches, its label and reasoning are the ones read from a reply the call log holds for that judge prompt, and scoring has one per key.
4. A judge reply is read as the runner reads it (`llm_client.py:285-293`): the whole reply is the JSON, and a `final` wrapper that holds a JSON string or object is unwrapped. One difference: a code fence around the whole reply is removed first, since `claude -p` has no JSON mode. A label inside other text is no verdict. A reply with no CORRECT or WRONG label is asked again, three replies per item in all; then the item fails and is named, and a rerun asks it again, where the runner would count it WRONG. Every reply is in the call log, and no verdict is made up.
5. A failed call of any kind is named and retried by a rerun while every other result is saved. A last record cut off by a kill mid-write is cut from the file; one that is whole but lacks its newline is kept. The call logs, the server's log and the result files split into records on LF alone, since a record may hold U+2028, U+0085 or U+2029, which Python's `splitlines` also splits on; the runner's log splits on CR and LF, since its progress bars redraw with CR.

**Unchanged:** Amendment 4's arms, models, prompts, sample, cutoffs, primary comparison, reading rule and publication rule.
