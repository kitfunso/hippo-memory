# Token-efficiency evals (ROADMAP Part IX, Track TE)

Three harnesses, from cheapest to most convincing. Build first with `npm run build`. Their tests (`tests/token-eval*`) run with `npm run test:eval`, not `npm test`; CI runs them in `token-eval.yml`.

| Harness | Roadmap | Needs | What it answers |
|---|---|---|---|
| `scripts/token-eval/replay.mjs` | TE4 | nothing (no LLM) | What does hippo's per-prompt hook add to a session, and how much does skipping unchanged blocks save? |
| `scripts/token-eval/budget-curve.mjs` | TE3 | a LongMemEval-format JSON | How many tokens of memory does an agent need to see the evidence, with hippo against recency, full context and no memory? |
| `scripts/token-eval/ab-analyze.mjs` | TE5 | run records from an agent A/B | Cost per resolved task, resolve rate and work avoided, with bootstrap CIs. Protocol: `docs/evals/2026-09-23-te5-token-ab-preregistration.md` |

Shared statistics and four-bucket cost accounting are in `src/eval-stats.ts`.

## What is and is not established

- **Established, with records:** on the bundled synthetic traces, skipping unchanged hook blocks cuts the text hippo itself injects by 85-90% (the cache-priced cost of that text by 84-89%, the table below). The run is deterministic: two runs give identical per-prompt counts, and the record is `replay-results.json`.
- **Not established:** that hippo saves anyone tokens or money. The replay prices only hippo's own text (tens of tokens per prompt in these traces), and its token counts are an estimate (characters / 4). For comparison, one long Claude Code session in the container this was built in recorded about 207 million cache-read tokens, as counted by the API. Cutting hippo's overhead is housekeeping. A saving claim needs the paired A/B (TE5) on real tasks.
- **Needs checking on a real machine:** that Claude Code keeps hook `additionalContext` in the transcript, which the cache model assumes. `claude-usage.mjs` below reads the real records.

## Measure on your own machine

Claude Code writes every session to `~/.claude/projects/<project>/<session>.jsonl`, including the API's billed usage for every message. The TE0 ledger records hippo's session id from the hook payload, and that id is the transcript file name.

```bash
npm run build
node scripts/token-eval/claude-usage.mjs --days 30                 # all sessions, joined to ~/.hippo's ledger
node scripts/token-eval/claude-usage.mjs --hippo-root path/to/project/.hippo --prices prices.json --out usage.json
```

It reports, per session:
- uncached input, cache writes, cache reads and output, as billed;
- the same totals priced in dollars, if you give prices;
- how many tokens hippo sent and skipped;
- hippo's share of the new context written.

Usage is counted once per API message id. One message spans several transcript lines, so summing lines would roughly double the totals. Subagent transcripts count towards their parent session.

This measures cost and hippo's share of it. It does not measure savings, because a session without hippo is a different session. A before-and-after comparison across weeks is confounded by different work, so the saving claim still needs TE5.

## Session replay (TE4)

```bash
node scripts/token-eval/replay.mjs            # bundled synthetic traces
node scripts/token-eval/replay.mjs --traces my-traces/ --out my-results.json
```

It replays each trace through the real hook in two arms:
- `every-turn`: the behaviour before TE2;
- `skip-unchanged`: the default.

It prices only hippo's injected text: written to the cache once at 1.25x, then re-read at 0.1x on every later prompt until a compaction drops it. `tests/token-eval-replay.test.ts` runs a short trace in CI.

**Latest run, `replay-results.json`, on synthetic traces:**

| Trace | Prompts | Every-turn cost | Skip-unchanged cost | Saving |
|---|---|---|---|---|
| steady | 40 | 8,704 | 952 | 89.1% |
| learning (4 lessons) | 40 | 13,921 | 2,235 | 83.9% |
| long-compact (2 lessons, 1 compaction) | 80 | 24,040 | 2,943 | 87.8% |

- Costs are in uncached-equivalent tokens.
- An unchanged block rendered byte-identically in 100% of cases.
- The traces are synthetic, with three short pinned rules, so the absolute numbers are small. Real stores inject more per block, and the TE0 ledger (`hippo tokens`) measures what real sessions send.

## Token-at-accuracy curve (TE3)

```bash
node scripts/token-eval/budget-curve.mjs --data benchmarks/longmemeval/data/longmemeval_s_cleaned.json
```

- **Data:** download `longmemeval_s_cleaned.json` from the LongMemEval release into `benchmarks/longmemeval/data/`.
- **Default without data:** it runs on the bundled `synthetic_smoke.json`. Each of those haystacks is about 200 tokens, so every arm reaches the evidence at every budget. That run checks the mechanics and says nothing about hippo.
- **Tests:** `tests/token-eval-budget-curve.test.ts` checks the scoring on a haystack built so that recency and relevance disagree.
- **Deferred:** an LLMLingua-2 compression arm.

