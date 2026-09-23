# 2026-09-23 mechanism audit: result

**Status:** RESULT, 2026-09-23, revised after the independent critique at the bottom of this file. Nothing here changes a default. Every proposal at the end waits for Keith's sign-off at the gate.

**Code under test:** product source at `6ce7e4d`, harness at `99d6424`, plan locked at `37191e9` (`git diff 6ce7e4d 37191e9 -- src` is empty). One `dist/` build served every run. A fresh compile of `6ce7e4d`'s `src/` with the same TypeScript 5.9.3 emits 476 files, all byte-identical to that build. The verdicts are for this code. Release 1.45.0 (`d5ba969`) has since changed 19 files under `src/`, so a re-run on release code is in NOT-DONE.

**Cost:** local CPU only. E1 makes no model call (`scripts/e1-lifecycle/run.mjs:33-35`). The LongMemEval build unsets every paid key (`benchmarks/longmemeval/build_mech_stores.sh:8`) and embeds with the local MiniLM model.

**Files:** the plan is `2026-09-23-mechanism-audit-prereg.md`. Raw outputs, copied by script, are in `2026-09-23-mechanism-audit-raw.txt`. The gate check is `scripts/e1-lifecycle/gates.mjs`; the LongMemEval scoring diagnostic is `benchmarks/longmemeval/merge_audit.mjs`; the critique's split of E1 by memory dating is `scripts/e1-lifecycle/strata.mjs`.

## Headline

Bad news first.

1. **On E1, the 7-day default loses to plain BM25 by 48 points.** With the full lifecycle at 7 days, E1 finds the current fact in the top five 29.2% of the time. BM25 alone finds it 77.6% of the time: -48.4 pp [-50.1, -46.5]. It loses both on facts that never changed (17.9% vs 76.8%) and on facts that did (46.3% vs 78.8%).
2. **365 days fixes most of that.** Overall it trails BM25 on the current fact by 2.9 pp [-4.3, -1.4], 74.7% vs 77.6%. That gap is a blend: -9.3 pp on facts that never changed and +6.8 on facts that did, and the way E1 dates its lookalike memories sets the size of both (Baselines). What the lifecycle clearly buys over BM25 is trap suppression: a memory marked bad stays in the top five 25.7% of the time, against 73.9% under BM25. It also lets in contradictions that BM25 never ranks: 6.5% vs 0.0%.
3. **On E1's dating, hippo's ranking with every mechanism off loses 18.9 pp to BM25 on facts that never changed, and gains 7.4 on facts that did** (undeclared diagnostic). The net is -8.4 pp [-9.9, -6.9], because six probes in ten ask about a fact that never changed. Both arms hold the same store; only the probe's ordering differs. The loss grows with the number of lookalikes dated after the fact, which fits the composite's recency factor. It is not isolated.
4. **The physics scorer hurts**: -22.2 pp hit@5 on the slept LongMemEval store, and -19.6 pp on the never-slept store, where every memory has a particle. Physics is auto-on and shapes every default MCP recall (prereg, Source-read). Why it hurts is open. In a store that has never slept every particle is at rest, so physics ranks, in effect, by embedding similarity, while hybrid also scores BM25 over the whole text. The median LongMemEval session runs 2306 words and the embedder truncates long input, so these lanes may measure cosine against BM25 on long text more than physics itself (critique, finding 3).
5. **Sleep's merge and dedup, on a fresh store, fall below the floor.** hit@5 +2.6 pp [1.0, 4.4] under the declared scorer: the interval excludes 0, but the point estimate misses the 3 pp floor, so by the rule sleep does not help. 14 of its 15 slept-only hits come from merged memories that inherit every source session's tag. An undeclared stricter scorer, which credits a memory only for session text it holds, reads +0.4 pp [-0.4, 1.2]. Sleep deleted nothing here (`lme-full/sleep.log:5`) and E1 never sleeps, so sleep's decay deletion was tested nowhere.
6. **On E1, outcome feedback, retrieval strengthening, the 365-day default and the whole lifecycle each help**, by the declared rule, at 95% and at 99%. The sizes are E1's best case: every outcome mark is right, and every scheduled recall repeats the probe's query (critique, finding 5).

## Verdicts

The rule, as locked. Benefit points the good way: A minus B for currentR5, hotR5 and hit@k; B minus A for trap persistence, stale intrusion and contradiction intrusion. Helps: the 95% CI lower bound is above 0 and the point estimate is at least +3 pp. Hurts: the 95% CI upper bound is below 0 and the point estimate is at most -3 pp. Anything else is no measurable effect, and a tie goes to the mechanism off.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

Two notes on the rule, both from the critique. First, the 3 pp floor applies to the point estimate, not to the interval, so a pass does not prove a 3 pp effect, and the prereg's "a pass is an effect a user could notice" claims too much. Every decisive 95% bound here does clear 3 pp (smallest: L2g, 4.3). Second, the rule names its third category "no measurable effect", which misdescribes L4: its 95% interval excludes 0, and only its point estimate misses the floor. This file calls that verdict BELOW THE FLOOR. The verdict itself is unchanged: sleep does not help, and the tie goes to the mechanism off.

| Lane | A vs B | Primary | Benefit, pp | 95% CI | 99% CI | Verdict |
|---|---|---|---|---|---|---|
| L1 | physics vs hybrid, slept store | hit@5 | -22.2 | [-26.6, -17.8] | [-27.8, -16.6] | HURTS |
| L1n | physics vs hybrid, never-slept store | hit@5 | -19.6 | [-23.6, -15.6] | [-25.0, -14.4] | HURTS |
| L2 | full@365 vs full@7 | currentR5 | +45.5 | [43.9, 47.1] | [43.3, 47.6] | HELPS, both guards pass |
| L2g | full@365 vs all-off | currentR5 | +5.5 | [4.3, 6.7] | [3.9, 7.1] | HELPS |
| L3a, verdict row | full@365 vs outcome-off@365 | trap persistence | +51.0 | [46.3, 55.6] | [44.7, 57.0] | HELPS |
| L3a | full@7 vs outcome-off@7 | trap persistence | +22.3 | [18.4, 26.2] | [17.4, 27.4] | HELPS |
| L3b, verdict row | full@365 vs strengthen-off@365 | hotR5 | +7.3 | [5.3, 9.4] | [4.6, 10.1] | HELPS |
| L3b | full@7 vs strengthen-off@7 | hotR5 | +27.7 | [24.9, 30.5] | [24.0, 31.5] | HELPS |
| L4 | slept vs never-slept, hybrid | hit@5 | +2.6 | [1.0, 4.4] | [0.6, 4.8] | BELOW THE FLOOR |

