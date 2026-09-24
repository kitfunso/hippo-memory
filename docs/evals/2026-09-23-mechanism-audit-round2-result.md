# 2026-09-23 mechanism audit, round 2: result

**Status:** RESULT, 2026-09-25, independent critique folded in. The release gate stays open until Keith says yes to the live-store half-life migration (Proposals). Nothing here changes a default. Every proposal waits for Keith's sign-off.

**Plan:** `2026-09-23-mechanism-audit-round2-prereg.md` (locked `b42da44`), amended by `2026-09-24-mechanism-audit-round2-amendment-1.md` (`7668626`: R2b and R2d transfer from the second decay-default registration, R2a and R2c move to seeds 101 to 120).

**Code under test:** the lock build is worktree `hippo-wt-mech2` at `f3e916d`, the branch commit that squashed into `b42da44`. W-rel is worktree `hippo-wt-rel` at `39dc65c`, detached and clean. Each lane ran on the build the prereg names for it (Provenance).

**Cost:** local CPU only. No paid key was set in any run; the embedder is the local all-MiniLM-L6-v2.

**Raw outputs:** `2026-09-23-mechanism-audit-round2-raw.txt`, collected by script. Run files are in `hippo-mech-runs/r2/` on the home box (not in git).

## Headline

Bad news first.

1. **The search recency factor hurts the current fact.** On E1, turning it off raises currentR5 by 6.1 pp [4.9, 7.3] (R2a) and cuts contradiction intrusion (7.5% to 0.0%). It costs two things. Trap persistence is 2.0% with recency off against 19.8% with it on, so off is better there by 17.8 pp. But stale intrusion rises from 88.2% to 94.2% with recency off, and cleanStaleR5 falls 5.1 pp: off lets more superseded facts through. The declared primary is currentR5, and there recency hurts at 95% and 99%; the stale-fact cost is real and rides the proposal.
2. **Under the declared text-credit scorer, sleep costs recall** (R-L4): the slept store loses 3.6 pp hit@5 [-5.8, -1.4] to the never-slept one. This number depends on the scorer. Round 1's text rule read the same comparison as +0.4 [-0.4, 1.2]; the lock build's `merge_audit.mjs` now drops snippets shared by more than one never-slept row, and that change is the likely driver of the gap. The tag scorer reads +2.2 [0.6, 3.8], but merged memories inherit every source session's tag, so it credits them for text they no longer hold: 12 of the 14 slept-only hit@5 wins under the tag scorer come only from merged rows (recount command below). No scorer here shows sleep helping recall.
3. **Decay has no measurable effect on E1** (R2b, transferred): full@365 minus decay-off is -0.7 pp [-1.4, 0.1] on currentR5. Amendment 1 printed this as +0.7 [-0.1, 1.4]; that is the decay-default doc's step C5, which runs the pair the other way round (decay-off vs full@365, `2026-09-24-decay-default-raw.txt:264`). The verdict does not change. E1 runs 20 sessions, so a 365-day half-life barely decays inside it; this lane could not detect decay's effect, which was knowable when it was registered.
4. **Physics hurts, again, under both scorers.** Never-slept store, hit@5: -19.6 pp under round 1's substring scorer, -19.4 under the exact one (R-L1n). Slept store: -21.6 (R-L1). Against cosine-only, physics shows no measurable difference at hit@5 (R5a: -0.8 [-2.4, 0.8]; R5b on one memory per turn: -2.2 [-4.8, 0.4]); that is a null, not proof of equivalence, and R5b's hit@1 is -3.2 [-5.6, -0.8]. On short memories physics still loses 13.4 pp to hybrid (R5c). So physics' loss is mostly the missing BM25 term, not memory length.
5. **Outcome feedback alone carries round 1's trap win.** Plain BM25 plus the fast outcome nudge drops trap persistence from 71.9% to 0.0% (R2c), and lifts currentR5 by 4.9 pp.
6. **Round 1's E1 replicates exactly; its LongMemEval stores nearly do.** All 180 E1 run files re-run from 1.45.0 code match round 1, meta aside, so round 1's six E1 verdicts transfer. The rebuilt LongMemEval slept store differs slightly: hybrid hit@5 77.0 against round 1's 77.6, L1 -21.6 against -22.2, tag-scored L4 +2.2 against +2.6. The never-slept store matches at hit@1 and hit@5 but reads 82.2 against 82.4 at hit@10. Every verdict is the same either way, but this is a real replication gap (Self-audit 6).
7. **R4 has no verdict.** Its validity gate failed on one seed of 20 (seed 89: 50.8% of lookalikes dated after v1, gate under 50%). The numbers are in the diagnostics below and prove nothing.

