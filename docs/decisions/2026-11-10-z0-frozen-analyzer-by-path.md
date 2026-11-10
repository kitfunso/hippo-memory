# Re-read a frozen Z0 round through its own analyzer, by path

Date: 2026-11-10
Status: accepted
Links: PR #1192, `scripts/token-eval/z0-cost-by-kind.mjs`, `docs/plans/2026-11-09-z0-round3-cost-by-kind-plan.html`,
`docs/evals/2026-11-09-z0-round3-cost-by-kind.md`

## Context
The round 4 prereg needs new reads of round 3's scored records, such as cost by task kind. Round 3's analyzer is
commit `04835462b` on `origin/z0/r3-cleanclaude` (`C:/z0-runs/scored/pins-r3c.json`). It never merged to master.

## Constraints and evidence
- Of the 10 analyzer sources that round 3's `unblind.json` hashes, master has 1 with the same sha256, 5 that differ
  (`z0-filters`, `z0-hypotheses`, `z0-gates`, `z0-blind`, `z0-analyze`) and 4 missing (`src/eval/` and
  `dist/eval/` stats files). Checked 2026-11-10 with `git show origin/master:<file>` against the report hashes.
- A new read must reproduce round 3's published H3 and H4 exactly, or its new cells cannot be trusted.
- The report's own grading and drop-list paths point at a deleted worktree. Byte-identical copies are in
  `docs/evals/z0-r3/` (sha256 `91db0471...` and `e65c99d7...`).

## Decision
A script that re-reads a frozen round imports that round's analyzer from a checkout given by `--analyzer`. It checks
every source and input sha256 against the round's report, and it stops unless the report's headline lines come out
exact in every compared field before it prints anything new.

## Alternatives considered
- Copy the frozen analyzer files onto master: a second analyzer on master that drifts from the live one.
- Merge round 3's analyzer branch (135 commits not on master, `git rev-list --count origin/master..04835462b`) to master: a large merge to support one read.
- Rebuild the read on master's analyzer: master differs in 9 of 10 sources, so H3 would not reproduce.

## Consequences
- The real read needs a local checkout of `04835462b` and `C:/z0-runs`. CI runs only the stub-analyzer tests.
- The hash list is the one round 3 recorded. Two modules the analyzer loads (`arms.mjs`, `exec.mjs`) are not in it.

## Reconsider when
- Round 3's analyzer merges to master, or a later round's analyzer replaces it on master.
