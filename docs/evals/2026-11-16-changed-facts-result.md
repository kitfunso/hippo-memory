# Changed facts and the rank without decay: result (2026-11-17)

**Status:** RESULT. **D does not merge** (G2b fails, G3 void). **R does not merge as registered:** G1 and G1b fail on cleanStaleR5 by a small margin. G4, G5 and G6 pass, and G6 HELPS. Whether R ships despite G1 is the owner's call.

**Plan:** `2026-11-16-changed-facts-prereg.md` with Amendments 1 and 2. Amendment 2 defines arm R and was written before any R run.

**Code under test:** arm A is `d86ce480b` (the v3.5.1 `src/`). Arm D is `8233e7aac`. Arm R is `81fd0e921` on `fix/rank-only`: D without the sleep pass. Each arm was built once. The full suite passed on R: 1,158 test files, 12,530 tests, 0 failures.

**Cost:** E1, G4, G5 and the replay are local CPU only. G6 ran the agent on Claude subscription usage (one token) and the judge on Codex; no API spend.

**Raw outputs:** the session scratchpad `rank-plan/` (not in git): `e1s-A/`, `e1s-D/`, `e1s-R/`, `e1-cmp-*.txt`, `g2b-D.json`, `g3-D/`, `locomo-R/`, `g4-R*.txt`, `lme-R/`, `g5-R*.txt`, `g6/` (logs and `pair-Z0_SUB_TOKEN_1.json`), `r1R-*/`, `r1-score.txt`, `r1-split.txt`. G6 run folders are `~/dolphin/runs-v3/g6a-hippo-*` and `g6r-hippo-*` in WSL.

## Headline

- **R passes more DolphinBench tasks.** 250 of 600 against A's 204 (41.7% against 34.0%), paired difference +7.67 pp [+4.17, +11.17]. R passed 85 tests that A failed, and A passed 39 that R failed. Every run passed its integrity gate (200 of 200 graded per persona, memory context in every session, pinned builds).
- **R finds the current version of a fact more often** (E1 currentR5 +6.9 pp at half-life 365, +22.4 pp at 35) and **LoCoMo and LongMemEval-S retrieval do not drop.**
- **R fails one registered guard.** When a fact changes, R shows the old version a little more often: cleanStaleR5 falls 2.8 pp [-4.3, -1.2] at half-life 365 and 1.9 pp [-4.3, +0.5] at 35. The margin is a lower bound above -3 pp, so G1 and G1b fail.
- **D's sleep pass found no real changes.** It acted on 0 of the 60 blind change pairs (floor 12) and proposed 0 links on the real-store copy. People write an update in new words, so a one-span match does not see it.

## Guards

### D (Amendment 2 records the failure)

- **G2b:** fails. changeActed 0 of 60, floor 12 (`g2b-D.json`).
- **G3:** void. 0 proposals on the real-store copy (465 eligible rows of at most 20 words).
- **E1, reported:** at half-life 365, D against A: currentR5 -7.5 pp [-9.6, -5.5], hotR5 -14.0 [-17.3, -10.4], cleanStaleR5 +2.9 [+0.7, +5.2], cleanTrapR5 -8.0 [-12.8, -3.0].

### G1, E1 lifecycle with sleep, half-life 365, seeds 181 to 200 (R against A)

| metric | R | A | R - A pp | 95% CI | gate |
|---|---|---|---|---|---|
| currentR5 | 0.710 | 0.640 | +6.9 | [+5.8, +8.1] | pass |
| hotR5 | 0.698 | 0.701 | -0.3 | [-2.0, +1.3] | pass |
| cleanStaleR5 | 0.135 | 0.162 | -2.8 | [-4.3, -1.2] | **fail** |
| cleanTrapR5 | 0.614 | 0.509 | +10.6 | [+7.1, +14.2] | pass |

Superseded s\* 76.4% [66.8, 88.3], gate 7.1%: passes. Demoted s\* is not triggered (cleanTrapR5 does not lose). Reported: MRR +2.1, stale intrusion 0.849 against 0.797 (worse by 5.2), trap persistence -7.6 (better), contradiction intrusion -7.2 (better). Alive: 28.2% of final-epoch probes rank the current version differently.