## Verdicts

The rule, unchanged from round 1. Benefit points the good way: A minus B for currentR5, hotR5 and hit@k; B minus A for trap persistence. Helps: 95% lower bound above 0 and point at least +3 pp. Hurts: 95% upper bound below 0 and point at most -3 pp. A CI that excludes 0 with a point under 3 pp is BELOW THE FLOOR. Anything else is no measurable effect, and a tie goes to the simpler configuration.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

| Lane | A vs B | Primary | Benefit, pp | 95% CI | 99% CI | Verdict |
|---|---|---|---|---|---|---|
| Replication | round 1's nine E1 arms from W-rel | identical epochs | 180 of 180 match | | | HOLDS: round 1's E1 verdicts transfer |
| R-L1 | physics vs hybrid, slept | hit@5, both scorers | -21.6 | [-26.2, -17.2] | [-27.4, -15.8] | HURTS |
| R-L1n | physics vs hybrid, never-slept, substring | hit@5 | -19.6 | [-23.6, -15.6] | [-25.0, -14.4] | HURTS |
| R-L1n | same, exact scorer | hit@5 | -19.4 | [-23.4, -15.4] | [-24.8, -14.0] | HURTS |
| R-L4 | slept vs never-slept, hybrid, text credit | hit@5 | -3.6 | [-5.8, -1.4] | [-6.4, -0.8] | HURTS |
| R2a | full@365 vs recency-off@365 | currentR5 | -6.1 | [-7.3, -4.9] | [-7.7, -4.4] | HURTS |
| R2b (transferred) | full@365 vs decay-off | currentR5 | -0.7 | [-1.4, 0.1] | [-1.6, 0.3] | NO MEASURABLE EFFECT |
| R2c | bm25-outcome vs bm25-static | trap persistence | +71.9 | [67.8, 75.8] | [66.6, 76.9] | HELPS |
| R2d (transferred) | full@730 vs full@365 | currentR5 | +0.7 | [0.1, 1.2] | [-0.0, 1.4] | BELOW THE FLOOR at 95%; no effect at 99% |
| R4a | full@365 vs bm25-static, v1 window | currentR5 | | | | NO VERDICT: gate failed |
| R4b | full@365 vs bm25-newest, v1 window | currentR5 | | | | NO VERDICT: gate failed |
| R5a | physics vs cosine, never-slept session store | hit@5 | -0.8 | [-2.4, 0.8] | [-3.0, 1.4] | NO MEASURABLE EFFECT |
| R5b | physics vs cosine, per-turn store | hit@5 | -2.2 | [-4.8, 0.4] | [-5.6, 1.4] | NO MEASURABLE EFFECT |
| R5c | physics vs hybrid, per-turn store | hit@5 | -13.4 | [-17.4, -9.4] | [-18.6, -8.2] | HURTS |

Headroom rule: no B arm in a LongMemEval lane is above 0.90 hit@5 (highest 78.0, R5c), so hit@5 stays primary everywhere.

Every HELPS and HURTS above also holds at 99%. R2b and R2d's intervals are from `2026-09-24-decay-default-raw.txt:264` (sign flipped) and `:248`.

R2d guards (amendment 1 left these open): superseded s* lower bound 29.4% against the 7.1% floor, demoted s* lower bound 33.8% against 1.4% (`2026-09-24-decay-default-raw.txt:258-259`). Both pass.

## Gates, guards and integrity

- **P0 check 1 (generator unchanged):** 20 of 20 protocol hashes on seeds 21 to 40 match round 1 (`raw`, p0-1).
- **P0 check 2 (lock build equals W-rel, switches unset):** full@365 and bm25-static on seed 1, identical final epochs (`raw`, p0-2).
- **P0 check 3 (every switch fires):** recency-off, `--recency-days 7`, bm25-outcome and bm25-newest each move 7 or 8 final-epoch metrics on seed 1. The v1 window moves only distractor sessions on seeds 1, 81, 90 and 100 (`raw`, lookalike gate).
- **P0 check 4 (scorer fix):** re-scoring round 1's four `lme-full` files changes 3 (file, question, k) credits, all three `answer_x_abs` twins, none other (`raw`, p0-4).
- **E1 integrity:** every E1 lane has 20 of 20 seeds, and `compare.mjs` ran without an integrity error on each.
- **R2c gate:** bm25-static trap persistence at least 0.20 on 20 of 20 seeds (gate: 18).
- **R2a gate:** recency-off differs from full@365 in the final epoch on 20 of 20 seeds (gate: 18).
- **R4 gate: FAILED.** Under the v1 window the share of lookalikes dated after v1 must be under 50% on every seed 81 to 100; seed 89 is 50.8%. No verdict for R4a or R4b (prereg, workload-validity gates).
- **LongMemEval build aborts:** none fired. Never-slept store 940 memories and 940 particles; slept store 848 memories, 728 particles (120 merged rows have none, as in round 1); per-turn store 10866 memories and 10866 particles.

