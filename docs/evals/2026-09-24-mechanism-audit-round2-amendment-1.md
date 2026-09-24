# 2026-09-24 mechanism audit round 2, amendment 1: seeds reused before the critique

**Status:** LOCKED before any R2a-R2d lane runs. Amends `2026-09-23-mechanism-audit-round2-prereg.md`
(locked `b42da44`), which is otherwise unchanged. The prereg's own text is not editable
after lock; this file is the record of what changed and why.

## What collided

The round 2 prereg reserves E1 seeds 41 to 60 for R2a to R2d (prereg, Lanes table,
`2026-09-23-mechanism-audit-round2-prereg.md:45-48`).

After that prereg locked (`b42da44`, 2026-09-24 17:19 UTC), the same author registered
and ran a second decay-default check, `2026-09-24-decay-default-prereg-2.md` (locked
`a6482a0`), on the same seeds 41 to 60. Its result is folded into
`2026-09-24-decay-default-result.md`, "Second registration" section. That work landed on
master in PR #227 (merge commit `7962889`, 2026-09-24 18:17 UTC), which also carries
`8e7b7ba` (default half-life 7 to 365 days) and `5d1e547` (physics off by default).

Why it matters: seeds 41 to 60 were supposed to be untouched until R2a to R2d ran. They
were not. Two of round 2's four comparisons on those seeds have now been run once
already, by the same author, and the results were read before round 2's independent
critique happened. A verdict on data the author has already seen is not blind.

## R2b and R2d: transfer, do not re-run

Checked prereg-2's runs (`2026-09-24-decay-default-prereg-2.md:9-12`; results at
`2026-09-24-decay-default-result.md:60-74`) against R2b and R2d as registered:

- **R2b** (`round2-prereg:46`, "full@365 vs decay-off, currentR5, seeds 41-60"). Prereg-2
  ran the same pair, same endpoint, same seeds, as its step 4 (`decay-default-result.md:72`,
  "decay-off vs full@365, currentR5, +0.7 [-0.1, 1.4]"). The comparison, arms, endpoint and
  seeds match exactly.