- Six lanes help, two hurt, and one (L4) falls below the floor. All eight decisive verdicts also clear the 99% interval.
- The L3a and L3b verdict rows are at 365 days because L2 passed with both guards (prereg, Mechanism claims).
- all-off runs once, at 7 days, as declared. With decay off, the half-life never enters strength (`src/memory.ts:361` at `6ce7e4d`).
- **Ledger:** N = 9 verdict lanes. Expected false passes: 0.45 at 95%, 0.09 at 99%. No joint bootstrap was run (NOT-DONE).

## Gates, guards and integrity

| Check | Needs | Result |
|---|---|---|
| E1 runs | 20 of 20 seeds per arm | 180 run files: 120 at 7 days (6 arms), 60 at 365 days (3 arms) |
| `compare.mjs` integrity | no throw | all 11 compares completed. The script throws on missing probe rows, a protocol-hash mismatch, unequal or misaligned probe rows, or rows that disagree with the stored aggregate (`compare.mjs:40`, `:80`, `:89`, `:92`, `:99`) |
| L2 gate: full@7 currentR5 below all-off | 18 of 20 seeds | 20 of 20 |
| L3a gate: outcome-off trap persistence at least 0.20 | 18 of 20 at each half-life | 20 of 20 at 7 (min 0.267); 20 of 20 at 365 (min 0.689) |
| L3b gate: strengthen-off hotR5 at most 0.90 | 18 of 20 at each half-life | 20 of 20 at 7 (max 0.215); 20 of 20 at 365 (max 0.750) |
| LongMemEval build aborts | neither fires | neither fired; exit 0 in 4012 s |
| Headroom rule | never-slept hybrid hit@5 above 90 switches the primary to hit@1 | 75.0, so hit@5 stays primary |

**L2 guards.** A guard passes when the 95% lower bound of the break-even exposed share s* is above the real-use share from the dogfood store. 365 days wins below s*.

| Intruder | s*, point [95%] [99%] | Real-use share (the guard) | Pass |
|---|---|---|---|
| Superseded | 79.8% [76.5, 83.3] [75.5, 84.5] | 7.1% (150 of 2119) | yes, also at 99% |
| Marked bad | 100% [100, 100] [100, 100] | 1.4% (29 of 2119) | yes, also at 99% |

On queries exposed to a superseded version, 365 days does worse: cleanStaleR5 -12.6 pp [-15.2, -9.9]. On the rest it does far better: nonStaleR5 +49.6 [47.5, 51.7]. So 365 loses only when about four in five queries face a superseded intruder. On queries exposed to a marked-bad memory it also does better (cleanTrapR5 +32.7), so its s* is 100%.

## E1 levels

Final epoch, seeds 21 to 40, as `compare.mjs` prints them. Rates are shares of probes. Higher is better for every column except stale, trap and contra.

| Arm | currentR5 | mrr | stale | trap | contra | hotR5 | cleanStaleR5 | nonStaleR5 | cleanTrapR5 | nonTrapR5 |
|---|---|---|---|---|---|---|---|---|---|---|
| full@365 | .747 | .364 | .876 | .257 | .065 | .770 | .113 | .675 | .549 | .754 |
| full@7 | .292 | .178 | .418 | .171 | .130 | .423 | .239 | .179 | .222 | .296 |
| all-off | .692 | .316 | .833 | .774 | .047 | .707 | .153 | .579 | .157 | .709 |
| outcome-off@365 | .687 | .314 | .822 | .767 | .065 | .716 | .162 | .573 | .151 | .705 |
| outcome-off@7 | .256 | .149 | .383 | .394 | .135 | .363 | .256 | .112 | .141 | .258 |
| strengthen-off@365 | .681 | .320 | .825 | .309 | .142 | .697 | .153 | .564 | .458 | .688 |
| strengthen-off@7 | .154 | .076 | .318 | .158 | .157 | .146 | .209 | .029 | .133 | .154 |
| bm25-static | .776 | .400 | .904 | .739 | .000 | .773 | .089 | .768 | .214 | .789 |
| recency-window | .000 | .000 | .004 | .002 | .000 | .000 | .000 | .000 | .001 | .000 |

Stale intrusion counts any older version anywhere in the top five, so a top five that holds both versions counts as intruded. That is why every arm without strong decay sits above 0.8. cleanStaleR5 (current in, no older version in) is the sharper measure.

## E1 paired differences, every metric

A minus B in pp with the 95% CI, exactly as in the raw file. The "better when" column gives the good sign for each row.

| Metric | Better when | L2 | L2g | L3a@365 | L3a@7 | L3b@365 | L3b@7 |
|---|---|---|---|---|---|---|---|
| currentR5 | + | +45.5 [43.9, 47.1] | +5.5 [4.3, 6.7] | +6.0 [5.1, 6.9] | +3.7 [2.9, 4.5] | +6.7 [5.5, 7.8] | +13.8 [12.4, 15.2] |
| mrr | + | +18.6 [17.7, 19.5] | +4.8 [4.2, 5.5] | +5.0 [4.5, 5.6] | +2.9 [2.4, 3.5] | +4.4 [3.9, 4.9] | +10.2 [9.2, 11.2] |
| stale | - | +45.8 [43.0, 48.7] | +4.3 [2.5, 6.0] | +5.4 [4.1, 6.9] | +3.5 [2.3, 4.8] | +5.1 [3.7, 6.5] | +10.0 [7.5, 12.5] |
| trap | - | +8.6 [5.4, 11.7] | -51.8 [-56.6, -46.8] | -51.0 [-55.6, -46.3] | -22.3 [-26.2, -18.4] | -5.2 [-7.4, -3.0] | +1.3 [-0.6, 3.2] |
| contra | - | -6.5 [-9.7, -3.5] | +1.8 [0.3, 3.7] | -0.0 [-0.7, 0.7] | -0.5 [-1.7, 0.3] | -7.7 [-10.7, -4.8] | -2.7 [-5.0, -0.5] |
| hotR5 | + | +34.7 [31.9, 37.6] | +6.3 [4.5, 8.2] | +5.4 [3.8, 7.0] | +5.9 [4.3, 7.7] | +7.3 [5.3, 9.4] | +27.7 [24.9, 30.5] |
| cleanStaleR5 | + | -12.6 [-15.2, -9.9] | -4.0 [-5.7, -2.4] | -4.9 [-6.4, -3.6] | -1.7 [-2.8, -0.8] | -4.0 [-5.5, -2.6] | +3.0 [0.6, 5.4] |
| nonStaleR5 | + | +49.6 [47.5, 51.7] | +9.6 [7.7, 11.4] | +10.2 [8.9, 11.4] | +6.7 [5.5, 7.9] | +11.1 [9.4, 12.8] | +14.9 [13.0, 16.8] |
| cleanTrapR5 | + | +32.7 [28.4, 36.9] | +39.2 [34.4, 44.0] | +39.8 [35.3, 44.3] | +8.1 [5.4, 11.1] | +9.1 [6.1, 12.4] | +8.9 [5.9, 11.9] |
| nonTrapR5 | + | +45.7 [44.0, 47.5] | +4.5 [3.3, 5.7] | +4.8 [4.0, 5.7] | +3.8 [2.9, 4.7] | +6.6 [5.2, 7.9] | +14.3 [12.7, 15.9] |

