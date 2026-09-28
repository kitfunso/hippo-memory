# 2026-09-28 E1 release confirmation: result

**Status:** RESULT, 2026-09-28. Independent critique: pending. Changes no default.

**Plan:** `2026-09-28-e1-release-confirmation-prereg.md`, locked at `04e1e6d` (committer date 2026-09-28T12:30:36+01:00, the `LOCK` every `params` call checks).

**Code under test:** hippo-memory 1.52.3, worktree `hippo-wt-r3run3` detached at `fcd432e` (tag `v1.52.3`), clean, built with `npm ci` and `npm run build`. `build.txt`, written before the first run, records the commit, the tree state and the Node version (Provenance). npm `latest` is now 1.52.6, which runs the same code for E1 (Deviations 4).

**Cost:** local CPU only. The launcher unset every paid key the prereg lists, and E1 passes no `hippoRoot`, so no embedder loaded.

**Raw outputs:** `2026-09-28-e1-release-confirmation-raw.txt`, written by one script (Commands) after all 320 runs had finished. Run files: `hippo-mech-runs/r3/main`, `r4` and `drift` on the home box, not in git. All of `r3` (729 files: the three blocks, the seed-1 dry runs, the exploratory 7-day block and every log) is archived as `results/e1-release/e1-release-runs.tar.gz` in the paper's repository, sha256 `3a824c6ce859554add326ca054101cab222f656a14522bc88ab83a58c1fa8d94`, with a sha256 line per file beside it. That repository goes public with the paper.

## Headline

Bad news first.

- **BM25 plus the outcome nudge beats the shipped lifecycle on current-fact recall by 6.5 pp** (0.820 against 0.755, 95% CI [5.1, 7.8]; C3 hurts). The nudge is the fast half of outcome feedback with none of the lifecycle.
- **Against plain BM25 the lifecycle shows no measurable recall difference:** -1.4 pp [-2.9, 0.1] (C1). That is inside the 3 pp margin at 95%; at 99% a loss of up to 3.4 pp is not ruled out.
- **Its hygiene edge over BM25 comes from outcome feedback.** It leaves marked-wrong memories in the top five 0.0% of the time against BM25's 71.9% (C2 helps). BM25 plus the outcome nudge also reads 0.0% on every seed (C4), and the nudge alone takes BM25 from 71.9% to 0.0% (C5 helps). Every mark in E1 is correct, the best case for both.
- **Inside the lifecycle,** outcome feedback cuts trap persistence by 77.0 pp (M1) and strengthening lifts recall of often-recalled facts by 8.0 pp (M2). The 365-day decay default does no measurable work on stale intrusion over E1's 20 weeks (M3). The recency factor costs 5.1 pp of current recall (M4 hurts); it cuts stale intrusion by 5.8 pp and adds 7.7 pp of contradiction intrusion.
- **The lifecycle beats its own ablated baseline** (decay, strengthening and outcome feedback off, the recency factor on) by 5.4 pp (C6).
- **On a second workload that dates every lookalike inside v1's window**, which favours a ranker that uses time, the lifecycle beats plain BM25 by 11.8 pp, BM25 with newest-first ties by 9.4 and BM25 plus the nudge by 6.9 (R4a to R4c). There it puts a contradiction in the top five on 19.5% of contradiction probes, against 0.0% for each BM25 arm.
- All ten decisive verdicts hold at 99%. All 320 runs exited 0, and every gate passed on 20 of 20 seeds.

## Verdicts

The rule, as registered. Benefit points the good way: A minus B for currentR5 and hotR5, B minus A for trap persistence, stale intrusion and contradiction intrusion, so `compare.mjs`'s A minus B is sign-flipped for those three. Helps: 95% lower bound above 0 and point at least +3 pp. Hurts: 95% upper bound below 0 and point at most -3 pp. A CI that excludes 0 with a point under 3 pp is BELOW THE FLOOR. Anything else is no measurable effect. Non-inferiority (C1 and C3): NON-INFERIOR when the 95% lower bound of A minus B on currentR5 is above -3.0 pp.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