- **R2d** (`round2-prereg:48`, "full@730 vs full@365, currentR5, with L2's two guards, seeds
  41-60"). Prereg-2 ran the same pair, same endpoint, same seeds, as its step 3
  (`decay-default-result.md:71`, "full@730 vs full@365, currentR5, +0.7 [0.1, 1.2], tie").
  L2's two guards (demoted s* and superseded s*, `2026-09-23-mechanism-audit-result.md:59-61`)
  were checked in prereg-2's step 1, against full@7, not against full@365
  (`decay-default-result.md:64-69`). They were not re-checked for the 730-vs-365 pair itself.
  This is a real gap against the R2d registration as written. It does not change the verdict:
  the point estimate is +0.7pp, under the 3pp floor either way, so R2d cannot reach HELPS or
  HURTS regardless of the guards. Transferring is safe; the gap is recorded here so a reader
  does not mistake this for a clean match.

**Transfer, with a caveat.** Both are the same comparison the round 2 prereg specified, run
by the same author, after round 1, on the same seeds, before the round 2 critique existed.
Do not re-run them. Take:

- **R2b: full@365 vs decay-off, currentR5, +0.7pp [-0.1, 1.4].** CI crosses 0. No measurable
  effect. Per the prereg's proposal table (`round2-prereg:102`), no measurable effect means
  propose decay off. A tie goes to the simpler configuration.
- **R2d: full@730 vs full@365, currentR5, +0.7pp [0.1, 1.2].** CI clears 0 but the point
  estimate is under the 3pp floor: BELOW THE FLOOR, i.e. no measurable effect
  (`round2-prereg:90`). Per the proposal table (`round2-prereg:104`), keep the 365 nominee.
  L2's guards were not separately checked against full@365 for this pair (see gap above);
  since the result cannot reach HELPS without clearing the 3pp floor first, the guard gap
  does not change the outcome.

## R2a and R2c: move to a fresh seed block

Checked every seed range already spoken for, across `docs/evals/` and `ROADMAP.md`:

- 1 to 20: June's original H2 probes (`mechanism-audit-prereg.md:84`).
- 21 to 40: round 1's E1 and the round 2 replication lane (`round2-prereg:41,69`); also the
  first decay-default registration (`decay-default-prereg.md:10`).
- 41 to 60: round 2's R2a to R2d (`round2-prereg:45-48`); also the second decay-default
  registration, the collision above.
- 61 to 80: round 1's #3 grid judge nominee (`mechanism-audit-result.md:263`) and FE3's
  planned re-test of the forgetting default (`ROADMAP.md:1794`) both claim this block.
- 81 to 100: R4a and R4b (`round2-prereg:49-50`); running now in
  `hippo-mech-runs/r2/e1/r4/` as of this amendment, untouched by this collision.
- 101 to 120: not referenced anywhere in `docs/evals/` or `ROADMAP.md`. Free.

R2a (recency) and R2c (outcome alone) move to **seeds 101 to 120**. Same arms, same
comparisons, same primary endpoints, same workload-validity gates as the original
registration (`round2-prereg:45,47,80`). Nothing about the mechanism under test changes,
only the seed block.

Run **R2c first**: it is the lane the outcome-nudge claim in the decay-default work leans
on hardest (trap persistence, `round2-prereg:55`), and it was not touched by the collision
at all, so it carries no risk of a second peek.

## #3 grid: does it trigger

`round2-prereg:63`: "#3 runs only if R2b or R2d is HELPS or HURTS." Evaluated on the
transferred verdicts above: R2b is no measurable effect (tie), R2d is BELOW THE FLOOR (tie).
Neither is HELPS or HURTS. **#3 does not run. NOT-DONE, reason: neither trigger lane cleared
the 3pp floor** (`decay-default-result.md:70-72`, both ties, matching commit `8e7b7ba`'s
summary: "730 and decay-off tie with 365").

## Release gate: the defaults #227 already changed

PR #227 (`7962889`) shipped two default changes to master before round 2's independent
critique ran at all:

- `8e7b7ba`: `DEFAULT_HALF_LIFE_DAYS` 7 to 365 (`src/memory.ts`).
- `5d1e547`: physics off by default.

Both commits predate the round 2 critique. The round 2 prereg is explicit on this: "No
default changes without an independent critique of this round first"
(`round2-prereg:108`), and its retraction conditions: "A default changes before the
independent critique: revert it" (`round2-prereg:131`).

This amendment does not revert code. Reverting `8e7b7ba` and `5d1e547` mid-campaign would
throw away a real registration and its guards over a process violation, and R4a/R4b are
running against the current build right now. Instead:

**Release gate for 1.46.0: master's 365-day half-life and physics-off default must not
reach npm until round 2's independent critique has run and signed off on them.** The
critique covers R-L1/R-L1n (physics) and the transferred R2b/R2d plus the re-run R2a/R2c
(decay and recency) as part of its normal scope. If the critique calls either default
wrong, `docs/evals/2026-09-23-mechanism-audit-round2-result.md` records the revert as its
own action item; this file only sets the gate, not the outcome.

## Ledger N update

Round 2's base N stays 19 (`round2-prereg:114`): round 1's 9, plus R-L4, R2a to R2d, R4a,
R4b, and R5a to R5c. R2b and R2d still count as 2 of the 19; their rows are populated by
transfer instead of a fresh round 2 run. Flag for the results doc's multiplicity section:
seeds 41 to 60 carried more looks than round 2's own N=19 accounts for, because prereg-2
ran a 4-step sequential procedure (one HELPS check plus three guards, then the two transferred
comparisons) on that block before round 2 ever touched it. Round 2's 99% interval check
(`round2-prereg:114`) still applies to R2b and R2d as reported here; it was not designed to
absorb prereg-2's earlier looks, and a reader comparing the two documents should not read
R2b/R2d's CIs as spent from a single N=19 budget.

## Commands, R2a and R2c on seeds 101 to 120

Lock build, E1 (R2c and R2a only; drop decay-off, bm25-newest and the 730 arm, transferred
above):

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
export R=<out-dir>
for s in $(seq 101 120); do
  for a in full recency-off bm25-outcome bm25-static; do echo "r2 $a 365 $s"; done
done | xargs -P 16 -L 1 sh -c 'mkdir -p "$R/$0" "$R/log" && HIPPO_HOME=$(mktemp -d) node scripts/e1-lifecycle/run.mjs --arms "$1" --half-life "$2" --seeds "$3" --out-dir "$R/$0" > "$R/log/$0-$1-s$3.log" 2>&1'

node scripts/e1-lifecycle/compare.mjs --a "$R/r2:bm25-outcome" --b "$R/r2:bm25-static" --seeds 101-120 # R2c, run first
node scripts/e1-lifecycle/compare.mjs --a "$R/r2:full" --b "$R/r2:recency-off" --seeds 101-120        # R2a
```

## Results

R2a and R2c results go in `2026-09-23-mechanism-audit-round2-result.md` alongside the
transferred R2b and R2d verdicts, with this file cited as the source of the seed change and
the transfer.
