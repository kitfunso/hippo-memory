# 2026-09-23 mechanism audit: which lifecycle mechanisms help retrieval

**Status:** PRE-REG-LOCKED 2026-09-23, at the commit that adds this file. No lane had run on its verdict seeds or its full store when it was locked.

**Code under test:** hippo-memory at `6ce7e4d` (master with 1.45.0 PRs A to D). The harness changes below touch `scripts/` and `benchmarks/` only, never `src/`.

**Cost:** local CPU only. The embedder is the free local all-MiniLM-L6-v2 through `@huggingface/transformers` 4.2.0. No LLM call, no paid embedder, no paid reranker. Both run commands unset every key a paid path reads: `ANTHROPIC_API_KEY` (the sleep LLM phase, `src/consolidate.ts:512`), `OPENAI_API_KEY`, `VOYAGE_API_KEY` and `COHERE_API_KEY` (embedders, `src/embedding-provider.ts:145-178`), `HIPPO_LLM_RERANKER_KEY` and `TYPESAFE_API_KEY` (rerankers).

## Why

The README and the Sep-23 architecture review list nine mechanisms. Their evidence is a mix of pilots, one registered E1 run on June code, and nulls. Several are on by default anyway. This campaign asks one question per mechanism: on the same data, with the mechanism on and then off, does retrieval get better, worse, or stay the same?

Five mechanisms get lanes here. The other four are in NOT-DONE with a reason and a slot.

## Mechanism claims under test

| Lane | Mechanism | Claim | A (on) vs B (off) | Primary endpoint |
|---|---|---|---|---|
| L1 | Physics scorer | Physics ranking finds the answer session more often than hybrid ranking | physics vs hybrid, slept store | hit@5 (headroom rule) |
| L1n | Physics scorer | Same, on a store where every memory has a particle | physics vs hybrid, never-slept store | hit@5 (headroom rule) |
| L2 | Decay default | A 365-day base half-life keeps the current fact in the top five more often than the 7-day default | full@365 vs full@7 | currentR5, plus two guards |
| L2g | Whole lifecycle | Decay, strengthening and outcome feedback together at 365 days beat no lifecycle | full@365 vs all-off | currentR5 |
| L3a | Outcome feedback | A memory marked bad stops showing up in the top five | full vs outcome-off, at 365 and at 7 | trap persistence |
| L3b | Retrieval strengthening | Facts recalled often stay findable | full vs strengthen-off, at 365 and at 7 | hotR5 |
| L4 | Sleep consolidation | A sleep pass leaves the answer session at least as findable | slept vs never-slept, hybrid | hit@5 (headroom rule) |

L3a and L3b report both half-lives. The verdict row is the half-life that ships: 365 if L2 passes with both guards, else 7.

## (a) Source-read

Product code at `6ce7e4d`:

- `src/memory.ts:309` `calculateStrength(entry, now = evalNow(), options = {}): number`. Strength decays on `effectiveHalfLife = entry.half_life_days * rewardFactor` (`:332`), so outcome feedback acts through the half-life.
- `src/memory.ts:390` `deriveHalfLife(base: number, entry: Partial<MemoryEntry>): number`; `:479` `DEFAULT_HALF_LIFE_DAYS = 7`; `createMemory` (`:489`) sets `half_life_days = deriveHalfLife(options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS, partial)` (`:530`).
- The product default reaches `createMemory` through `config.ts:108` (`defaultHalfLifeDays`), `cli.ts:911`, `api.ts:274` and `mcp/server.ts:1190`. L2 sets the same `baseHalfLifeDays` through `run.mjs --half-life`.
- `src/memory.ts:424` `applyOutcome(entry: MemoryEntry, good: boolean): MemoryEntry`.
- `src/search.ts:349` `hybridSearch(query, entries, options)`: a relevance score (BM25, blended with embedding similarity only when `options.hippoRoot` is set, `:460-465`) times a strength factor from `calculateStrength` and a recency factor (`:574-593`). E1 passes no `hippoRoot`, so E1 measures BM25 plus the lifecycle; the LongMemEval lanes pass it and get the blend.
- The strengthen-off arm sets `HIPPO_ABLATE_RECALL_BOOST`, which removes every recall effect: `markRetrieved` (`src/search.ts:1254`) returns early (`:1255`), strength drops the retrieval boost (`src/memory.ts:368-370`), and decay counts from creation instead of the last recall (`src/memory.ts:325-327`).
- `src/search.ts:866` `physicsSearch(query, entries, options)`. It falls back to `hybridSearch` when the embedder is unavailable, needs a reindex or fails (`:913-925`), or when physics state fails to load (`:937-938`). A memory joins the physics pool only if it has a particle whose vectors match the query's length; every other memory goes to a classic pool (`:946-971`). The classic pool is scored with `hybridSearch` (`:1051-1053`), and `mergeScorePools` (`:1056`) merges the two pools after dividing each by its own top score (`:1074-1086`).
- `src/consolidate.ts:119` `consolidate(hippoRoot: string, options: { dryRun?, now?, fetcher? }): Promise<ConsolidationResult>`: the sleep pass. Its result counts decayed, removed, merged, semantic-created and replayed memories (`:126-131`); the physics step runs at `:631-672`.
- `src/physics-config.ts:38` `enabled: 'auto'` (also `config.ts:119` and `:150`).
- Where physics runs: the CLI only when the recall has no global-store entries (`cli.ts:1160`, `:1165`, `:1249`); the MCP server whenever `physics.enabled !== false` (`mcp/server.ts:612`, `:1102`); `api.ts:2721` likewise; `api.ts:718` when the caller asks for mode physics. So physics shapes every default MCP recall.

