# DolphinBench pilot runbook: hippo-memory v1.52.3, 20 Morgan tests per arm

Plan and deviations D1 to D7: `dolphinbench-feasibility.md`. This file covers running the pilot, checking it and tearing it down. Every command runs in a WSL (Ubuntu) shell.

## What is in place

| Piece | Where |
|---|---|
| hippo v1.52.3, built (tag v1.52.3, commit fcd432e) | `~/dolphin/hippo-v1.52.3` |
| Claude Code 2.1.259, pinned local install | `~/dolphin/claude-code/bin/claude` |
| Stores: Morgan 3,400, Alex 5,011, Riley 5,128 memories | `~/dolphin/stores`, ingest runs in `~/dolphin/runs/ingest-<persona>` |
| DolphinBench clone, its WSL venv, judge work files | `/mnt/c/Users/<user>/hippo-bench` (`dolphinbench/`, `.venv-dolphin-wsl/`, `runs/`) |
| Adapter and stage driver | `$DOLPHIN/dolphin_hippo.py`, where `DOLPHIN=/mnt/c/Users/<user>/hippo-wt-dolphin/benchmarks/public/dolphinbench` |
| Memory hook and `search_memories` MCP tool | `$DOLPHIN/dolphin_memory.py` |
| Fake Claude for dry runs (no model call) | `$DOLPHIN/dolphin_fake_claude.py` |
| Judge proxy (stub or codex) | `$DOLPHIN/dolphin_smoke.py` |
| Memory server, run with `--dist` on the v1.52.3 build, `--read-only`, `--host 127.0.0.1` | `$DOLPHIN/../hippo-mem0-server.mjs` |

`run` starts the judge proxy, then one process per arm (`hippo`, `bm25`). Each arm serves the shared store through its own read-only hippo-mem0-server on loopback (ports 18801 and 18802) and runs the tests. It stops everything and prints the `check` report, then the `GATE:` line. Exit code 0 means both arms exited 0 and the gate passed (Checking).

## One-time setup

1. The founder runs `claude setup-token` once, in any terminal, and copies the token it prints. Never save it to a file.
2. Make a clean codex profile for the judge: a folder holding only a copy of `auth.json` (feasibility doc, Regenerate):

   ```bash
   mkdir -p /mnt/c/Users/<user>/.dolphin-codex && cp /mnt/c/Users/<user>/.codex/auth.json /mnt/c/Users/<user>/.dolphin-codex/
   ```

   Risk from the doc: a copied `auth.json` can fail when either copy refreshes (`refresh_token_reused`). If judging fails that way, copy it again and rerun.

## Each session

```bash
cd /mnt/c/Users/<user>/hippo-bench
DOLPHIN=/mnt/c/Users/<user>/hippo-wt-dolphin/benchmarks/public/dolphinbench
read -rs DOLPHIN_CLAUDE_OAUTH_TOKEN && export DOLPHIN_CLAUDE_OAUTH_TOKEN   # paste the token, then Enter; nothing echoes
export DOLPHIN_CODEX_HOME=/mnt/c/Users/<user>/.dolphin-codex
```

`read -rs` keeps the token out of the command line and shell history. Each arm process removes the variable from its own environment at start and hands the token to Claude as `CLAUDE_CODE_OAUTH_TOKEN` only in the Claude subprocess environment. The judge process never receives it. Keep it exported until `check` and `compare` have run: they scan every file for it, and a real run checked without it fails as `not scanned`.

A real-agent run refuses to start while any file it runs has uncommitted changes (`commit these first`): the adapter files, `hippo-mem0-server.mjs` and `evidence_recall.py`. It records the last commit that changed them, and `compare` checks every recorded hash against that commit.

## Environment

`ingest`, `run`, `arm` and `judge` refuse to start while any `HIPPO_*` or `DOLPHINBENCH_*` variable, `DOLPHIN_JUDGE_MODEL`, a model variable under `ANTHROPIC_`, `CLAUDE_CODE_`, `OPENAI_` or `CODEX_`, `MAX_THINKING_TOKENS` or `CLAUDE_CODE_EFFORT_LEVEL` is set; `unset` the ones it names. The pinned hippo build reads `HIPPO_FAKE_NOW` and `HIPPO_ABLATE_*`, so one stray variable would change the ranking without showing in the record. Every child starts from an allowlist, `PATH HOME LANG LC_ALL SSL_CERT_FILE SSL_CERT_DIR WSL_INTEROP`, plus only what it needs: the arms the token (or `DOLPHIN_FAKE_FAIL` in a dry run), the judge `DOLPHIN_CODEX_HOME`, Claude its token, its per-test home and config dir, and the effort. The record lists the allowlist's names, never values.