What moved the wrong way with its 95% CI clear of 0:

- **Every lane raises stale intrusion**, by 3.5 to 45.8 pp, and cleanStaleR5 falls in every lane but L3b@7. See anomaly 1.
- L2 raises trap persistence by 8.6 pp: a longer half-life keeps marked-bad memories around longer. The guard above covers it.
- L2g raises contradiction intrusion by 1.8 pp [0.3, 3.7]; its 99% CI [-0.0, 4.3] touches 0.

Three secondary intervals cross 0 at 99% although they clear it at 95%: L2g contra [-0.0, 4.3], L3b@7 contra [-5.8, 0.2] and L3b@7 cleanStaleR5 [-0.2, 6.1]. Treat them as flags, not findings.

## Baselines

Each E1 verdict arm beside the two naive strategies, A minus B in pp. bm25-static ranks by the raw BM25 part of the score with the lifecycle off; recency-window returns the five newest memories whatever the query (`run.mjs:110-111`), so it is a query-blind floor.

| A vs B | currentR5 | trap (better when -) | contra (better when -) | hotR5 |
|---|---|---|---|---|
| full@365 vs bm25-static | -2.9 [-4.3, -1.4] | -48.2 [-53.2, -43.0] | +6.5 [4.0, 9.3] | -0.3 [-3.1, 2.6] |
| full@7 vs bm25-static | -48.4 [-50.1, -46.5] | -56.8 [-62.1, -51.3] | +13.0 [9.3, 16.8] | -35.0 [-38.6, -31.6] |
| full@365 vs recency-window | +74.7 [73.2, 76.1] | +25.4 [21.3, 29.7] | +6.5 [4.0, 9.3] | +77.0 [74.6, 79.4] |
| full@7 vs recency-window | +29.2 [27.7, 30.8] | +16.9 [13.2, 21.1] | +13.0 [9.3, 16.8] | +42.3 [39.5, 45.0] |
| all-off vs bm25-static (diagnostic, undeclared) | -8.4 [-9.9, -6.9] | +3.6 [-0.0, 7.2] | +4.7 [2.5, 7.2] | -6.5 [-9.2, -3.7] |

- recency-window ignores the query, so it almost never finds the current fact. It is a floor, not a competitor.
- bm25-static is the real competitor. Against it, on E1's dating, the 365-day lifecycle gives up 2.9 pp of currentR5 overall for 48.2 pp less trap persistence, at 6.5 pp more contradiction intrusion. The currentR5 gap depends on how lookalikes are dated (next section).
- The diagnostic row holds two arms with identical flags and an identical store (`run.mjs:61-69`). all-off takes `hybridSearch`'s composite order; bm25-static re-sorts the same candidates by raw BM25 and breaks ties by entry id (`run.mjs:113-121`). Its cleanStaleR5 is +6.4 [4.2, 8.5] and its nonStaleR5 is -18.9 [-20.7, -17.1]. That split fits a recency factor that favours newer memories: it helps when the newer memory is the current version and hurts when the newer memory is a distractor.

### How E1's dating shapes the gap to BM25 (diagnostic, undeclared)

From the critique. `strata.mjs` joins each final-epoch probe with its regenerated protocol (all 80 protocol hashes match) and counts, for each fact, the lookalikes: memories that share its sentence template with another value, dated after its current version. v1 of a fact lands in sessions 0 to 11 (`generate.mjs:152`) and its lookalikes anywhere in sessions 0 to 19 (`:248`, `:275`), so most lookalikes are newer than the fact they imitate. currentR5, final epoch, seeds 21 to 40:

| Facts | Newer lookalikes | n | all-off | full@365 | full@7 | bm25-static |
|---|---|---|---|---|---|---|
| never changed | 0 | 77 | .740 | .857 | .325 | .727 |
| never changed | 1 | 404 | .698 | .797 | .295 | .745 |
| never changed | 2 | 801 | .687 | .754 | .253 | .775 |
| never changed | 3 | 1035 | .596 | .681 | .180 | .767 |
| never changed | 4 | 1013 | .494 | .594 | .094 | .785 |
| never changed | 5 or more | 270 | .293 | .481 | .056 | .730 |
| never changed | all | 3600 | .579 | .675 | .179 | .768 |
| updated | 0 | 1245 | .935 | .934 | .640 | .790 |
| updated | 1 | 763 | .826 | .819 | .334 | .789 |
| updated | 2 | 340 | .718 | .709 | .159 | .797 |
| updated | 3 | 50 | .600 | .500 | .100 | .680 |
| updated | 4 | 2 | .000 | .000 | .000 | .500 |
| updated | all | 2400 | .862 | .856 | .463 | .788 |

- BM25 stays roughly flat as newer lookalikes pile up, and every lifecycle arm falls. On facts that never changed, all-off's gap to BM25 runs from +1.3 pp with none newer to -43.7 with five or more. That fits a ranking that favours newer memories: the recency factor in all-off, and decay as well in the full arms.
- So the overall -8.4 (all-off) and -2.9 (full@365) are blends of a loss on facts that never changed (-18.9, -9.3) and a gain on facts that did (+7.4, +6.8). The generator's dating sets the size of both, so neither overall number is a property of hippo alone.
- L2 holds in every group: on facts that never changed, full@365 beats full@7 by 42.5 to 53.2 pp.
- L2g does not track the dating cost. From one to four newer lookalikes, all-off's gap to BM25 grows from 4.7 to 29.1 pp while L2g's gain stays between 6.7 and 10.0. On updated facts L2g is flat: .856 against .862.
- These are hit rates without paired intervals. The "all" row for facts that never changed equals nonStaleR5 in the E1 levels table.