Harness:

- `scripts/e1-lifecycle/run.mjs:95` `probeEpoch(...)`: read-only probes, top five by `hybridSearch` with an explicit `now`. `:230` creates every memory with `baseHalfLifeDays: SWEEP_HALF_LIFE`. `:61-69` hold the arm flags. The final epoch keeps one row per probe.
- `scripts/e1-lifecycle/compare.mjs`: paired, hierarchical bootstrap (resample seeds, then probes within each seed), one mulberry32(1) stream per row, B = 10000, following June's `analyze.mjs`.
- `benchmarks/longmemeval/paired_hits.mjs`: session-level hit@k by the `check_session_hit` rule (a hit when the session id is a tag, a tag contains it, or the content carries `[Session: <id>]`), paired bootstrap over questions.
- `benchmarks/longmemeval/build_mech_stores.sh`: one ingest, a never-slept and a slept copy, four retrieval passes. It aborts unless every memory is embedded, and unless the never-slept store has one particle per memory.

## (b) Dry-runs: every mechanism fires

Run before the lock, on data the verdicts never use.

E1, seed 1 (the verdict seeds are 21 to 40):

| Comparison | Endpoint | A minus B, pp | 95% CI |
|---|---|---|---|
| full@365 vs full@7 | currentR5 | +45.0 | [39.0, 51.0] |
| full@365 vs outcome-off@365 | trap persistence | -55.6 | [-68.9, -40.0] |
| full@365 vs strengthen-off@365 | hotR5 | +5.3 | [0.0, 12.0] |

Strengthening fires only weakly at 365 days on one seed. June's registered run measured it at 7 days: strengthen-off minus full, hotR5 -26.9 [-29.9, -23.9].

LongMemEval, 20 oracle questions pooled into one 48-memory store:

| Comparison | Top-5 lists that differ |
|---|---|
| physics vs hybrid, never-slept | 20 of 20 |
| physics vs hybrid, slept | 20 of 20 |
| slept vs never-slept, hybrid | 2 of 20 |
| slept vs never-slept, physics | 20 of 20 |

Levels on those 20: never-slept hybrid hit@5 100% and hit@1 95%; never-slept physics hit@5 95% and hit@1 85%.

**Bug found by the dry run.** Sleep merged two episodic memories into one new semantic memory and removed one duplicate (its log: merged 2, new semantic 1, deduped 1). After `hippo embed` the new memory has a vector but no particle: 48 memories, 47 particle rows. In physics mode it sits alone in the classic pool, `mergeScorePools` divides it by its own score, and it scores 1.0: rank 1 on 20 of 20 questions. Hybrid ranks it first on 1 of 20; never-slept physics never returns it. L1 measures physics as shipped, so the bug stays in L1. L1n measures the scorer without it.

## P0: harness fidelity and code drift since June

