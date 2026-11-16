# Recall rank without age: result (2026-11-16)

**Status:** RESULT. **B does not merge.** G1 and G1b fail; G2 and G3 pass.

**Plan:** `2026-11-16-rank-age-prereg.md`, locked at `be2517624`, with its dated amendment (written before any arm B run).

**Code under test:** arm A is `d86ce480b` (worktree `rank-base`), arm B is `fcf558060` on `fix/rank-age-decay` (worktree `rank-wt`). Each arm was built once with `npm ci` and `npm run build`. The full test suite passed on B before the guards ran.

**Cost:** local CPU only. No guard or report made a model call.

**Raw outputs:** the session scratchpad `rank-plan/` (not in git): `e1-A/`, `e1-B/`, `g1-*.txt`, `g1b-*.txt`, `locomo-A/`, `locomo-B/`, `g2-*.txt`, `lme-A/`, `lme-B/`, `g3-*.txt`, `r1-A/`, `r1-B/`, `r2-B/`, `explain-probe2/`, `explore/`.

## Headline

Bad news first.

- **B fails the changing-facts guards.** When a fact changes, B shows the old version beside the current one more often. cleanStaleR5 falls by 4.4 pp at half-life 365 [-6.3, -2.6] and by 13.2 pp at half-life 35 [-15.4, -11.0]. E1 writes each new version as a new row with no link to the old one, so age was the only signal that told the versions apart.
- **G1 also fails on two wide intervals:** hotR5 (-0.4 pp, lower bound -3.2) and the demoted break-even s\* (lower bound 0.0%).
- **B helps everywhere else.** currentR5 rises by 1.6 pp at half-life 365 and by 25.1 pp at half-life 35. MRR rises by 5.4 and 13.8 pp. Contradiction intrusion falls to 0.
- **LoCoMo and LongMemEval-S retrieval pass.** LoCoMo evidence recall rises by 0.9 pp at top 10 [+0.0, +1.9] and by 1.2 pp at top 50 [+0.5, +1.9]. LongMemEval-S is level: +0.2 [-0.5, +0.9] and -0.3 [-0.8, +0.2].
- **The DolphinBench replay (R1) confirms the start finding on the built code:** evidence recall rises from 38.3% to 53.7%.
- **Sleep still forgets old instructions (R2).** With sleep at each persona's test date, B's replay falls from 53.7% to 42.8%.
- **The named next route fails in exploration.** A port of `newestOnTopicFirst` drops currentR5 from 0.755 to 0.567 on seeds 161 to 165.

## Guards

Benefit points the good way: B minus A for a recall, A minus B for an intrusion rate. Pass: the 95% CI lower bound is above -3 pp.

### G1, E1 lifecycle, half-life 365, seeds 161 to 180, 10,000 draws

| Measure | A | B | Benefit (pp) | 95% CI | Verdict |
|---|---|---|---|---|---|
| currentR5 | 0.762 | 0.779 | +1.6 | [+0.3, +3.0] | pass |
| hotR5 | 0.782 | 0.777 | -0.4 | [-3.2, +2.4] | **fail** (wide CI) |
| cleanStaleR5 | 0.116 | 0.072 | -4.4 | [-6.3, -2.6] | **fail** |
| cleanTrapR5 | 0.757 | 0.787 | +3.0 | [-0.3, +6.2] | pass |
| superseded s\* | | | 70.8% | [61.9, 80.8] | pass (above 7.1%) |
| demoted s\* | | | 100.0% | [0.0, 100.0] | **fail** (lower bound below 1.4%) |

Reported: MRR +5.4 [+4.2, +6.7]; stale intrusion -5.0 [-6.8, -3.2]; contradiction intrusion +9.5 [+6.3, +13.0]; trap persistence 0.0 in both arms. Alive: 4,125 of 6,000 final-epoch probes rank the current version differently (68.8%).

### G1b, E1 lifecycle, half-life 35, seeds 161 to 180, 10,000 draws