| Lane | A vs B | Primary | A | B | Benefit, pp | 95% CI | 99% CI | Verdict |
|---|---|---|---|---|---|---|---|---|
| C1 | full vs bm25-static | currentR5 | 0.755 | 0.769 | -1.4 | [-2.9, 0.1] | [-3.4, 0.5] | No measurable effect |
| C1, NI | full vs bm25-static | currentR5, margin -3.0 | 0.755 | 0.769 | -1.4 | lower -2.9 | lower -3.4 | NON-INFERIOR at 95%, not at 99% |
| C2 | full vs bm25-static | trap persistence | 0.000 | 0.719 | +71.9 | [68.0, 75.6] | [66.7, 76.6] | Helps |
| C3 | full vs bm25-outcome | currentR5 | 0.755 | 0.820 | -6.5 | [-7.8, -5.1] | [-8.2, -4.7] | Hurts |
| C3, NI | full vs bm25-outcome | currentR5, margin -3.0 | 0.755 | 0.820 | -6.5 | lower -7.8 | lower -8.2 | Not non-inferior |
| C4 | full vs bm25-outcome | trap persistence | 0.000 | 0.000 | 0.0 | [0.0, 0.0] | [0.0, 0.0] | No measurable effect: both arms 0.000 on all 20 seeds |
| C5 | bm25-outcome vs bm25-static | trap persistence | 0.000 | 0.719 | +71.9 | [68.0, 75.6] | [66.7, 76.6] | Helps |
| C6 | full vs all-off | currentR5 | 0.755 | 0.701 | +5.4 | [4.2, 6.6] | [3.9, 7.0] | Helps |
| M1 | full vs outcome-off | trap persistence | 0.000 | 0.770 | +77.0 | [73.3, 80.7] | [72.2, 81.7] | Helps |
| M2 | full vs strengthen-off | hotR5 | 0.774 | 0.694 | +8.0 | [5.9, 10.1] | [5.2, 10.8] | Helps |
| M3 | full vs decay-off | stale intrusion | 0.885 | 0.883 | -0.2 | [-1.2, 0.8] | [-1.5, 1.0] | No measurable effect |
| M4 | full vs recency-off | currentR5 | 0.755 | 0.806 | -5.1 | [-6.5, -3.7] | [-6.9, -3.3] | Hurts |
| R4a | full vs bm25-static, v1 window | currentR5 | 0.892 | 0.775 | +11.8 | [10.4, 13.2] | [9.9, 13.7] | Helps |
| R4b | full vs bm25-newest, v1 window | currentR5 | 0.892 | 0.798 | +9.4 | [8.2, 10.6] | [7.8, 11.1] | Helps |
| R4c | full vs bm25-outcome, v1 window | currentR5 | 0.892 | 0.823 | +6.9 | [5.7, 8.2] | [5.3, 8.6] | Helps |

A and B are final-epoch means over seeds 121 to 140 (141 to 160 for R4). All ten decisive verdicts (C2, C3, C5, C6, M1, M2, M4, R4a, R4b, R4c) hold at 99%, and the three lanes with no measurable effect (C1, C4, M3) include 0 at 99% too. C1's non-inferiority holds at 95% only (99% lower bound -3.4), so it stays out of the abstract. `compare.mjs` prints one decimal, so C1's printed -2.9 is a bound at or above -2.95, clear of -3.0. The judge helper (Commands) flagged one lane, C4, whose bounds print as 0.0. Its run files give final-epoch trap persistence 0.000 for full and for bm25-outcome on all 20 seeds, while bm25-static reads 0.556 to 0.822 on each of them: the control arm is alive, and the zero-width interval is the floor the prereg's Caution flags predicted for correct marks.

## Gates, guards and integrity