## Smoke first: 1 test per arm

The dry run used a fake agent, so three things are only proven with the real CLI: the hook's context reaches the model, `CLAUDE_CODE_EFFORT_LEVEL=medium` is honoured, and every tool the agent calls is on the official list. The first two are read from Claude's own session file, which the run keeps until the test ends. Spend two sessions on them first:

```bash
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py run --label smoke --persona morgan --tests 1 --judge codex --agent claude
```

Pass: exit 0 and `GATE: PASS`, which includes `memory_context ok` (the hook's full context is in Claude's session file) and `model ok` (every main-thread message from `claude-sonnet-5`, at `medium` effort per the session file); `attempts` shows `usable` only; and `~/dolphin/runs/smoke-hippo-morgan/hooks/morgan/001-0.json` exists. Read `helper_models`: models Claude Code calls on its own, with their tokens, recorded apart and never failing the gate. A tool outside the list shows as `Claude used tools outside the allowed MCP surface` in the attempt's `error` in `tests/morgan/001.json`; the test still counts.

## Pilot: 20 Morgan tests per arm

```bash
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py run --label pilot --persona morgan --tests 20 --judge codex --agent claude
```

The official Claude + Mem0 rows took 32 s per test on these 20 tests, so expect roughly 15 to 30 minutes with both arms in parallel. Follow progress with `tail -f ~/dolphin/logs/pilot-hippo-morgan.log` (one line per test: attempts, outcome, seconds, tools called; an arm that stops early ends its log with a `STOPPED`, `PAUSED` or `DEFERRED` line).

## Full run: 200 tests per persona per arm

Only after the pilot passes its gate (Amendment 3 in `docs/evals/2026-09-24-public-benchmarks-prereg.md`). One persona at a time, since the judge and server ports are fixed:

```bash
for p in morgan alex riley; do .venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py run --label full --persona $p --tests 200 --judge codex --agent claude || break; done
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py compare --label full
```

At 200 tests the gate is integrity only: `complete`, `token`, `memory_context`, `model` and `judge`. The pilot's alarms become rules: a test that touched a benchmark file or that the adapter closed fails in its arm and is listed (`dataset_touches`, `closed_by_adapter`). If an arm prints `PAUSED`, the run is over: publish it as paused, with no reading, and do not rerun it under a new label (Amendment 3).

