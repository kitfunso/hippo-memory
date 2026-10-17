# Z0-Q: hippo on a private ML repository, a case study. Pre-registration

**Date:** 2026-10-15
**Roadmap:** Track Z, beside Z0. Not part of Z0's scored run.
**Parent design:** `docs/evals/2026-09-29-z0-built-in-memory-prereg.md` ("the Z0 prereg"). Every rule there holds here unless this file changes it.
**Review:** an outside review of the plan on 2026-10-15. Its fixes are applied here and listed at the end.
**Status:** draft. It is registered when merged. No session under this design exists. After the first paid session, the arms, lessons, decision rule and power statement do not move.

## Question

On Quantamental, Keith's commodity-model repository, does an agent with hippo repeat a taught mistake less often, and solve tasks for less money, than the same agent with Claude Code's built-in memory?

Quantamental is where most of our own repeated mistakes happened. Its `CLAUDE.md` rules exist because the same errors came back across sessions: unlagged data sources, hand-copied lot sizes, transaction costs in the wrong unit. So it is the repository where memory should matter most to us.

## Why this is a case study and not Z0

The Z0 prereg requires public repositories (line 56) and rules that maintainers wrote (line 51). Quantamental is private, and its owner picked the lessons, so a reader could say we chose mistakes hippo is good at. Z0 stays the evidence for outsiders. Z0-Q is evidence for ML work on this repository, and every result is written that way.

## What changes from the Z0 prereg

**Repository.** One: a clone of Quantamental at `d50f60cd` (tag `zq-base-2026-10-15`), tracked files only, so no `.env` or data cache. The eval checkout drops `CLAUDE.md`, `AGENTS.md`, `.claude/`, `LEARNINGS.md`, `docs/`, `PLANS/`, `REVIEW.md` and `website/frontend/FRONTEND_RULES.md`, and its history is truncated to one snapshot commit (`0b7efc64`). Several of these files state the rules under test. The snapshot keeps the 2,110 tracked files that the repository's own `.gitignore` matches (`research/` 1,909, `outputs/` 179, 22 pickles under `paper/model_data/`); the Z0 snapshot script, which commits with `git add -A`, left them out, and tests that pass at the clone point then failed in a fresh checkout. Z0-Q builds with a copy that force-adds them. The one submodule link stays out.

**Task bases.** As in Z0's stage 3, every task's base is one commit on that snapshot, written by the author. A family needs six tasks and each lesson has two to five incidents, many with no test, so bases cannot be the incident commits themselves. Instead a base may take back out what an incident's fix added to state or enforce its rule (a comment, a docstring, a guard test), where an agent doing that task would read or run it. That puts the task back in the state the incident happened in. The author lists every such removal.

**Lessons.** Rules from Quantamental's `CLAUDE.md`, each with at least two incidents in its git history, so all are owner rules and none are template lessons. Six enter the screen:

| Id | Rule | Checker |
|---|---|---|
| C1 | Lag every source that is not same-day with the lag helper, never a bare reindex and forward fill | Regex, plus the repository's publication-lag audit script copied into `checks/` |
| C6 | No cap on lots | Any added `max_lots_cap` under `production/` |
| C8 | Transaction cost is dollars per contract traded, not basis points | A basis-point cost on notional, or a literal cost in a model script |
| C9 | `shared_constants.py` is the one source for lot sizes, multipliers and tickers | An added commodity-to-number literal outside that file |
| C10 | Adjusted prices for continuity returns, raw prices for sizing and denominators | The incident's own form, `adj.diff()/adj.shift()`, or `pct_change` on an adjusted column |
| C12 | Every registered output validator declares `requires_committed` | A `ValidatorSpec(` added without `requires_committed=` |

Each lesson's key phrase comes from the rule's wording and appears in no task base. The runner refuses a stub that holds a key phrase (`scripts/token-eval/runs.mjs:85`) and voids a sequence on a workspace hit (`leaks.mjs:127`), and code identifiers such as `align_with_lag` sit in over a hundred tracked files. Authoring proves absence with `git grep` over every base, and drops any base that states its own rule.

**Families.** One teach task, four apply tasks and one screen task. No reversal families: six families cannot also power the stale-rule test. Hidden tests check the task's own function. The repository's incident guard tests are not used as hidden tests, since that would make the lesson the task.

**No-lesson tasks.** A third of each sequence, from the same history, written as symptoms, as in the Z0 prereg.

**Arms.** A0, A1, A2 and A4, defined as in the Z0 prereg. A5 and set X are not run; Z0 measures capture attribution and Codex portability.

**Seeds.** A1 and A2 run three seeds. A0 and A4 run two, as in Z0 (prereg 124).

