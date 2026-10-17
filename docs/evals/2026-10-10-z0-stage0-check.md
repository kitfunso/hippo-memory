# Z0 stage 0 check: runner and prerequisites closed

**Date:** 2026-10-10
**Scope:** stage 0 of the [Z0 prereg](./2026-09-29-z0-built-in-memory-prereg.md) ("Stages, each closed by its check", item 0). No session ran and no efficacy claim is made.
**Verdict:** every stage 0 bullet has a merged PR and a test file that pins it (table below), and the closing dry run passes for all nine arms.

Stage 0 closes on two checks: a unit test per change, and a dry run showing fresh, empty memory directories per run (prereg line 230). The table covers the first check. The section after it covers the second.

## What built each bullet

PR numbers are from `gh pr list -R kitfunso/hippo-memory --state merged --search "Z0"`, and each row was checked against the PR body or its file list.

| Stage 0 bullet (prereg lines 220-228) | Merged PR | Test file |
| --- | --- | --- |
| Auto memory on or off per arm; own `CLAUDE_CONFIG_DIR`; login through the environment; transcript lookup there | #353 Z0 runner arms A0/A1/A2/A5 with per-run homes | `tests/token-eval-ab-run.test.ts`, `tests/token-eval-z0-homes.test.ts` |
| Stub `CLAUDE.md` and per-arm carry lists in place of the `checkoutBase` wipe | #353 | `tests/token-eval-ab-run.test.ts`, `tests/token-eval-z0-homes.test.ts` |
| Teach messages, confirmations and correction resumes | #361 Z0 lesson families, teach turns, checkers and screen | `tests/token-eval-z0-turns.test.ts`, `tests/token-eval-lessons.test.ts` |
| Lockstep rotation of the arm order and wider file reads (shell reads count as file reads) | #353 | `tests/token-eval-ab-run.test.ts` (the lockstep planning test and the `shellReads` cases) |
| Snapshot-and-restore on retry | #411 Z0 memory-surface ledger, G1 and G3 voids, grading save | `tests/token-eval-z0-snapfail.test.ts`, `tests/token-eval-z0-surfaces.test.ts` |
| The three grading checks listed under TE5 in the ROADMAP | #411 (grading save, timeout record) and #485 Z0 G5 regrade, reader sample and stored sample | `tests/token-eval-z0-grading.test.ts`, `tests/token-eval-z0-timeout.test.ts`, `tests/token-eval-z0-regrade.test.ts`, `tests/token-eval-z0-samples.test.ts` |
| Codex runner with per-run installs and `CODEX_HOME` | #742 Z0 set X runner, Codex applies (E6) | `tests/token-eval-z0-codex-run.test.ts`, `-codex-guards`, `-codex-faults`, `-codex-install`, `-codex-session`, `-codex-units` |
| Codex wrapper that reads `~/.codex` and ignores `CODEX_HOME` | #350 Codex wrapper honours `CODEX_HOME` at launch; #723 resolves the Codex CLI and dashboard UI from the package root | `tests/codex-wrapper.test.ts` |
| `HIPPO_AGENT_MEMORY_TOOLS` in every run, and the import dry run listing only the run's own homes | #353 (`--check-homes`, the per-run environment); #742 extends it to the X2 install | `tests/token-eval-z0-homes.test.ts`, `tests/token-eval-ab-run.test.ts`, and the canary in `tests/agent-memories-canary.test.ts` (from #342, before Z0) |
| Sham-hippo shim | #353 | `tests/token-eval-z0-homes.test.ts`, `tests/token-eval-ab-run.test.ts` |
| Memory-surface ledger and the read check | #411 | `tests/token-eval-z0-surfaces.test.ts`, `tests/token-eval-z0-readcheck.test.ts` |
| Two-level bootstrap | #351 Z0 statistics, two-level bootstrap and Holm verdicts | `tests/eval-stats.test.ts` |
| Blind mode in the analyzer | #357 Z0 analyzer | `tests/token-eval-z0-analyze.test.ts`, `tests/token-eval-z0-analyze-cli.test.ts` |

