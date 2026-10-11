# Z0 stage 1 smoke report (draft)

**Prereg:** `docs/evals/2026-09-29-z0-built-in-memory-prereg.md`, stage 1 (lines 231-239).
**Status:** all six points are settled (2026-10-11).

## Setup

- **Toy repository.** `node benchmarks/token-eval/smoke/make-toy.mjs <dir>` builds `<dir>/toy-repo`, `<dir>/tasks.json` and `<dir>/checks/`. The repo is 18 one-line helper modules, each with one bug, and one fix commit per task that adds its hidden test. Every hidden test fails on the base and passes on its fix (checked 2026-10-10).
- **Lessons.** Four template lessons, one per family, each graded by a script:
  - f1 (set R): change notes go in a new file under `changelog.d/` (`checks/fragment.mjs`).
  - xa (set X): every fix raises the patch number in `VERSION` (`checks/version.mjs`).
  - xb (set X): run `node scripts/lint.mjs` before finishing (`checks/ran.mjs`, which reads `Z0_COMMANDS`).
  - xc (set X): every fix adds a regression test under `test/regress/` (`checks/fragment.mjs`).
- **Plan.** Sequence `smoke-r` (5 tasks) runs under A0, A1, A2, A4 and A5. Sequence `smoke-x` (3 Claude Code teaches, 6 Codex applies) runs under X1 and X2. The run uses one seed. That makes 43 first sessions, plus every teach's resume and each failed set R apply's correction. `--dry-run` and `--check-homes` both pass on this plan:

```bash
node benchmarks/token-eval/smoke/make-toy.mjs C:/z0-runs/toy1
node scripts/token-eval/ab-run.mjs --tasks C:/z0-runs/toy1/tasks.json --out C:/z0-runs/smoke-homes \
  --model claude-sonnet-5-5 --codex-model gpt-5.6-sol --arms A0,A1,A2,A4,A5,X1,X2 --seeds 1 --check-homes
# Homes check passed for 7 runs.
```

The Codex model is passed explicitly. The operator's `~/.codex/config.toml` names `gpt-6.1-sol`, and the server rejects it for a ChatGPT login with a 400 ("not supported when using Codex with a ChatGPT account", seen 2026-10-10).

## The six points

1. **Canaries and a logging proxy (G1). Settled: a local logging proxy works with plan login, so G1 reads a request log.** Claude Code reaches the proxy through `ANTHROPIC_BASE_URL` and still logs in with `CLAUDE_CODE_OAUTH_TOKEN`. Four hand-run `claude -p` sessions went through it (Claude Code 2.1.288, 2026-10-10, `C:/z0-runs/proxy1/requests.jsonl`), and every request got status 200:
   - a fresh arm home: no operator text in the request;
   - the operator's own home: the request held the operator's `CLAUDE.md`;
   - auto memory on, with a canary planted in `MEMORY.md`: the canary and Claude Code's auto memory wording reached the model;
   - auto memory off the A0 and A4 way: neither did.

   No logged body held the login token, and the proxy never writes headers. The runner now sends every Claude Code attempt through its own proxy (`scripts/token-eval/proxy.mjs`). Each attempt's log is `<task>.<session|resume><n>.requests.jsonl` in the run's raw directory. The read check voids a session when a request carries an operator canary, auto memory text in A0 or A4, or hippo text (its marker or hook context) outside A2, A5 and X2 (`tests/token-eval-z0-proxy.test.ts`). The set R smoke ran before this change. The set X smoke's teach sessions are the first runner sessions through it.