## R4 diagnostics (no verdict: gate failed)

On seeds 81 to 100 with the v1 window, full@365 beats bm25-static on currentR5 by 11.4 pp [10.0, 12.7] and bm25-newest by 8.0 [6.8, 9.3]. Round 1's default window gave -2.9 against bm25-static, on different seeds. This lane has no verdict, so no conclusion is drawn from the difference. All-off beats bm25-static by 5.2 [4.2, 6.3]. Re-running R4 on a new seed block where every seed passes the gate needs a new amendment (NOT-DONE).

## Side checks

**Published numbers.** Re-scoring PR #224's ten salvaged retrieval files with the exact scorer changes nothing: loose and strict agree on every file and every k (`hippo-mech-runs/r2/scratch-c/rescore_out.json`, on the home box, not copied into `raw`). 98.0, 96.8, 88.4 and 98.6 are unchanged. 74.0, 73.8 and 86.8 are pooled-oracle numbers from the v0.28 era and 99.8 is the paid voyage-3-large run: none of them is in these files, so for those four the prereg's bound stands as a ceiling, not a measurement: at most 1.2 pp (6 twin pairs of 500).

**Store size.** A `VACUUM INTO` copy of the live store (2,201 memories), dry-run sleep on W-rel. With half-lives as stored, sleep would remove 777 at +30 days, 1,438 at +90 and 1,923 at +365. With 358 days added to every half-life, it removes none at any horizon. **Correction:** the first run of this check, in an earlier session (`scratch-c/dryrun_results.txt`), ran with its working directory outside the copy; hippo climbed to the live `~/.hippo` store and counted that. It was a dry run and wrote nothing, but its numbers are for the wrong store and are withdrawn. The rows above ran with the working directory inside each copy (`raw`, store-size).

## Provenance

- E1 R4 (seeds 81 to 100) and R2a/R2c (101 to 120): lock build `hippo-wt-mech2`. R4 files carry `lookalikeWindow: "v1"` and `halfLife: 365` in their meta; the arms and flags exist only in the lock build.
- Replication: W-rel, round 1's command, into `r2/rel-e1/`.
- LongMemEval R-L1, R-L1n, R-L4, R5a: stores built on W-rel with `build_mech_stores.sh`. The first build attempt in an earlier session stopped at 590 of 940 sessions and left no store; this build is a clean re-run (`r2/rel-lme-build2.log`). Model cache: `hippo-mech-runs/lme-reproduce-data/model-cache` (Xenova all-MiniLM-L6-v2). Cosine-only ran on W-rel. `merge_audit.mjs` and the exact scorer ran from the lock build; the substring scorer from W-rel.
- R5b, R5c: per-turn store built with the lock build's `build_turn_store.sh`.
- R2b and R2d: transferred from the second decay-default registration (build `a6482a0`, seeds 41 to 60). Its decay-off arm ran in the `hl7` directory, not at 365 as round 2 registered; with decay off the half-life is not used, and decay-off vs full@730 reads -0.0, so the difference does not move R2b.
- The rebuilt never-slept store matches round 1's L1n at hit@1 and hit@5 (55.4 vs 75.0) but differs at hit@10 (82.2 vs 82.4), and the slept store differs by 0.6 pp (Headline 6).

## Ledger and multiplicity

Base N = 19. The replication held, so it adds no lanes, and R-L1/R-L1n replace round 1's L1/L1n. #3 did not run. Expected false passes at N = 19: 0.95 at 95%, 0.19 at 99%. All six decisive verdicts hold at 99%. Seeds 41 to 60 carried extra looks from the second decay-default registration before this round (amendment 1); R2b and R2d are not spent from a single N = 19 budget. Extra looks beyond N: R-L1n read under two scorers, the seed-1 P0 runs of every E1 pair, the R4 diagnostics, and the four-step sequential procedure the decay-default registration ran on seeds 41 to 60. The lanes share arms; no joint bootstrap ran (NOT-DONE).

