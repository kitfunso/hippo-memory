# DolphinBench x hippo: feasibility and run plan

2026-09-28. DolphinBench clone `C:/Users/<user>/hippo-bench/dolphinbench` at 81cb6f8; relative paths below are inside it.

## Verdict: feasible with deviations

The stock runner, mock apps and grader ran end to end in WSL with no paid key, and codex on the ChatGPT plan reaches the official judge model, gpt-5.6-sol at medium effort. The agent, Claude Code with Sonnet 5, can run on the subscription through the benchmark's own driver. Three things stand in the way: a one-time `claude setup-token` by the founder, about a day of adapter code, and subscription headroom for about $215 of API-equivalent Sonnet use across both arms. Results cannot be packaged as an official submission (D3), so this measures hippo against BM25 inside DolphinBench; it is not a leaderboard entry.

## Smoke test (done, no agent model calls)

- `dolphin_smoke.py`, beside this file, runs the stock `Runner` in WSL on Morgan: 2 history sessions, then test 001, with a scripted agent that places the order through the real mock-app MCP server.
- Stub judge: `runs/smoke-stub-20260928T103909`, 2 of 2 checks pass. Codex judge: `runs/smoke-codex-20260928T104011`, 2 of 2 pass; the field check went to gpt-5.6-sol, medium, in 8.8 s and 4,716 tokens (`runs/codex-0.log:5-9,38-39`).
- Judge calibration, `dolphin_judge_calibration.py 10`: 60 judge conversations from the public Claude Code + Mem0 evidence (10 Sol-pass and 10 Sol-fail per persona) re-judged through codex. 59 of 60 agree; the miss is one Morgan-036 field check that Sol failed and codex passed (`runs/judge-calibration.out`).
- Outputs live in `C:/Users/<user>/hippo-bench/runs/`. The scratch codex profile and its auth.json copy are deleted.

## Q1. Mock apps and call_app

- Per interaction, `Runner._apps` (harness/runner.py:106-149) makes a fresh workspace (state.json, calls.jsonl, tools.json) and returns a stdio MCP spec: the runner's Python running `mock_mcp/server.py`, or `mock_mcp/repair_server.py` when the persona has a test runtime (:127-136). All three do (`mock_mcp/runtime/*.json`, attached at harness/submission.py:539-547).
- call_app is plain MCP, `ClientSession.call_tool` over stdio (examples/mcp_connection.py:14-22). For Claude Code the driver passes the spec with `--strict-mcp-config --mcp-config` (harness/claude_driver.py:509-510).
- The server logs each call to calls.jsonl; the runner reads it after the turn (runner.py:184-189), and grading requires every app call to match a transcript tool call (submission.py:360; prefix `mcp__dolphinbench_apps__` stripped at :300).

## Q2. Reference harnesses and subscription login

- Claude Code driver: subscription only. It strips API-key and cloud credentials and passes only `CLAUDE_CODE_OAUTH_TOKEN` (claude_driver.py:27-66), made by `claude setup-token` (.env.example:25-27). Each call gets its own `CLAUDE_CONFIG_DIR` (:451-453), stream-json output (:491-502), strict MCP config, hooks via `settings`, and a model flag (:389-414, :505-517). Rate-limit rejections return a reset time (:87, :97-104).
- The official Claude runs used a subscription too: the evidence cost basis reads "Claude-reported API equivalent, not subscription charges". Official workers pin Claude Code 2.1.259 (reference/README.md:141), which npm still serves. This PC has 2.1.280 on Windows and none in WSL.
- No Claude participant adapter exists to reuse: `harness/adapters/` is Hermes only, and the reference suite "does not execute Claude external-memory runs" (docs/CANONICAL_EVALUATION.md:138-141). The same guide says the public benchmark does not require Modal (:133-136), where the reference Claude ingestion workers run (reference/execution/claude.py:13-28).
- Hermes is out: it needs Linux, a patched checkout and Azure gpt-5.6-luna (examples/reference/README.md:11-13, :29), and that example supports neither external memory providers nor Claude Code (:119).
- Reuse with hippo means a small adapter around `run_claude` (plan step 6).

## Q3. Ingestion

- Volume: 13,539 history messages, one per session: Morgan 3,400, Alex 5,011, Riley 5,128, each persona about 500k o200k tokens (`dolphin_stats.py history`).
- The contract says every history message goes through the agent and its normal memory hooks, one fresh conversation each (docs/DRIVER_CONTRACT.md:102-105). The runner checks transcript shape, not that a model produced it: the smoke test's scripted acknowledgement passed (runner.py:176-180).
- Verbatim storage: section 3 of the contract sets processing and retention rules, not a storage format. hippo-mem0-server already stores each chunk verbatim as one memory dated at the session time (hippo-mem0-server.mjs:74-96).
- Faithful path: 13,539 Claude turns whose hook writes the dated message. In the official Claude + Mem0 run, ingestion was about $1,696 of the $1,804 agent cost (results/claude-code/claude-sonnet-5/mem0/cost.json, minus the $107 test cost), about $0.13 per turn.
- Smallest faithful alternative: skip the agent turn and write the same dated message straight to the store. With verbatim storage the reply cannot change what is stored, so the store holds the same text as the faithful path. What is lost is Claude's native auto-memory from ingestion, which the official runs kept (results/claude-code/claude-sonnet-5/mem0/configuration.json:8). Both arms lose it equally (D1).