| Measure | A | B | Benefit (pp) | 95% CI | Verdict |
|---|---|---|---|---|---|
| currentR5 | 0.528 | 0.779 | +25.1 | [+23.2, +27.0] | pass, HELPS |
| hotR5 | 0.691 | 0.777 | +8.6 | [+5.7, +11.7] | pass, HELPS |
| cleanStaleR5 | 0.204 | 0.072 | -13.2 | [-15.4, -11.0] | **fail** |
| cleanTrapR5 | 0.530 | 0.787 | +25.7 | [+21.3, +30.1] | pass, HELPS |
| superseded s\* | | | 74.8% | [71.6, 78.1] | pass |
| demoted s\* | | | 100.0% | [100.0, 100.0] | pass |

Reported: MRR +13.8 [+12.4, +15.2]; stale intrusion -25.2 [-27.8, -22.5]; contradiction intrusion +18.7 [+13.7, +24.0]. Alive: 4,367 of 6,000 (72.8%). B's numbers are the same at both half-lives: its rank reads no decay.

### G2, LoCoMo retrieval, 1,531 questions with evidence, 4,000 paired draws

| Cutoff | A | B | B minus A (pp) | 95% CI | Verdict |
|---|---|---|---|---|---|
| top 10 | 52.1 | 53.0 | +0.9 | [+0.0, +1.9] | pass |
| top 50 | 68.1 | 69.3 | +1.2 | [+0.5, +1.9] | pass |

Temporal (320 questions): +0.6 [-1.2, +2.4] at top 10, +0.3 [-1.0, +1.5] at top 50. Alive: all 1,540 top-10 lists differ by text; 55 have the same set in another order. The sessions span months, so the recency factor moves nearly every list.

### G3, LongMemEval-S retrieval, 479 questions with evidence, 4,000 paired draws

| Cutoff | A | B | B minus A (pp) | 95% CI | Verdict |
|---|---|---|---|---|---|
| top 10 | 82.8 | 83.0 | +0.2 | [-0.5, +0.9] | pass |
| top 50 | 94.4 | 94.2 | -0.3 | [-0.8, +0.2] | pass |

Knowledge-update (72): +2.1 [+0.0, +4.9] at top 10, +0.0 at top 50. Temporal-reasoning (132): +0.0 [-2.3, +2.3] at top 10, -1.0 [-2.8, +0.0] at top 50. Alive: 344 of 500 top-10 lists differ (68.8%).

### Explain probe

One temp store with an 89-day-old memory. A prints `recency: x0.810 (age=89d)`. B prints `age: 89d (not ranked)`, and its JSON breakdown gives `recencyMultiplier: 1`. Pass in intent; see Deviations 2.

## Reported, not gated

**R1, DolphinBench replay on the built code** (`dolph_ablate.mjs` default variant, scored by `dolph_replay_score.py`):

| Replay | Evidence recall | Any source shown | Same list as v3full |
|---|---|---|---|
| A, default | 38.3% | 42.8% | 100.0% |
| A, `neither` variant | 53.7% | 59.1% | 0.7% |
| B, default | 53.7% | 59.1% | 0.7% |

A's default replay reproduces the v3full lists on every test, so the replay has not drifted. A to B: 104 tests gain a source session and 9 lose one (`dolph_flip.py`). `dolph_loss_class.py` puts all 9 lost tests in its single-session class: each needs a fact with one source session, so none is a fact that changed. B and A's `neither` variant give the same evidence on all 580 tests. Plain BM25 order scored 54.2% in the start finding, so B still trails it by 0.5 pp.

**R2, sleep on long histories.** Clock at each persona's test date, production strength model, threshold 0.05:

| Persona | Dormant entries | Gold sessions with a dormant entry |
|---|---|---|
| morgan | 0 of 3,400 | 0 of 216 |
| alex | 487 of 5,011 | 48 of 168 |
| riley | 582 of 5,128 | 59 of 192 |

B's replay with those entries removed: evidence recall 42.8%, any source shown 46.7%. Sleep decay alone costs 10.9 pp of B's gain.

**O1, DolphinBench agent rerun:** not run. B does not merge, and Claude answers wait for 18 Nov.

## Deviations