## Caution flags

- E1 is synthetic, 20 sessions long, and every outcome mark in it is correct. R2c's size is its best case; real bad marks are noisy (`hippo outcome --bad` marks a whole recall batch).
- R2b's null is about E1's time scale. It is not evidence that decay does nothing over months of real use; the real-data decay replay (2026-09-24, NO VERDICT, re-run 2026-10-24) is the test for that.
- R2a: recency's win is on stale facts: with it off, stale intrusion rises 6.0 pp and cleanStaleR5 falls 5.1 pp. On E1 its trap effect runs against it (recency on leaves 17.8 pp more marked-bad memories in the top five).
- R-L4 depends on the scorer: text credit says -3.6, round 1's text rule said +0.4, the tag scorer (which over-credits merged rows) says +2.2. None is the product's real use.
- LongMemEval is static: decay and strengthening never act there.
- The per-turn store is ingested in process (prereg caution flag).
- The author built, ran and judged this. The earlier session that started the runs is the same author.

## Self-audit: what else is wrong with what I did

Data
1. R4's seed block was never pre-checked against its own gate; seed 89 failed after the runs. The gate check should run before the verdict runs.
2. The store-size check first counted the wrong store (above). Any script that runs hippo against a copy must set its working directory inside the copy, not just `HIPPO_HOME`.

Statistics
3. Amendment 1 flipped R2b's sign. Caught here; the verdict is unchanged, but the amendment's text is wrong and this file is the correction.
4. The draft first said R2b and R2d had no 99% interval at source. They do (`2026-09-24-decay-default-raw.txt:248, 264`); the table now carries them, and R2d's floor verdict holds only at 95%.
5. The R2a and R2c gate counts used a short script over the final epochs that `raw` does not carry. P0 check 3's split of the after-v1 lookalike share by never-changed and updated facts (prereg) was not reported.
6. R2b was registered on a workload too short for a 365-day half-life to act. That was knowable at registration, so its null says little.

Code
7. The rebuilt LongMemEval stores differ slightly from round 1's (Headline 6). The model cache differs by path, and no hash of the model file was taken, so a model or build difference cannot be ruled out.

Process
8. R2a and R2c ran after the author had seen seed-1 P0 results for both pairs and round 1's diagnostic that pointed at recency. The seeds are fresh; the hypothesis was not blind.
9. The W-rel LongMemEval build and the E1 runs overlapped in time on one CPU. Nothing in either depends on timing, but it is recorded.

## NOT-DONE

| Item | Why not | Slot |
|---|---|---|
| #1 real recall ages | Needs the trace re-count | On or after 2026-09-26 |
| #3 half-life grid | Triggered only if R2b or R2d is HELPS or HURTS; neither is | Not triggered |
| R4 re-run on a gate-passing seed block | Gate failed on seed 89 | Needs amendment 2 |
| Joint bootstrap (StepM) | Lanes share arms | Next campaign |
| E1 with the embedding blend | E1 passes no `hippoRoot` | Next campaign |
| Half-life migration of live stores | Live-data change | 1.46.0, Keith's yes |
| Paid legs (99.8 voyage number) | Cost money | Never without a priced yes |

## Proposals for 1.46.0 (each waits on Keith)

- **Physics default off** (already on master as `5d1e547`): R-L1n HURTS under both scorers, so by the prereg it stays off. Clears amendment 1's release gate for physics.
- **365-day half-life** (already on master as `8e7b7ba`): R2d keeps 365; round 1's L2 and the decay-default doc carry the win over 7 days. The evidence clears amendment 1's gate for the half-life. **But the default and the live-store migration ship together:** on master every sleep runs `migrateDefaultHalfLife` (`src/consolidate.ts:191`), so 1.46.0 rescales each existing store the first time it sleeps. The prereg treats that migration as a live-data change that needs Keith's explicit yes. Release gate: open until that yes is on record, or the migration becomes opt-in.
- **Decay (deviation from the locked table):** the prereg's table says "propose decay off" for R2b's null. I decline to follow it: E1 is too short for a 365-day half-life to act, and the real-data replay is scheduled. Proposal: keep decay on, record the null, re-judge after the 2026-10-24 replay.
- **Recency factor:** R2a HURTS on the primary, so the table says turn it off. That is a ranking change, and it lets more superseded facts through (stale intrusion +6.0 pp). Proposal: not in 1.46.0; decide after a round-3 check on stale facts and the LongMemEval stores.
- **Sleep recall claim:** R-L4 HURTS under text credit, and no scorer shows sleep helping. Drop any claim that sleep helps recall, and find the phase that costs it (merge is the first suspect: 260 episodic rows merged, `r2/rel-lme/sleep.log:6`; 12 of the 14 tag-scored slept-only wins come only from merged rows).
- **Outcome nudge:** R2c HELPS. Claim it: the fast outcome channel alone removes marked-bad memories from the top five on E1.

