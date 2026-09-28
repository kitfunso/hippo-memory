# 2026-09-28 E1 release confirmation: the paper's E1 claims, re-measured on 1.52.3

**Status:** PRE-REG-LOCKED at the commit that adds this file. No run has used seeds 121 to 160.

**Code under test:** hippo-memory 1.52.3, npm `latest` on 2026-09-28: tag `v1.52.3` (`fcd432e`), detached and unchanged, built with `npm ci` and `npm run build` (both exit 0). The E1 scripts at that tag are the ones round 2 locked: `git diff f3e916d v1.52.3 -- scripts/e1-lifecycle` is empty. The only new script is `scripts/e1-lifecycle/confirm-check.mjs`, added by this commit. It reads the generator and run files and never touches `src/`.

**Cost:** local CPU only. E1 passes no `hippoRoot` to `hybridSearch` (`run.mjs:132`, `:258`), so no embedder loads. No LLM, no paid call. Every command unsets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`, `HIPPO_LLM_RERANKER_KEY` and `TYPESAFE_API_KEY`.

## Why

The paper draft (`hippo-paper/draft/paper.tex` at `a472c28`; every `paper.tex` line cited here is at that commit) reports E1 results measured on code older than every release that ships the 365-day default. Its critique (`hippo-paper/CRITIQUE-2026-09-28.html`) names a pre-registered E1 run on the current release as the single change that matters most. Four gaps:

1. **The measured code is not the shipped code.** `e79d71b` (#231, 2026-09-25) changed how a memory marked wrong ranks: its strength halves per net bad mark, up to three halvings, even when pinned; it loses the recall boost; and recall no longer refreshes its decay clock. Release 1.46.0 shipped it together with the 365-day default (`paper.tex:49`), so every release with that default has it. None of the builds the E1 audits ran on does: `e79d71b` is not an ancestor of `6ce7e4d` (round 1), `a6482a0` (the second decay-default registration), `39dc65c` (round 2's replication build) or `f3e916d` (round 2's lock build, the same tree as master's `b42da44`) (`git merge-base --is-ancestor`, checked 2026-09-28). 40 commits touching `src/` lie between `b42da44` and 1.52.3.
2. **The BM25 comparison was never a lane.** The abstract (`paper.tex:50-51`) and the body (`:427-429`) say that against plain BM25 the lifecycle trails by 2.9 pp on current-fact recall but leaves marked-wrong memories in the top five 25.7% of the time, against 73.9%. Both numbers come from round 1's context rows ("They are context rows, not lanes", `2026-09-23-mechanism-audit-prereg.md:147`).
3. **Outcome feedback alone was never put against the lifecycle.** BM25 plus the fast outcome nudge takes trap persistence from 71.9% to 0.0% and lifts currentR5 by 4.9 pp (R2c, `2026-09-23-mechanism-audit-round2-result.md:21`). No registered lane compares that baseline with full. If it ties or wins, the abstract's conclusion that on this protocol the lifecycle's value is memory hygiene (`paper.tex:51-52`) is a claim about outcome feedback.
4. **R4 has no verdict.** Its gate failed on seed 89 (`round2-result:23`, `:63`), yet the paper uses lookalike dating to explain the BM25 gap (`paper.tex:434-436`).

This run re-measures every E1 claim the paper makes at the shipped default, on one release, on untouched seeds. It changes no default.

## Lanes

Every arm runs at `--half-life 365`, the shipped default (`src/memory.ts:505`); `run.mjs` defaults to 7 (`:65`, `:324`), so the flag is required.

| Lane | Claim in the paper, or question | A vs B | Primary endpoint | Seeds |
|---|---|---|---|---|
| C1 | Trails BM25 on current-fact recall by 2.9 pp (`paper.tex:427-428`) | full vs bm25-static | currentR5, plus non-inferiority | 121 to 140 |
| C2 | Cuts marked-wrong persistence from 73.9% to 25.7% against BM25 (`:428-429`) | full vs bm25-static | trap persistence | 121 to 140 |
| C3 | Does the lifecycle beat BM25 plus the outcome nudge on recall? | full vs bm25-outcome | currentR5, plus non-inferiority | 121 to 140 |
| C4 | Does it beat BM25 plus the outcome nudge on marked-wrong memories? | full vs bm25-outcome | trap persistence | 121 to 140 |
| C5 | The outcome nudge alone takes BM25 from 71.9% to 0.0% (`:439-441`, R2c) | bm25-outcome vs bm25-static | trap persistence | 121 to 140 |
| C6 | full@365 beats the fully-ablated baseline by 5.5 pp (`:49`, `:381`); that baseline keeps the recency factor | full vs all-off | currentR5 | 121 to 140 |
| M1 | Outcome feedback cuts trap persistence by 51.0 pp at 365 (`:382`) | full vs outcome-off | trap persistence | 121 to 140 |
| M2 | Strengthening lifts hot facts by 7.3 pp at 365 (`:383`) | full vs strengthen-off | hotR5 | 121 to 140 |
| M3 | Decay cuts stale intrusion (+43.8 pp, a 7-day result, `:41`, `:276`): does it at 365? | full vs decay-off | stale intrusion | 121 to 140 |
| M4 | The recency factor costs 6.1 pp of current recall (`:437-438`, R2a) | full vs recency-off | currentR5 | 121 to 140 |
| R4a | With lookalikes inside v1's window, does full@365 beat BM25? | full vs bm25-static, `--lookalike-window v1` | currentR5 | 141 to 160 |
| R4b | Same, against BM25 with newest-first ties | full vs bm25-newest, `--lookalike-window v1` | currentR5 | 141 to 160 |
| R4c | Same, against BM25 plus the outcome nudge | full vs bm25-outcome, `--lookalike-window v1` | currentR5 | 141 to 160 |

- Every lane reports every metric `compare.mjs` prints; only the primary gets a verdict. Named secondaries: for C1 and C3, hotR5, stale and contradiction intrusion, and the split the paper quotes (`paper.tex:434-435`): hit@5 on facts that never changed (`nonStaleR5`) and on facts that did (`updatedR5`, every `staleEligible` row, from `confirm-check.mjs split`); for M4, stale intrusion, R2a's cost (`round2-result:93`).
- The paper's +6.8 pp on facts that changed is hit@5 on updated facts, .856 against .788 (`2026-09-23-mechanism-audit-result.md:390`). `cleanStaleR5` is a different number: it also requires that no older version is in the top five, and its round-1 gap is +2.4 pp (.113 against .089, `:74`, `:81`). `compare.mjs` has no endpoint for the paper's number, so `split` computes it with a copy of `compare.mjs`'s bootstrap; its `nonStaleR5` line must equal `compare.mjs`'s to the digit, and did on seed 1.
- bm25-outcome, "BM25 plus the outcome nudge" below, ranks by BM25 times a multiplier within ±15% (`run.mjs:110`, `search.ts:133`), with decay, strengthening and the slow outcome channel off (`run.mjs:78`) and so no wrongness penalty. It carries the fast half of outcome feedback and none of the lifecycle. The paper calls it "outcome feedback alone" only beside that description.
- **D1, diagnostic, no verdict:** all-off vs bm25-static on 121 to 140, every metric. The two arms share flags (`run.mjs:74-75`) and store; all-off keeps `hybridSearch`'s own order, recency factor included, while bm25-static re-sorts the same candidates by raw BM25 (round 1's diagnostic row, `mechanism-audit-result.md:125`). If C1 or C3 shows a loss, D1 shows how much of it the search order already pays with every lifecycle mechanism off. Both arms run anyway.
- R4a and R4b are round 2's lanes as registered (`2026-09-23-mechanism-audit-round2-prereg.md:49-50`), on a block that passes their gate before any run (P0 check 5). R4c asks the same of C3's baseline and was added after the seed-1 dry run (Caution flags).
- Seeds 121 to 160 appear nowhere in `docs/evals/`, `ROADMAP.md` or `hippo-paper/`, and no run file for them exists under `hippo-mech-runs/` (checked 2026-09-28).

## (a) Source-read

At `v1.52.3`. The `src/` diff from 1.52.2 touches only `secret-detect.ts`, `support-bundle.ts` and `version.ts`, so these lines hold for both.

- `src/memory.ts:295` `netWrong(entry: MemoryEntry): number`: bad outcome marks past good ones, never below 0, and 0 whenever outcome-slow or decay is ablated (`:296`).
- `src/memory.ts:325` `calculateStrength`: `wrongPenalty = 0.5 ** min(netWrong, 3)` (`:288`, `:333`); a pinned memory returns it (`:334`); a wrong memory gets no retrieval boost (`:386`); the clamped strength is multiplied by it (`:402`).
- `src/search.ts:1274` `markRetrieved`: a superseded memory is left alone (`:1277`); a wrong one keeps its `last_retrieved` and `half_life_days` (`:1278-1284`), so recall no longer refreshes its decay clock.
- `src/search.ts:128` `outcomeMultiplier(entry: MemoryEntry): number`: `1 + 0.15 * tanh((pos - neg) / 2)`, clamped to [0.85, 1.15] (`:133`), neutral when the fast channel is ablated or the memory has no marks (`:132`). bm25-outcome ranks with it.
- `src/ablation.ts:108`, `:128-129`: `HIPPO_ABLATE_OUTCOME` sets both outcome channels; the other switches map one to one.
- `src/memory.ts:505` `DEFAULT_HALF_LIFE_DAYS = 365`.
- **Where `e79d71b` acts.** `netWrong` is live only where neither outcome-slow nor decay is ablated. By the arm switches (`run.mjs:69-80`) that is full, strengthen-off and recency-off. It is 0 in outcome-off, decay-off, all-off and every BM25 arm.
- `scripts/e1-lifecycle/run.mjs:109-111`: bm25-static ranks by raw BM25, bm25-outcome by BM25 times `outcomeMultiplier`, bm25-newest by BM25 with ties to the newest; every tie then breaks by entry id. Probes are read-only `hybridSearch` calls with an explicit `now` (`:17-18`, `:276`); scheduled retrievals call `hybridSearch` then `markRetrieved` (`:253-262`); outcomes go through `applyOutcome` on explicit ids (`:272`); every memory gets `baseHalfLifeDays: SWEEP_HALF_LIFE` (`:247`).
- `scripts/e1-lifecycle/run.mjs:290-297`: a run file's meta records arm, seed, `protocolHash`, `ranAt` (stamped when the run ends, `:293`), `halfLife`, `recencyDays` (absent unless `--recency-days` is set) and `lookalikeWindow` (absent for the default window, `generate.mjs:303`), and no build. `protocolHash` hashes the generated protocol only (`:211`), so `compare.mjs` cannot see a wrong `--half-life`; `confirm-check.mjs params` checks it, and the launcher records the build (Commands).
- `scripts/e1-lifecycle/generate.mjs:148`: traps are 15% of facts; each gets two bad marks, in the two sessions after it appears (`:207-223`); 30% of facts get one good mark on v1 (`:236-239`). Nothing else is ever marked bad, so a superseded version never carries net wrongness. v1 lands in sessions 0 to 11 (`:159`) and each later version after the one before, up to session 19 (`:171`, `:181`, `:184`); the v1 window dates hard negatives in sessions 0 to 11 (`:251`, `:257`). A hard negative's token names its fact: `NEG{f}N{n}D####`, or `VAL{f}X1D####` when it paraphrases an updated fact's v1 (`:258`, `:267`, `:288`).
- `scripts/e1-lifecycle/compare.mjs`: unchanged since round 2's lock. Paired bootstrap that resamples seeds, then probes within each seed, one mulberry32(1) stream per row (`:4`, `:58-59`), B = 10000 (`:17`). It throws on a protocol-hash mismatch (`:80`), misaligned probe rows (`:89`, `:92`), or rows that disagree with the stored aggregates (`:99`).