## LongMemEval lanes

The store pools all 500 oracle questions: 940 unique sessions, one memory each. Sleep leaves 848 memories, 124 of them new semantic memories merged from episodic ones. Percent of 500 questions; A-only and B-only count the questions only one arm hits.

| Lane | hit@1 | hit@5 (primary) | hit@10 |
|---|---|---|---|
| L1 physics vs hybrid, slept | 15.0 vs 53.4: -38.4 [-43.6, -33.2] | 55.4 vs 77.6: -22.2 [-26.6, -17.8]; A-only 20, B-only 131 | 67.2 vs 84.0: -16.8 [-21.0, -12.6] |
| L1n physics vs hybrid, never slept | 29.6 vs 49.2: -19.6 [-23.6, -15.4] | 55.4 vs 75.0: -19.6 [-23.6, -15.6]; A-only 13, B-only 111 | 66.0 vs 82.4: -16.4 [-20.2, -12.8] |
| L4 slept vs never slept, hybrid | 53.4 vs 49.2: +4.2 [2.4, 6.2] | 77.6 vs 75.0: +2.6 [1.0, 4.4]; A-only 15, B-only 2 | 84.0 vs 82.4: +1.6 [0.0, 3.2] |

Top-five lists differ on all 500 questions in L1 and L1n, and on 297 (59.4%) in L4. L4's hit@1 would clear the helps bar, but hit@5 is the declared primary, and hit@1 shrinks to +0.4 under the text rule below.

### What the scorer credits sleep for (diagnostic, undeclared)

`merge_audit.mjs` reads both stores and the four retrieval files:

- **Merged rows carry many sessions.** All 124 merged memories are tagged with more than one session; 112 carry sessions of more than one question.
- **The tags outrun the text.** 140 session tags on merged memories lack that session's `[Session: ...]` header. For 96 of them the session's text is in the memory. For 44 it is only elsewhere in the slept store. None is missing.
- **The hit rule credits a memory for any tag** (`paired_hits.mjs:29-32`, the same rule as `check_session_hit`). So a merged memory scores a hit for all its source sessions, including the 44 whose text it does not hold.
- **L4's gain rides on that credit.** 15 questions hit at 5 only when slept; in 14 of them a merged memory is the only hit.
- **Merged memories have no particle.** The slept store has 124 memories without one, all 124 merged; the never-slept store has none. This is the merge bug the dry run found (prereg, Dry-runs), at full scale.
- **Physics puts them on top.** Merged memories are 124 of 848 (14.6%) of the slept store. They take 2852 of the 5000 top-10 slots under physics, against 781 under hybrid. Every retrieved id is in its store: 0 missing in all four files.

The same retrieval files, re-scored under two stricter rules. The header rule credits a memory only for sessions whose header it carries. The text rule also credits an 80-character snippet from the middle of the session's never-slept memory.

| Rule | L1 hit@5 | L1n hit@5 | L4 hit@5 |
|---|---|---|---|
| Declared: tag or header | -22.2 [-26.6, -17.8] | -19.6 [-23.6, -15.6] | +2.6 [1.0, 4.4] |
| Header only | -23.6 [-28.0, -19.2] | -19.4 [-23.4, -15.4] | -3.4 [-5.6, -1.2] |
| Header or text | -23.0 [-27.4, -18.6] | -21.2 [-25.2, -17.2] | +0.4 [-0.4, 1.2] |

- L1 and L1n hurt under every rule.
- L4 swings with the rule. The header rule reads it as harm, but it misses the 96 tags whose text a merged memory holds without the header, so it is biased against sleep. The text rule credits what a memory actually holds, and reads +0.4 [-0.4, 1.2]. No rule reaches the +3 pp floor, so the declared verdict stands.
- The text rule also lifts never-slept hybrid from 75.0 to 77.2, because some sessions share text. Both arms get that lift.
- Every rule here also matches tags by substring (`paired_hits.mjs:29-32`, as `evaluate_retrieval.py:62` does), so a memory tagged `answer_c6fd8ebd_abs` counts as a hit for `answer_c6fd8ebd`. The pooled store holds six such id pairs. Both arms share the rule, so it favours neither by design; the fix is an exact tag match (critique, finding 6).

## Anomalies

Each has a suspected cause. None is isolated.

1. **Every mechanism raises stale intrusion.** At 365 days: L2g +4.3, L3a +5.4, L3b +5.1. At 7 days: L3a +3.5, L3b +10.0. E1 never writes `superseded_by` (prereg, NOT-DONE), so only ranking can push an old version out. Suspected cause: credit earned while a version was current outlives it. 30% of facts' v1 gets a good outcome (`generate.mjs:228-233`), and scheduled recalls strengthen whatever they retrieve (`generate.mjs:219-226`). L2's +45.8 is different: it is decay removing old versions at 7 days.
2. **Contradictions never reach the top five under either baseline (0.000), but do under every lifecycle arm**: all-off .047, full@365 .065, full@7 .130. Contradictions arrive later and carry extra words ("Heard in passing that ...", `generate.mjs:186-198`), so BM25 ranks them lower. Suspected cause: the recency factor lifts them because they are newer.
3. **L4's +2.6 is scorer credit, not recall.** See the section above.
4. **L1's hit@1 harm (-38.4) is twice L1n's (-19.6).** The gap is the merge bug: particle-less merged memories fill 2852 of 5000 physics slots. L1n still hurts at every k, so the merge bug does not explain all the harm. Whether physics still hurts on short memories, or after many sleeps, is untested (critique, finding 3).
5. **Strengthening at 365 lowers contradiction intrusion (-7.7) and trap persistence (-5.2).** A good-direction side effect: recalls strengthen the fact's own memories, which then outrank the intruders.
6. **With the lifecycle off, the composite loses 18.9 pp to BM25 on facts that never changed and gains 7.4 on facts that did.** The loss tracks how many lookalikes are dated after the fact (Baselines). A recency-off lane would isolate the recency factor, and a lane with lookalikes dated inside v1's window would test the dating (both NOT-DONE).