### G1b, half-life 35, same seeds

| metric | R | A | R - A pp | 95% CI | gate |
|---|---|---|---|---|---|
| currentR5 | 0.710 | 0.486 | +22.4 | [+20.6, +24.3] | pass |
| hotR5 | 0.698 | 0.495 | +20.3 | [+16.9, +23.8] | pass |
| cleanStaleR5 | 0.135 | 0.153 | -1.9 | [-4.3, +0.5] | **fail** |
| cleanTrapR5 | 0.614 | 0.208 | +40.7 | [+35.3, +46.0] | pass |

The superseded s\* gate is not triggered (the upper bound of cleanStaleR5 is above 0). Alive: 59.3%. R's numbers are the same at both half-lives, because its rank no longer reads strength.

### G4, LoCoMo retrieval, 1,531 questions with evidence

Top 10 +0.7 pp [+0.1, +1.4], top 50 +0.6 [+0.0, +1.1]: pass. Temporal top 10 -0.1 [-1.6, +1.4]. Alive: 99.2% of top-10 lists differ.

### G5, LongMemEval-S retrieval, 479 questions with evidence

Top 10 +0.1 pp [+0.0, +0.3], top 50 -0.1 [-0.2, +0.0]: pass. Knowledge-update top 10 +0.7 [+0.0, +2.1]. Alive: 24.8%.

### G6, DolphinBench agent rerun, 600 tests, both arms on slept copies of the v3 stores

| persona | A | R | R only | A only | R - A pp | 95% CI |
|---|---|---|---|---|---|---|
| morgan | 84/200 | 105/200 | 34 | 13 | +10.5 | [+4.0, +17.0] |
| alex | 68/200 | 76/200 | 24 | 16 | +4.0 | [-2.0, +10.5] |
| riley | 52/200 | 69/200 | 27 | 10 | +8.5 | [+2.5, +14.0] |
| all | 204/600 | 250/600 | 85 | 39 | **+7.67** | **[+4.17, +11.17]** |

Gate: R's estimate is above A's and the lower bound is above -3 pp: **pass**. The lower bound is above 0 and the point is above +3 pp: **HELPS**. Without morgan tests 1 to 20: +7.24 [+3.62, +10.86]. Without the one adapter-closed test: +7.51 [+4.01, +11.02]. Same agent (claude-sonnet-5 at medium effort), judge, hooks and tests as v3full.

## Reported, not gated

- **R1 replay, evidence recall:** A 39.0%, R 53.4% on the stores as saved; A 18.5%, R 35.1% on the slept copies. Gains and losses A to R: 97 and 8 as saved, 110 and 5 slept. By persona, as saved: morgan 38.8 to 52.6, alex 35.1 to 50.0, riley 43.2 to 57.5 (`r1-split.txt`).
- **Sleep lowers evidence recall in every persona under both arms**, and 0% of the memories shown after sleep lack a session stamp, so the scorer is not the cause.
- **Against the earlier v3full runs (not paired, a different window):** v3full hippo passed 270 of 600 (45.0%) on the stores as saved, and the keyword control passed 312 of 600 (52.0%). G6's A on slept stores passed 204. This points at sleep at the test dates as a cost to the agent, and it leaves hippo below the keyword control on DolphinBench.

## Next route

1. **The owner's call on R.** R trades a small rise in old versions of changed facts (cleanStaleR5 -2.8 pp) for a clear gain on current facts and DolphinBench (+7.67 pp of tests passed). This file recommends shipping R with the G1 miss named in the release notes. Shipping overrides a registered guard, so it needs the owner's explicit yes.
2. **Sleep on DolphinBench.** Register a paired test of R with sleep against R without sleep at the test dates. The replay and the v3full gap both say sleep costs recall.
3. **Changed facts.** Link an old fact to its replacement when the new memory is written, under a new registration with a new blind fixture (the G2b fixture is now seen).