- The harness edits only add fields. full@7 seed 1 run with the edited `run.mjs` and with the committed one gives identical aggregates.
- The environment is deterministic. June's worktree (tag `e1-generator-freeze`, `4981910`) reproduces June's registered raw file for full@7 seed 1 exactly.
- Today's product code moves that run: 45 of 240 aggregate fields differ from June. Final epoch, today vs June: currentR5 0.327 vs 0.320, stale intrusion 0.483 vs 0.475, trap persistence 0.044 vs 0.067 (one probe of 45).
- So no June number enters a verdict. Every arm is re-measured on `6ce7e4d`. June's numbers below only sized the lanes. The drift is not bisected (NOT-DONE).
- `compare.mjs` against June's registered data (seeds 1 to 20, June's validated probe rows) reproduces all four registered H2 point estimates and three of the four intervals exactly: full vs all-off currentR5 -40.2 [-41.7, -38.6]; decay-off vs full stale +43.8 [41.3, 46.5]; outcome-off vs full trap +25.4 [21.8, 29.2]. The fourth, strengthen-off vs full hotR5 -26.9, gives [-29.9, -23.6] against the registered [-29.9, -23.9]. That 0.3 pp gap on one bound is not traced.

## Workload-validity gates

A lane whose control arm fails its gate reports "no verdict: the workload did not exercise the mechanism".

- Every E1 lane: 20 of 20 seeds complete, and `compare.mjs` passes its integrity checks (same protocol hash across arms, aligned probe rows, probe rows equal to the stored aggregates).
- L2: decay at 7 days must bite. full@7 currentR5 below all-off on at least 18 of 20 seeds.
- L3a: marked-bad memories must persist without feedback. outcome-off trap persistence at least 0.20 on at least 18 of 20 seeds, at each half-life.
- L3b: strengthening needs room to help. strengthen-off hotR5 at most 0.90 on at least 18 of 20 seeds, at each half-life.
- L1, L1n, L4: the build script's two aborts must not fire.
- **Headroom rule.** If never-slept hybrid hit@5 on the full store is above 0.90, the primary endpoint of L1, L1n and L4 becomes hit@1. The rule reads the control arm's level only, so no physics or sleep result can steer it. At ceiling a lane can show harm but not help; the tie rule then turns the mechanism off, which puts the burden of proof on the mechanism.

## Decision rule

Benefit points the good way. For currentR5, hotR5 and hit@k it is A minus B. For trap persistence, stale intrusion and contradiction intrusion it is B minus A. A is the arm with the mechanism on; in L2 it is the proposed default.

- **Helps:** the 95% CI lower bound is above 0 and the point estimate is at least +3 pp.
- **Hurts:** the 95% CI upper bound is below 0 and the point estimate is at most -3 pp.
- **No measurable effect:** anything else.
- A tie goes to the simpler configuration: the mechanism off.

**This verdict is only as good as this rule. Attack the rule, not just the numbers.**

The 3 pp floor is about twice E1's hierarchical half-width on currentR5 and close to LongMemEval's half-width at n = 500, so a pass is an effect a user could notice.

What each verdict proposes for 1.46.0. No default changes without Keith's sign-off at the gate and an independent critique of this campaign first.

| Lane | Helps | No measurable effect | Hurts |
|---|---|---|---|
| L1 physics, slept | physics stays auto-on | `physics.enabled` default becomes false | same as no effect |
| L1n physics, never slept | re-test L1 once the merge bug is fixed | physics stays off after the fix | same as no effect |
| L2 decay default | default becomes 365, if both guards pass | stays 7 | stays 7 |
| L2g whole lifecycle | the lifecycle earns its place | propose the lifecycle off by default | same as no effect |
| L3a outcome feedback | keep it, claim the number | propose it off | turn it off |
| L3b strengthening | keep it, claim the number | propose it off | turn it off |
| L4 sleep | claim the number | drop the recall claim from the docs; sleep stays for store upkeep | find the phase that costs recall before changing sleep |

The merge bug gets fixed whatever L1 says. L1n says whether physics deserves a second test after the fix.

### L2 guards: the cost of keeping old memories longer

A longer half-life keeps superseded facts and marked-bad memories around longer. Two guards check that this cost cannot flip the win at real-use rates.

`compare.mjs` scores a query exposed to an intruder (a superseded version, or a memory marked bad) as a hit only when the current fact is in the top five and the intruder is not. A query with no intruder scores a plain hit. The mix is linear in the exposed share, so one break-even share s* makes 365 and 7 tie, and 365 wins below it. A guard passes when the 95% lower bound of s* is above the real-use share.

