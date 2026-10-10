# Z0 stage 1 smoke report (draft)

**Prereg:** `docs/evals/2026-09-29-z0-built-in-memory-prereg.md`, stage 1 (lines 231-239).
**Status:** draft. Three of the six points still need real sessions. This file is committed when every point below says **settled**.

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

1. **Canaries and a logging proxy (G1).** Pending: this needs a Claude Code session.
2. **`--resume` delivers a teach message.** Pending: this needs a Claude Code session.
3. **hippo's hooks fire under `claude -p`.** Pending: this needs a Claude Code session.
4. **Auto memory saves under `-p`.** Pending: this needs a Claude Code session.
5. **Codex memories under `codex exec` with a per-run home.** The documentation part is settled; the live probe is pending. The Codex config reference (fetched 2026-10-10) says memory generation runs as a startup pass, at most `memories.max_rollouts_per_startup` (default 16) threads per pass. A thread is a candidate only after it has been idle for `memories.min_rollout_idle_hours` (default 6, range 1 to 48). Generation is also skipped when the account's remaining Codex rate limit is below `memories.min_rate_limit_remaining_percent` (default 25). So no Codex memory can form in the minutes after a session ends. The runner's default `--codex-memory-wait poll:30000:600000` would therefore always return after 30 s with nothing written. The live probe will show whether `codex exec` runs the startup pass.
6. **Codex hook trust in a fresh home.** The live probe is pending. codex-cli 0.153.4 offers `codex exec --dangerously-bypass-hook-trust`, which the runner passes under `--codex-hook-trust flag`. Persisted trust is a `[hooks.state.'<hooks.json path>:<event>:<group>:<hook>']` table with `enabled` and `trusted_hash`. The runner's `--codex-hook-trust file:` route can write that table once the hash is known.

## Runner changes these findings need

- Done: the run's `config.toml` sets `memories.min_rollout_idle_hours = 1`, the documented floor (`scripts/token-eval/codex.mjs`, pinned in `tests/token-eval-z0-codex-session.test.ts`). At the default of 6 hours, almost no apply ends early enough in a run to feed a later apply's memories. The setting applies to X1 to X4 alike, so it moves no arm against another. `--strict-config` makes the first live session fail if Codex does not know the key.
- The memory wait has to come from the startup pass, not from a poll after each session.