- **P0 checks 1 to 5** passed before the lock (prereg, (b) and P0 checks) and were not re-run.
- **Runs:** `launch.out` holds 320 `exit=0` lines, 320 in all, and one `ALL-DONE` (raw, Provenance).
- **Build:** `build.txt` holds `fcd432e73c9752fce4180269dfb5ff08ea71f389`, an empty `git status --porcelain` and Node v24.13.0, and the worktree was still at `fcd432e` and clean when the analysis ran (raw, Provenance).
- **`params`:** PASS on main, r4 and drift: a run file for every arm and seed, each recording its own arm and seed, half-life 365, no `recencyDays`, the block's window and a `ranAt` after the lock.
- **Gates, main block:** all five PASS on 20 of 20 seeds (18 needed), none missing. bm25-static trap persistence 0.556 to 0.822 (C2, C4, C5); outcome-off trap persistence 0.667 to 0.867 (M1); strengthen-off hotR5 0.549 to 0.765 (M2); decay-off stale intrusion 0.825 to 0.942 (M3); recency-off's final epoch differs from full's on 20 of 20 (M4).
- **R4 gate:** P0 check 5 kept all of 141 to 160 before any run (prereg).
- **Integrity:** all 13 `compare.mjs` calls exited 0 with 20 seeds on every row. `compare.mjs` throws on a protocol-hash mismatch, misaligned probe rows or rows that disagree with the stored aggregates (prereg, (a)), so exit 0 means all three held. The two `split` and four `diff` calls exited 0 too; the judge helper lists any non-zero exit in `raw` and listed none.
- **Post-lock edit:** `gates` printed identical output under `04e1e6d` and `d91bd51` (raw, last line).

## What the paper says now

The prereg's table (What each verdict does to the paper), lane by lane. Quoted wording is the table's, with this run's numbers. The paper applies it at `hippo-paper` commit `3062f29` (abstract, sections 5.1 and 5.2, Table 2 and Figure 1).

- **C1**, no measurable effect, non-inferior at 95% only. Body: "within 3 pp of BM25 on current-fact recall", -1.4 pp [-2.9, 0.1], flagged as a 95% reading. The abstract carries only what holds at 99%, and the non-inferiority reading does not, so the abstract takes the table's other wording: "no measurable difference from BM25 on current-fact recall; a loss of up to 3.4 pp is not ruled out", with 3.4 the 99% bound.
- **C2**, helps: "leaves marked-wrong memories in the top five 0.0% of the time, against 71.9% under BM25".
- **C3**, hurts: the abstract says BM25 plus the outcome nudge retrieves current facts 6.5 pp better than the lifecycle.
- **C4**, both arms 0 on every seed: "in E1, where every mark is correct, both keep every marked-wrong memory out of the top five, so E1 cannot separate them".
- **The thesis sentence** (`paper.tex:51-52` at `a472c28`): C2 helps and C4 has both arms at 0, so it is rewritten to say the hygiene comes from outcome feedback, which the lifecycle includes, and that BM25 plus the outcome nudge does the same in E1.
- **C5**, helps: R2c's sentence stays with this run's numbers: the nudge alone takes BM25's trap persistence from 71.9% to 0.0%.
- **C6**, helps: "5.4 pp over the ablated baseline (decay, strengthening and outcome feedback off, the recency factor on)".
- **M1**, helps: outcome feedback cuts trap persistence by 77.0 pp at 365 days.
- **M2**, helps: strengthening lifts hot-fact recall by 8.0 pp at 365 days.
- **M3**, no measurable effect: "over E1's 20 weekly sessions the 365-day default does no measurable work on stale intrusion; the +43.8 pp is a 7-day result, and 20 weeks is too short to test 365-day decay".
- **M4**, hurts: R2a's sentence stays with this run's numbers: the recency factor costs 5.1 pp of current-fact recall.
- **R4a to R4c**, help: "with lookalikes dated inside v1's window, full@365 beats BM25 on current-fact recall by 11.8 pp", by 9.4 pp against BM25 with newest-first ties and by 6.9 pp against BM25 plus the outcome nudge. R4 is a second workload. The paper does not use it to explain C1 or C3 and does not put their gaps down to dating.
- **Secondaries that go beside the verdicts** (Diagnostics): the lifecycle puts a contradiction in the top five on 7.7% of contradiction probes, where BM25 with or without the nudge puts none, and on 19.5% under R4's window; recency-off reads 0.000, so the recency factor carries it. On facts that changed, the lifecycle beats BM25 by 8.6 pp and BM25 plus the nudge by 8.0 pp; on facts that never changed, it trails them by 8.1 and 16.1 pp.
- **Labels:** every E1 number in the main text comes from this run or carries its build, seeds and half-life. The June and round-1 7-day rows stay, labelled. The abstract's 2.9 pp and 25.7% against 73.9% (round 1's context rows), R2a's 6.1 pp and R2c's 4.9 pp leave the abstract and, where the body keeps them, carry their build and seeds.