1. **s\* orientation.** `compare.mjs` computes s\* as the share below which the first arm wins, and it assumes the first arm wins on the probes outside the exposed share. With A first it printed 0.0% [0.0, 0.0] for superseded and 0.0% [0.0, 4.8] for demoted. The prereg asks for B's break-even, so the table reads `compare.mjs` with B as `--a` (`g1-sstar-swapped.txt`, `g1b-sstar-swapped.txt`). Both outputs are kept. The choice changes the superseded s\* verdict at half-life 365; it changes no overall verdict, because cleanStaleR5 fails in both guards.
2. **Explain text.** The prereg expected B to print `recency x1.000`. B prints an age line marked "not ranked" instead; the JSON value is 1. The probe memory was 89 days old, not 90.
3. **Amendment.** The three points of the dated amendment hold as written. None changes a guard, metric or rule.

## Exploration after the verdict (not registered)

Seeds 161 to 165, which G1 already used, so this only picks the next registration. Each candidate wraps B's `hybridSearch` in `rank-plan/explore/wrap.mjs`; an unwrapped copy reproduces E1-B on all 300 probes of seed 161.

| Candidate, half-life 365 | currentR5 | A | Candidate minus A (pp) | cleanStaleR5 | A |
|---|---|---|---|---|---|
| `newestOnTopicFirst` by position | 0.567 | 0.755 | -18.9 | 0.155 | 0.115 |
| halve trust per newer near-duplicate, Jaccard 0.4 | 0.268 | 0.755 | -48.7 | 0.202 | 0.115 |
| the same, Jaccard 0.5 | 0.343 | 0.755 | -41.2 | 0.148 | 0.115 |

At half-life 35, newest-first beats A on currentR5 by 3.5 pp [-0.1, +7.2] but loses hotR5 by 15.4 pp; both halving rules lose currentR5 by 18.9 to 26.4 pp. The reason: E1's distractors include newer rows that paraphrase an old version or copy the form of a value claim. A rule that prefers the newer of two near-duplicates promotes those rows above the current version. A time-only rule among near-duplicates does not work.

**C1: decay off, 30-day recency kept** (`explore/recency/`, compared with C1 as `--a`, `rank-plan/c1-explore-compare.txt`):

| Measure | C1, hl 35 | A, hl 35 | C1 minus A (pp) | C1, hl 365 | A, hl 365 | C1 minus A (pp) |
|---|---|---|---|---|---|---|
| currentR5 | 0.763 | 0.532 | +23.1 [+19.8, +26.5] | 0.763 | 0.755 | +0.8 [-0.3, +1.9] |
| hotR5 | 0.767 | 0.707 | +6.1 [+1.7, +10.5] | 0.767 | 0.769 | -0.2 [-1.4, +1.0] |
| cleanStaleR5 | 0.105 | 0.197 | -9.2 [-13.2, -5.0] | 0.105 | 0.115 | -1.0 [-2.7, +0.5] |
| cleanTrapR5 | 0.796 | 0.560 | +23.6 [+14.2, +32.9] | 0.796 | 0.787 | +0.9 [-2.7, +4.9] |
| superseded s\* | | | 74.7% [64.5, 85.7] | | | 50.0% [0.0, 100.0] |

C1 keeps B's gains at depth with a smaller stale-version loss (-9.2 pp on seeds 161 to 165; B lost 13.2 pp on seeds 161 to 180 at half-life 35), and it is level with A at half-life 365. C1's numbers are the same at both half-lives: its rank reads no half-life. At half-life 365 neither measure moves, so s\* has no defined value and its interval spans 0 to 100%.

## Next route

The changing-facts failure needs a signal that links an old version to its replacement when the new one is written. Today sleep marks a conflict only with a polarity signal (`src/domain/consolidate/conflicts.ts`), so a plain value update ("X is A", then "X is B") is never marked stale. B already demotes a stale or superseded row, so a write-time update link would give B the signal that age gave A. That arm needs its own plan and registration on fresh E1 seeds 181 to 200. Sleep decay (R2) is a second, separate harm.

The next arm is D: C1's rank, a stale mark that counts as one wrong mark, and a sleep pass that links an old fact to the newer memory that changed one span of it. It is registered in `2026-11-16-changed-facts-prereg.md`.