## Provenance

- `6ce7e4d` was committed 10:57:50Z, `99d6424` (harness) 11:35:27Z, and `37191e9` (the lock) 12:25:02Z. `git diff 6ce7e4d 37191e9 -- src` is empty.
- The tested `dist/` was built 11:35:43Z to 11:35:44Z. Every file a fresh compile of `6ce7e4d`'s `src/` emits (476) is byte-identical to it.
- The 180 E1 run files were written 12:29:31Z to 14:04:24Z, all after the lock.
- LongMemEval: the wrapper that points ingest at this checkout's `bin/hippo.js` (`build_mech_stores.sh:12-15`) was written 12:25:39Z, after the lock. The store databases were last written 13:24:16Z and the retrieval files 13:26:43Z to 13:32:31Z. Later `-wal` and `-shm` files come from read-only opens.
- `lme-full/sleep/hippo.db` holds 0 memories. It is the empty global store that `hip()` creates by setting `HIPPO_HOME` to the store directory (`build_mech_stores.sh:17`).
- The harness files the lanes use are unchanged since the lock. Between `37191e9` and `d5ba969`, only three other LongMemEval scripts changed under `scripts/e1-lifecycle/` and `benchmarks/longmemeval/`.

## Retraction check

All five conditions are clean.

1. A `compare.mjs` integrity check fails: none did; all 11 compares completed.
2. A lane ran on other code: none did (Provenance).
3. The June-to-today drift comes from the harness: P0 showed the harness edits only add fields, and the committed and edited `run.mjs` give identical aggregates.
4. A LongMemEval build abort fires: neither did.
5. A default changes before the critique: none changed.

## Caution flags

From the prereg, still true:

- E1 is synthetic: generated facts, versions, traps and schedules.
- The author built, ran and judged this. The independent critique is below.
- The decision rule was written after seeing June's descriptives, and the guard form after the seed-1 peek.
- LongMemEval is static, so decay and strengthening never act there.
- The dogfood store decays on an adaptive basis; E1 decays by days. Recall ranking itself uses the clock: `hybridSearch` calls `calculateStrength` with no options (`src/search.ts:574` at `6ce7e4d`), and only sleep passes the configured basis (`src/consolidate.ts:158`).
- The embedder is an optional peer dependency; the build installs it and aborts unless every memory is embedded.

New:

- **Memory ages set the size of every decay effect.** E1 runs 20 sessions a week apart (`generate.mjs:103-106`), so a memory is at most 19 weeks old at the final probe. A store whose recalls mostly hit memories days old would shrink L2's gap; year-old memories would widen it.
- **E1 has no embedding blend** (`run.mjs:33-35`). The product's hybrid recall mixes in cosine similarity, which may change every E1 number.
- **E1 is a best case for outcome feedback and strengthening.** Traps are marked bad and nothing else is. Two bad marks cut a score by about 11% (`src/search.ts:612`), which is enough in E1 because each trap competes with near-identical rivals; a bad memory that leads its rivals by more would not move. Every scheduled recall repeats the probe's exact query (`generate.mjs:221-225`), so strengthening boosts the same top five the probe later reads. L3a and L3b are E1's best case, not bounds on real use (critique, finding 5).
- **Lookalike dating drives every comparison with BM25.** At least 10 hard negatives per fact (`generate.mjs:96`), most of them dated after the fact they imitate. On facts that never changed, the composite's gap to BM25 swings from +1.3 to -43.7 pp with that dating (Baselines).
- **The 3 pp floor applies to the point estimate.** A pass shows a point estimate a user could notice, not a proven 3 pp effect (Verdicts).
- **Sleep's decay deletion is untested.** The LongMemEval store was freshly built, so sleep deleted nothing, and E1 never sleeps (`run.mjs:33`).
- **The physics lanes may measure cosine against BM25.** On a never-slept store physics ranks, in effect, by embedding similarity, and the embedder truncates LongMemEval's long sessions (Headline 4).
- **The pooled LongMemEval store is not comparable** with any per-question LongMemEval figure elsewhere in the docs.
- **The LongMemEval hit rule credits merged memories for every source tag, and matches tags by substring.** L4's declared number carries the first bias; both arms share the second.
- **The diagnostics are undeclared.** all-off vs bm25-static and the header and text rules cannot flip a verdict.
- **Runs overlapped.** The E1 batch and the LongMemEval build ran at the same time (Provenance). Every E1 probe carries an explicit clock (`run.mjs:96`, `:113`), so the overlap changes E1's timing only. The one global store the LongMemEval build created holds 0 memories (Provenance).
- **The verdicts are for `6ce7e4d`.**

## Coverage interrogation

| # | Question | Answer | Pointer |
|---|---|---|---|
| 1 | What have you tried? | Nine verdict lanes on five mechanisms (physics, decay default, outcome feedback, strengthening, sleep) and the whole lifecycle, two naive baselines on every E1 seed, and two undeclared diagnostics. Ladder below. | Verdicts, Baselines |
| 2 | What features? | Ranking inputs as shipped: BM25; BM25 plus MiniLM cosine (LongMemEval only); strength from decay, recall boost and outcomes; the recency factor; physics particles. | prereg, Source-read |
| 3 | What feature engineering? | None. Each mechanism is tested as shipped, on or off. | prereg, Mechanism claims |
| 4 | What model? | hippo's composite ranking (`src/search.ts:574-593` at `6ce7e4d`), `physicsSearch`, and one `consolidate` pass. | prereg, Source-read |
| 5 | Tuning? | No search. One half-life nominee (365 days) from June's sweep, so k = 1, judged on fresh seeds 21 to 40 at today's code. The recency scale (30 days) and the multiplier weights were never tuned. | prereg, The L2 nominee |
| 6 | Optuna? | Not used; there is no search. | this row |
| 7 | Are the agents detailed enough? | For Keith to grade. | this file, NOT-DONE, ledger line |
| 8 | Full effort to find a suitable model? | For Keith to grade. | same |
| 9 | What is missing? | Five drafts below: three from before the critique and two it added. None runs without a yes. | NOT-DONE |

Answer 9, each with a cost and a draft declaration:

- **INPUT: real recall ages.** Reweight E1 probes by the age of the memories real recalls return, read from the recall traces at the 2026-09-26 re-count. Cost: an afternoon, local. Declaration: the same lanes and rule, with the weights fixed before any re-score.
- **MECHANISM: recency-off, decay-off and BM25 plus outcomes.** One eval-only flag that sets the recency factor to 1, then three arms: full@365 with recency off; decay-off (one arm, since the half-life never enters when decay is off); and BM25 ranking times the outcome factor alone. Cost: about 30 minutes of local CPU plus the flag. Declaration: currentR5 primary, trap persistence secondary, the same rule, 20 fresh seeds (41 to 60).
- **TUNING: a half-life by recency-scale grid.** Half-lives 30, 90, 365 and 730 days by recency scales 7, 30 and 90 days plus no recency: 16 cells. Nominate on seeds 41 to 60; judge the single nominee on seeds 61 to 80. Cost: about 3 hours of local CPU. Declaration: k = 16, and the nominee must beat both full@365 and bm25-static on currentR5 by the rule.
- **INPUT: lookalikes dated inside v1's window** (critique, finding 2). A generator option that dates each fact's lookalikes within the sessions its v1 can occupy, then full@365, all-off and bm25-static on it. Cost: the option plus about 15 minutes of local CPU. Declaration: currentR5 primary, the same rule, 20 fresh seeds; this lane, not the overall -2.9, decides any claim against BM25.
- **MECHANISM: cosine-only and short memories** (critique, finding 3). Re-retrieve the never-slept LongMemEval store with `retrieve_inprocess.mjs --embedding-weight 1 --no-mmr` (no product change), and build a store with one memory per turn instead of per session. Cost: minutes for the first, about an hour of local CPU for the second. Declaration: hit@5 primary, physics against cosine-only on each store; a tie means the physics harm is the missing BM25 term.

The mechanism ladder (Stage 4.1), rung by rung:

| Rung | Status |
|---|---|
| 1 Level before sign | N/A: no forecast target; the endpoints are hit rates |
| 2 Magnitude and distribution | N/A: paired rates with bootstrap intervals; nothing is sized |
| 3 Window and recency | NOT-DONE: the recency factor is untested and the diagnostic points at it. Slot: the recency-off lane above |
| 4 Lag structure of outside data | N/A: no outside series |
| 5 Feature selection | N/A: nothing is fitted |
| 6 Structure before search | N/A: nothing is fitted |
| 7 Hyperparameters | NOT-DONE: k = 1 on the half-life, none on the recency scale. Slot: the grid above |
| 8 Ensembles | N/A: one ranker per arm |
| 9 Late-lane data | N/A: no late series |
| 10 Execution lag and real costs | Partly: the L2 guards use real-use shares. Latency and store size were not measured; at 365 days sleep's decay deletion nearly stops, so store size must be measured before that default ships |

## Self-audit: what else is wrong with what I did

Data

1. E1's schedules (weekly sessions, 30% good outcomes, traps marked twice) are the generator's design, not measured behaviour. Every E1 effect size depends on them.
2. The guard shares come from one dogfood store of 2119 memories. The prereg already notes that 7.1% likely over-counts supersession and 1.4% may under-count bad memories.
3. All 500 LongMemEval questions search one pooled store, and 112 merged memories mix sessions from more than one question, so the questions are not independent draws. The paired bootstrap treats them as independent.

Statistics

4. There is no joint bootstrap over the nine lanes, which share arms. All eight decisive verdicts hold at 99%, where 0.09 false passes are expected, so a StepM run is unlikely to change any of them; it is still not done.
5. The 3 pp floor was written after seeing June's descriptives (prereg, Caution flags). The 18-of-20 gate thresholds are the author's choice.
6. The marked-bad guard passes trivially. 365 days also wins on queries exposed to a marked-bad memory, so s* is pinned at 100% and its interval carries no information about the trade-off.

Code

7. `gates.mjs` and `merge_audit.mjs` were written after the runs. `gates.mjs` recomputes declared gates; `merge_audit.mjs` is labelled diagnostic throughout.
8. The LongMemEval hit rule over-credits merged memories. The rule predates this campaign: `paired_hits.mjs` copies `check_session_hit` from `evaluate_retrieval.py` (`paired_hits.mjs:28`), so earlier sleep numbers scored by it may carry the same bias.
9. The provenance rebuild covers the main compile only. The extensions build writes the OpenClaw plugin into `dist/extensions/` and the benchmarks build writes `dist-bench/`; no lane imports either.

Process

10. The author wrote the plan, ran it and judged it; the critique below is the only outside check.
11. The dist is from before 1.45.0. The verdicts may not transfer to 1.45.0, which changed 19 source files.
12. The anomalies' causes are argued, not measured. Each needs its own lane before it is cited as a cause.
13. The first draft read the overall gaps to BM25 (-8.4, -2.9) as properties of hippo. The critique showed they are blends whose size E1's dating sets; this self-audit missed it.

## NOT-DONE

| Item | Why not now | Slot |
|---|---|---|
| Learned value | Its fitted weights sit on the strength formula that L2 may change | Re-fit after the half-life decision |
| Supersession links | E1 never writes `superseded_by` | Needs a harness that supersedes |
| Goal stack | Its eval tied 20 of 20 | Fix-or-cut call in 1.46.0 |
| Salience gate | Off by default; its harm is recorded | Only if someone proposes turning it on |
| Strengthening on real use | Needs about 90 days of recall traces | Trace re-count on or after 2026-09-26 |
| Outcome feedback on real use | Real outcomes are sparse | Replay on or after 2026-12-23 |
| Physics after many sleeps | One sleep here | After the merge-bug fix |
| Joint bootstrap (StepM) | All decisive verdicts hold at 99% | Next campaign |
| Bisecting the June-to-today drift | No June number enters a verdict | Open |
| Paid legs | Cost money | Only on a priced yes |
| Recency-off lane | Needs an eval-only flag | Answer 9, MECHANISM |
| decay-off arm | Not declared this campaign | Answer 9, MECHANISM |
| BM25 plus outcome feedback | Not declared this campaign | Answer 9, MECHANISM |
| Half-life by recency grid | Not declared this campaign | Answer 9, TUNING |
| Re-run on release code | 1.45.0 shipped after the runs | Before any default changes |
| E1 with the embedding blend | E1 has no embedder | With the re-run |
| A fair LongMemEval hit rule | Found in this campaign | Fix the scorer or give merged memories per-source provenance, then re-score L4 as a declared lane |
| Exact tag match in the hit rule | Substring matching found by the critique; `evaluate_retrieval.py:62` shares it | With the fair hit rule; then check every published LongMemEval number that script scored |
| Lookalikes dated inside v1's window | Found by the critique | Answer 9, second INPUT; before any claim against BM25 |
| Cosine-only lane and a short-memory store | Found by the critique | Answer 9, second MECHANISM; before any claim about why physics hurts |
| Half-life migration plan | Strength reads each memory's stored half-life (`src/memory.ts:332`), so memories stored at 7 days keep 7 | Before the 365 default ships |
| Store size with sleep on at 365 days | Sleep deletes below strength 0.05 (`src/consolidate.ts:39`, `:196`), which is 4.3 half-lives: about 30 days at 7, about 4.3 years at 365 | Before the 365 default ships |
| Sleep's decay deletion | The LongMemEval store was freshly built and E1 never sleeps | A store with real ages |
| BM25 ranked newest first | A sharper recency baseline, suggested by the critique | Next declared campaign |