## Diagnostics (no verdict)

- **D1**, all-off against bm25-static: with every lifecycle mechanism off, `hybridSearch`'s own order, recency factor included, trails raw BM25 by 6.8 pp on currentR5 [-8.4, -5.2]. Its split fits a recency factor that favours newer memories, as in round 1 (`2026-09-23-mechanism-audit-result.md:125`): cleanStaleR5 +6.9 pp [4.8, 9.0], facts that never changed -17.3 [-19.5, -15.1]. On the means, full's -1.4 against BM25 (C1) is its +5.4 over all-off (C6) less D1's 6.8: the search order pays more than all of C1's gap before any lifecycle mechanism acts. C3's gap splits the same way, with the nudge's +5.0 for BM25 (C5's currentR5 row) on top: 5.4 - 6.8 - 5.0 = -6.4, against the measured -6.5. That is arithmetic on means with no interval, and it explains neither verdict on its own.
- **`split`**, C1 and C3 secondaries: on facts that changed (`updatedR5`), the lifecycle beats bm25-static by 8.6 pp [6.5, 10.9] and bm25-outcome by 8.0 [6.0, 10.2]; on facts that never changed (`nonStaleR5`), it trails them by 8.1 [-10.1, -6.1] and 16.1 [-17.8, -14.4]. Both `split` calls print a `nonStaleR5` line equal to `compare.mjs`'s to the digit, as the prereg requires.
- **Other named secondaries.** C1: hotR5 +0.4 [-2.1, 2.8]; stale intrusion 2.1 pp lower [0.2, 4.1], under the 3 pp floor; contradiction intrusion 7.7 pp higher [5.0, 10.7]. C3: hotR5 -5.4 [-8.0, -2.9]; stale intrusion 5.4 pp lower [3.5, 7.3]; contradiction intrusion 7.7 pp higher [5.0, 10.7]. M4, the recency factor on against off: stale intrusion 5.8 pp lower [4.3, 7.4], contradiction intrusion 7.7 pp higher [5.0, 10.7].
- **Drift**, seeds 101 to 120, 1.52.3 against round 2's lock build (`f3e916d`). bm25-static and bm25-outcome are identical in every epoch on 20 of 20 seeds, as the source read predicted. full and recency-off differ on all 20; recency-off's final epoch matches on seeds 105, 108, 114 and 117. On full, `compare.mjs` gives trap persistence 0.000 against 0.198 (-19.8 pp [-23.4, -16.1]) and cleanTrapR5, the current fact in the top five with no marked-wrong memory beside it, 14.3 pp higher [11.3, 17.4]; every other metric moves by 0.3 pp or less. That fits `e79d71b`, which acts on marked-wrong memories and, by the source read, only in full, strengthen-off and recency-off (prereg, Where `e79d71b` acts). R2c's arms did not move, so R2c holds for 1.52.3 on its own seeds.
- **A tie that is not a copy.** bm25-static's trap persistence averages 0.7189 on seeds 121 to 140 and on round 2's seeds 101 to 120. The per-seed rates differ (0.756, 0.711, 0.733 on 121 to 123; 0.756, 0.733, 0.800 on 101 to 103) and so do the protocol hashes (`d0a35d78b7…` and `1069413244…`). Each rate is a count out of 45 trap probes (0.756 is 34 of 45), so block means move in steps of about 0.001 and can tie by chance.

## Provenance

- All 320 runs: worktree `hippo-wt-r3run3` at `fcd432e`, the prereg's command through the launcher in Commands (Deviations 1): `xargs -P 20`, a fresh `HIPPO_HOME` per run, one log per run under `r3/log/`.
- `confirm-check.mjs` ran from `git archive 04e1e6d`, the locked version; `raw` prints its blob hash. `compare.mjs` ran from `hippo-wt-r3run3`, unchanged since `f3e916d` (P0 check 2).
- Drift baseline: round 2's lock-build files for seeds 101 to 120, `hippo-mech-runs/r2/e1-am1/r2/` (build `f3e916d`).
- No verdict-seed run file was opened before all 320 runs had finished. Progress was tracked by counting `exit=` lines in `launch.out`.
- The Verdicts table was read off `raw` by `hippo-paper/analysis/e1-release-judge.py` (its self-check exits 0) and checked row by row against `raw` by hand. C4's floor was re-read from the run files.
- The archive (Raw outputs) was built by `hippo-paper/analysis/pack-runs.py`, which stores members in sorted order with zeroed times and owners, so the same files give the same hash.

## Deviations from the prereg

1. **Launcher logging.** The launcher is the prereg's command with two additions: each run's `sh -c` string ends with `; echo "$0 $1 s$3 exit=$?"`, and the script ends with `echo ALL-DONE`. Both write to `r3/launch.out` and record only each run's exit code and the end of the batch. Flags, environment, output paths and run list are the prereg's.
2. **A post-lock edit to the checker.** `d91bd51`, after the lock, changed `confirm-check.mjs:122` from a `typeof` test to `Number.isFinite` to clear a lint-ratchet hit in CI, and added a test that pins `confirm-check.mjs`'s bootstrap to `compare.mjs`'s. No run uses the checker. The analysis ran the locked version, and `raw` ends with `gates` run under both versions and compared byte for byte.
3. **A README check ran beside the verdict runs.** To check `scripts/e1-lifecycle/README.md` (`398af8a`) before committing it, its run command ran once on `hippo-wt-r3run3`: full and bm25-static, `--half-life 365`, seed 1, a fresh `HIPPO_HOME`, output to a scratch directory outside `r3`. Seed 1 is not a verdict seed, the worktree was read and not written, and both files matched the prereg's seed-1 files in every epoch. It shared the CPU with the verdict runs; nothing in E1 depends on timing.
4. **The prereg's "npm `latest`" was stale at lock.** The prereg calls 1.52.3 npm `latest` on 2026-09-28. Tags `v1.52.4` (`656efde`, 11:26) and `v1.52.5` (`d0150e5`, 12:01) came before the 12:30 lock and `v1.52.6` (`ee78c6b`, 12:43) after it; npm `latest` is now 1.52.6 (`npm view hippo-memory dist-tags`). From `v1.52.3` to `v1.52.6`, `src/` changes only `cli.ts`, `connectors/github/cli-impl.ts`, `support-bundle.ts` and the version string in `version.ts`, and `scripts/e1-lifecycle` does not change (`git diff --stat v1.52.3 v1.52.6 -- src/ scripts/e1-lifecycle/`). E1 imports `dist/memory.js`, `store.js`, `search.js` and `ablation.js` (`run.mjs:52-55`). Of the changed files, only `cli.ts` imports `support-bundle.ts` and `cli-impl.ts`, nothing in `src/` imports `cli.ts`, and the version string reaches E1 at most through `db.ts`'s rollback guard. For E1, 1.52.6 runs the code measured here. The run itself followed the prereg: the build under test was `fcd432e`.
5. **An exploratory arm ran beside the batch's tail.** For the paper's figure, full at the old 7-day default ran on seeds 121 to 140 (`r3/explore-hl7`, `fcd432e`, 20 runs, all exit 0). It was launched at 14:02 while the drift block was still running and finished at 14:16; `ALL-DONE` came at 14:27. It wrote only to its own directory and read no verdict file, and its first reader was the figure script, after `raw` was written. It is outside the prereg, carries no verdict and is labelled exploratory wherever it appears. Like Deviation 3, it shared the CPU, and nothing in E1 depends on timing.

## Ledger and multiplicity

15 tests: 13 lanes and 2 non-inferiority readings. Expected false passes: 0.75 at 95%, 0.15 at 99%. At 95%, 10 lanes are decisive (C2, C3, C5, C6, M1, M2, M4, R4a, R4b, R4c) and C1's non-inferiority reading passes; C1, C4 and M3 show no measurable effect, and C3's non-inferiority reading fails. All 10 decisive verdicts hold at 99%; C1's non-inferiority does not. full is in 12 of the 13 lanes, and C1 with C2 and C3 with C4 share their runs, so the errors are correlated; no joint bootstrap ran (NOT-DONE). D1, `split` and the drift diagnostic carry no verdict. Extra looks: none on verdict seeds before the runs finished; the README check reran seed 1, which the prereg's seed-1 runs had already shown; the exploratory 7-day arm (Deviations 5) was first read after `raw`.

## Caution flags

- E1 is synthetic: 20 weekly sessions, BM25 plus the lifecycle, no embeddings, no sleep.
- Every outcome mark in E1 is correct, the best case for both outcome channels and for `e79d71b`; a real `hippo outcome --bad` marks a whole recall batch.
- E1's memories are at most 19 weeks old at the final probe, about 0.36 of one 365-day half-life, so M3 asks what decay does inside that horizon and nothing longer.
- R4's v1 window is a second workload, not a corrected one: it dates every lookalike inside the sessions v1 can occupy, which favours a ranker that uses time.
- `e79d71b` is shipped behaviour and part of what is measured. It acts in full, strengthen-off and recency-off, so M2 and M4 compare two arms that both have it, while M1, C1 to C4, C6 and R4a to R4c compare an arm that has it with one that does not.
- decay-off also switches off the wrongness penalty and the slow outcome channel (prereg, Caution flags).
- Seed 1's levels were in view when the non-inferiority reading, the gates, the paper-edit table and R4c were finalised (prereg, Caution flags).
- The author designed, built, ran and judged this.

## Self-audit: what else is wrong with what I did

1. **The prereg called 1.52.3 npm `latest`, and I did not re-check at lock.** 1.52.4 and 1.52.5 were tagged before the lock and 1.52.6 after it (Deviations 4). No E1 number moves, since E1 reaches none of the changed code, but the prereg's "current release" was already out of date when it locked. The paper names 1.52.3 and says the code E1 exercises is unchanged through 1.52.6.
2. **Seed 1 called every headline.** The prereg's seed-1 hypotheses (C3 hurts, C4 at the floor, M3 null, R4a and R4c help) all came true. They were written down before the lock, so this run confirms them rather than finding them, but the non-inferiority margin, the gates, the paper-edit table and R4c were set with seed 1 in view (Caution flags). The run's worth is in the intervals on untouched seeds, not in surprise.
3. **The verdict column came from a helper written after `raw` existed.** `e1-release-judge.py` applies the registered rule, its self-check covers each branch, and I checked every row by hand. It is still unregistered code written with the numbers in view. The rule fits in one paragraph (Verdicts), and every verdict can be re-read from `raw` without the helper.
4. **Contradiction intrusion is a cost no verdict carries.** full puts a contradiction in the top five on 7.7% of contradiction probes where no BM25 arm puts one, and on 19.5% under R4's window. It is a named secondary, larger than C1's primary difference, and M4's row pins it on the recency factor. The paper states it beside C1, C3 and R4; left in a table, it would flatter the lifecycle.
5. **decay-off's trap row is not a decay effect.** decay-off leaves marked-wrong memories in the top five 20.2 pp more often (0.202 against 0.000) because it also turns off the wrongness penalty and the slow outcome channel (Caution flags). M3's null is about stale intrusion only, and the paper must not credit decay with the trap row.
6. **Every hygiene number sits on a floor.** C2, C4, C5 and M1 each compare an arm at 0.000, which correct marks and a ±15% multiplier are enough to reach. E1 cannot say how much of that survives a `hippo outcome --bad` that marks a whole recall batch (NOT-DONE, noisy marks).
7. **I ran an exploratory arm on verdict seeds before the batch finished** (Deviations 5). It read nothing and wrote only to its own directory, so the Provenance promise about opening files holds, but a cleaner run would have waited for `ALL-DONE`.
8. **Nobody outside can check the run files yet.** The archive sits in the paper's private repository until the paper posts, and no one but the author has re-run E1 from the README (NOT-DONE).

## NOT-DONE

| Item | Why not | Slot |
|---|---|---|
| Noisy outcome marks | Needs generator code | Next campaign |
| E1 with the embedding blend | E1 passes no `hippoRoot` | Next campaign |
| The 7-day June and round-1 lanes on 1.52.3 | 7 days is no longer shipped | Only if the paper keeps a 7-day number in a claim about the current release |
| The dating test (full@v1 against full@default on the same seeds) | Needs its own script: `compare.mjs` refuses arms whose protocol hashes differ | Next campaign |
| Joint bootstrap (StepM) | The 99% column is the cheap guard | Next campaign |
| A re-run by a person other than the author, from the README | Needs a person | Before the paper posts |
| DolphinBench | Amendment 3 to `2026-09-24-public-benchmarks-prereg.md` | Separate |

## Commands

Every call behind a verdict, a gate or a diagnostic is printed verbatim, with its output and exit code, in `raw` (each line starting `$ `). The launcher, run once, output to `r3/launch.out`:

```bash
#!/usr/bin/env bash
# The prereg's run command (04e1e6d), plus one exit-code line per run.
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
export W=C:/Users/skf_s/hippo-wt-r3run3 R=C:/Users/skf_s/hippo-mech-runs/r3
mkdir -p "$R" && { git -C "$W" rev-parse HEAD; git -C "$W" status --porcelain; node --version; } > "$R/build.txt"
{
  for s in $(seq 121 140); do for a in full bm25-static bm25-outcome all-off outcome-off strengthen-off decay-off recency-off; do echo "main $a 365 $s"; done; done
  for s in $(seq 141 160); do for a in full bm25-static bm25-newest bm25-outcome; do echo "r4 $a 365 $s v1"; done; done
  for s in $(seq 101 120); do for a in full bm25-static bm25-outcome recency-off; do echo "drift $a 365 $s"; done; done
} | xargs -P 20 -L 1 sh -c 'mkdir -p "$R/$0" "$R/log" && HIPPO_HOME=$(mktemp -d) node "$W/scripts/e1-lifecycle/run.mjs" --arms "$1" --half-life "$2" --seeds "$3" ${4:+--lookalike-window $4} --out-dir "$R/$0" > "$R/log/$0-$1-s$3.log" 2>&1; echo "$0 $1 s$3 exit=$?"'
echo ALL-DONE
```

The analysis script, run once after `ALL-DONE`, output to `raw`:

```bash
#!/usr/bin/env bash
# The prereg's analysis block (04e1e6d, prereg lines 219-240), run from an archive of the locked commit.
# Ends with the post-lock check: gates from d91bd51 must print exactly what gates from 04e1e6d printed.
S=<scratch directory>
DOC=C:/Users/skf_s/hippo-wt-r3doc W=C:/Users/skf_s/hippo-wt-r3run3 R=C:/Users/skf_s/hippo-mech-runs/r3
OLD=C:/Users/skf_s/hippo-mech-runs/r2/e1-am1/r2 LOCK=2026-09-28T12:30:36+01:00
rm -rf "$S/lock04" && mkdir -p "$S/lock04" && git -C "$DOC" archive 04e1e6d scripts/e1-lifecycle scripts/lifecycle-stress | tar -x -C "$S/lock04"
K="node $S/lock04/scripts/e1-lifecycle/confirm-check.mjs"
C="node $W/scripts/e1-lifecycle/compare.mjs"
run() { echo; echo "\$ $*"; "$@" 2>&1; echo "[exit $?]"; }

echo "== Provenance"
run cat "$R/build.txt"
run git -C "$W" rev-parse HEAD
run git -C "$W" status --porcelain
echo "launch.out: $(grep -c 'exit=0' "$R/launch.out") runs exit=0, $(grep -c 'exit=' "$R/launch.out") runs total, $(grep -c ALL-DONE "$R/launch.out") ALL-DONE"
echo "confirm-check.mjs under test: 04e1e6d, $(git -C "$DOC" rev-parse 04e1e6d:scripts/e1-lifecycle/confirm-check.mjs) (blob)"

echo; echo "== params, then gates, before any compare"
run $K params "$R/main" full,bm25-static,bm25-outcome,all-off,outcome-off,strengthen-off,decay-off,recency-off 121-140 all "$LOCK"
run $K params "$R/r4" full,bm25-static,bm25-newest,bm25-outcome 141-160 v1 "$LOCK"
run $K params "$R/drift" full,bm25-static,bm25-outcome,recency-off 101-120 all "$LOCK"
run $K gates "$R/main" 121-140

echo; echo "== Lanes"
echo "-- C1, C2"; run $C --a "$R/main:full" --b "$R/main:bm25-static" --seeds 121-140
echo "-- C3, C4"; run $C --a "$R/main:full" --b "$R/main:bm25-outcome" --seeds 121-140
echo "-- C5"; run $C --a "$R/main:bm25-outcome" --b "$R/main:bm25-static" --seeds 121-140
echo "-- C6"; run $C --a "$R/main:full" --b "$R/main:all-off" --seeds 121-140
echo "-- M1"; run $C --a "$R/main:full" --b "$R/main:outcome-off" --seeds 121-140
echo "-- M2"; run $C --a "$R/main:full" --b "$R/main:strengthen-off" --seeds 121-140
echo "-- M3"; run $C --a "$R/main:full" --b "$R/main:decay-off" --seeds 121-140
echo "-- M4"; run $C --a "$R/main:full" --b "$R/main:recency-off" --seeds 121-140
echo "-- R4a"; run $C --a "$R/r4:full" --b "$R/r4:bm25-static" --seeds 141-160
echo "-- R4b"; run $C --a "$R/r4:full" --b "$R/r4:bm25-newest" --seeds 141-160
echo "-- R4c"; run $C --a "$R/r4:full" --b "$R/r4:bm25-outcome" --seeds 141-160

echo; echo "== No verdict: D1, split, drift"
echo "-- D1"; run $C --a "$R/main:all-off" --b "$R/main:bm25-static" --seeds 121-140
echo "-- C1 secondary"; run $K split "$R/main:full" "$R/main:bm25-static" 121-140
echo "-- C3 secondary"; run $K split "$R/main:full" "$R/main:bm25-outcome" 121-140
for a in full bm25-static bm25-outcome recency-off; do run $K diff "$R/drift:$a" "$OLD:$a" 101-120; done
echo "-- drift"; run $C --a "$R/drift:full" --b "$OLD:full" --seeds 101-120

echo; echo "== Post-lock edit (d91bd51 changed confirm-check.mjs:122 from typeof to Number.isFinite)"
$K gates "$R/main" 121-140 > "$S/gates-04e1e6d.txt" 2>&1
node "$DOC/scripts/e1-lifecycle/confirm-check.mjs" gates "$R/main" 121-140 > "$S/gates-d91bd51.txt" 2>&1
if cmp -s "$S/gates-04e1e6d.txt" "$S/gates-d91bd51.txt"; then echo "gates output identical under 04e1e6d and d91bd51"; else echo "gates output DIFFERS:"; diff "$S/gates-04e1e6d.txt" "$S/gates-d91bd51.txt"; fi
```

The verdict column was read off `raw` by `hippo-paper/analysis/e1-release-judge.py`, which applies the Decision rule to each lane's primary row and flags any bound within 0.05 pp of 0 or 3, where `compare.mjs`'s one-decimal rounding could flip a verdict. It flagged C4 alone, and C4 was re-read from the run files (Verdicts). Run it as `python analysis/e1-release-judge.py <raw>`; with no argument it runs its self-check.

## Independent critique

Pending.

## What changed after the critique

Pending.