Real-use shares, read from the live dogfood store (`~/.hippo/hippo.db`, read-only) on 2026-09-23, 2119 live memories:

| Intruder | Upper proxy (the guard) | Lower bound |
|---|---|---|
| Superseded | 150 of 2119 (7.1%): live memories named in `memory_conflicts` | 4 of 2119 (0.19%): `superseded_by` set |
| Marked bad | 29 of 2119 (1.4%): `outcome_negative > 0` | 12 of 2119 (0.57%): more negative than positive outcomes |

The conflict flags come from lexical rules (1135 enabled/disabled, 527 negation and 18 always/never rows, all resolved), so 7.1% likely over-counts real supersession. Negative outcomes are rarely recorded, so 1.4% may under-count misleading memories. A share of memories stands in for a share of queries.

**Disclosure.** The guard form was chosen after the seed-1 peek. On seed 1, 365 vs 7 gave trap persistence +13.3 pp, stale intrusion +38.3 pp, superseded s* 87.3% [74.9, 100.0] and marked-bad s* 100%. The thresholds come from the dogfood store, which the peek cannot move. An earlier draft capped the trap increase at +10.9 pp with no recorded derivation, and used a 19% superseded share (407 of 2119) whose 407 counted 257 memories no longer in the store. Both are withdrawn.

### The L2 nominee

June's sweep of full currentR5 by half-life (`hippo-paper/results/e1/SWEEP-DECISION.md`): 7 days 0.307, 30 days 0.505, 90 days 0.684, 365 days 0.757; all-off 0.709. 365 days was the highest. The same sweep put 365-day stale intrusion at 0.873 against 0.44 at 7 days, which is why L2 carries guards. The nominee rule (highest wins, ties within 3 pp go to the shorter half-life) was written after seeing that sweep. One nominee, one lane, no search on the verdict seeds.

## Baselines

bm25-static (BM25 only, lifecycle off) and recency-window (the five newest memories) run on every E1 seed. Every E1 verdict row is reported beside both, so each result names the naive strategy it beats. They are context rows, not lanes.

## Sample size and multiplicity

- **E1:** 20 seeds (21 to 40), 300 facts each. June's per-seed spread of the paired difference: 1.37 pp for currentR5 365 vs 7, 1.65 pp for full vs all-off, 4.96 pp for trap persistence 365 vs 7. June's registered hierarchical 95% half-widths: about 1.5 pp on currentR5 and 3.7 pp on trap persistence.
- **LongMemEval:** 500 oracle questions, 940 unique sessions pooled into one store, paired. With 10% to 20% of questions discordant, the 95% half-width is about 2.8 pp to 3.9 pp.
- **Ledger:** N = 9 verdict lanes (L1, L1n, L2, L2g, L3a and L3b at two half-lives each, L4). Expected false passes: 0.45 at 95%, 0.09 at 99%. Every table shows the 99% interval too, and a pass that holds at 95% but not at 99% is flagged. The L2 guards are gates on L2, not extra lanes. The lanes share arms, so a joint bootstrap would be tighter than N times alpha; it is in NOT-DONE.

## Retraction conditions

- A `compare.mjs` integrity check fails: no verdict for that lane.
- A lane ran on code other than `6ce7e4d` plus this harness: rerun it or retract it.
- The June-to-today drift turns out to come from the harness, not the product: retract every E1 verdict.
- A full LongMemEval store fails a build abort: no L1, L1n or L4 verdict.
- A default changes on these results before the independent critique: revert it until the critique is done.

## NOT-DONE

| Item | Why not now | Slot |
|---|---|---|
| Learned value | Its fitted weights sit on the strength formula that L2 may change | Re-fit and re-test after L2 settles |
| Supersession links | E1 never writes `superseded_by`; its stale suppression comes from decay and recency, so the 0.475 vs 0.825 figure measures the lifecycle, not the link | Needs a harness that supersedes |
| Goal stack | Its eval tied 20 of 20; no workload yet where a goal changes what should be retrieved | Fix-or-cut call in 1.46.0 |
| Salience gate | Off by default; its harm is recorded (recall 81 to 15) | Only if someone proposes turning it on |
| Strengthening on real use | Needs about 90 days of recall traces | Trace re-count on or after 2026-09-26 |
| Outcome feedback on real use | Real outcomes are sparse | Replay on or after 2026-12-23 |
| Physics after many sleeps | This campaign runs one sleep | After the merge-bug fix |
| Joint bootstrap (StepM) and H4 | Effects are expected to be large next to the intervals; the 99% column is the cheap guard | Next campaign |
| Bisecting the June-to-today drift | Does not change any verdict here, since June numbers are excluded | Open |
| Paid legs (LLM sleep phases, paid embedders, rerankers) | Cost money | Only on a priced yes |