## Q4. Grading

- Judge settings come from env at import (graders/llm_judge.py:46-104): `DOLPHINBENCH_JUDGE_BACKEND=openai`, `_ENDPOINT`, `_MODEL`, `_KEY_ENV`. The openai backend posts chat completions to any endpoint (`_call_openai`, :210), so a local proxy works. Ours is `serve_judge` in dolphin_smoke.py, which calls `codex exec` with gpt-5.6-sol at medium effort and a no-tools preamble.
- The runner refuses paid runs unless the judge is Azure Sol (runner.py:86-91) and otherwise wraps grading in a replay-only guard (:227). Without editing the repo: build `Runner(..., allow_paid=False)`, then set `runner.allow_paid = True` (dolphin_smoke.py:142-143).
- Calls per test: the judge runs only for calls whose direct checks passed (graders/explicit.py:247-253). Morgan and Alex make one call per judged field (semantic_judge_version 1), Riley one batched call per action (version 2). Upper bound 0.94, 1.00 and 1.11 calls per test; the public evidence shows 298 calls over 600 tests, about 0.5 per test.

## Q5. Scoping and outputs

- The runner takes any release dict, so one persona or one test is a slice (dolphin_smoke.py:137-140). Run one process per persona.
- A run directory holds run.json; ingestion/<p>/<id>.{json,returned}; apps/<p>/{ingestion,<test>}/ (state.json, calls.jsonl, tools.json, directory.json, manifest.yaml); checkpoints/<p>.json; costs/{ingestion,tests}.json; tests/<p>/<id>.{json,returned}; grades/<p>/<id>.json.
- `package` and `validate` accept only the full 3-persona, 600-test release with the Sol judge settings (submission.py:388-400). Score from grades/: a test passes when every check passes.

## Q6. Token load per test

From the public Claude Code + Sonnet 5 + Mem0 evidence (`dolphin_stats.py evidence`): mean 279k input-side tokens per test (91 to 92% cache reads), 2.7k output tokens, 6 to 7 tool calls, 0.27 to 0.55 explicit Mem0 searches, $0.18 API-equivalent. For 2 arms x 600 tests: about 335M input-side and 3.3M output tokens, about $215 API-equivalent, plus about 600 judge calls at about 5k codex tokens each.

## Recommended run plan

