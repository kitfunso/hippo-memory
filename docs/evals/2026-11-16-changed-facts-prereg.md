# Changed facts and age-free recall: registration (2026-11-16)

**Status:** LOCKED before any run of arm D on any measure below. Plan page: `rank-plan/plan-link.html` in the session scratchpad. Outside review: `rank-plan/plan-link-review.md` (20 findings, 4 blockers); this file applies it, and the end section lists what was rejected and why. Branch: `fix/rank-no-decay`.

## What was seen before the lock

Stated in full, because this registration is openly post hoc.

- **Arm B** (`2026-11-16-rank-age-prereg.md`) failed G1 and G1b on cleanStaleR5 (`2026-11-16-rank-age-result.md`). An exploration of arm C1 (decay off, recency kept) on E1 seeds 161 to 165 then shaped arm D. So E1 seeds 161 to 180 are spent. The E1 guards here use seeds 181 to 200. A grep of `docs/` and `scripts/` finds no use of 181 to 200.
- **DolphinBench** data has been looked at, so its replay is reported and never a guard.
- **Z6 held-out split leaked.** The plan's count "39 of 40 Z6 changes on paper" covered both splits. After the rule was fixed, a paper count per split was read: 18 of 20 held-out changes and 20 of 20 tune changes accept the span test; 0 of 10 controls. The Z6 registration allows tuning on the tune split only (`2026-09-28-z6-supersession-prereg.md:59`). So Z6 is used here only as a plumbing gate (G2a), never as a detection measure. Detection is gated on a new blind fixture (G2b).
- **Real store.** The reviewer ran the plan's first rule over the real-store copy (read-only): 766 proposed links, 719 from `tool-failure` rows, and every sampled pair a parallel record, not a changed fact. The eligibility list and the two modes below come from that finding. They follow the row's source type (written by a person or by a machine). They are not fitted to counts.

## Why