## Caution flags

- E1 is synthetic: generated facts, versions, traps and schedules.
- The author built, ran and will judge this. An independent critique is required before any default ships.
- The decision rule was written after seeing June's descriptives, and the guard form after the seed-1 peek.
- LongMemEval is static: no time passes inside the store, so decay and strengthening never act there. L1, L1n and L4 test the scorer and the sleep pass, not the lifecycle.
- The dogfood store decays on an adaptive basis; E1 decays by days.
- The embedder is an optional peer dependency. A plain `npm ci` installs none, and then hybrid silently drops to BM25 and physics drops to hybrid. The build installs `@huggingface/transformers@4.2.0` with `--no-save`, pins `HIPPO_MODEL_CACHE`, and aborts unless every memory is embedded.

## Commands

E1, 9 arms by 20 seeds (180 runs):

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
export R=<out-dir>
for s in $(seq 21 40); do
  for a in full outcome-off strengthen-off all-off bm25-static recency-window; do echo "$a 7 $s"; done
  for a in full outcome-off strengthen-off; do echo "$a 365 $s"; done
done | xargs -P 16 -L 1 sh -c 'mkdir -p "$R/hl$1" "$R/log" && HIPPO_HOME=$(mktemp -d) node scripts/e1-lifecycle/run.mjs --arms "$0" --half-life "$1" --seeds "$2" --out-dir "$R/hl$1" > "$R/log/$0-hl$1-s$2.log" 2>&1'

node scripts/e1-lifecycle/compare.mjs --a "$R/hl365:full" --b "$R/hl7:full"            # L2 and its guards
node scripts/e1-lifecycle/compare.mjs --a "$R/hl365:full" --b "$R/hl7:all-off"         # L2g
node scripts/e1-lifecycle/compare.mjs --a "$R/hl365:full" --b "$R/hl365:outcome-off"   # L3a at 365
node scripts/e1-lifecycle/compare.mjs --a "$R/hl7:full" --b "$R/hl7:outcome-off"       # L3a at 7
node scripts/e1-lifecycle/compare.mjs --a "$R/hl365:full" --b "$R/hl365:strengthen-off" # L3b at 365
node scripts/e1-lifecycle/compare.mjs --a "$R/hl7:full" --b "$R/hl7:strengthen-off"    # L3b at 7
```

LongMemEval:

```bash
npm install --no-save @huggingface/transformers@4.2.0
HIPPO_MODEL_CACHE=<model-cache> bash benchmarks/longmemeval/build_mech_stores.sh <run> <longmemeval_oracle.json>
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <run>/ret-sleep-physics.jsonl --b <run>/ret-sleep-hybrid.jsonl      # L1
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <run>/ret-nosleep-physics.jsonl --b <run>/ret-nosleep-hybrid.jsonl  # L1n
node benchmarks/longmemeval/paired_hits.mjs --data <oracle> --a <run>/ret-sleep-hybrid.jsonl --b <run>/ret-nosleep-hybrid.jsonl     # L4
```

Dogfood shares (read-only): `SELECT COUNT(*) FROM memories WHERE outcome_negative > 0`, and the count of live memories whose id appears in `memory_conflicts.memory_a_id` or `memory_b_id`.

## Fixtures

- E1: `scripts/e1-lifecycle/generate.mjs`, seeds 21 to 40, its defaults of 300 facts, 20 sessions and at least 10 hard negatives per fact (`:96`, `:321-323`). Sentinel check: the probe query is the fact's entity and attribute (`:221`), each fact, update or trap memory is that pair plus a connective and one opaque value token (`:158-210`), and a hit is scored on the current version's token (`run.mjs:124-125`). So the scored token can never come from the query. Probes are read-only: `probeEpoch` calls `hybridSearch` and never `markRetrieved`.
- LongMemEval: `longmemeval_oracle.json`, 500 questions, 940 unique sessions. Every pooled session id starts with `answer_`, so the id prefix in the tags carries no signal.

## Results

In `2026-09-23-mechanism-audit-result.md`, with the self-audit, the coverage table and the independent critique.