## Gate questions for Keith

Verbatim from the steering bank:

1. Attack the decision rule, not just the numbers.
2. Tied on WHAT?
3. What market structure could explain or refute this?
4. Is the capacity right for the data frequency?
5. What would make you say no?
6. What is on the accrual list, and when is each re-test?
7. What have you tried, and what is missing that we should try?
8. Which rung of the ladder is still NOT-DONE, and why?

## Proposals for 1.46.0

The prereg's table applied to each verdict, revised after the critique. None ships without Keith's sign-off.

- **Physics (L1, L1n hurt):** `physics.enabled` defaults to false once the 1.45.0 re-run agrees. Whether it should stay off after the merge fix is open: run the cosine-only lane and a short-memory store first.
- **The merge bug:** fixed regardless. Merged memories need particles.
- **Decay default (L2 helps, guards pass):** claim only that 365 beats 7 on E1. 365 is the longest half-life tried, and with either outcome feedback or strengthening off it does not beat all-off (.687 and .681 against .692), so 365 is not shown to be the right value. No default change until the 1.45.0 re-run, the decay-off and 730-day arms, a migration plan for memories stored at 7 days, and a store-size check with sleep on.
- **Whole lifecycle (L2g helps):** it earns its place on E1.
- **Outcome feedback (L3a helps):** keep it. Claim 51.0 pp less trap persistence at 365 days (22.3 at 7 days), as E1's best case.
- **Strengthening (L3b helps):** keep it. Claim +7.3 pp hotR5 at 365 days (+27.7 at 7 days), as E1's best case. Strength is capped at 1 (`src/memory.ts:383`), so strengthening does nothing with decay off; if a decay-off arm wins, this claim goes too.
- **Sleep (L4 below the floor):** drop the claim that merging improves recall. Say nothing about decay deletion, which was never tested. Sleep stays for store upkeep.
- **The LongMemEval scorer:** match tags exactly, and credit a memory only for session text it holds or keep per-source provenance through merges. Then re-score L4 as a declared lane.

## Independent critique

A reviewer that did not build or run this campaign (a separate Claude Opus agent, read-only, given the artifacts rather than a summary) attacked the method. Its report follows word for word. Its bare `:N` references point at lines of the draft it read, before the changes listed after it. Its script now lives at `scripts/e1-lifecycle/strata.mjs`, with its output at the end of the raw file; the scratchpad path in its first paragraph no longer exists.

### Critique, verbatim

Method: read-only. Bare `:N` means a line of the result file. Besides reading the docs and source, I joined each E1 final-epoch probe row with `generateProtocol(seed)`. All 80 protocol hashes match. For each fact I counted the memories of its key that use its sentence template and are dated after its current version. Script: `node C:/Users/skf_s/AppData/Local/Temp/claude/C--Users-skf-s/3e8af126-85de-4c79-b53d-8f12f784993e/scratchpad/critic/strat.mjs`.

**1. WEAKENS A CLAIM. Attacks: the 365-day default proposal (:315). The L2 verdict itself stands.**
- 365 was the longest half-life tried, and June's sweep was still rising there (prereg:143). At 365, decay with only one other mechanism does not beat all-off: .687 and .681 against .692 (:74-77). So "365 beats 7" is shown. "365 is the right value" is not.
- Strength reads each memory's stored `half_life_days` (`memory.ts:332`). A new default reaches new memories only. 7-day memories over a month old would then rank at about half weight (`search.ts:576`). That mixed store is untested.
- Sleep deletes memories below strength 0.05 (`consolidate.ts:39`, `:196`). For a daily sleeper, an unrecalled memory drops that low in about 30 days at 7, and in 4.3 years at 365. So the change stops decay deletion in practice. Store size was not measured (:246).
- Strength is capped at 1 (`memory.ts:383`), so strengthening does nothing when decay is off. If decay-off wins, L3b's claim goes too.
- Fix: say "365 beats 7 on E1." Before any change, run the 1.45.0 re-run (:292) and the decay-off and 730-day arms. Also write a migration plan and check store size with sleep on.

**2. WEAKENS A CLAIM. Attacks: headlines 2 and 3, and the caveats at :315 and :316.**
- v1 lands in sessions 0 to 11 (`generate.mjs:152`). Its lookalikes land in sessions 0 to 19 (`:248`, `:275`). So most lookalikes are newer than the fact, and recency favours them.
- Facts that never change, all-off vs bm25-static, by how many lookalikes are newer than the fact:

  | Newer lookalikes | all-off | bm25-static | n |
  |---|---|---|---|
  | 0 | .740 | .727 | 77 |
  | 2 | .687 | .775 | 801 |
  | 4 | .494 | .785 | 1013 |
  | 5 or more | .293 | .730 | 270 |

- Updated facts (n = 2400): all-off .862, full@365 .856, bm25-static .788.
- So -8.4 and -2.9 are 60/40 blends of a loss and a gain. The generator's dating sets the size of both.
- L2g's gain does not track that cost. From 1 to 4 newer lookalikes, all-off's gap to BM25 grows from 4.7 to 29.1 pp. Over the same range, L2g's gain stays between 6.7 and 10.0.
- Fix:
  - Headline 3 becomes "on E1's dating, the composite loses 18.9 pp to BM25 on unchanged facts and gains 7.4 on updated ones".
  - Drop "not better recall than BM25" and "wins back".
  - Declare a lane with lookalikes dated inside v1's window. The recency-off draft (:230) keeps today's dating, so it cannot settle this.