Two readings to flag. The ROADMAP names the three TE5 grading checks without listing them (`ROADMAP.md:2246`), so that row lists the grading PRs that merged, not a one-to-one match. And #723 is a package-root path fix for the same wrapper file, not the `CODEX_HOME` fix; that is #350.

## The closing dry run

`--check-homes` runs no Claude Code or Codex session and costs nothing. For each planned run it recreates the run's folders, checks the three homes exist and are empty, runs `hippo import --agents --dry-run` under each HOME the run uses, asks the agent's login shell for `hippo`, and removes the run.

Command, from the repository root at the base `070bea7f` plus the commit that adds this record:

```
node scripts/token-eval/ab-run.mjs --tasks <dev-tasks.json> --out <out> --arms A0,A1,A2,A4,A5,X1,X2,X3,X4 --seeds 1 --check-homes
```

The tasks file sets `"dev": true`. It holds two sequences on a two-commit local repository: `seqA` (one teach, two no-lesson and two apply tasks) and `seqX` (`"set": "X"`, three families, each taught once and applied twice). The out dir has no instruction file above it, so `Z0_ANCESTOR_STOP` was not set. The built `codex` (0.153.4) was on PATH for the X2 install and no `--codex-model` was needed. Exit code 0. Full output:

```
61 steps (Claude Code sessions) in lockstep; seeds A0:1 A1:1 A2:1 A4:1 A5:1 X1:1 X2:1 X3:1 X4:1.
Homes check passed for 9 runs.
  seqA/A1/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqA\A1\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqA\A1\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqA\A1\seed1\codex-home
    shell hippo: none
    after the check: empty
  seqA/A2/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqA\A2\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqA\A2\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqA\A2\seed1\codex-home
    shell hippo: C:/z0-stage0-check/out/runs/seqA/A2/seed1/bin/hippo
    after the check: empty
  seqA/A4/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqA\A4\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqA\A4\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqA\A4\seed1\codex-home
    shell hippo: none
    after the check: empty
  seqA/A5/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqA\A5\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqA\A5\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqA\A5\seed1\codex-home
    shell hippo: C:/z0-stage0-check/out/runs/seqA/A5/seed1/bin/hippo
    after the check: empty
  seqA/A0/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqA\A0\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqA\A0\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqA\A0\seed1\codex-home
    shell hippo: none
    after the check: empty
  seqX/X2/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqX\X2\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqX\X2\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqX\X2\seed1\codex-home (HOME=C:\z0-stage0-check\out)
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqX\X2\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqX\X2\seed1\codex-home (HOME=C:\z0-stage0-check\out\runs\seqX\X2\seed1\home)
    shell hippo: C:/z0-stage0-check/out/runs/seqX/X2/seed1/bin/hippo
    after the check: codex-home: hooks.json
  seqX/X3/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqX\X3\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqX\X3\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqX\X3\seed1\codex-home
    shell hippo: none
    after the check: empty
  seqX/X4/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqX\X4\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqX\X4\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqX\X4\seed1\codex-home
    shell hippo: none
    after the check: empty
  seqX/X1/seed1: claude-config, codex-home, hippo-home fresh and empty under C:\z0-stage0-check\out\runs\seqX\X1\seed1
    hippo import --agents sees Claude Code at C:\z0-stage0-check\out\runs\seqX\X1\seed1\claude-config, Codex at C:\z0-stage0-check\out\runs\seqX\X1\seed1\codex-home
    shell hippo: none
    after the check: empty
```

All nine arms ran, and none was left out. How to read it:

- Every run's three homes were fresh and empty before the check (the first line of each block).
- The importer saw exactly Claude Code and Codex at that run's own `claude-config` and `codex-home` in every run. X2 shows two lines, one per HOME, because hippo also runs under the wrapper home there.
- The agent's shell found no `hippo` in A0, A1, A4 and X1, X3, X4, and the run's own `bin/hippo` in A2, A5 and X2.
- The homes stay empty after the check, except X2: its Codex install writes `hooks.json` into `codex-home`, which is the install doing its job.