1. Pin hippo: clone `C:/Users/<user>/hippo` into WSL ext4 (for example `~/hippo-pinned`), check out a named commit, then `npm ci && npm run build` there (WSL node 22.22.0 meets engines >=22.16.0). The dist in `C:/Users/<user>/hippo` dates from 2026-09-25, older than HEAD 8690a38, and must not be rebuilt in place.
2. Store, one per persona: POST all 13,539 dated user messages (`[narrative_date] message`, the runner's own format) to /memories with the session timestamp. Hash the stored entries (id, created, content).
3. Serve two read-only servers from the pinned clone on that data dir: `--arm hippo` (shipped 365-day half-life, v1.52.3 src/core/memory.ts:505; embeddings off as pre-registered, hippo-mem0-server.mjs:56-57) and `--arm bm25` (:111-113). The server writes the store only in addChunk (:75-96) and deleteUser (:124-129); the hash check catches any other write.
4. Agent: `npm i -g @anthropic-ai/claude-code@2.1.259` in WSL; Sonnet 5 at medium effort (configuration.json:6); token in the environment only; a fresh config dir per test; no native memory; Claude default built-in tools as in the official run (configuration.json:9).
5. Memory exposure, identical for both arms: a UserPromptSubmit hook that sends the prompt, date prefix stripped, to /search and injects the top 10, plus a `search_memories` MCP tool for follow-up queries. No write tool. The hook matters: the official agent searched Mem0 only 0.27 to 0.55 times per test.
6. Adapter, about 1 day: ingestion turns return a fixed acknowledgement with zero usage, as the smoke test does; test turns call `run_claude` and convert stream-json to messages (merge assistant events by message id, usage once per response; submission.py:173-222 accepts Anthropic usage keys); save the hook output beside each record; freeze and verify_checkpoint compare the store hash; on a rate-limit rejection, wait for the reset time and retry.
7. Judge: one shared proxy process with the dolphin_smoke.py settings. `dolphin_hippo.py` pins its model to gpt-5.6-sol in code and refuses to start while `DOLPHIN_JUDGE_MODEL` or any `DOLPHINBENCH_*` variable is set, so no variable can swap the judge.
8. Order: ingest once per persona, copy the run directory per arm, then evaluate one process per persona per arm. First pilot 20 Morgan tests per arm and compare latency and pass rate with the official Morgan rows.

## Deviations from the official protocol

- D1. No agent turn at ingestion. Stored text is unchanged; Claude's native memory stays empty. Scores are not comparable with the leaderboard's Claude Sonnet 5 rows (Built-In 158, Mem0 194, Honcho 215 of 600).
- D2. Judge transport: codex runs the model inside its agent loop, and the proxy ignores the grader's temperature, max_tokens and response_format. Same model and effort as the official judge (runner.py:29); 59 of 60 agreement on public verdicts.
- D3. No submission.zip and no validation; scores come from grades/.
- D4. The runner's paid-run guard is bypassed in memory (Q4), not by editing files.
- D5. The per-prompt retrieval hook is benchmark-specific. hippo's shipped UserPromptSubmit hook runs `hippo context --pinned-only --include-recent 5` (hippo src/hooks.ts:138), not a query-driven search.
- D6. The server's "now" is the latest memory plus one day (hippo-mem0-server.mjs:103-104). Every test in a persona shares one date, and "now" falls 1.4, 10.2 and 13.6 days before it for Morgan, Alex and Riley. Effect on hippo's ranking not measured; BM25 ignores it.
- D7. Runs in WSL on this PC, not on the reference Modal workers; Claude Code stays at 2.1.259, so only the host differs.
- Local only: the clone was re-checked-out with `core.autocrlf false` so manifest hashes match; content equals HEAD.

## Load and wall time

- Tests: the official Claude + Mem0 run summed 9.4 h of test latency per 600 tests (Morgan 2.8, Alex 3.0, Riley 3.5; `dolphin_stats.py results`). With three persona processes per arm, about 3.5 to 4 h per arm including judging, about 7 to 8 h for both arms, longer if subscription limits throttle.
- Judge: about 300 calls per arm at about 9 s each, 45 minutes of codex time spread over the persona processes.
- Ingestion under D1: 13,539 local writes and no model calls; not yet timed.
- Subscription load: about 1,200 Claude sessions, 335M input-side tokens (over 90% cache reads) and 3.3M output tokens; codex about 600 calls and 3M tokens.

## Hard blockers

1. `claude setup-token` for CLAUDE_CODE_OAUTH_TOKEN: one-time and interactive, the founder only. Keep the token in the environment, never in a file.
2. The adapter (plan step 6) does not exist yet, about a day of work.
3. Everything must run in WSL: the runner fails on native Windows (fcntl at runner.py:7, directory fsync at harness/durable_json.py:38, backslash manifest keys at submission.py:505). Claude Code is not yet installed there (plan step 4).
4. hippo must be built from a pinned clone outside `C:/Users/<user>/hippo` (plan step 1).

Risks, not blockers: the subscription caps for this load are unknown. Codex needs a profile holding auth.json, and a copied auth.json can fail when either copy refreshes the token (refresh_token_reused); pointing `CODEX_HOME` at the real profile with `--ignore-user-config` may avoid the copy (untested).

## Regenerate

The scripts sit beside this file (`C:/Users/<user>/hippo-wt-dolphin/benchmarks/public/dolphinbench`, `$DOLPHIN` in WSL); the clone, the venv, the evidence and every output stay in `C:/Users/<user>/hippo-bench`.

- Stats: `C:/Users/<user>/AppData/Local/Programs/Python/Python312/python.exe C:/Users/<user>/hippo-wt-dolphin/benchmarks/public/dolphinbench/dolphin_stats.py` (steps: history, tests, results, evidence).
- Smoke, stub judge: `wsl.exe -e bash -lc '/mnt/c/Users/<user>/hippo-bench/.venv-dolphin-wsl/bin/python /mnt/c/Users/<user>/hippo-wt-dolphin/benchmarks/public/dolphinbench/dolphin_smoke.py stub'`
- Smoke, codex judge: the same with `DOLPHIN_CODEX_HOME=<clean profile> DOLPHIN_JUDGE_MODEL=gpt-5.6-sol` and `codex` in place of `stub`. A clean profile is a directory holding only a copy of auth.json; delete it afterwards.
- Calibration: `DOLPHIN_CODEX_HOME=<clean profile> DOLPHIN_JUDGE_MODEL=gpt-5.6-sol .venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_judge_calibration.py 10`, run in WSL from `/mnt/c/Users/<user>/hippo-bench`.
- Evidence: `C:/Users/<user>/hippo-bench/evidence/<persona>-claude-mem0-results.json.gz`, from `https://dolphinbench-review.vercel.app/leaderboard/evidence/<persona>-claude-mem0-results.json.gz`; SHA256 matches `website/content/official-results.json`.