Age in the recall rank works as a proxy for "this fact was replaced". On long histories it buries old facts that are still true (DolphinBench replay: evidence recall 38.3% as shipped, 53.7% with decay off). Removing age alone lets old versions of changed facts show more often at depth (C1 at half-life 35: cleanStaleR5 0.105 against A's 0.197). Arm D removes the proxy and adds the real signal: sleep acts on an old fact when a newer note changes one value of it.

## Arms

- **A:** `d86ce480b` (worktree `rank-base`), the arm A build of the arm B run. `origin/master` at `995c57327` has the same `src/`. G4, G5 and R1 make no model call and are deterministic for a build, so A's outputs from the arm B run are reused (`rank-plan/locomo-A`, `lme-A`, `r1-A`). For E1, A runs `d86ce480b` plus the E1 sleep-step commit (branch `eval/e1-sleep`, scripts only).
- **D:** the `fix/rank-no-decay` commit that the result file names, built once. It holds:
  1. **Rank** (`strengthRecencyMultipliers`, `src/domain/search/boosts.ts`): strength = `0.5 + 0.5 * calculateStrength(entry, now, { ...model, decays: false }) * share`. `share` is 0.5 when the stored `confidence` is `'stale'`, or when the row has a successor link and the rank has no `asOf`; else 1. The 30-day recency factor stays. Pinning, recall count and emotional weight stop acting on the rank; merge's half-life cut on its sources no longer demotes them in the rank. Sleep keeps full decay.
  2. **Conflict loser** (`weaken`): a stored stale mark with the tag `conflict-loser`.
  3. **Sleep pass** `supersedeChangedFacts` (`src/domain/consolidate/supersede-pass.ts`), after the model passes and before physics and merge.
     - Eligible rows: source `cli`, `cli-global`, `capture` or `claude-memory:*`; never `tool-failure`, `compaction:*`, `consolidation`, `session-digest`, `shared:*` or a row tagged `error`. At most 20 words. Distilled, not semantic, trace, DAG, extracted, raw, kept-as-written, object-backed or superseded. Same tenant, same `originProject`, same derivation partition. The old row is not pinned and has no `kept-current:<newId>` tag. The new row has no net wrong mark, is not stale, and its confidence is not below the old row's.
     - Span test `replacesOne`: after the words now, again, actually and instead are dropped, the texts share a prefix of at least 2 words, each side changes one span of 1 to 4 words, and the shared words are at least 60% of the longer text.
     - Order: by `validFrom` (else `created`); a pair whose two orders disagree or whose times are equal is skipped. Old rows go oldest first; each acts toward its nearest newer qualifying row, and same-text newer rows count as one. Three versions in one sleep give a chain.
     - Two modes: **hide** (`superseded_by`) when the new text holds an update cue (now, instead, again, actually, anymore, no longer, moved to, switched to, changed to, back to); else **soft**: stale mark with the tag `replaced-by:<newId>` and no half-life cut.
     - Each action writes the row, a `supersede` audit row `{newId, by: 'sleep', rule: 'one-span', mode}` and the DAG dirty mark in one transaction. The compare-and-set checks the old row is current and the new row exists, is current and is in the same tenant.
     - Dedup repoints a link (and a `replaced-by:` tag) from a deleted twin to its winner. The share phase applies the same mode to the global copy of an acted-on row, and never copies a superseded or stale row.
  4. **Explain and undo.** `hippo explain` prints `replaced by <id>` (hide) or `maybe replaced by <id>` (soft), and the strength line names `stale` or `replaced`. `hippo unsupersede <id>` clears either mode, writes `kept-current:<id>` so the next sleep does not act again, and writes an `unsupersede` audit row. A good outcome clears a sleep stale mark (`conflict-loser`, `replaced-by:`).

Each arm runs from its own worktree and `dist/`. Same seeds, same data, same flags.

## Rule

Benefit points the good way: D minus A for a recall or pass rate, A minus D for an intrusion rate.

- **Guard pass (non-inferiority):** the 95% CI lower bound of the benefit is above -3 pp. A guard with a wide CI fails.
- **HELPS** (reported): the lower bound is above 0 and the point is at least +3 pp.
- **Alive checks** are listed per guard. A guard whose alive check fails is void, and D does not merge.

Keith's three conditions (16 Nov) map to the guards: the registered check on fresh data passes (G1 to G3); LoCoMo and LongMemEval do not drop (G4, G5); a DolphinBench rerun passes more tasks (G6).

## Guards

**G1, E1 lifecycle with sleep, half-life 365, seeds 181 to 200.** Each arm from its own worktree with the sleep-step commit, one seed per process, `ANTHROPIC_API_KEY` unset: `node scripts/e1-lifecycle/run.mjs --arms full --sleep --half-life 365 --seeds <s> --out-dir <dir>`. Each session ends with one real sleep; the probe drops superseded rows, as default recall does. Then `compare.mjs --a <D>:full --b <A>:full --seeds 181-200`, 10,000 draws (D first, because `sStarOf` returns 0 when the first arm loses outside the exposed share).
- currentR5, hotR5, cleanStaleR5 and cleanTrapR5 must pass non-inferiority (arm B's guards).
- Superseded s\*: the 95% lower bound must be above 7.1% (the September proxy, `2026-09-23-mechanism-audit-prereg.md:134`; the 16 Nov recount on the real store is 2.1%). Demoted s\*: the lower bound must be above 1.4%.
- Change from arm B's rule, with the reason: each s\* gate applies when its exposed measure (cleanStaleR5, cleanTrapR5) shows a clear loss, its 95% upper bound below 0. s\* is the break-even share of a trade. When the exposed measure does not move, s\* has no defined value and its interval spans 0 to 100%: C1 at half-life 365 gave 50.0% [0.0, 100.0], and arm B's demoted s\* failed that way (100.0% [0.0, 100.0]). Without this condition an arm equal to A fails.
- Reported: MRR, stale intrusion, contradiction intrusion, trap persistence; per arm, the sleep counts per session; for D, the links and soft marks whose new row is a distractor (`NEG` token) against those whose new row is a true update (`VAL` token of the same fact with a higher version).
- Alive: at least 1% of final-epoch probes rank the current version differently (`docs/evals/rank-age/e1_alive.mjs`), and D's sleep acts on at least one pair per seed.

**G1b, E1 lifecycle with sleep, half-life 35, seeds 181 to 200.** The same runs and rules with `--half-life 35`.

E1's family-4 distractors (`scripts/e1-lifecycle/generate.mjs:274-283`) state a fact in its exact form with a new value and no hedge, and they are labelled noise. So E1 tests the link against an adversary that is built to look like an update. If D fails G1 or G1b, D does not merge, and the result file gives Keith the trade with the numbers.

**G2a, Z6 plumbing, remember arm.** `node scripts/z6-supersession-eval.mjs --arms remember,oracle` on D's `dist/`, all 50 scenarios, daily sleep and auto-share as the script runs them (auto-share is on by default). Gate, held-out split, remember arm:
- every held-out change scenario whose two fact texts pass the span test on paper (18 of 20) gets label `d`;
- no held-out control scenario fails, and no filler memory is retired (the script's R15 check);
- alive: D's sleep logs at least one `superseded` event in each of those 18 scenarios, and the result names the SHA-256 of D's `dist/cli.js`.
Reported: the remember arm on A; the oracle arm on D (A gives `d0` on 40 of 40 because explain names no replacement); the tune split. The capture arm (Z6's primary arm) is not run here; it stays at its last result, so this file makes no "Z6 pass" claim.

**G2b, blind fixture, detection.** 60 change pairs and 60 look-alike pairs in `benchmarks/changed-facts-blind/`, written by two Sonnet agents that saw neither the rule nor the code. The change author wrote natural updates with free wording; the look-alike author wrote pairs that stay true together (different subject, several values at once, separate events, different scope). For each pair, D's CLI in a fresh store: `remember` the old note at day 0, the new note at day `gapDays`, then `sleep` one day later. Read the old row.
- Look-alikes hidden: at most 3 of 60. Look-alikes acted on (hidden or soft): at most 9 of 60.
- Changes acted on (hidden or soft): at least 12 of 60 (alive floor; the rule is narrow on purpose). Reported with the Wilson interval, split by mode, kind and domain.
The fixture is frozen before D's first run on it; no pair is edited or dropped after. SHA-256: `changes.json` 8a2c5f5c0301ead95fee9879394dd42ca5ef36764cd02ab9f2f33168e5663b99, `lookalikes.json` 456ca65d531d4e87bb7998e59b9b3cbf15c5df46f6794b2bcd1b35d4d2b2d1c2. Nobody, the rule included, has scored a pair before this lock.

**G3, real store, sleep dry run.** On a copy of the real-store copy (`rank-plan/realdb/hippo.db`, never `~/.hippo`), D's `hippo sleep --global --dry-run --no-learn --no-share`. The SHA-256 of the copied file must be the same before and after. Every proposed action is listed with both texts (a random 100 if there are more). An Opus agent labels each pair without seeing the rule, the code or the mode: correct when the new note states a changed value of the same attribute of the same subject, so the old note is no longer true.
- Hidden proposals: point precision at least 95% and Wilson 95% lower bound at least 80%.
- Soft proposals: precision reported with its interval.
- Alive floor: at least 20 proposals in total. Below 20, G3 is void for power, and precision rests on G2b; the result says so.

**G4, LoCoMo retrieval.** As G2 of the arm B registration, with the same script (`rank-plan/locomo-srv.sh`): categories 1 to 4 (1,531 questions with evidence), embeddings off, `hippo-mem0-server.mjs --arm hippo --embeddings 0 --dist <arm>/dist`, Mem0's runner `--predict-only --top-k 200`, each memory with its session date. `evidence_recall.py --k 10,50 --baseline <A>`, 4,000 paired draws. Top 10 and top 50 must pass non-inferiority. Temporal is a named secondary read. Alive: at least 1% of top-10 lists differ.

**G5, LongMemEval-S retrieval.** As G3 of the arm B registration, with the same script (`rank-plan/lme.sh`): 500 questions (479 with evidence), arm `hippo365`, embeddings off, `HIPPO_SERVER_DIST=<arm>/dist`, each memory with its haystack date. `longmemeval_evidence_recall.py --k 10,50 --baseline <A>`, 4,000 paired draws. Top 10 and top 50 must pass non-inferiority. Knowledge-update (72 with evidence) and temporal-reasoning are named secondary reads. Alive as G4.

G4 and G5 run no sleep; they test the rank part. LoCoMo never runs beside E1 or LongMemEval on this box (CPU share with another session).

**G6, DolphinBench agent rerun.** The hippo arm on A and on D, in the same window, with the agent, model, judge, hooks and 600 tests of the v3full runs (`2026-09-24-public-benchmarks-prereg.md:130`). Before the agent runs, each arm's own sleep runs once on copies of the three v3 stores, with the clock at each persona's test date, so both arms carry sleep's decay and D also carries its links. Pass rate paired by test, 4,000 draws. Gate: D's estimate is above A's (D passes more tests), and the 95% lower bound of D minus A is above -3 pp. Reported: each arm against the keyword control, the actions D's sleep took per persona, and the replay's evidence recall before and after sleep for each arm. G6 runs when the Claude subscription tokens for the bench return. **D does not merge before G6.**

## Reported, not gated

- **R1, DolphinBench replay.** `dolph_ablate.mjs` default variant on A's and D's `dist/`, on the v3 stores as saved and on the slept copies of G6. Evidence recall, any source shown, `dolph_flip.py` gains and losses.
- **R2, actions on the v3 stores.** The hides and soft marks D's sleep makes per persona, an Opus blind label on a random 50, and the share of the 516 superseding facts in the v2 registries (`construction/v2/*/facts.yaml`) whose old version is acted on.
- **Undo probe.** A temp store through the CLI: sleep acts on a pair, `hippo unsupersede`, the row is back in recall, one `unsupersede` audit row exists, and a second sleep leaves it current.

## What a pass allows

If G1 to G6 pass and every alive check passes, D merges to master and ships in a release. If a guard fails, D does not merge; the result file names the failure, the numbers and the next route. A pass supports one claim: hippo's recall no longer buries a relevant memory because of its age, and sleep retires or demotes a note that a newer note changes in one value, with a reason and an undo. It supports no claim against a competitor beyond G6's own reading.

## Scope

- Capture is unchanged: it stores only cue-matching clauses.
- Sleep decay is unchanged: a memory below strength 0.05 still goes dormant (R2 of arm B: this loses old instructions; that is its own registration).
- Unchanged ranks: the per-prompt hook block (token overlap only); `hippo context` with no query (`src/api/context/context-select.ts:296-330`, decayed strength); physics mass (`src/domain/search/physics-search.ts:282`, off by default); `newestOnTopicFirst` and `temporalBoost` keep their age terms.
- No model call in the new pass. No schema migration: the pass uses the existing `superseded_by` column and tags.

## NOT-DONE

- A rephrased update ("we moved standup to Tuesday" after "standup is Monday") is not acted on.
- The pass does not read resolved conflicts. A resolved conflict already applied its fate to the loser.
- The global store's own sleep does not act on `shared:*` rows. Global copies change only through the share-phase reconcile of a local action.

## Review findings rejected or changed

- **Finding 12, real-store lower bound 90% and a partition split.** With 20 proposals all correct, the Wilson lower bound is 83.9%, so 90% needs at least 35 correct pairs with no error. The real store may hold fewer person-written one-span pairs. The bound is 80% with an alive floor, and G2b carries precision when G3 is void. No partition split: the eligibility list follows source type and is not fitted to counts.
- **Finding 11, stale share for merge sources.** Not added. A merge source is not wrong. E1 with sleep now measures sleep and merge under the new rank; if merged rows and their sources crowd the top results there, that is the next fix.
- **Finding 2, resolved conflicts as a block.** Not added (see NOT-DONE).
- **Finding 13, the shared-store Z6 run.** Dropped, as the review says it cannot fail. G2b holds the look-alikes.

## Amendment 1 (16 Nov, before any arm D guard run)

**G3 hide gate and small counts.** The alive floor counts all proposals, but the gate reads hide proposals alone. With every hide correct, the Wilson 95% lower bound reaches 80% only from 17 hides (8 of 8 gives 67.6%), so a store with few hides would fail G3 for lack of data, not for wrong links. Finding 12 above already sets 20 pairs as the point where the bound has power. So: with 20 or more hide proposals, the gate stays as written. With fewer, the bound is reported and not gated, and the gate is that no labelled hide is wrong; G2b carries the hide precision. Written before D's dry run on the real store; the scorer is `rank-plan/g3-score.py`.