2. **`--resume` delivers a teach message. Settled.** In all five set R arms, the teach went in by `--resume`. It landed in session 1's own transcript as the next user turn, and the agent acted on it by writing a note under `changelog.d/`. Every teach record has `teachTurns: 1` and a passing acceptance check (`C:/z0-runs/smoke1/runs.jsonl`). Failed applies got their correction the same way (`correctionTurns: 1`).
3. **hippo's hooks fire under `claude -p`. Settled.** hippo's SessionStart hook ran in every A2 and A5 session. Its prompt hook added context in A2 (`hook_additional_context` in the transcripts; 1 to 4 injections per task, 266 to 890 characters, from the runner's `hippo` record). A5 got no prompt context, which is right for A5 on a toy repository: init seeds nothing there, and A5 captures nothing.
4. **Auto memory saves under `-p`. Settled: it saves, so no interactive driver is needed.** Under `-p`, A1's system prompt carries Claude Code's memory section, and the memory directory exists. A probe (`C:/z0-runs/probe-automem/probe.mjs`, 2026-10-10) asked one `-p` session in a fresh config to remember a repository rule. It wrote a memory file and the `MEMORY.md` index. A second `-p` session then answered from that memory without reading any file. Saving is the agent's own choice: in the smoke, A1 got the same correction three times (t1, a1, a2) and never saved a memory or wrote the rule into an instruction file.
5. **Codex memories under `codex exec` with a per-run home. Settled: they never form, so X1 to X4 run with Codex memories off (prereg 91).** The Codex config reference (fetched 2026-10-10) says memory generation runs as a startup pass. A thread is a candidate only after it has been idle for `memories.min_rollout_idle_hours` (default 6, range 1 to 48), and the pass is skipped when less than `memories.min_rate_limit_remaining_percent` (default 25) of the account's Codex rate limit is left.

   The live probe (`C:/z0-runs/probe-codex/probe.mjs`, codex-cli 0.153.4) ran one `codex exec` session in each of two fresh homes with memories on and the idle floor at 1 hour. It ran a second session in the same homes 1 hour 54 minutes later, on 2026-10-11. The startup pass did run: at the second session's start, Codex set up its memory workspace (a git repository under `memories/`) and started a consolidation job, which failed with `failed_agent` and scheduled a retry. But phase 1 took no thread in either home: `stage1_outputs` stayed empty, and `raw_memories.md` says "No raw memories yet." All three threads in each home's state database have source `exec`.

   Codex's source explains it. Phase 1 picks candidates only from `INTERACTIVE_SESSION_SOURCES`, which lists `Cli`, `VSCode`, and the custom sources `atlas` and `chatgpt` (`codex-rs/rollout/src/lib.rs` and `codex-rs/memories/write/src/phase1.rs` in openai/codex, read 2026-10-11). `Exec` is not on the list. So a `codex exec` thread never becomes a memory, however long it idles: Codex memories cannot run headless, and the prereg's fallback applies: "If Codex memories cannot run headless ... X1 to X4 run with them off, and the write-up says so."

   The runner now defaults to `--codex-memories off` and `--codex-memory-wait none`, and writes the idle-hours setting only when memories are on. With memories on, each startup pass also spends a consolidation call on the account's Codex limit for nothing.

   The account hit its Codex usage limit at 23:33 BST on 2026-10-10, during the set X smoke. Codex said to try again at "Oct 14th, 2026 6:15 AM", but sessions ran again after four 15-minute waits, and the probe's second session started at 00:41 BST on 2026-10-11. The stated reset time is not the block's length. The limit is shared with every other Codex use on the account, such as code reviews, so stage 2 has to budget Codex sessions for set X.
6. **Codex hook trust in a fresh home. Settled: every Codex arm runs with `--codex-hook-trust flag`.** codex-cli 0.153.4 offers `codex exec --dangerously-bypass-hook-trust`, which the runner passes under that flag. A probe (`C:/z0-runs/probe-codex/probe.mjs`, 2026-10-10) gave two fresh homes the runner's `config.toml` and a `hooks.json` with SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop hooks. Without the flag, none of the five fired. With it, all five fired. Persisted trust, a `[hooks.state.'<hooks.json path>:<event>:<group>:<hook>']` table with `enabled` and `trusted_hash`, stays unused.

   The set X smoke showed where hook output lands. Codex writes it as a `developer` message right after the user's prompt, tagged `content_item_kinds: ["hooks.additional_context"]` in the message's `internal_chat_message_metadata_passthrough`. Its own developer messages carry other kinds, such as `host_skills.instructions`. The runner read a placeholder field the fake Codex wrote, so it saw no hook output in a real rollout. `codex-rollout.mjs` now reads the real tag (plan R16), and the fake writes the same shape.

   The probe also found two things the runner has to control:
   - A fresh home on a ChatGPT login downloads remote plugins, app caches and system skills. The plugin set came from the account and differed between the two homes by timing. The run's `config.toml` now turns `plugins`, `remote_plugin` and `apps` off for every Codex arm, which matches the Claude Code arms' `--strict-mcp-config`. Codex's own `features list` reads all three as off under that file.
   - On the operator's machine, `codex` on `PATH` is hippo's launcher wrapper. The runner already resolves past it: `resolveCodex` returns the real binary and records the wrapper.

## Runner changes these findings need

- Done: Codex memories are off by default for X1 to X4, with no memory wait after each session (point 5, `scripts/token-eval/codex.mjs`, pinned in `tests/token-eval-z0-codex-session.test.ts` and `tests/token-eval-z0-codex-run.test.ts`). With `--codex-memories on`, the run's `config.toml` still sets `memories.min_rollout_idle_hours = 1`, the documented floor.
- Done: every Claude Code attempt goes through a request-log proxy, and the read check voids on what the model received (point 1).
- Done: the run's `config.toml` turns Codex plugins and apps off (point 6).
- Done: the Codex reader finds hook output by its real tag (point 6). Before this, a Codex apply's chain read `shown: false` even when hippo's hook carried the lesson, and a hook in a non-hippo Codex arm could not void it.
- Done: the read check skips the body of a heredoc that only `cat` or `tee` takes. That body is file content, like a Write tool's. A body fed to any other command, or piped on, still counts, since it may be a script (`tests/token-eval-z0-readcheck.test.ts`).

## What the set R smoke showed beyond the six points

One seed on a toy repository settles no hypothesis. These are inputs to stage 2, not results.

- **The positive control works.** In both apply tasks (a1, a2), A4 kept the lesson with no correction. A0, A1, A2 and A5 broke it both times.
- **hippo captured the lesson but did not recall it when it mattered.** A2's store holds the teach as a captured rule, written at 21:38 UTC during t1. On the first prompt of a1 and a2, the prompt hook recalled session digests that mention `changelog.d/`, not the rule. The rule came back only when the correction named it. A task prompt about `formatCents` shares no words with a rule about change notes, so prompt-matched recall misses a repository-wide rule. This is the main risk to H1, and hippo has to answer it before the freeze tag.
- **Built-in memory saved nothing on its own** (point 4), so A1 may sit near A0 on lessons like this one. Stage 2's calibration measures that before the sizes are computed.
- **hippo's answer to the recall miss is PR #781.** Capture now pins a rule the person stated, so the prompt hook injects it on every later prompt, whatever its words. A2's set R run is repeated once #781 is merged, before the freeze tag.

## What the set X smoke showed

The run is `C:/z0-runs/smoke2` (X1 and X2, one seed, Codex model `gpt-5.6-sol`). Again, these are inputs to stage 2, not results.

- **All six Claude Code teaches resolved,** each with one teach turn and a passing acceptance check. They are the first runner sessions through the request-log proxy, and no request log held a canary, auto memory text or hippo text outside X2.
- **X2 kept 5 of its 6 Codex applies with no correction; X1 kept none.** Each lesson has two applies, a first (a-) and a later one (b-). Re-read with the fixed hook reader (`codexAdapter.hookContexts` over each apply's rollout), hippo's prompt hook carried the lesson into 5 of the 6 X2 sessions, all but b-xb. Codex followed it in 4 of those 5 and broke it in b-xa. b-xb passed with the lesson in neither a hook item nor a tool result, so that pass did not come from memory. For xa, the carrier was the teach's session digest: the agent's own reply, "I'll bump the patch number in `VERSION` on every fix from now on". It was not a captured rule.
- **The run's records read `shown` with the old hook reader** (point 6). a-xa, a-xb and b-xa read `shown: false` though the hook carried the lesson. a-xc and b-xc read `shown: true` only because a tool result also held the key phrase.
- **One false void, now fixed.** X1's t-xc teach was voided as a read of another run's files. The agent had written a test file with `cat > test/regress/last.test.js <<'EOF'`, and the read check took the `require('../../src/last.js')` line in the file's body for a shell path.
- **hippo's capture misses plain imperative corrections.** "No: every fix raises the patch number in `VERSION`" holds none of the extractor's rule keywords (never, always, must, make sure), so nothing is captured from the person's words. xa was carried only because the agent restated it. A detector tuned to the teach template's "No:" would fit this eval and nothing else, so any fix has to detect corrections in general.