## (b) Dry-run: every switch fires, and so does `e79d71b`

Seed 1 only (the verdict seeds are 121 to 160), `--half-life 365`. Run files under `hippo-mech-runs/`: `r3/p0-1523/` and `r3/p0-1523-v1/` (1.52.3), `r3/p0/` and `r3/p0-v1/` (1.52.2), `r2/p0-3/` (round 2's lock build).

- **1.52.3 against 1.52.2:** identical in every epoch on all nine configurations run on both (full, bm25-static, bm25-outcome, all-off, outcome-off, strengthen-off and decay-off at the default window; full and bm25-static at the v1 window). For E1 the two releases are one build.
- **1.52.3 against the lock build:** bm25-static, bm25-outcome and bm25-newest are identical in every epoch. full differs in 17 of 20 epochs, and in its final epoch only on trap persistence, 0.178 to 0.000. recency-off differs in 17 of 20 (final-epoch trap persistence 0.044 to 0.000, currentR5 0.813 to 0.810). That is `e79d71b`, acting only where the source read says it can.
- **Every switch fires.** Each arm's epochs differ from full's in 17 to 19 of 20 epochs. bm25-outcome differs from bm25-static in 19 of 20, and bm25-newest from bm25-static under the v1 window in 19 of 20. The v1 window moves full in all 20 epochs. It moves bm25-static and bm25-outcome in 19 of 20 but not in the final epoch: a ranker that ignores time sees the same store once every lookalike has arrived.

Final-epoch levels on seed 1, 1.52.3:

| Arm | currentR5 | trap persistence | stale intrusion | hotR5 |
|---|---|---|---|---|
| full | 0.777 | 0.000 | 0.867 | 0.760 |
| bm25-static | 0.790 | 0.711 | 0.908 | 0.813 |
| bm25-outcome | 0.833 | 0.000 | 0.917 | 0.907 |
| bm25-newest | 0.777 | 0.756 | 0.875 | 0.760 |
| all-off | 0.727 | 0.756 | 0.825 | 0.693 |
| outcome-off | 0.703 | 0.733 | 0.825 | 0.693 |
| strengthen-off | 0.713 | 0.000 | 0.842 | 0.720 |
| decay-off | 0.790 | 0.200 | 0.858 | 0.760 |
| recency-off | 0.810 | 0.000 | 0.933 | 0.813 |
| full, v1 window | 0.897 | 0.000 | 0.933 | 0.867 |
| bm25-static, v1 window | 0.790 | 0.711 | 0.908 | 0.813 |
| bm25-newest, v1 window | 0.820 | 0.800 | 0.900 | 0.800 |
| bm25-outcome, v1 window | 0.833 | 0.000 | 0.917 | 0.907 |

Every control arm clears its gate on seed 1: bm25-static trap persistence 0.711, outcome-off 0.733, strengthen-off hotR5 0.720, decay-off stale intrusion 0.858, and recency-off differs from full.

As hypotheses for the verdict seeds, seed 1 suggests: C3 hurts (0.777 against 0.833), C4 sits at the floor (both 0.000), M3 finds no decay effect at 365 days (stale intrusion 0.867 against 0.858), and R4a and R4c help (0.897 against 0.790 and 0.833).

## P0 checks (before any verdict run)

1. **Build.** HEAD is `fcd432e` (`v1.52.3`), the tree is clean, `package.json` says 1.52.3, and `npm ci` and `npm run build` exit 0.
2. **Scripts.** `git diff f3e916d v1.52.3 -- scripts/e1-lifecycle` is empty.
3. **Every arm fires.** On seed 1, every arm's epochs differ from full's; bm25-outcome's from bm25-static's; bm25-newest's from bm25-static's under the v1 window; and the v1 window's from the default for full, bm25-static and bm25-outcome (`confirm-check.mjs diff`).
4. **The release differs where the source read says it should.** On seed 1, full and recency-off on 1.52.3 differ from round 2's lock build (`hippo-mech-runs/r2/p0-3/`); bm25-static, bm25-outcome and bm25-newest are identical to it.
5. **R4 seed screen.** `confirm-check.mjs r4-seeds 141 20` keeps all of 141 to 160: under the v1 window the share of lookalikes dated after v1 runs from 41.5% (seed 159) to 49.6% (seeds 156 and 157), all under 50%; the default window gives 64.1% to 69.5%. The same screen on 81 to 100 fails seed 89 at 50.8%, as round 2 found. Output: `hippo-mech-runs/r3/r4-seed-screen.txt`.

Checks 1 to 5 passed before this file was committed; the evidence is in (b) and above. A failed P0 check stops the lanes it feeds.

## Workload-validity gates

Run `confirm-check.mjs params` on every block, then `gates` on the main block, before any `compare.mjs` call. `params` reads only run metadata; `gates` reads control arms only, and for M4 only whether two arms differ. A lane whose gate fails reports "no verdict: the workload did not exercise the mechanism".

- Every block: `$R/build.txt`, written before the first run, shows `fcd432e` and an empty `git status --porcelain` for `W`. `params` passes: a run file exists for every arm and seed, and each records its own arm and seed, `halfLife` 365, no `recencyDays`, the block's window (none on main and drift, `v1` on r4) and a `ranAt` after the commit that adds this file.
- Every lane: 20 of 20 seeds complete, and `compare.mjs` passes its integrity checks.
- C2, C4, C5: bm25-static trap persistence at least 0.20 on at least 18 of 20 seeds (R2c's gate, `round2-prereg:79`).
- M1: outcome-off trap persistence at least 0.20 on at least 18 of 20 (L3a's gate, `mechanism-audit-prereg.md:92`).
- M2: strengthen-off hotR5 at most 0.90 on at least 18 of 20 (L3b's gate, `:93`).
- M3: decay-off stale intrusion at least 0.20 on at least 18 of 20. New: the lane needs superseded versions in the top five for decay to remove.
- M4: recency-off's final epoch differs from full's on at least 18 of 20 (R2a's gate, `round2-prereg:80`).
- R4a to R4c: P0 check 5 (R4's gate, `round2-prereg:81`).
- C1, C3, C6: integrity only, as round 1's L2g.
- A gate value missing from a run file counts as a failed seed.

## Decision rule

Round 2's rule (`2026-09-23-mechanism-audit-round2-prereg.md:84-90`): round 1's thresholds (`2026-09-23-mechanism-audit-prereg.md:97-103`) plus the BELOW THE FLOOR label. Both rounds' tie rule (`round2-prereg:91`, `mechanism-audit-prereg.md:104`) picks which configuration ships; this run changes no default, so it does not apply, and the paper-edit table below does its job. Benefit is A minus B for currentR5 and hotR5, and B minus A for trap persistence, stale intrusion and contradiction intrusion.

- **Helps:** the 95% CI lower bound is above 0 and the point estimate is at least +3 pp.
- **Hurts:** the 95% CI upper bound is below 0 and the point estimate is at most -3 pp.
- **No measurable effect:** anything else. A CI that excludes 0 with a point estimate under 3 pp is labelled BELOW THE FLOOR and is reported with its sign and interval, never as a tie.
- **Non-inferiority, C1 and C3 only:** NON-INFERIOR when the 95% lower bound of A minus B on currentR5 is above -3.0 pp. The margin is round 1's 3 pp floor, set at about twice E1's hierarchical half-width on currentR5 (`mechanism-audit-prereg.md:108`, `:151`). Round 1's result withdrew the floor's other reading, an effect a user could notice (`mechanism-audit-result.md:415`), so the margin claims nothing about users. It is reported beside the verdict and never replaces it.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

## What each verdict does to the paper

Fixed now, before any verdict seed runs. X stands for this run's difference in pp, L for an interval bound, a and b for the two arms' levels.

| Lane | Helps | No measurable effect (the CI includes 0) | Hurts |
|---|---|---|---|
| C1 | "beats BM25 on current-fact recall by X pp" | NON-INFERIOR: "within 3 pp of BM25 on current-fact recall"; otherwise "no measurable difference from BM25 on current-fact recall; a loss of up to L pp is not ruled out" | "trails BM25 on current-fact recall by X pp" |
| C2 | "leaves marked-wrong memories in the top five a% of the time, against b% under BM25" | drop the hygiene claim against BM25 | "keeps more marked-wrong memories in the top five than BM25" |
| C3 | "beats BM25 plus the outcome nudge on current-fact recall by X pp" | as C1, against BM25 plus the outcome nudge | the abstract says BM25 plus the outcome nudge retrieves current facts X pp better than the lifecycle |
| C4 | "removes marked-wrong memories better than BM25 plus the outcome nudge (a% against b%)" | "no measurable difference from BM25 plus the outcome nudge on marked-wrong memories"; if both arms read 0 on every seed: "in E1, where every mark is correct, both keep every marked-wrong memory out of the top five, so E1 cannot separate them" | "BM25 plus the outcome nudge removes more marked-wrong memories than the lifecycle" |
| C5 | keep R2c's sentence (`paper.tex:439-441`) with this run's numbers | drop it | no claim until explained |
| C6 | "X pp over the ablated baseline (decay, strengthening and outcome feedback off, the recency factor on)" | drop the claim | "at 365 days the lifecycle trails that ablated baseline by X pp" |
| M1 | keep the 365-day claim with this run's numbers | drop it | state it |
| M2 | keep the 365-day claim with this run's numbers | drop it | state it |
| M3 | "over E1's 20 weekly sessions, decay also cuts stale intrusion at 365 days" | "over E1's 20 weekly sessions the 365-day default does no measurable work on stale intrusion; the +43.8 pp is a 7-day result, and 20 weeks is too short to test 365-day decay" | state it, limited to E1's 20 weekly sessions |
| M4 | "the recency factor adds X pp of current-fact recall" | drop R2a's sentence | keep R2a's sentence (`paper.tex:437-438`) with this run's numbers |
| R4a | "with lookalikes dated inside v1's window, full@365 beats BM25 on current-fact recall by X pp" | "with lookalikes dated inside v1's window, full@365 and BM25 show no measurable difference on current-fact recall" | "with lookalikes dated inside v1's window, BM25 beats full@365 on current-fact recall by X pp" |
| R4b | as R4a, against BM25 with newest-first ties | as R4a | as R4a |
| R4c | as R4a, against BM25 plus the outcome nudge | as R4a | as R4a |

- **BELOW THE FLOOR, any lane:** the paper gives the sign, the size and the 95% interval, "A trails (or beats) B on <metric> by X pp [L, L], under the 3 pp floor", and never words it as a tie, a match or no difference. For C1 and C3 the non-inferiority reading rides beside it.
- **No verdict, any lane** (a failed P0 check, `params` check, gate or integrity check): the claim leaves the abstract, and the body keeps the earlier number only labelled with its build, seeds and half-life.
- **The thesis sentence** (`paper.tex:51-52`), keyed on C2 and C4:
  - C2 or C4 has no verdict: it leaves the abstract.
  - C2 anything but helps, or C4 hurts: drop it.
  - C2 helps and C4 helps: keep it, with this run's numbers.
  - C2 helps and C4 neither helps nor hurts (no measurable effect, BELOW THE FLOOR, or both arms at 0): rewrite it to say the hygiene comes from outcome feedback, which the lifecycle includes, and that BM25 plus the outcome nudge does the same in E1.
- Each lane is read on its own. The paper does not use R4 to explain C1 or C3, and does not put a C1 or C3 gap down to how the generator dates lookalikes (`paper.tex:434-436`), unless the dating test in NOT-DONE is registered and run.
- The abstract carries a lane only when its verdict also holds at 99%. A pass at 95% only is flagged and stays in the body.
- Every E1 number in the paper's main text either comes from this run or is labelled with its build, seeds and half-life. The June and round-1 7-day rows stay, labelled: they show the protocol can see a mechanism, not what 1.52.3 does.
- No default changes on this run. A default change needs its own registration and an independent critique.

## Sample size and multiplicity

- 20 seeds per lane, 300 facts each, B = 10000. Round 1's hierarchical 95% half-widths: about 1.5 pp on currentR5 and 3.7 pp on trap persistence (`mechanism-audit-prereg.md:151`).
- **Ledger:** 13 lanes and 2 non-inferiority readings, 15 tests. Expected false passes: 0.75 at 95%, 0.15 at 99%. Every table shows the 99% interval. full is in 12 of the 13 lanes, and C1 with C2 and C3 with C4 share their runs, so the errors are correlated; a joint bootstrap is NOT-DONE. D1, `split` and the drift diagnostic carry no verdict and add no test.

## Drift diagnostic (no verdict)

Seeds 101 to 120, arms full, bm25-static, bm25-outcome and recency-off at 365 days on 1.52.3, against round 2's lock-build files for the same arms and seeds (`hippo-mech-runs/r2/e1-am1/r2/`). `confirm-check.mjs diff` per arm, and `compare.mjs` full on 1.52.3 against full on the lock build. It measures how far the September numbers sit from the shipped code on the block where R2a and R2c ran (`2026-09-24-mechanism-audit-round2-amendment-1.md:73`). It is not a replication of R2a or R2c: those seeds are spent. The source read predicts identical BM25 arms and a moved full and recency-off; that is a prediction, not a gate.

## Retraction conditions

- A P0 check fails: no verdict for the lanes it feeds.
- A gate fails: no verdict for its lanes.
- A `compare.mjs` integrity check fails: no verdict for that lane.
- `params` fails on a block, `build.txt` shows a build other than `fcd432e` or a dirty tree, or a lane ran with E1 scripts other than `f3e916d`'s: rerun or retract.
- A run file for seeds 121 to 160 dated before this file's commit is found: those seeds are spent, and the lanes move to a fresh block by amendment.
- The paper states a lane's result in words the table above does not allow: fix the paper.

## NOT-DONE

| Item | Why not now | Slot |
|---|---|---|
| Noisy outcome marks | E1's marks are always right, the best case for both outcome channels and for `e79d71b`; a real `hippo outcome --bad` marks a whole recall batch. Needs generator code | Next campaign |
| E1 with the embedding blend | E1 passes no `hippoRoot` | Next campaign |
| The 7-day June and round-1 lanes on 1.52.3 | 7 days is no longer shipped; those rows stay labelled with their build | Only if the paper keeps a 7-day number in a claim about the current release |
| The dating test: does full's gap to BM25 plus the outcome nudge depend on how lookalikes are dated? full@v1 against full@default on the same seeds (bm25-outcome's final epoch is the same under both windows) | `compare.mjs` refuses arms whose protocol hashes differ (`:80`), so it needs its own script. Until it runs, the paper does not put a C1 or C3 gap down to dating | Next campaign |
| Default changes | None proposed here | Own registration |
| DolphinBench | Amendment to `2026-09-24-public-benchmarks-prereg.md` | Separate |
| Joint bootstrap (StepM) | The 99% column is the cheap guard | Next campaign |
| A re-run by a person other than the author, from the README | Needs a person | Before the paper posts |

## Caution flags

- The author designed, built, ran and will judge this. An independent critique rides the result, and this file's commit precedes every verdict run.
- The author saw seed 1's levels on 1.52.2 and 1.52.3, the table in (b), before locking. Lanes C1 to C6, M1 to M4, R4a and R4b come from the paper's claims and its critique and were drafted before those numbers existed. The non-inferiority reading, the gates and the paper-edit table were finalised after, and R4c was added after: seed 1 shows BM25 plus the outcome nudge ahead of full on recall while the v1 window lifts full by 12 pp. bm25-outcome's final epoch is the same under both windows, so R4c's seed-1 reading, 0.897 against 0.833, was in view when R4c was added. An independent review of this file before lock added D1, `split`, `params`, the thesis rule and the no-verdict rule, and deleted a rule that read C3 and R4c together; seed 1 was in view for all of it, and so was `split`'s test run on seed 1 (full against bm25-static: +8.3 pp on facts that changed, -7.8 pp on facts that never did). Seed 1 is not a verdict seed.
- Other looks before lock. Round 2's R4 diagnostics on seeds 81 to 100 (v1 window, lock build) were in view when R4a and R4b were re-registered: full@365 beat bm25-static on currentR5 by 11.4 pp [10.0, 12.7] and bm25-newest by 8.0 [6.8, 9.3], and all-off beat bm25-static by 5.2 [4.2, 6.3] (`round2-result:68`). Lock-build files for full, recency-off, bm25-outcome and bm25-static at 365 days exist for seeds 101 to 120 (`amendment-1:134-135`). Round 2 compared only bm25-outcome with bm25-static and full with recency-off on them (`2026-09-23-mechanism-audit-round2-raw.txt:68`, `:84`); no comparison of full with bm25-static or bm25-outcome on those files appears there or in this machine's session logs (searched 2026-09-28). The BM25 arms match across builds and full moved only on trap persistence at seed 1, so those files would preview C1 and C3 closely. They are the drift block, and their C1 and C3 contrasts stay uncomputed until the verdict runs are compared.
- Every outcome mark in E1 is correct. If full and bm25-outcome both read 0.000 trap persistence on every seed, C4's interval is [0, 0]: a floor set by those correct marks, not evidence that the two remove marked-wrong memories equally well in use.
- `e79d71b` is part of what is measured, not a confound: it is shipped behaviour. It acts in full, strengthen-off and recency-off, so M2 and M4 compare two arms that both have it, while M1, C1 to C4, C6 and R4a to R4c compare an arm that has it with one that does not.
- decay-off also switches off the wrongness penalty (`memory.ts:296`) and, since decay no longer runs, the slow outcome channel (`ablation.ts:76`). M3's endpoint is about superseded versions, which never carry a bad mark, but in full a v1 with a good mark decays more slowly through the slow channel (`memory.ts:349-350`).
- E1's memories are at most 19 weeks old at the final probe (`mechanism-audit-result.md:232`), about 0.36 of one 365-day half-life, and the paper itself says a 365-day half-life is indistinguishable from no decay over 20 weeks (`paper.tex:417`). A null M3 is about E1's horizon, as R2b's was (`round2-result:19`).
- Neither way of dating lookalikes is neutral. By default a lookalike can land in any of the 20 sessions (`generate.mjs:251`), and most land after the v1 of the fact they imitate (64.1% to 69.5% on seeds 141 to 160, P0 check 5), which penalises a ranker that favours newer memories. The v1 window puts every lookalike in sessions 0 to 11, the sessions v1 can occupy (`:159`, `:251`), while later versions land after v1, up to session 19 (`:171`, `:181`). That favours a ranker that uses time: on seed 1 it lifts bm25-newest by 4.3 pp (0.820 against 0.777) and full by 12.0 pp (0.897 against 0.777). R4 measures a second workload, not a corrected one.
- The R4 screen selects seeds by a generator property. All 20 of 141 to 160 passed, so none was dropped.
- E1 is synthetic: 20 weekly sessions, BM25 plus the lifecycle, no embeddings, no sleep.

## Commands

From a checkout of this commit, with `W` a built `v1.52.3` worktree:

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
export W=<v1.52.3 worktree> R=<out-dir> OLD=<hippo-mech-runs/r2/e1-am1/r2> LOCK=<committer date of the commit that adds this file>
mkdir -p "$R" && { git -C "$W" rev-parse HEAD; git -C "$W" status --porcelain; node --version; } > "$R/build.txt"
{
  for s in $(seq 121 140); do for a in full bm25-static bm25-outcome all-off outcome-off strengthen-off decay-off recency-off; do echo "main $a 365 $s"; done; done
  for s in $(seq 141 160); do for a in full bm25-static bm25-newest bm25-outcome; do echo "r4 $a 365 $s v1"; done; done
  for s in $(seq 101 120); do for a in full bm25-static bm25-outcome recency-off; do echo "drift $a 365 $s"; done; done
} | xargs -P 20 -L 1 sh -c 'mkdir -p "$R/$0" "$R/log" && HIPPO_HOME=$(mktemp -d) node "$W/scripts/e1-lifecycle/run.mjs" --arms "$1" --half-life "$2" --seeds "$3" ${4:+--lookalike-window $4} --out-dir "$R/$0" > "$R/log/$0-$1-s$3.log" 2>&1'

K="node scripts/e1-lifecycle/confirm-check.mjs"
$K params "$R/main" full,bm25-static,bm25-outcome,all-off,outcome-off,strengthen-off,decay-off,recency-off 121-140 all "$LOCK"
$K params "$R/r4" full,bm25-static,bm25-newest,bm25-outcome 141-160 v1 "$LOCK"
$K params "$R/drift" full,bm25-static,bm25-outcome,recency-off 101-120 all "$LOCK"
$K gates "$R/main" 121-140                                                # gates, before any compare
C="node $W/scripts/e1-lifecycle/compare.mjs"
$C --a "$R/main:full" --b "$R/main:bm25-static" --seeds 121-140          # C1, C2
$C --a "$R/main:full" --b "$R/main:bm25-outcome" --seeds 121-140         # C3, C4
$C --a "$R/main:bm25-outcome" --b "$R/main:bm25-static" --seeds 121-140  # C5
$C --a "$R/main:full" --b "$R/main:all-off" --seeds 121-140              # C6
$C --a "$R/main:full" --b "$R/main:outcome-off" --seeds 121-140          # M1
$C --a "$R/main:full" --b "$R/main:strengthen-off" --seeds 121-140       # M2
$C --a "$R/main:full" --b "$R/main:decay-off" --seeds 121-140            # M3
$C --a "$R/main:full" --b "$R/main:recency-off" --seeds 121-140          # M4
$C --a "$R/r4:full" --b "$R/r4:bm25-static" --seeds 141-160              # R4a
$C --a "$R/r4:full" --b "$R/r4:bm25-newest" --seeds 141-160              # R4b
$C --a "$R/r4:full" --b "$R/r4:bm25-outcome" --seeds 141-160             # R4c
$C --a "$R/main:all-off" --b "$R/main:bm25-static" --seeds 121-140       # D1, no verdict
$K split "$R/main:full" "$R/main:bm25-static" 121-140                     # C1 secondary
$K split "$R/main:full" "$R/main:bm25-outcome" 121-140                    # C3 secondary
for a in full bm25-static bm25-outcome recency-off; do $K diff "$R/drift:$a" "$OLD:$a" 101-120; done
$C --a "$R/drift:full" --b "$OLD:full" --seeds 101-120                   # drift, no verdict
```

## Fixtures

The E1 generator at `f3e916d`, unchanged: 300 facts, 20 sessions, 10 hard negatives per fact. Round 1's sentinel check (`mechanism-audit-prereg.md:221`) carries over: a hit is scored on the current version's opaque value token, which never appears in the query. Round 2's only generator change, the v1 window, moves the session a lookalike is dated in and nothing else ("One draw per negative either way, so 'v1' keeps every token and only moves sessions", `generate.mjs:250`).

## Results

In `2026-09-28-e1-release-confirmation-result.md`: P0, `params` and gate output, every lane with its 95% and 99% intervals, D1, the `split` secondaries, the drift diagnostic, the paper edits each verdict triggers, and an independent critique.
