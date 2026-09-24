# 2026-09-23 mechanism audit, round 2: replication, recency, lookalikes, short memories

**Status:** PRE-REG-LOCKED at the commit that adds this file. No round-2 lane has run on its verdict seeds or its stores.

**Code under test:** two builds.

- **W-rel:** hippo-memory 1.45.0 plus the round-1 result, master `39dc65c`, detached and unchanged. It runs the replication and the rebuilt LongMemEval stores.
- **Lock build:** this commit. It adds eval-only switches to `src/` (below) and new harness options. P0 check 2 proves that with every switch unset it ranks exactly like W-rel.

**Cost:** local CPU only, as in round 1: the free local all-MiniLM-L6-v2 through `@huggingface/transformers` 4.2.0, no LLM, no paid embedder or reranker. Every command unsets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`, `HIPPO_LLM_RERANKER_KEY` and `TYPESAFE_API_KEY`.

## Why

Round 1 (`2026-09-23-mechanism-audit-result.md`) left four open questions and one scorer bug:

1. Do round 1's verdicts hold when re-run from the released code? (replication)
2. Round 1's diagnostic points at the recency factor, which no lane isolated. (#2)
3. The lookalikes that make BM25 hard mostly sit outside v1's window, so the "full@365 loses to BM25 by 2.9 pp" result may be about where the generator dates them. (#4)
4. Physics lost to hybrid by about 20 pp. Is that the missing BM25 term, or long session memories? (#5)
5. The LongMemEval hit rule matched tags by substring, so `answer_x` credited its abstention twin `answer_x_abs`. Fixed here (exact tags), and every lane is scored both ways where round 1 was.

Keith signed off the five drafts in round 1's answer 9 and their order: replication, #4, #5, #2; #1 after 2026-09-26; #3 only if #2 shows the half-life matters.

## What changed in code

Eval-only, all default-off:

- `src/ablation.ts`: `HIPPO_ABLATE_RECENCY` sets the search recency factor (`0.8 + 0.2 * exp(-age / 30d)`) to 1; decay, strengthening and outcomes stay live. `HIPPO_EVAL_RECENCY_DAYS` replaces the 30-day scale when it is a positive number; unset, zero, negative or junk keep 30.
- `src/search.ts`: `recencyBoost` reads both switches. The fast outcome nudge moves into an exported `outcomeMultiplier(entry)` with the same formula, so the `bm25-outcome` baseline ranks with the product's own code.
- `scripts/e1-lifecycle/generate.mjs`: opt-in `lookalikeWindow: 'v1'` draws each hard negative's session from `[0, floor(0.6 * numSessions))`, v1's window. It makes one draw per negative either way, so every token stays and only sessions move. The default protocol is byte-identical (P0 check 1). This amends the frozen generator; the freeze note in its header says so.
- `scripts/e1-lifecycle/run.mjs`: arms `recency-off`, `bm25-outcome` (all lifecycle off but the fast outcome channel, ranked by raw BM25 times `outcomeMultiplier`), `bm25-newest` (raw BM25, ties to the newest); flags `--recency-days` and `--lookalike-window`; meta records `halfLife`, `recencyDays` and `lookalikeWindow`.
- `benchmarks/longmemeval/evaluate_retrieval.py`, `paired_hits.mjs`, `merge_audit.mjs`: exact tag match. `merge_audit.mjs` drops text snippets shared by more than one never-slept row, since abstention twins share text.
- `benchmarks/longmemeval/ingest_turns.mjs` and `build_turn_store.sh`: a never-slept store with one memory per turn (content `[Date]`, `[Session]`, `Role: text`; tags the session id and date), particles seeded by `hippo embed --reset-physics`, and the same aborts as round 1.

Tests: `tests/ablation-flags.test.ts` (recency switch, scale, junk values, isolation, `outcomeMultiplier` parity) and `tests/e1-harness.test.ts` (window determinism and bounds, the new arms, meta).

## Lanes

| Lane | Question | A vs B | Primary endpoint | Data |
|---|---|---|---|---|
| Replication | Do round 1's E1 epochs reproduce from W-rel? | round 1's nine arms, re-run | identical epochs (meta aside) | seeds 21 to 40 |
| R-L1 | Physics vs hybrid, slept store, rebuilt | physics vs hybrid | hit@5 (headroom rule) | oracle, 500 |
| R-L1n | Same, never-slept store | physics vs hybrid | hit@5 (headroom rule) | oracle, 500 |
| R-L4 | Does sleep keep the answer findable, credited by text? | slept vs never-slept, hybrid | hit@5 (headroom rule) | `merge_audit.mjs` `text/` output |
| R2a | Does the recency factor help? | full@365 vs recency-off@365 | currentR5 | seeds 41 to 60 |
| R2b | Does decay help at all? | full@365 vs decay-off | currentR5 | seeds 41 to 60 |
| R2c | Does outcome feedback alone beat plain BM25? | bm25-outcome vs bm25-static | trap persistence; currentR5 secondary | seeds 41 to 60 |
| R2d | Does a longer half-life help more? | full@730 vs full@365 | currentR5, with L2's two guards | seeds 41 to 60 |
| R4a | With lookalikes in v1's window, does full@365 beat BM25? | full@365 vs bm25-static | currentR5 | seeds 81 to 100, `--lookalike-window v1` |
| R4b | Same, against BM25 with newest-first ties | full@365 vs bm25-newest | currentR5 | same |
| R5a | Is physics' loss the missing BM25 term? | physics vs cosine-only | hit@5 (headroom rule) | rebuilt never-slept session store |
| R5b | Same, on short memories | physics vs cosine-only | hit@5 (headroom rule) | per-turn store |
| R5c | Physics vs hybrid on short memories | physics vs hybrid | hit@5 (headroom rule) | per-turn store |

- R2c's primary is trap persistence, not the draft's currentR5: the outcome channel's job is to push marked-bad memories out, which is what round 1's L3a measured. currentR5 is reported as secondary.
- bm25-newest runs in #2 as a context row only.
- Diagnostics in #4, no verdict: all-off vs bm25-static, and full@365 vs all-off.
- Cosine-only is `retrieve_inprocess.mjs --mode hybrid --embedding-weight 1 --no-mmr`: the blend base is pure cosine and no product code changes.
- R-L1 and R-L1n are judged under both the round-1 substring scorer and the exact scorer. Physics goes default-off in 1.46.0 only if R-L1n is HURTS under both.

**Replication rule.** If every R-E1 epoch file matches round 1's byte for byte (meta aside), round 1's six E1 verdicts transfer unchanged and their lanes add nothing to the ledger. Otherwise all six are re-judged on the R-E1 files and each adds one lane.

**#3, conditional.** Runs only if R2b or R2d is HELPS or HURTS. Grid: half-lives 30, 90, 365, 730 by recency scales 7, 30, 90 days and no recency, 16 cells, 13 new (full@365, recency-off@365 and full@730 come from #2), 20 seeds each: 260 runs. Nominate the highest currentR5 on seeds 41 to 60, ties within 3 pp to the shorter half-life and then the 30-day scale; judge the one nominee on seeds 61 to 80. It must beat both full@365 and bm25-static on currentR5 by the rule. If #3 does not run, it is NOT-DONE with the reason.

**#1** is declared and gated to on or after 2026-09-26: reweight E1 probes by the ages of memories real recalls return, with weights fixed by an amendment before any re-score. NOT-DONE in this round.

## P0 checks (before any verdict run)

1. The default generator's `protocolHash` for seeds 21 to 40 equals round 1's run files.
2. With every switch unset, the lock build equals W-rel: full@365 and bm25-static on seed 1 give identical epochs.
3. Every new switch fires on seed 1: recency-off, `--recency-days 7`, bm25-outcome and bm25-newest each move at least one final-epoch metric against their reference arm. The v1 window moves only distractor sessions; report the share of lookalikes dated after v1 (expected about 46%), split by facts that never changed and facts that were updated.
4. The scorer fix changes only credits from `_abs` pairs on round 1's `lme-full` files: re-score all four with both rules and list every question that changed.

A failed P0 check stops the lanes it feeds.

## Workload-validity gates

- Every E1 lane: 20 of 20 seeds complete and `compare.mjs` passes its integrity checks.
- R2c: bm25-static trap persistence at least 0.20 on at least 18 of 20 seeds.
- R2a: recency-off must differ from full@365 on at least 18 of 20 seeds' final epoch.
- R4a and R4b: the v1 window must bring the share of lookalikes dated after v1 under 50% on every seed (round 1's default: 67.5%).
- LongMemEval lanes: the build aborts must not fire. The headroom rule is round 1's: if B's hit@5 is above 0.90, hit@1 becomes primary.

## Decision rule

Round 1's rule, unchanged. Benefit is A minus B for currentR5, hotR5 and hit@k, and B minus A for trap persistence, stale intrusion and contradiction intrusion.

- **Helps:** the 95% CI lower bound is above 0 and the point estimate is at least +3 pp.
- **Hurts:** the 95% CI upper bound is below 0 and the point estimate is at most -3 pp.
- **No measurable effect:** anything else. A CI that excludes 0 with a point estimate under 3 pp is labelled BELOW THE FLOOR.
- A tie goes to the simpler configuration.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

What each verdict proposes for 1.46.0:

| Lane | Helps | No measurable effect | Hurts |
|---|---|---|---|
| R-L1n (both scorers) | physics stays auto-on | physics default off | physics default off |
| R-L4 | keep the sleep recall claim | drop it | find the phase that costs recall |
| R2a recency | keep it, claim it | propose it off | turn it off |
| R2b decay | keep decay | propose decay off | turn decay off |
| R2c outcome alone | the outcome nudge carries L3a's win | L3a's win needs the full lifecycle | investigate |
| R2d 730 days | run #3 | keep the 365 nominee | keep 365 |
| R4a / R4b | claim full@365 beats BM25 | no claim against BM25 | state that BM25 wins |
| R5a / R5b / R5c | physics earns a second look | physics' loss is the BM25 term or memory length, as the pair says | physics stays off |

No default changes without an independent critique of this round first. The half-life migration of live stores is a live-data change and waits on Keith.

## Sample size and multiplicity

- E1: 20 seeds per lane, 300 facts each, hierarchical bootstrap, B = 10000. Round 1's 95% half-widths: about 1.5 pp on currentR5 and 3.7 pp on trap persistence.
- LongMemEval: 500 oracle questions, paired; half-width about 2.8 to 3.9 pp.
- **Ledger:** base N = 19 across both rounds: round 1's 9, plus R-L4, R2a to R2d, R4a and R4b, and R5a to R5c. Up to 8 more if the replication fails (six E1 re-judgements, R-L1, R-L1n), and 1 more if #3 runs: at most 28. Expected false passes at N = 19: 0.95 at 95%, 0.19 at 99%; at N = 28: 1.4 and 0.28. Every table shows the 99% interval, and a pass that holds at 95% but not at 99% is flagged.
- R-L1 and R-L1n replace round 1's L1 and L1n rather than adding lanes when the replication holds.

## Store-size diagnostic (no verdict)

Copy `~/.hippo/hippo.db` and its config into a temp directory, point `HIPPO_HOME`, `HOME` and `USERPROFILE` at it, and dry-run consolidation at +30, +90 and +365 days with half-lives as stored and as stored plus 358 days. Report how many memories each would remove. The live store is opened read-only and never written.

## Published-number check

Re-score the 10 retrieval files salvaged from PR #224's reproduction (`hippo-mech-runs/lme-reproduce-data/`, source commit `3192667`) with the exact `evaluate_retrieval.py` and `score_haystack.py`, then read `cells_q8.log`. For 74.0, 73.8, 86.8 and 99.8, state the change or the substring bound (pooled oracle: 6 twin pairs, at most 1.2 pp).

## Retraction conditions

- A P0 check fails: no verdict for the lanes it feeds.
- A `compare.mjs` integrity check fails: no verdict for that lane.
- A lane ran on a build other than the one declared above: rerun or retract.
- A LongMemEval build abort fires: no verdict for that store's lanes.
- A default changes before the independent critique: revert it.

## NOT-DONE

| Item | Why not now | Slot |
|---|---|---|
| #1 real recall ages | Needs the trace re-count | On or after 2026-09-26 |
| #3 grid | Conditional on R2b or R2d | This round, if triggered |
| E1 with the embedding blend | E1 passes no `hippoRoot`, so it measures BM25 plus the lifecycle | Next campaign |
| Half-life migration of live stores | Live-data change | 1.46.0, on Keith's yes |
| Joint bootstrap (StepM) | Lanes share arms; the 99% column is the cheap guard | Next campaign |
| Learned value, supersession, goal stack, salience | Round 1's reasons stand | Round 1's slots |
| Paid legs | Cost money | Never without a priced yes |

## Caution flags

- The v1 window is symmetric around v1, not around the current version, so it helps lookalikes of facts that never changed more than of updated ones. P0 check 3 reports the split.
- The generator amendment is opt-in; round 1's protocol is untouched.
- R2c's primary endpoint differs from the draft (see Lanes).
- The per-turn store is ingested in process, not through `hippo remember`: no schema-fit from existing tags, no path or scope tags, no markdown mirrors. Every arm on it shares the store, so the lanes compare scorers, not ingest paths.
- E1 is synthetic; LongMemEval is static, so decay and strengthening never act there.
- The author built, ran and will judge this; an independent critique rides the result.

## Commands

Lock build, E1 (#2: 7 arms by seeds 41 to 60; #4: 4 arms by seeds 81 to 100):

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
export R=<out-dir>
for s in $(seq 41 60); do
  for a in full recency-off decay-off bm25-outcome bm25-static bm25-newest; do echo "r2 $a 365 $s"; done
  echo "r2-730 full 730 $s"
done | xargs -P 16 -L 1 sh -c 'mkdir -p "$R/$0" "$R/log" && HIPPO_HOME=$(mktemp -d) node scripts/e1-lifecycle/run.mjs --arms "$1" --half-life "$2" --seeds "$3" --out-dir "$R/$0" > "$R/log/$0-$1-s$3.log" 2>&1'
for s in $(seq 81 100); do for a in full all-off bm25-static bm25-newest; do echo "$a $s"; done; done \
  | xargs -P 16 -L 1 sh -c 'mkdir -p "$R/r4" "$R/log" && HIPPO_HOME=$(mktemp -d) node scripts/e1-lifecycle/run.mjs --arms "$0" --half-life 365 --seeds "$1" --lookalike-window v1 --out-dir "$R/r4" > "$R/log/r4-$0-s$1.log" 2>&1'

node scripts/e1-lifecycle/compare.mjs --a "$R/r2:full" --b "$R/r2:recency-off" --seeds 41-60        # R2a
node scripts/e1-lifecycle/compare.mjs --a "$R/r2:full" --b "$R/r2:decay-off" --seeds 41-60          # R2b
node scripts/e1-lifecycle/compare.mjs --a "$R/r2:bm25-outcome" --b "$R/r2:bm25-static" --seeds 41-60 # R2c
node scripts/e1-lifecycle/compare.mjs --a "$R/r2-730:full" --b "$R/r2:full" --seeds 41-60           # R2d
node scripts/e1-lifecycle/compare.mjs --a "$R/r4:full" --b "$R/r4:bm25-static" --seeds 81-100       # R4a
node scripts/e1-lifecycle/compare.mjs --a "$R/r4:full" --b "$R/r4:bm25-newest" --seeds 81-100       # R4b
```