`compare` refuses, with exit 1 and `compare refused`, a paused run. It then runs the gate for each persona at 200 tests, prints the `GATE:` lines, and refuses unless every part passes and each arm has 200 graded tests per persona. Last, it refuses records that differ across arms or personas, that come from the fake agent or the stub judge, or whose recorded hash of any file it runs differs from the recorded commit or from this checkout: run it from this checkout at that commit, with the token still exported. Then it prints hippo minus bm25 in pass rate, paired by test, with the 95% bootstrap interval and the registered reading on the `all` row. The rows per persona, `without_morgan_1_20` (the pilot's tests left out) and `excluding_closed` are secondary; `arms` pools each arm's counts and lists over the personas.

## Where results land

- Per arm: `~/dolphin/runs/pilot-hippo-morgan` and `pilot-bm25-morgan` (from Windows: `\\wsl$\Ubuntu\home\<user>\dolphin\runs\`).
  - `tests/morgan/NNN.json`: transcript, per-attempt summary (outcome, cost, usage, main-thread models, `model_usage` per model, the effort and injected context read from Claude's session file, session id, tools, memory hits, own and wall time, any limit wait, and `closed` with its reason).
  - `grades/morgan/NNN.json`: one entry per check; a test passes when it has checks, every check passes and there is no `dataset_touch` or `closed` entry.
  - `deferred/morgan/NNN.json`: why a test was left for a rerun, with its attempts, which the rerun carries on, so the attempt cap spans passes and resumes.
  - `hooks/morgan/NNN-K.json`: the query, the 10 memories injected and the hook time for attempt K, numbered over every pass.
  - `paused.json`: why a full-run arm paused; the run stays paused.
  - `apps/morgan/NNN/`: the app state and the app call log.
  - `costs/tests.json`: summed API-equivalent cost reported by Claude Code (subscription, no charge).
- Logs: `~/dolphin/logs/pilot-*.log` (arms, judge, servers).
- Judge work files (codex replies and logs): `C:/Users/<user>/hippo-bench/runs/judge-pilot/`, named `codex-<arm>-<persona>-<test>-<8 hex>.txt` and `.log`, so arms, personas and retries never share a file.

## Checking

```bash
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py check --label pilot --persona morgan --tests 20
```

The last line is the gate, `GATE: PASS` or `GATE: FAIL`, with each part; exit 0 only on PASS. The parts:

- `complete`: every test of both arms has a result and a grade, and each arm has `costs/tests.json`.
- `token`: no run file, log, file under `/tmp/dolphin-work` or judge work file holds the token or the dry run's dummy. A real run checked with the token unset fails as `not scanned`.
- `memory_context`: every graded attempt the agent acted on has the hook's full context in Claude's session file (`not_injected` lists the rest as `trimmed` or `missing`).
- `model`: every attempt the agent acted on has main-thread messages from `claude-sonnet-5` only, at `medium` effort (`model_flags`). Sub-agent and helper models are listed in `helper_models` with their tokens and do not fail.
- `judge`: every judged grade names the run's judge, `codex:gpt-5.6-sol` or `stub` (`judge_mismatch`).

Three more parts are pilot alarms, checked below 200 tests only:

- `memory_found`: no graded attempt whose hook found nothing (`no_memory_context`).
- `dataset_path`: no benchmark file path in any tool call or tool result (`dataset_touches`, see D8). Such a test also fails.
- `closed`: at most 1 test per arm closed by the adapter. A closed test fails whatever the agent did before it stopped. Read its attempts before trusting the score.

The report also gives, per arm: `passed` and `latency_s_mean` beside `official_claude_sonnet_5`, the public rows for the same 20 tests (builtin 9, mem0 9, honcho 8 passed; mean latency 25.2, 32.0 and 42.5 s). Latency is the graded attempt's own run time; `limit_wait_s` and the `attempts` count by outcome (`usable`, `failed`, `limited`, `no_turn`) show waits and retries. `retry_graded` lists tests graded after an earlier failed or before-a-turn attempt; `closed_by_adapter` gives each closed test's reason, and `mismatch_closed` the ones closed because the transcript or app calls could not be matched. `tokens_per_test` and `memory_searches_per_test` come from the graded attempts, `cost_usd_api_equivalent` from every attempt. `deferred` lists tests still waiting for a rerun. In the pilot, `local_calls` lists every Bash, Read, Grep and Glob call per test: read each one, with every `dataset_touches` entry, for paths outside the test's working directory (Differences, D8).

## Resuming

Rerun the same command. Finished tests are kept and not repeated; grading resumes where it stopped.

- `DEFERRED twice: NNN`: 3 attempts in a row ended before the agent's first turn, in each of two passes. The tests are not failed; rerun to pick them up. Their attempts carry over, and a test closes after 9 attempts that failed or ended before a turn, counted over every pass and rerun.
- `STOPPED at morgan/NNN: Claude usage limit, resets ...`: the reset is more than 6 hours away, or the test hit 20 limits. Rerun after the reset. Shorter waits happen inside the run and are not failed attempts. `STOPPED ... memory server check failed` means the arm's server stopped answering; read its server log first.
- `PAUSED: the adapter closed N of this arm's tests, over 12`: in the full run, the arm's closed tests exceeded 2% of its 600, counted over every persona. The arm stops scheduling tests, and the run is over: publish it as paused, with no reading, and never rerun it under a new label (Amendment 3). A rerun of the same label prints `PAUSED earlier`. The pilot never pauses; its `closed` alarm fails instead.
- `commit these first`: a real-agent run found uncommitted changes in a file it runs. Commit them, then rerun.
- `unset ...: the run pins its models and hippo settings`: unset the variables it names (Environment).
- `Uncertain interaction tests/morgan/NNN`: the process died mid-test. Delete `tests/morgan/NNN.inflight` (keep any `NNN.returned` for reading) and rerun; that one test runs again.
- `Run inputs changed`: the configuration, test count or code differs from the directory's `run.json`, which pins the sha256 of every adapter file, the memory server, `evidence_recall.py` and the hippo build, the last commit that changed this checkout's files among them, the judge and the allowlist. Use a new `--label`.
- `port ... is busy`: a server from an earlier run is still up; see teardown.

## Teardown

```bash
unset DOLPHIN_CLAUDE_OAUTH_TOKEN                  # or close the shell
rm -rf /mnt/c/Users/<user>/.dolphin-codex          # the auth.json copy
pkill -f "[d]olphin_hippo.py"; pkill -f "[h]ippo-mem0-server"   # only if a run was interrupted
rm -rf /tmp/dolphin-work                          # per-test Claude homes (emptied after each test)
```

To remove everything, including the stores, the pinned hippo and Claude Code: `rm -rf ~/dolphin` and `rm -rf /mnt/c/Users/<user>/hippo-bench/runs/judge-*`.

## Differences from the feasibility doc

- hippo is a shallow clone of GitHub tag v1.52.3, not a clone of `C:/Users/<user>/hippo` at a named commit (the build brief said so; that checkout holds other people's uncommitted work).
- D8: the agent runs as the normal WSL user, not a dedicated one: `sudo` needs a password and bubblewrap is not installed. Mitigations: a fresh HOME, config dir and working directory per test under `/tmp`; the token lives only in the Claude subprocess environment; the codex profile stays out of the arm processes; transcripts are redacted; `check` scans for the token and for dataset paths in tool calls and tool results. The agent can still read files through Bash; this is detected, not prevented. The review's probes found two misses: the other arm's live hook file read by a relative path, now caught through `hooks/<persona>/`, and `grep -rh` over /home, which prints no path and stays a miss. The structural fix is the driver's `run_as_user` (`claude_driver.py:521-531`) with a user that cannot read `/home/<user>` or `/mnt/c`, set up with one sudo; until then read every pilot `local_calls` entry. Known false alarms: `ps` during a run shows the other arm's `--out` hook path, and the agent reading its own `mcp.json` or settings file shows `/dolphin/runs/`.
- Claude runs with session persistence on (`persist_session=True`, where the driver's default adds `--no-session-persistence`, `claude_driver.py:503`), so its own session file proves the hook's context reached the model and gives the effort. The file is read after each attempt and removed with the per-test home.
- Every child process starts from an allowlist, where the driver copies the full environment (`claude_driver.py:46`); see Environment.
- Effort is pinned with `CLAUDE_CODE_EFFORT_LEVEL=medium`; the official run relied on the default, recorded as medium.
- The store hash covers every column of every memory row, stricter than the doc's (id, created, content). The arms re-check it after every test.
- The judge proxy now answers one verdict at a time (`JUDGE_LOCK` in `dolphin_smoke.py`), since two arms grade at once.
- The arms' servers run with `--read-only` (every route but `POST /search` and `GET /health` answers 403) and bind 127.0.0.1 only. Only ingestion writes.
- Each arm runs the stock runner's steps through `evaluate()` in `dolphin_hippo.py` instead of `Runner.evaluate`, adding deferral with carried attempts, the pause, the dataset and closure stamps and the judge tag. Like D4, the tag is set in memory (`llm_judge.OPENAI_DEFAULT_ENDPOINT`), not by editing DolphinBench's code; the recorded judge settings do not include the endpoint.

## Dry run (done, no model calls)

```bash
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py selftest
.venv-dolphin-wsl/bin/python $DOLPHIN/dolphin_hippo.py run --label v5dry --persona morgan --tests 2 --judge stub --agent fake
```

The fake echoes the model it is given, runs the hook and writes a session file as Claude does, and reports a `fake-helper` model beside the main one. Result, 2026-09-28: `selftest ok`; `v4dry` exit 0 and `GATE: PASS` with every part ok, 2 tests and 2 grades per arm, `helper_models` showing `fake-helper`; `v5dry`, rerun on the committed files after comment-only edits, the same. Forced failures, on the v4 files, same command with a new label and `DOLPHIN_FAKE_FAIL`: `=drop` (context left out of the session file) failed `memory_context` on both tests of both arms; `=1` (3 tests) closed all 3 in each arm after 3 failed attempts and failed the pilot's `closed` alarm, with no pause; `=idle` deferred both tests twice, and the same command without it graded them on attempt 7, with the 6 earlier attempts in `retry_graded` and hook files 0 to 6; a second `=idle` run of a deferred label closed both tests at the cap (`0 failed, 9 before a turn`); `=limit` stopped both arms at 001 with the reset time. `compare --label v4dry --personas morgan` refused with exit 1 (2 of 200 graded). Labels before v5 predate the current code hashes, so they cannot be resumed.