**3. WEAKENS A CLAIM. Attacks: the cause named in headline 4, and "stays off after the merge fix" (:313).**
- In the never-slept store, each particle sits at its embedding with zero velocity (`physics-state.ts:171-173`). So the momentum term is 0 (`physics.ts:172`). Physics then ranks by mass times cos² plus cluster amplification (`physics.ts:150-159`). In effect, that is a cosine ranking. Hybrid adds BM25 at weight 0.4, plus MMR (`search.ts:412-413`).
- The median session is 2306 words, and the embedder cuts off long input (`transformers.node.mjs:32758`). So cosine sees only the start of each session, while BM25 sees all of it.
- Fix: keep physics off by default, but cut "stays off after the fix". The after-many-sleeps test is still NOT-DONE (:284). First declare a cosine-only lane (`retrieve_inprocess.mjs --embedding-weight 1 --no-mmr`, no product change) and a store of short memories.

**4. WEAKENS A CLAIM. Attacks: headline 5 and :319.**
- Sleep removed nothing by decay (`lme-full/sleep.log:5`), because the store was about an hour old. E1 never sleeps (`run.mjs:33`). So L4 tested merge and dedup only. Sleep's deletion step was tested nowhere.
- "No measurable effect" sits next to a 95% CI of [1.0, 4.4], which excludes 0.
- Headline 5's +0.4 comes from an undeclared rule and carries no label.
- Fix: "Merge and dedup on a fresh store: +2.6 under the declared scorer, below the floor. The undeclared text rule reads +0.4." Limit the docs change to the merge claim.

**5. WEAKENS A CLAIM. Attacks: "+51.0 as an upper bound" (:317) and the +7.3 claim (:318).**
- Two bad marks cut a trap's score by about 11% (`search.ts:612`) and shorten its half-life. Each E1 trap shares its template with at least four memories of its key, so a small cut is enough to push it out. A bad memory that leads its rivals by more would not move.
- Every scheduled recall uses the probe's exact query (`generate.mjs:221-235`). So strengthening boosts the same top five the probe later reads.
- Fix: call both numbers "E1's best case", not a bound. Show the 7-day rows (+22.3, +27.7) beside them.

**6. COSMETIC.**
- The 3 pp floor applies to the point estimate, not the CI bound. So "an effect a user could notice" (prereg:108) claims too much. No verdict moves: every decisive 95% bound clears 3 pp (smallest: L2g, 4.3).
- recency-window ignores the query (`run.mjs:111`). Drop rows :117-118, or rank BM25 matches newest first.
- The hit rule matches substrings (`paired_hits.mjs:29-32`), so a memory tagged `answer_c6fd8ebd_abs` counts as a hit for `answer_c6fd8ebd`. There are six such pairs, and both arms share the rule. Match tags exactly.

**Clean:**
- Off switches are correct at `6ce7e4d`. Decay-off skips the half-life (`memory.ts:361`), and the cap on strength neutralises the recall boost.
- Multiplicity cannot flip a verdict. Every decisive lane holds at 99%, the weakest being L2g at [3.9, 7.1].
- The E1 token scorer cannot produce false matches.
- L2 and its guard hold in every group in finding 2: on unchanged facts, 365 beats 7 by 42.5 to 53.2 pp.

**Numbers checked:**
- Against raw.txt, all matched:
  - L2 +45.5 [43.9, 47.1] (:13)
  - L2g +5.5 (:29)
  - L3a@365 -51.0 (:48)
  - L3b@365 +7.3 (:82)
  - L1 -22.2, A-only 20, B-only 131 (:193)
  - L1n -19.6 (:198)
  - L4 +2.6 [1.0, 4.4] (:203)
  - -48.4 (:141) and -8.4 (:173)
  - s* 79.8% (:23), and 49.6/62.2 = 0.797
  - merge audit 124/112/140/96/44/2852/781 (:211-216)
  - text rule +0.4 (:247)
- Recomputed from the run files, all matched (full@365, full@7, all-off, bm25-static):
  - currentR5 .747/.292/.692/.776
  - nonStaleR5 .675/.179/.579/.768
- From the source data, matched: 848 memories after sleep, 940 sessions and 500 questions.

**Closing:** all nine verdicts stand as measured. Only L4's label needs rewording. Headlines 2 to 5 and the proposals at :313 and :315-319 need rewording too. Physics off by default follows from L1n once the 1.45.0 re-run agrees. The 365 default and "physics stays off after the fix" should not ship until the checks in findings 1 and 3 are done.

### What changed after the critique

Every factual claim in it was checked against the source at `6ce7e4d`, the run files and the logs, and held. One pointer is coarse: the truncation flag sits at `transformers.node.mjs:32773-32776`, inside the class its `:32758` opens. Its script, re-run from the repo, prints the same table byte for byte.

Accepted:

1. **Finding 1.** The decay proposal now claims only that 365 beats 7 on E1. No default change until the 1.45.0 re-run, the decay-off and 730-day arms, a migration plan and a store-size check. The strengthening claim now says it depends on decay.
2. **Finding 2.** Headlines 2 and 3 now say "on E1's dating" and split the gap by fact type, and the dating table is in Baselines. "Not better recall than BM25" and "wins back" are gone. The lane with lookalikes dated inside v1's window is in Answer 9 and NOT-DONE.
3. **Finding 3.** Why physics hurts is now open, and "stays off after the merge fix" is cut. The cosine-only lane and the short-memory store are in Answer 9 and NOT-DONE.
4. **Finding 4.** L4 is now BELOW THE FLOOR, the +0.4 is labelled undeclared, decay deletion is marked untested, and the docs change is limited to the merge claim.
5. **Finding 5.** +51.0 and +7.3 are now E1's best case, with the 7-day rows beside them.
6. **Finding 6, the floor and the hit rule.** Verdicts notes that the floor applies to the point estimate. Exact tag matching joins the scorer proposal. NOT-DONE adds a check of the published LongMemEval numbers, because `evaluate_retrieval.py:62` matches by substring too.

Rejected:

- **Finding 6, dropping the recency-window rows.** They stay, labelled query-blind, because they show the floor any ranking must clear. Ranking BM25 matches newest first would be a new baseline, so it goes to the next declared campaign (NOT-DONE).

Checking it turned up one more point: L2g is flat on updated facts (.856 against .862), so its gain comes from facts that never changed (Baselines).