W-rel: round 1's E1 command (its prereg, Commands) into a fresh directory, then `build_mech_stores.sh`, then cosine-only on the never-slept store:

```bash
node benchmarks/longmemeval/retrieve_inprocess.mjs --data <oracle> --store-dir <run>/nosleep --output <run>/ret-nosleep-cosine.jsonl \
  --budget 1000000 --min-results 10 --top 10 --mode hybrid --embedding-weight 1 --no-mmr
```

Lock build, LongMemEval:

```bash
npm install --no-save @huggingface/transformers@4.2.0
HIPPO_MODEL_CACHE=<model-cache> bash benchmarks/longmemeval/build_turn_store.sh <turn-run> <oracle>
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <run>/ret-nosleep-physics.jsonl --b <run>/ret-nosleep-cosine.jsonl  # R5a
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <turn-run>/ret-turn-physics.jsonl --b <turn-run>/ret-turn-cosine.jsonl  # R5b
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <turn-run>/ret-turn-physics.jsonl --b <turn-run>/ret-turn-hybrid.jsonl  # R5c
node benchmarks/longmemeval/merge_audit.mjs --data <oracle> --run <run> --out <run>/audit
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <run>/audit/text/ret-sleep-hybrid.jsonl --b <run>/audit/text/ret-nosleep-hybrid.jsonl  # R-L4
```

## Results

In `2026-09-23-mechanism-audit-round2-result.md`, with the self-audit, the coverage table and the independent critique.