## Z0 built-in memory A/B (Claude Code arms)

This is the only harness that can support a savings claim. It runs real Claude Code sessions, signed in with your subscription, on the same coding tasks in five arms. Protocol: `docs/evals/2026-09-29-z0-built-in-memory-prereg.md`.

- **A0:** no memory. Claude Code's auto memory is off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `autoMemoryEnabled: false`).
- **A1:** Claude Code's built-in auto memory, nothing else.
- **A2:** A1 plus hippo's Claude Code hooks and a `hippo` on PATH that runs this checkout.
- **A4:** written memory. A0, plus every lesson the run has been taught so far appended to the root `CLAUDE.md` before each task, one line per lesson: `- <rule>, because <reason>.` A reversal replaces the line of the lesson it supersedes.
- **A5:** sham hippo. Like A2, but the capture hooks (`SessionEnd`, `PreCompact`, `PostCompact`, `PostToolUseFailure`) are dropped and the `hippo` shim turns `remember`, `capture`, `learn` and `outcome` into silent no-ops.

Default seeds are A0 and A4 2, the others 3; `--seeds N` lowers every arm to at most N (smoke and calibration runs) and never raises an arm past its prereg count, since the analyzer refuses an A0 or A4 seed 3.

**1. Draft tasks from a repository's history** (small bug-fix commits with tests make the best tasks):

```bash
node scripts/token-eval/make-tasks.mjs --repo ../some-repo --cluster some-repo \
  --test-cmd "npx vitest run {files}" --setup "npm ci" --verify > tasks.json
```

- `--verify` keeps only commits whose tests fail before the fix and pass after it. A candidate whose setup fails or whose test command times out is dropped as an error, not scored as a fail or a pass.
- **The scope gate skips bundled commits before they cost a test run.** A candidate is skipped when it touches more than `--max-test-files` runnable test files (default 4) or changes more than `--max-code-lines` lines outside tests (default 400); each skip is printed with its reason. Pass `0` to either flag to disable it.
- **`--run-exclude REGEX`** (default matches `fixtures?/`, `__fixtures__/`, `__snapshots__/`, `conftest.py`) marks hidden test files that are support files, not files the agent must produce: they are still written from the fix commit for the hidden test run, but never appear in the test command or count toward the scope gate. An `e2e/` spec is excluded from both tests and code entirely; it needs a running app, so it is never run as a hidden test.
- **Then edit every prompt.** A drafted prompt is the commit message, which usually describes the fix. Rewrite each one as the problem a user would report, then delete `needsReview`. The runner refuses tasks that still have it.
The tasks file is `{ "families": [...], "sequences": [ { "id", "cluster", "repo", "fixedOrder"?, "tasks": [ { "id", "kind", "baseRef", "fixRef", "prompt", "testFiles": [...], "test", "setup"? } ] } ] }`, where `repo` is a URL or a local path. `make-tasks.mjs` drafts every task as `kind: "no-lesson"` (set N); lesson tasks are written by hand, as below. The first task of each sequence is run but not scored (nothing to recall yet).

**Lesson families (set R).** A family is one rule a maintainer would teach, with at most one reversal:

```json
{ "id": "f1", "sequence": "seqA", "lessonSource": "maintainer",
  "lessons": [
    { "id": "f1-l1", "rule": "Changelog entries go in changelog.d fragments", "reason": "the release script builds CHANGELOG.md from them",
      "keyPhrase": "changelog.d", "check": { "script": "checks/f1.mjs", "args": [] } },
    { "id": "f1-l2", "supersedes": "f1-l1", "rule": "...", "reason": "...", "keyPhrase": "...", "check": { "script": "checks/f1b.mjs" } } ],
  "screen": { "id": "f1-screen", "baseRef": "...", "fixRef": "...", "prompt": "...", "test": "...", "testFiles": [] } }
```

- Each task in the family's sequence is `teach` or `apply` with `familyId` and `lessonId`, or `no-lesson` with neither. Every lesson has exactly one teach task and at least one apply; a family has at least 2 applies, one root lesson, and `lessonSource` `maintainer` or `template`.
- A rule or reason may not say "remember" or name hippo, auto memory or an instruction file. An apply prompt may not hold its lesson's `keyPhrase` unless the task sets `keyPhraseAllowed: true`. Every mode refuses, before any clone, a rule or reason that holds another lesson's `keyPhrase` (a reversal may name the lesson it supersedes) and a `keyPhraseAllowed` prompt that holds any phrase but its own lesson's. A real run also refuses a stub tree that holds a phrase.
- Every family needs a `screen` task. Only a tasks file with top-level `"dev": true` may skip it (`screenSkipped: true` plus a `screenNote`), and a real run refuses a dev file.
- **Order.** Each seed draws one order per sequence, shared by every arm. There are at least 2 other tasks between a teach and its lesson's first apply. A reversal's teach comes after every apply of the lesson it supersedes. No task before a teach may hold that lesson's `keyPhrase`. `fixedOrder: true` keeps the file order and checks the same rules.