**Environment.** A venv built from `production/requirements.txt` pins, with no editable install. The `qm` launch case sets `PYTHONNOUSERSITE`, `PIP_NO_INDEX`, `PYTHONDONTWRITEBYTECODE`, `VIRTUAL_ENV`, and the venv first on `PATH`. The runner gives every arm one environment, so a per-session `PYTHONPATH` is not possible; instead the venv's `sitecustomize.py` walks up from the working directory to the checkout's `production/` and puts it on `sys.path`, as the repository's editable install would. Outside a checkout, `shared_constants` does not import. The arm environment carries no service key, and the analysis checks every record's `envKeys` for one. The venv's site-packages are hashed before and after each chunk; a change voids the chunk.

**Extra void.** Any session whose transcript names the owner's Quantamental checkout or the case study's scratch folder is void under G1.

**Runner and model.** The Z0 runner and hippo build at the Z0 freeze tag, with the Z0 pins. Nothing paid runs before that tag exists.

## Screen

As the Z0 prereg's screen (line 68): A0 and A4 on two seeds; a family is kept if A0 breaks the lesson on at least 2 of 4 attempts and A4 follows it on both. The drop list is published. If fewer than 5 families are kept, the main run does not start, and the report says the lessons are not learnable at this size.

## Decision rule

Checked in this order:
- **Void.** If A4 does not repeat at least 30 points less than A0, the run is void: the task set cannot show what memory is worth.
- **Helps.** An exact sign-flip test over families on the per-family A2 minus A1 repeat-mistake rate, one-sided at 0.05 with A2 lower.
- **Loss.** The same test, one-sided at 0.05 with A2 higher. A loss leads the write-up.
- **Tie.** Neither, and the 95% interval of the mean difference sits inside plus or minus 15 points.
- **Not detectable.** Anything else, reported with the interval.

The tests are one-sided in each direction because a two-sided sign-flip test over 5 families cannot get below p = 0.0625. That is weaker than Z0's two-sided 0.05. One hippo store serves every family in a seed, so families are not fully independent, and this test overstates certainty; the write-up says so.

The repeat-mistake rate is defined as in the Z0 prereg (line 151), on first attempts. Cost per solved task, A2 against A1, is reported with its interval; a cheaper A2 inside the interval is written as "not shown". Per-lesson rows are description only.

## Power, stated before the run

Built-in memory already avoids most repeats in Z0's raw calibration records, so hippo has little room. Simulated under this decision rule with families' difficulty spread from 0.25 to 1.75 times the base rate, 12 attempts per arm and family, 20,000 runs (`power.mjs`, sha256 prefix `d94c33717802ebd3`, kept with the run outputs; `node power.mjs --families=6 --a1=0.12 --a2=0.04` gives the first cell):

| Families kept | A1 12%, A2 4% | A1 30%, A2 10% | Both 12% |
|---|---|---|---|
| 6 | 18% | 63% | 1.2% false "helps", 1.2% false "loss" |
| 5 | 7% | 35% | 0.5% false "helps", 0.5% false "loss" |

So "not detectable" is the likely outcome unless built-in memory finds these lessons much harder than Z0's. The run goes ahead anyway: it costs free credit only, and the per-family rates and cost per solved task answer the owner's practical question either way. This departs from the Z0 prereg's rule that an underpowered run is not started (line 215), and the write-up says so.

## Budget and schedule

About $12 for the screen and about $135 for the main run (450 sessions at about $0.30, from Z0 calibration), on the monthly free Console credit through Z0's swap proxy, capped at $170. The main run is one runner invocation over the four arms at their seeds (45 sessions per arm and seed), as Z0 calibration runs. At the cap the proxy answers 429 and the runner waits, as the calibration build makes it, until the proxy is moved to the plan login, so a cap stop delays the run and never cuts it. A scheduled job starts the paid steps on the first day from 2 to 12 November 2026 on which the freeze tag, the authored task set and a credit check are all in place.

## Stages

- **Q0.** This prereg, merged before any paid session.
- **Q1.** Venv, eval repository and launch case. Check: in a work folder, `shared_constants` resolves inside it and `py` resolves to the venv; the named test files pass at the clone point.
- **Q2.** Authoring blind to hippo, then Z0's stage 3 validators. Check: each hidden test fails at base and passes at fix; each checker fails a breaking diff and passes a compliant one; key phrases absent from every base; no base states its rule.
- **Q3.** Screen. Check: drop list published, at least 5 families kept.
- **Q4.** Main run. Check: no abandoned chunk, G1 voids listed, the positive control alive.
- **Q5.** Analysis and report. Check: one command regenerates every number from the run records.

## Review findings applied (2026-10-15)

- Key phrases taken from code identifiers would have stopped every task at the runner's stub check; they now come from rule wording.
- Docs and review files stated several rules; they are dropped from the checkout, and every base is grepped.
- Power: four apply tasks, a third seed for A1 and A2, an exact test over families, and tie and loss verdicts. The reviewer's power estimate of about 50% did not reproduce under this test; the table above is ours.
- Five candidate lessons were dropped as unsound or correlated with a kept one (C4, C5, C7, C11, C13).
- Python isolation and the void for reads of the owner's checkout were added.
- Not taken: hashing site-packages around every session and widening the runner's read check. Both need runner changes after the freeze; the per-chunk hash and the transcript void cover the same risks.