## Commands

Every `compare.mjs` and `paired_hits.mjs` call behind a verdict or diagnostic is printed verbatim, with its output, in `raw` (each line starting `$ `). Builds and retrievals:

```bash
HIPPO_MODEL_CACHE=<cache> bash benchmarks/longmemeval/build_mech_stores.sh <run> <oracle>        # W-rel
node benchmarks/longmemeval/retrieve_inprocess.mjs --data <oracle> --store-dir <run>/nosleep --output <run>/ret-nosleep-cosine.jsonl --budget 1000000 --min-results 10 --top 10 --mode hybrid --embedding-weight 1 --no-mmr
node benchmarks/longmemeval/merge_audit.mjs --data <oracle> --run <run> --out <run>/audit        # lock build
# 12 of 14: slept-only tag hits@5 whose every hit is a sem_ row, over r2/rel-lme/ret-{sleep,nosleep}-hybrid.jsonl
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1]));const a=new Map(d.map(q=>[q.question_id,new Set(q.answer_session_ids)]));const L=f=>new Map(fs.readFileSync(f,"utf8").trim().split("\n").map(JSON.parse).map(r=>[r.question_id,r.retrieved_memories.slice(0,5)]));const S=L("ret-sleep-hybrid.jsonl"),N=L("ret-nosleep-hybrid.jsonl");let o=0,m=0;for(const[q,s]of S){const h=x=>x.filter(e=>(e.tags||[]).some(t=>a.get(q).has(t)));const hs=h(s);if(hs.length&&!h(N.get(q)).length){o++;if(hs.every(e=>e.id.startsWith("sem_")))m++}}console.log(o,m)' <oracle>
```

The R2a and R2c gate counts came from a throwaway script over the final epochs that was not kept (Self-audit 5).

## Independent critique

An Opus sub-agent that did not build, run or judge the campaign, given the prereg, amendment 1, `raw`, round 1's result, the decay-default docs and this draft. Its findings as returned, reformatted to one paragraph per finding (line numbers refer to the draft):

