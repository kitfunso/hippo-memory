# DolphinBench, official Claude Code + Sonnet 5 setup: pre-registration

**Date:** 2026-11-17
**Status:** fixed before the first real turn. The `hippo` and `plugin_sha256` fields come from the 3.6.0 setup; the run record (`/opt/dolphin-official/setup.json`, copied into every test run's `configuration.json`) is the binding value.
**Plan:** `hippo-bench/dolphinbench-official-plan.html`. **Review:** `hippo-bench/dolphinbench-official-plan-review.md` (rows 1-28).
**Runner:** `benchmarks/public/dolphinbench/dolphin_official.py`, launched by `run-dolphin-official.sh`.

## Comparison

The score is tests passed of 600 (Morgan, Alex and Riley, 200 each). It compares with the published Claude Code + Sonnet 5 rows: Built-in memory 158, Mem0 194, Honcho 215. The dataset, the tests, the scorer and the agent model do not change. No competitor agent runs on our tokens. The headline uses the v3.5.1 rank (decision 1); a rank chosen on these 600 tests would be a second, labelled pass (arm R), not the headline.

## Run record

```json
{
  "model": "claude-sonnet-5",
  "claude_code": "2.1.259",
  "claude_sha256": "f7dd62ae415378018cd21dd950eb3bac174ab085830304d3b8b098146bfd47b6",
  "claude_install": "/opt/claude-2.1.259/bin/claude, root-owned 0755; init event version checked every turn",
  "ingestion_effort": null,
  "test_effort": "medium",
  "hippo": "hippo-memory@3.6.0, integrity sha512-E+y9gv1Sk05IXUwN4RK+TNNuYoJGt8q+2/JSezwG8hxP0QFunEqz7lJ19pSAmd3q/zTeYTShL8qf1Gb34+i9ng== (matches the registry)",
  "plugin_sha256": "b4bfdfac4e441060f72a81b4e2058ede72ffe2035dc8a3df842a15d8389fbc6e (v3.6.0 tag 4b7501631, extensions/claude-code-plugin, version 0.6.2, own .mcp.json, no overlay)",
  "rank": "v3.5.1 rank (decision 1)",
  "mcp_server": "hippo-memory (plugin .mcp.json: command hippo, args [mcp]); Claude Code names it plugin:hippo-memory:hippo-memory",
  "node": "v22.22.0",
  "embedder": "@huggingface/transformers 4.2.0, onnxruntime-node 1.24.3, Xenova/all-MiniLM-L6-v2 onnx/model.onnx sha256 759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e",
  "hippo_model_cache": "/opt/hippo-models, root-owned, bound read-only",
  "npm_install": "npm install --prefix /opt/hippo-<version> --ignore-scripts --omit=dev <spec> @huggingface/transformers@4.2.0",
  "env_allowlist": ["HOME", "HIPPO_HOME", "HIPPO_MODEL_CACHE"],
  "init": "hippo init --no-hooks --no-schedule, as the persona uid, in <home>/project",
  "sandbox": "bwrap 0.9.0, uid 2002 ingest, uid 2001 test",
  "memory_writes_at_test": "HIPPO_READ_ONLY=1, five write tools denied",
  "seed": "official predicate + .hippo",
  "capture_scheduling": "runner waits for an empty worker queue (runner_waits_for_empty_worker_queue_v1)",
  "tokens": "any of 1-3 with room; every pause logged",
  "judge": "gpt-5.6-sol medium, transport per decision 3 (Codex proxy, port 18765)",
  "smoke_gates": "user facts >= 5/20, project recall, 1 vector per memory, hook p95 < 2.5 s, 0 hook timeouts",
  "deviations": ["judge transport", "WSL host", "bwrap", "worker wait", ".hippo seed",
                 "module branches", "no LLM key for hippo", "notes import finds nothing"]
}
```

### Fixed inputs

| Input | Value |
|---|---|
| Source bundles | `claude-mem0-{morgan,alex,riley}-source.tar.gz` from the leaderboard evidence page. sha256 morgan `87bf36c0...17a5`, alex `00f0b992...c910`, riley `87f4179f...b906` (full values in `dolphin_official_setup.py` `BUNDLES`). The three ship byte-identical code folders; setup checks it. |
| Source history | Each persona's source id list must hash to the published Mem0 receipt (`SOURCE_IDS_SHA256` in `dolphin_official.py`). 13,539 turns in total. |
| Module branches | `official/hippo-memory.patch` (sha256 `b3f77af945da4b794310f2be3952e8106c96d868ee58e62ece6e4c0a67038d35`), one `hippo-memory` branch per function, plus `local_bwrap_agent.py`. The full diff against the bundle is `/opt/dolphin-official/official-diff.patch`, its sha256 in setup.json. |
| Published app runtime | Each test stage copies the persona bundle's `published-test-runtime` to `/opt/dolphinbench/published-test-runtime` (the path its `runtime.json` names); the pristine bundle copy is hashed into the run record. |
| Host | WSL2 Ubuntu, kernel 6.6.87.2-microsoft-standard-WSL2, homes on ext4 under `/srv/dolphin-official`. |

## Sandbox command

Root bwrap, then the official driver drops to the persona uid (`run_as_user`, no ambient caps survive the setuid). Shape, from `dolphin_sandbox.bwrap()`:

```
bwrap --unshare-pid --die-with-parent --new-session [--cap-drop ALL --cap-add CHOWN,SETUID,SETGID,DAC_OVERRIDE,FOWNER at test]
  --ro-bind /usr /usr  (bin, sbin, lib, lib64 as on the host)
  --tmpfs /etc  (each host /etc entry ro-bound, links into /mnt dropped, a copied resolv.conf)  --remount-ro /etc
  --perms 0755 --dir <each mount-point parent>
  --ro-bind <each of: /opt/dolphin-official/bin, /opt/dolphin-official/fake, /opt/claude-2.1.259, /opt/hippo-<version>, /opt/hippo-models, /opt/hippo-plugin-<sha12>>
  --tmpfs /tmp --dev /dev --proc /proc
  --bind <persona home> <persona home>      (ingest)   |   --bind <payload> /payload, --bind <empty> <agent home>  (test)
  --chdir <home>/project
```

Nothing from `/mnt` or `/home/skf_s` is bound. Inside, an init process runs the agent, then waits up to 900 s for every process it left (hippo's detached session-end worker) and reports both times.

Environment inside the agent. Ingest: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `HOME`, `LANG`, `PATH` from the official driver, `HIPPO_HOME` and `HIPPO_MODEL_CACHE` from the allowlist, `PWD` set by bwrap. Test adds `HIPPO_READ_ONLY=1` and `CLAUDE_CODE_EFFORT_LEVEL=medium`. The token goes through the child env only, never argv or a log.

## Stages

| Stage | What it does | Stop rule |
|---|---|---|
| setup | Installs Claude Code, hippo, the embedder, the plugin and the patched official tree, root-owned; writes setup.json | A version, sha or bundle mismatch stops setup. |
| smoke | 20 Morgan messages through the full ingest path, then the gates below | A failed gate stops the run: no full ingest. |
| ingest | One official `run_claude` call per message, uid 2002, effort unset, tools Read/Write/Edit/Bash/Skill/ToolSearch, the native memory seed | A turn fails `verify_turn` when the init version is not 2.1.259, the drain report is missing or not empty, or a `.queued` file remains. |
| seed | Drain check, `PRAGMA wal_checkpoint(TRUNCATE)` as uid 2002, sha256 of each hippo.db, copy with the official predicate plus `.hippo` | The seed must hold no `.claude/projects`; a busy checkpoint stops. |
| test | The official `evaluate()` path, 200 tests per persona, fresh seed copy per test, uid 2001, timeout 1800 s | The official resume rule keeps rows with `driver_ok`. |
| judge | gpt-5.6-sol, effort medium, through the Codex proxy | |
| report | Score per persona and total, the score without tests that read `.hippo`, token usage, the largest idle gap between ingest turns, store audit counts, the rejudge summaries | The scoreboard footer takes its deviations from the list below. |

## Smoke gates

The smoke runs on Morgan's first 20 messages. Every gate must pass before the full ingest starts.

| Gate | Pass rule |
|---|---|
| user_facts | At least 5 of 20 messages kept. A message is kept when one non-digest memory holds at least min(3, n) of its n key words (words of 5+ letters, stop words removed). |
| project_recall | On the best-kept message: a direct `hippo_recall` in the sandbox returns at least 2 of 4 key words, and a read-only agent probe turn calls recall, ends ok and answers with at least 2 of them. |
| one_vector_per_memory | Every non-digest memory has a vector. Session digests are written without an embed call in hippo, so the report counts them apart (`digests_with_vector`). |
| hook_p95 | The p95 of every hook duration in the transcripts is under 2,500 ms. The report also times 10 runs of the UserPromptSubmit hook command. |
| hook_timeouts | 0 hook timeouts. |
| versions | Every turn's init event says 2.1.259. |
| drained | Every turn's drain report is present and empty. |

The smoke also records memories by source, per-turn usage from stream-json, and the rate-limit headers before and after.

### Projection (fill from smoke.json before the full ingest)

| Field | Value |
|---|---|
| Seconds per turn | TBD from the real smoke |
| Usage per turn (input, output, cache read, cache write) | TBD |
| 13,539 turns: hours, tokens, share of weekly limit per token | TBD |
| Rate-limit headers before and after | TBD |

## Tokens and 429s

- Tokens: `Z0_SUB_TOKEN_1`, `_2`, `_3` from the Windows User environment. `dolphin_tok_pick.py` sends a one-token ping per token and picks the one with the most weekly room. With none, the runner sleeps to the earliest reset plus 60 s. Every pick goes to `tokens.jsonl` with the headers and the token name, never the value.
- Ingest 429: the official `ingest()` sets `receipt["pause"]` and keeps the in-flight marker. The runner logs the gap in `gaps.jsonl`. When the hippo store counts did not change, it records a `retry` adjudication and goes on with a new token. When they changed, it stops; a person reviews the traces and reruns with `--recover retry`.
- Test 429: the official runtime returns 2 with `results["pause"]`. The runner logs the gap, picks a token and reruns with the earlier run as `resumed_from_run`.
- The report gives the largest wall-clock gap next to the score (review row 16).

## Test-time memory writes

`HIPPO_READ_ONLY=1` is set, and `hippo_remember`, `hippo_outcome`, `hippo_learn`, `hippo_resolve` and `hippo_share` are denied. Retrieval hooks and tools stay on. After each test the runner hashes the master store against the seed hash (`master_unchanged`) and the test copy (`test_store_changed`), and counts Bash or Read calls into `.hippo` (`hippo_reads`). The report gives the score with and without the tests that read `.hippo` (review row 23).

## Deviations

From the plan list:

1. **Judge transport.** gpt-5.6-sol at medium effort through the Codex proxy, not Azure; no submission.zip. The proxy matched 59 of 60 public verdicts. `rejudge-published` grades the published answers with the same judge (judge calls only) so the gap is measured.
2. **WSL host,** not Modal.
3. **bwrap sandbox** in place of the Modal container (`local_bwrap_agent.py` has the `ModalAgentContainer` constructor and `run()` contract).
4. **Worker wait.** The runner waits for hippo's session-end worker after each turn.
5. **.hippo in the seed.**
6. **Module branches** (the patch above).
7. **No LLM key for hippo.** The driver strips `ANTHROPIC_API_KEY`; hippo's LLM steps stay off.
8. **Notes import finds nothing.** The driver puts `autoMemoryDirectory` in a `--settings` file that hippo's session-end import does not read.

Found while building the runner:

9. The app server runs on the host behind the official `AppBridge` unix socket, as the Modal tunnel's far end does. `claude_agent.py` imports the Modal container only on the Modal path, so the local path needs no Modal install.
10. `/etc` inside the sandbox is rebuilt from the host entries with a copied `resolv.conf`, because WSL's points into `/mnt`.
11. Root bwrap makes missing mount-point parents 0700; the sandbox creates them 0755 first.
12. The published runtime is staged at `/opt/dolphinbench/published-test-runtime` per test stage, under a lock, from a pristine bundle copy.
13. bwrap sets `PWD` in the agent env.
14. `run_simulation.py` adds `hippo-memory` to its three provider gates, and its memory identity must name the seed's post-drain store hash.

## Fake-agent proof (no Claude tokens)

`dolphin_fake_official.py` stands in for Claude Code 2.1.259: it takes the official flags, runs the plugin hooks with Claude Code's stdin, starts the plugin and `--mcp-config` MCP servers, makes real tool calls and writes the transcript where Claude Code does. Proof installs: hippo 3.5.1 and the plugin from `feat/plugin-mcp-read-only` (sha256 `b4bfdfac4e441060f72a81b4e2058ede72ffe2035dc8a3df842a15d8389fbc6e`, version 0.6.2).

- Ingest (Morgan, 3 then 20 messages): uid 2002, effective caps 0, no `/mnt`, no host home, `/etc` read-only, only its own home under `/srv`. The hippo MCP server connected every turn. The drain took 0.6 to 1.8 s and left nothing. The version check passed.
- Seed: 19 files, checkpoint not busy, no `.claude/projects`.
- Test (2 Morgan tests, judge proxy up): both answered with `driver_ok`, graded by the official grader. uid 2001, caps 0. The plugin MCP server and `dolphinbench_apps` connected. The master store hash did not change. `test_store_changed` was true in both, because hippo 3.5.1 has no read-only mode.
- Smoke on the fake (20 messages): project_recall, one_vector_per_memory, hook p95 (373 ms), hook timeouts, versions and drained passed. user_facts failed, 2 of 20: hippo 3.5.1 kept 1 capture memory and 4 digests from the fake turns, which carry no model reply.
- rejudge-published, Mem0 Morgan, 2 tests: 1 judge call, agreement 1.0 with the published verdicts. Built-in has no published results with tool calls, so it cannot be rejudged.

## Open before the full run

- Done 2026-11-17T11:09Z: setup on the 3.6.0 build and plugin. The plugin tree hash equals the proof plugin's, so the fake-agent proof covers the same plugin files.
- Expect `test_store_changed` false under 3.6.0's `HIPPO_READ_ONLY`; a true value there is a finding, not noise.
- The real smoke decides the user-fact gate; the fake result is not evidence either way.
- Hook p95 is measured at smoke store size only; the review asks for a size near the end of Morgan.
- The real smoke's agent probe checks that Claude Code starts plugin MCP servers with the project folder as the working folder.