**Checkers.** `check.script` is resolved against the tasks file's folder, so the agent never sees it. The runner runs `node <script> <args>` in the workspace with a 120 s timeout and these variables:
- `Z0_PRE_COMMIT`: the workspace as on disk before the session, after every runner write (checkout, setup, A4 lines, hippo's init block, carried files). `Z0_POST_COMMIT`: the workspace as on disk right before this check. Grade with `git diff $Z0_PRE_COMMIT $Z0_POST_COMMIT`, which shows a file the agent never staged and never shows a runner write.
- `Z0_COMMANDS`: a JSON file listing every Bash and PowerShell command the agent ran in the task, resume and subagents included (`<session>/subagents/*.jsonl`). Commands are grouped by transcript: each session's own commands in order, then each of its subagents' in turn, so a checker should not rely on order across a subagent boundary.
- `Z0_LESSON_ID`: the lesson being checked.

Exit 0 is pass, 1 fail, 3 na. Any other exit, a timeout or a failure to start makes the record `invalid: 'checker'`, with the checker's output in `raw/<seq>/<arm>/seed<n>/<task>.checker.txt`.

A checker runs with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, so the operator's git config never reaches it, and with `core.fsmonitor=false` added to `GIT_CONFIG_PARAMETERS`, so its own `git status` runs no program the agent named. The workspace's own `.git/config` and `.gitattributes` are agent-writable, though, and can set `diff.external` or a textconv driver: pass `--no-ext-diff --no-textconv` to every `git diff` a checker runs. Filter drivers are off for the runner's git and the checker's: each `filter.<name>` the workspace config defines gets empty `clean`, `smudge` and `process` commands and `required=false`.

**Teach and correction turns.** Every check runs before the hidden tests are written in.
- A teach task always gets one resume of the same session. When the first check fails it is the correction `No: <rule>, because <reason>. Please fix it.`, else the confirmation `Yes, keep doing that: <rule>, because <reason>.` The final check runs after the resume.
- An apply task gets the correction only when its first check fails. After a reversal, the superseded lesson's checker also runs on the first attempt: `staleFollow` is true when the old rule passed.
- A2 and A5 wait for hippo's session-end capture before the resume. Instruction-file carry, A4's taught list and the hidden tests all run once, after the last turn.
- A resume cut off by a plan limit is undone exactly before it reruns: the workspace's whole `.git` (refs, `HEAD`, the index, reflogs, config, hooks), the work tree, the instruction files and the session transcript go back to how session 1 left them, subagent transcripts included, and the retry counts in `limitRetries`. The saved `.git` is a copy kept outside the workspace, so nothing the cut-off attempt does to the repo can reach it. Git-ignored files that attempt wrote are not removed.

**Records.** Every record is `z0-record/1`: identity (`schema`, `set`, `tool`, `repo`, `sequence`, `taskId`, `seed`, `arm`, `position`, `order`), role (`kind`, `familyId`, `lessonSource`, `lessonId`, and on applies `applyIndex`, `afterReversal`, `tasksSinceTeach`, `wordOverlap`), `lessons: [{lessonId, first, final, staleFollow}]`, `acceptancePassed`, `resolved` (accepted, every lesson's final check a pass, not timed out), `usage: {firstSession, extra}` (`extra` sums the resume), `costUsd`, `turns`, `turnsSource`, the work counts, `wallMs`, `teachTurns`, `correctionTurns`, `teachForm`, `timedOut`, `void`, `voidHits`, `leak`, `limitRetries`, `surfaceRestored`, and on A2 and A5 `injectedRows`; valid applies add `chain`. `turnsSource` is `'result'` when every turn returned a result and `'transcript'` when a timed-out turn was counted from its transcript. The two units differ: a result gives Claude Code's own `num_turns`, while a transcript count takes distinct assistant message ids, so compare `turns` only within one source. `plan.json` cells carry `set`, `kind` and `familyId` too, with the same values as the cell's record.

**Screen (`--screen`).** Before a real run, each family is screened on seeds 1 and 2. A0 runs the root lesson's teach task and then the screen task; A4 runs the screen task alone, with the root lesson written into `CLAUDE.md`. No session takes a resume, and the root lesson's checker grades each first attempt. Records go to `<out>/screen.jsonl` (`kind: "screen"`, `screen: true`). `<out>/screen.json` keeps a family when A0 breaks the rule in at least 2 of its 4 sessions and A4 follows it in both of its 2 (`na` counts as neither). Every other family is dropped and listed with its counts. A family with an invalid screen session is `undecided`, with the reason. `--screen --dry-run` prints the screen plan; A1, A2 and A5 never run in the screen.

**2. Check the plan, then run:**

```bash
node scripts/token-eval/ab-run.mjs --tasks tasks.json --out C:/z0-runs/r1 --model <model id> --dry-run
node scripts/token-eval/ab-run.mjs --tasks tasks.json --out C:/z0-runs/r1 --model <model id> --max-budget-usd 3
```

`--dry-run` only validates the tasks file, prints the plan and writes it to `<out>/plan.json` (every expected cell, so the analysis can tell a run cut off in lockstep): it needs no `npm run build` and no `dist/`. It also prints each seed's drawn order and, per sequence, the min, median and max `tasksSinceTeach` over all applies, so a bunched draw shows before any session runs. `--check-homes` runs the homes check below for every planned run and stops; it needs `dist/`. A real run needs `dist/` (`npm run build` first) and `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` and export it), runs the homes check first, and fails fast with a clear message if either is missing. `--arms` takes a subset of `A0,A1,A2,A4,A5`. A real run or a dry run refuses an `--out` that already holds `runs.jsonl` (`screen.jsonl` under `--screen`), since it would append to an earlier run's records and rewrite its `plan.json`. A real run clones the task repos and checks every task it will run (under `--screen`, the screen tasks too) for symlinked instruction files before it starts, so that refusal leaves no marker. If a real run throws partway, `<out>/ABANDONED` holds the error and the last completed step.

**Preflight.** Claude Code loads `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/CLAUDE.md` and `.claude/rules/` from every directory above the workspace, so every mode refuses an out dir with any of them above it: on a machine with a home-level `CLAUDE.md`, use a dir such as `C:/z0-runs` or `/tmp/z0`. `Z0_ANCESTOR_STOP` stops that walk early, for tests only; a real run refuses to start when it is set. A managed-policy `CLAUDE.md` outside that ancestry is not covered. The homes check then, for each planned run, creates its dirs, runs `hippo import --agents --dry-run` in the arm's env and requires exactly Claude Code and Codex at the run's own homes, and runs `command -v hippo` in the agent's login shell (Git Bash on Windows) to require no `hippo` for A0/A1/A4 and the run's `bin/` for A2/A5. That catches a shell profile that puts a global hippo back on PATH. It refuses, naming the dir, any planned run dir that already holds data, so it never deletes a run; pick a fresh `--out` for it.

What the homes check proves is narrow: hippo's importer sees only the run's own homes, and the agent's login-shell PATH resolves no installed hippo (A0/A1) or only the run's `bin/` (A2/A5). It does not stop the agent reading the operator's memory files straight off disk (`~/.claude`, a global `.hippo`); that is prereg gate G1, settled by the read check over the transcripts.

**3. Analyze** with `scripts/token-eval/z0-analyze.mjs`, which pairs arms on their shared seeds. It is not on this branch yet; it lands with PR #357.

```bash
node scripts/token-eval/z0-analyze.mjs --runs C:/z0-runs/r1/runs.jsonl --plan C:/z0-runs/r1/plan.json --prices prices.json
```

Never feed Z0 records to `ab-analyze.mjs`: it averages each arm over its own seeds unpaired, and A0 runs fewer seeds than the other arms.

What the runner does to keep the comparison fair:
- **No future history.** Each workspace contains the repository's history only up to the task's base commit, so neither the agent nor hippo's git learning can read the fix from `git log`. Hidden tests are written in after the agent finishes.
- **Every surface that can hold memory is per run.** Each (sequence, arm, seed) gets `<out>/runs/<seq>/<arm>/seed<n>/` holding `work/`, `claude-config/` (`CLAUDE_CONFIG_DIR`), `codex-home/` (`CODEX_HOME`), `hippo-home/` (`HIPPO_HOME`) and `bin/`. The homes are created empty and checked empty before `hippo init`; each record's `homesAtStart` lists what they held when the first session started.
- **Every arm starts each task from the same stub base.** The runner commits the task's base plus a root `CLAUDE.md` holding one stub line, with a fixed identity and date, so every arm gets the same `baseCommit`. Before each task the runner empties the workspace and keeps only `.hippo/`, and only in A2 and A5; everything else goes, `.git` and `node_modules/` included, so the task's setup installs dependencies again. Inside a kept `.hippo/`, every git repo or piece of one is deleted (a `.git`, an `objects` store with or without `HEAD`, a worktree admin dir), and so is every git bundle or pack file under any name and every link, so A0 is a true floor and no arm keeps a copy of the history. Hippo's own store (`hippo.db`, `config.json`, `index.json`, `stats.json`, `embeddings.json`, `buffer/`, `episodic/`, `semantic/`, `conflicts/`, `compactions-spool/`) uses none of those names and stays. If the agent replaced `work/` itself with a link, the link is removed and a real dir made; its target is never touched. If it deleted `work/`, a new one is made. Hidden tests are written the same way: a link at the test path or any dir above it is removed first. A process left running from the last session (a dev server, a watcher) can hold a file: the runner retries for about 11 seconds, then stops the run naming the locked path.
- **Instruction files carry in A1, A2 and A5.** Files named `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md` at any depth, and files under the root `.claude/rules/`, are snapshotted after setup and after the session; whatever the agent (or `hippo init`) changed is applied at the next task. Nothing else under `.claude/` carries, `.claude/CLAUDE.md` included, though Claude Code loads it. Where the next base also changed a file, a three-way `git merge-file` runs (`carryMerges`); a conflict falls back to `--union` (`carryUnionMerges`), which keeps both sides, so stale native lines can survive where A0 never sees them. That confounds H3 and the stale-lesson families: the analysis must exclude, or covary on, sessions with `carryUnionMerges > 0`. A deletion against a base that changed the file keeps the base's version (`carryDeleteKept`) and is dropped for later tasks. A task whose stub base holds an instruction file, `.claude` or anything under `.claude/` as a symlink is refused before any session runs: a link's content is its target path, and an edit through it lands outside the carried files. A root `CLAUDE.md` that links to `AGENTS.md` is fine, since the stub replaces it. The snapshot keeps regular files only, so if the agent replaces a tracked instruction file with a link, the carry sees a deletion and deletes that file at the next task (or keeps the base's version, if the next base changed it).
- **Your own environment is stripped.** Every key starting `ANTHROPIC_`, `CLAUDE_`, `AWS_`, `CODEX_` or `HIPPO_`, plus `CLAUDECODE`, is removed, in any case. The only key added back is `CLAUDE_CODE_OAUTH_TOKEN`, which reaches `claude` and never setup, tests or `hippo init`. Each record lists the surviving key names, never values. `--pass-env NAME` (repeatable) copies one more key, for example a logging proxy's `ANTHROPIC_BASE_URL`; on a Windows host where Claude Code cannot find Git Bash by itself, pass `--pass-env CLAUDE_CODE_GIT_BASH_PATH`.
- **PATH hides every installed hippo.** Every PATH dir holding a `hippo` launcher is removed for every arm, so A0 and A1 get the shell's own "command not found" and A2/A5 only their run's `bin/`. Everything else in those dirs is hidden from every arm alike: for a global npm install that includes CLIs such as `bun`, `bunx` and `codex`. The runner refuses to start when `node`, `npm`, `npx`, `git` or `claude` stops resolving; install hippo in its own prefix or uninstall the global copy. `claude` is resolved once, from your full PATH, and spawned by absolute path. The mixed-case PATH test runs on Windows only.
- **Your own setup is excluded.** Runs use `--setting-sources project` and `--strict-mcp-config`, so your `~/.claude` hooks, hippo's included, and your MCP servers do not load. hippo itself runs with HOME set to the output dir, init runs with `--no-schedule`, and hippo's optional LLM extraction is off, so hippo spends nothing outside Claude Code's recorded usage.
- **Prompt recall is pinned on.** A2 and A5 write `pinnedInject.promptRecall: true` into the workspace's `.hippo/config.json`, so the hippo default cannot change what the arms receive.
- **Every cost comes from Claude Code's own JSON result.** It uses `modelUsage` for the four token buckets and `total_cost_usd` at list price. Work metrics (tool calls, file reads, repeated errors) are read from the session transcripts, subagent transcripts included. `fileReads` counts Read and Grep plus shell calls with a read command (`cat`, `head`, `tail`, `less`, `more`, `sed -n`, `grep`, `rg`, and in PowerShell also `Get-Content`, `Select-String`, `type`, `gc`); `shellReads` is the shell share.
- **Lockstep order.** Sessions run seed by seed and position by position, with the arm order rotated each position, so the arms share time-of-day and plan-limit conditions. First-slot counts are exactly balanced only within a seed whose position count is a multiple of the active-arm count; each record's `order` is the step index, and the analysis should take it as a covariate. One unrecorded warm-up call runs first, in a stripped A0 env.
- **Failures are recorded, not hidden.** A run with no result is recorded `invalid: 'no-result'` and excluded, never zero-filled. A session that runs out of time (`--session-timeout-min`, default 60) is the exception (prereg 165): the runner kills its whole process tree, and the record stays valid with `timedOut: true`, never resolved, `costUsd: null`, and usage and turns read from its transcript (per message id, the largest value in each bucket). It is still checked and resumed; a timed-out resume is graded on the state at the kill. A timed-out session with no transcript is `invalid: 'no-transcript'`. Session 1 starts under its own `--session-id`, so a killed session still names its transcript. A task whose setup fails is recorded `invalid: 'setup'` and skipped entirely: no Claude Code session, no hidden-test run, never graded as a genuine "not resolved". A2 and A5 run `hippo init` before the first task that actually runs, so a failed first setup does not leave the arm without its store.
- **A leak skips the session and the rest of its (sequence, seed).** Prereg G3 has two triggers, both checked before the session. One is a line of 40 or more characters from the task's gold diff already in the arm's hippo store. The other is the key phrase of a lesson whose teach the run has not reached, found in a memory surface file, a hippo store entry, the workspace at `Z0_PRE_COMMIT` (`git grep`) or the prompt; the task's own lesson is exempt. A gzip file is opened and searched. Any other archive in a surface counts as a hit, with surface `<key>-archive`. Phrase matching folds ASCII case only, so a non-ASCII phrase must match exactly. The record is `invalid: 'leak'`, `leak: true`, with `leakHits: [{lessonId, surface, path}]` for a phrase leak, and no session or hidden-test run happens. Every later cell of that (sequence, seed), in every arm, gets an `invalid: 'leak'` record with `leakFrom: {arm, position, taskId}` and no session, so the run never looks cut off. A teach closes its lesson when the run reaches it, before setup, so a failed setup cannot keep the lesson open. Screen runs skip the phrase search, since they teach outside the drawn order.
- **An instruction file above `work/` skips the session.** Claude Code loads `CLAUDE.md`, `AGENTS.md` and `.claude/rules` from every ancestor of its cwd, and the dirs between `work/` and `<out>` survive the workspace reset. The runner looks for one there before each session, right after every session 1 whatever the task kind, again right before a resume (grading ran in between), and before each usage-limit rerun of a session or resume. If it finds one, the record is `invalid: 'ancestor-instructions'`, the paths go to `raw/.../<task>.ancestor.txt`, and nothing more runs for that cell: no session, no lesson check, no resume, no resume rerun (a session-1 rerun still runs and is graded as void). An apply is the exception at its resume. If the file first appears right before the resume or before its rerun, the apply stays valid. The resume does not run, and the paths go to `resumeAncestorHits` and `raw/.../<task>.resume-ancestor.txt`. The run goes on, and every later cell that can see the file is void too.
- **Every record has the same fields.** `usage`, `costUsd`, `turns`, `toolCalls`, `fileReads`, `shellReads` and `repeatedErrors` are null on every invalid record, never 0, and integers on every valid one. A session that returns a result but leaves no transcript to count work from is recorded `invalid: 'no-transcript'`, which widens G4's "a crash with no result". A result with no session id is `no-transcript` too. A resume with no result is `invalid: 'resume'`, a broken checker `invalid: 'checker'`. When the agent leaves its workspace repo so broken that the runner's own git fails on it after the session (an orphan or unborn `HEAD`, a corrupt index, a deleted `.git`), the record is `invalid: 'workspace'`, the git error goes to `<task>.workspace.txt`, and the run goes on to the next cell; a runner git failure before the session still stops the run. When several apply, the first of `ancestor-instructions`, `no-result`, `workspace`, `checker`, `resume`, `no-transcript` wins. Setup and leak records carry `resolved: false` and `limitRetries: 0`. Their carry counts (`carryMerges`, `carryUnionMerges`, `carryDeleteKept`) are null for a setup record, since no carry was applied, and the counts actually applied for a leak record, since the carry runs before the leak check.
- **Plan limits are retried, then the run is abandoned.** A session that hits a usage limit waits and reruns on a reset checkout, with the instruction files put back exactly as they were before the session; the record counts `limitRetries`. A setup that fails on that rerun stops the run. Every memory surface goes back to its pre-session snapshot too (a resume retry: its pre-resume snapshot), and the record's `surfaceRestored` says whether every restore matched the snapshot's hashes. A copy that failed (a locked file) leaves that snapshot unrestorable and `surfaceRestored: false`; the run goes on, and the analysis voids that cell. When the waits run out (96 waits of 15 minutes), the run throws and `<out>/ABANDONED` is written, per the prereg's rule that a run stopping partway is abandoned. `wallMs` leaves out every cut-off attempt with its wait and reset, session 1's and the resume's, so it times only the attempts the record keeps.
- **No earlier task's fix survives a checkout in the workspace.** Sequence order comes from the seed, so an earlier base can hold a later task's fix. The new `.git` fetches only the stub base's history, so nothing the agent left in git carries over: refs, stash, tags, notes, reflog, linked worktrees, config, submodule checkouts. Every git call the runner makes (the task clone, the checkout, the carry merge, the hidden tests and the gold diff for the leak check) reads no system or global git config and no global attributes file, and runs no hooks and no `core.fsmonitor` program, so a hook, a URL rewrite, a diff driver or a colour setting the agent put in your global config cannot touch the checkout or blank the leak check. The gold diff also passes `--no-ext-diff --no-color --no-textconv`. The task clone gets no credential helper either, so give a private repo as a local path you cloned yourself. Files the agent wrote outside the workspace stay, such as the checkout of a linked worktree it added elsewhere, and so does a file inside `.hippo/` that is not a repo, such as an archive the agent built by hand; the G1 read check and the G3 surface search below catch reads and phrases there.
- **`--pass-env` cannot override the runner.** It refuses, in any case, the keys the runner sets per arm: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HIPPO_HOME`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `HIPPO_AGENT_MEMORY_TOOLS`, `DISABLE_AUTOUPDATER`, `EVAL_SEED`, `CLAUDE_CODE_OAUTH_TOKEN` and `PATH`.
- **Permissions.** Runs use `--permission-mode bypassPermissions` inside throwaway clones. Claude Code refuses that as root; there, use `--permission-mode acceptEdits`, which allows edits but not shell commands.

**Memory surfaces, voids and the grading save.**
- **Surface ledger (prereg 104).** Before every session and resume, and at the end of each cell, the runner hashes each memory surface into `<out>/ledger.jsonl` (`z0-ledger/1`): auto memory, the user-level `CLAUDE.md` and rules, codex memories, the global hippo store, `work/.hippo` and the instruction files. A link is hashed by its target path and never followed. A linked project folder is the one exception: Claude Code loads the memory under it, so the runner hashes that memory too. A retry never copies, deletes or restores anything through a linked folder, so a change there fails the restore check. The G3 search follows every file and folder link and reads each real folder once. The restorable surfaces are copied to `<out>/snap/<run>/<arm>/seed<n>/{pre-session,pre-resume}/` for the retry restore. Those copies sit outside the run root, so an agent read of them is a G1 hit.
- **G1 read check (prereg 113, 159-162).** Every record whose session ran carries `void`: `null`, `operator-canary`, `read`, `auto-memory`, `user-instructions` or `hippo-text`, the first hit in that order, with every hit in `voidHits: [{reason, class, tool, path, file}]`. A `read` void comes from the paths in each tool call (file tools and the tokens of shell commands, with `~`, `$X`, `%X%` and `$env:X` expanded and Git Bash `/c/` paths mapped). Its classes, first match wins: `other-arm` (the repo cache), `past-transcript`, `past-rollout`, `other-run`, `ancestor-search`, `outside-work`, `operator`, `worktree`. The cell's own memory, instructions and transcripts stay readable. A tool result that holds another session's transcript line (a JSON line with `type`, `uuid` and `sessionId`) voids as `transcript-content`. `--canaries FILE` takes one string per line; a canary anywhere in the transcripts voids as `operator-canary` (in an apply's resume it fails the run instead, reading 14). The delivery voids are decided at pre-session, and for a resume again at pre-resume (reading 14): auto memory or a user-level `CLAUDE.md` in A0 or A4, and a hippo marker, store or hook context outside A2 and A5. G1 sets `void` and never `invalid`, so the invalid precedence above is unchanged.
- **Failure chain (prereg 179-182).** Each valid apply carries `chain: {stored, shown, followed, captured, capturedAny}`. `stored`: the key phrase is in a memory surface file or a hippo store entry at the apply's pre-session. `shown`: the phrase is in an instruction file, a user-level `CLAUDE.md` or the loaded part of a `MEMORY.md` (its first 200 lines within 25 KB) at pre-session, or in session 1's hook context or any tool result, subagents included. `followed`: the first verdict when `shown`, else null. `captured`: A2 only, from the stores at the end of the lesson's teach cell; it counts entries that hold the phrase or the rule, minus rows hippo imported from agent notes, which `capturedAny` keeps. Other arms get null for both.
- **Injected rows (prereg 93).** A2 and A5 records whose session ran carry `injectedRows: {rows, importedRows, chars, importedChars, unmatched, ambiguous}`. The hook's added context is split into its bullets and each bullet is matched by content to the union of both stores at pre-session and at the end. Each repeat counts, since each one is paid again. The ledger gets an `injected` line with each matched row's source prefix (`agent-memory:<tool>` for an imported note).
- **Grading save (prereg 166).** Every valid, non-screen cell saves its trees outside the workspace before the next checkout rebuilds `.git`, in `<out>/grading/<runName>/<arm>/seed<n>/`. `<task>.bundle` holds `refs/z0/grade/{pre,first,final}` past the stub: fetch `refs/eval/<seq>/<task>` from `<out>/repo-cache/<seq>` into a fresh repo first, then the bundle. `first` is the first check's tree and `final` the tree after the last turn, before the hidden tests. `<task>.first.diff` and `<task>.final.diff` are text diffs from `pre` with every instruction file left out, since one could show a reader the arm. `<task>.grade.json` holds the ids, the three commits, the verdicts, acceptance, the commands each verdict saw and each checker's sha256. Applies also get `<task>.surfaces.txt`, the memory-surface text at pre-session, cut at 64 KB. A save that fails on the agent's git makes the cell `invalid: 'workspace'`.

**Readings where the prereg is silent.**
1. A teach task whose first check is `na` gets the confirmation form.
2. A plan-limit cut-off during a resume restores the post-session-1 work tree and instruction files, then reruns the resume from the original session id; the retry counts in `limitRetries`.
3. A4's written memory is `rule, because reason`, one line per taught lesson; a reversal replaces the superseded line.
4. Screen sessions take no resumes.
5. `wordOverlap` is the share of the rule's distinct content words (lowercased, 3 or more characters, minus a stop list) that occur in the apply prompt.
6. `staleFollow` is the superseded lesson's checker passing on the first attempt of an after-reversal apply.
7. "Apply tasks spread across the sequence" is met by the random draw, not a constraint; the dry run reports the `tasksSinceTeach` spread.
8. A4 is told a lesson only when its teach resume returned a result.
9. A teach whose checker crashes is still taught, in the confirmation form, and its record is then `invalid: 'checker'`.
10. A session with a result but no findable transcript is invalid (`no-transcript`), since its work cannot be measured.
11. A broken workspace repo after the session is the agent's doing, so it voids that cell (`invalid: 'workspace'`), not the run. A teach with such a fault takes no resume, so A4 is not taught that lesson; a fault found after a delivered resume leaves the lesson taught.
12. `hippo` sums the ledger over every session id of the cell, the resume's own id included when Claude Code gives it a new one.
13. An instruction file session 1 leaves above `work/` voids the cell before any lesson check, for teach, apply, no-lesson and screen cells alike, so whether a cell is void never depends on its first verdict. Such a cell takes no resume, and A4 is not taught from it. One that a cut-off resume leaves stops the resume before its rerun; the cut-off attempts still count in `limitRetries`. Every teach resumes, so a file found at its resume voids it. Only a failing apply resumes, so a file found at its resume would make the cell's status depend on the verdict. That apply stays valid: the resume is skipped and the paths go to `resumeAncestorHits`.
14. Session 1 decides `void` for every cell, split from the resume at the byte where session 1 ended in each transcript file, subagents included. Every teach resumes, so a teach's resume hits also void it: its reads, and the memory session 1 left that the resume loads. Only a failing apply resumes, so its resume hits would make `void` depend on the verdict; they go to `resumeVoidHits` and never set `void`. An operator canary there still fails the whole run at the analyzer's G1, since a canary anywhere puts the isolation in doubt.
15. An instruction file a lesson checker leaves above `work/` voids that cell as `ancestor-instructions`. The check runs on every graded cell right after its first lesson check, before the resume decision, so a passing apply is caught too.

**Checked so far.** The runner is exercised end to end with a stand-in for Claude Code in `tests/token-eval-ab-run.test.ts` and the `tests/token-eval-z0-*.test.ts` files (homes, turns, surfaces, surface reads, snapshot failure, timeout, read check, leaks, chain and grading); every corpus those tests write is checked against a local copy of the analyzer's `z0-record/1` contract. No real Claude Code session has run under the Z0 arms yet: the stage 1 smoke report settles that auto memory saves in a per-run config dir, that A0 gets none, and that the OAuth token signs in with an empty config dir.

## A/B analysis (TE5)

```bash
node scripts/token-eval/ab-analyze.mjs --runs runs.jsonl --prices prices.json
```

- `runs.jsonl` holds one record per task, arm and seed; the input format is in the script header.
- `prices.json` holds `{inputPerMTok, cacheWritePerMTok, cacheReadPerMTok, outputPerMTok}`, taken from the provider's current price page for the exact model.
- Records written by `ab-run.mjs` carry `scored` and `invalid`. Unscored first tasks and invalid runs are excluded and counted in the output.