> 1. **[major] The 365-day default auto-migrates live stores; the draft never says so.** On master `src/consolidate.ts:191` calls `migrateDefaultHalfLife(...)` on every sleep, so shipping 1.46.0 rewrites every existing store on its first sleep. The prereg treats that migration as a live-data change gated on Keith (prereg:108, 140). The draft's proposal (result:129) says "still needs Keith's yes" as if it were a separate step; it is not. Fix: state that the default and the migration ship together, and require Keith's explicit yes before release (or make the migration opt-in).
> 2. **[major] R-L4 headline omits round 1's own text-rule reading.** Round 1's text rule read the same comparison as +0.4 [-0.4, 1.2] (round-1 result:182); round 2 reads -3.6 [-5.8, -1.4]. The difference is the lock build's `merge_audit.mjs` change dropping snippets shared by >1 never-slept row (prereg:32): round 2's never-slept text score is 74.8 (raw:142), the same as tag, while round 1's text rule lifted it to 77.2 (round-1:186). Round 2's -3.6 sits near round 1's header-only -3.4, which round 1 called "biased against sleep" (round-1:185). The verdict follows the letter (text credit was the declared primary, prereg:44), but "Sleep costs recall once credit is honest" (result:18) overclaims. Fix: report round 1's +0.4 beside it, name the scorer change as the likely driver, and state the -3.6 is scorer-dependent. Also "12 of the 14" and "260 episodic rows merged" (result:18, 132) are not in raw; add or cite them.
> 3. **[major] "Recency's only win is trap persistence" is wrong in direction.** With recency off, stale intrusion rises 88.2% to 94.2% (raw:88) and cleanStaleR5 falls 5.1 pp (raw:92); lower stale intrusion is better (prereg:86). Headline 1 says recency-off "cuts stale and contradiction intrusion" (result:17) and the caution flag says recency's "only win is trap persistence" (result:90). Fix both, and weigh the stale-fact cost in the recency-off proposal.
> 4. **[major] "Replicates exactly" does not hold for the LongMemEval stores.** Round 1's slept store: hybrid 77.6, L1 -22.2, L4 tag +2.6 (round-1:159-161); round 2: 77.0, -21.6, +2.2 (raw:116, 148). Never-slept hybrid hit@10: 82.4 vs 82.2. So result:80 ("match round 1's L1n exactly") holds for one cell only, and it weakens self-audit 6's use of that match as proof the model is the same. Fix: say the rebuilt stores differ slightly from round 1's, record it as a real replication gap, and hash the model file.
> 5. **[minor] R2b/R2d: numbers and sign correction check out; 99% intervals do exist at source.** The sign correction is right: decay-default-raw:264 (A=decay-off, B=full@365) reads +0.7 [-0.1, 1.4], so A=full is -0.7 [-1.4, 0.1]; amendment 1:31 and :48 have it backwards. But the 99% intervals are at raw:248 and :264, and the draft says "not reported at source" (result:39, 41; self-audit 4). R2d's 99% is [-0.0, 1.4], so BELOW THE FLOOR holds only at 95%; say so. R2d's guard "gap" (amendment:36-41) can be closed from data on hand: superseded s* lower bound 29.4% > 7.1%, demoted 33.8% > 1.4% (raw:258-259). Provenance should list build `a6482a0` for R2b/R2d, and note the decay-off arm ran at `hl7`, not at 365 as registered (prereg:162); harmless, since decay-off vs 730 reads -0.0, but "arms match exactly" (amendment:31) is not literally true.
> 6. **[minor] Smaller gaps.** Declining the prereg's "propose decay off" (prereg:102) is reasoned; label it a deviation from the locked table, and add to self-audit that R2b was underpowered by design, which was knowable at registration. "Physics ranks like plain cosine" (result:20) reads a null as equivalence; R5b's CI reaches -4.8 and hit@1 is -3.2 [-5.6, -0.8] (raw:101). R4: gate handling is correct, but the diagnostics paragraph interprets a no-verdict lane ("which is what round 1 suspected", result:66); cut it. P0 check 3 required the after-v1 lookalike share split by never-changed and updated facts (prereg:71); not reported. Multiplicity: list the extra looks (R-L1n under two scorers, the seed-1 P0 peeks, the R4 diagnostics, the four-step sequential procedure prereg-2 ran on seeds 41-60). Commands (result:137) does not regenerate everything: R4b, all-off, the paired_hits calls and the gate script are missing; self-audit 5 points to a command that is only a comment. The published-numbers claim rests on `rescore_out.json`, which is not in raw.
>
> Build provenance is clean: `f3e916d` and `b42da44` have identical trees (`e69e9f7`).
>
> Release gate: DO NOT SIGN OFF. Physics off is well supported (R-L1n HURTS under both scorers at 99%), and the 365-day half-life is supported by prereg-2 step 1 with its guards passing, with R2d keeping it. But 1.46.0 auto-migrates live stores on sleep (`consolidate.ts:191`), which the prereg gates on Keith's explicit yes. Sign off once that yes is on record or the migration is made opt-in.

## What changed after the critique

- 1, accepted. I confirmed `src/consolidate.ts:191` calls `migrateDefaultHalfLife` on every sleep. The 365-day proposal now says the default and the migration ship together, and the release gate stays open until Keith's yes is on record or the migration becomes opt-in.
- 2, accepted. Headline 2 now leads with the scorer, gives round 1's +0.4 beside the -3.6, and names the `merge_audit.mjs` change as the likely driver. I re-derived the 12 of 14 with a script this session (command in Commands). The 260 is cited to `sleep.log:6`. I did not quote round 1's header-only -3.4, because I have not read that line myself.
- 3, accepted. Headline 1, the caution flag and the recency proposal now show the stale-fact cost. The proposal moves from "off in 1.46.0" to "not in 1.46.0; decide after round 3".
- 4, accepted. Headline 6 and Provenance now record the LongMemEval replication gap. Self-audit 7 says the model file was not hashed. Hashing it is left for round 3.
- 5, accepted. The 99% intervals are filled in, R2d reads BELOW THE FLOOR at 95% and no effect at 99%, the R2d guards are closed from source, and the `a6482a0` and `hl7` provenance is added.
- 6, accepted, with one exception. The decay deviation is labelled. Self-audit 6 is added. The physics and cosine wording is now a null. The R4 interpretation is cut. The P0-3 split and the extra looks are listed. Commands now points at every call printed in `raw`. The exception is the gate script: it was not kept, and that is recorded rather than rebuilt.
