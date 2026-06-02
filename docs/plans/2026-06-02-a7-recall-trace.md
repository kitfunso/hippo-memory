# A7 recall-trace — make lifecycle re-ranking explainable

Episode: `01KT4C2Z63AQB0BR9DFQQGB2HE` (dev-framework-rl). project_type: library. Status: Draft, revised round 2 after plan-eng-critic R1 (2 crit).

## Problem

hippo already explains the *match* (lexical/embedding): `ScoreBreakdown` (search.ts:187), `explainMatch()`/`recall --why` (search.ts:1122), `hippo explain` (cli.ts:1732), the C5/J1/J2/J3 hints. It does NOT explain the *lifecycle re-ranking* — the transforms that mutate `r.score` and re-sort AFTER candidate generation. That re-ranking is hippo's differentiator and is currently invisible: "why did X rank here" is only half-answerable.

## Scope decision (locked 2026-06-02)

The pre-plan audit found re-ranking is **fragmented across three pipelines**, only `applyGoalStackBoost` (goals.ts:252) shared:
- **cli.ts `cmdRecall`** — works on `SearchResult[]` (search.ts:169); inline vlPFC interference `×0.3` (1098), vmPFC value (1118), OFC utility (1144), reranker (1176), `applyGoalStackBoost` (1211), goal-stack downweight (1250).
- **api.ts `recall()`** (@624) — builds `RecallResultItem[]`; applies ONLY `applyGoalStackBoost` (747). Does NOT run interference/value/OFC.
- **mcp/server.ts `hippo_recall`** — its own physics/hybrid `SearchResult` band + `applyGoalStackBoost` (573); returns **markdown text** via `formatMemories` (785, blob at 3069); calls the boost with `limit: results.length` (vs api's `limit`).

So "all three apply the *same* traced re-ranking" = unifying three pipelines on the hot path = **A7.2** (separate, own plan). **A7 (this episode):** trace where transforms live, surface on the two surfaces that carry structured per-item data (CLI `--why`, HTTP `/v1`), instrument the shared `applyGoalStackBoost`, and **document the fragmentation + the MCP-text limitation** as the finding.

## Design

### 1. Shared trace type, two carriers
`RerankStep { stage: string; multiplier?: number; scoreBefore: number; scoreAfter: number; note?: string }`, exported from **src/api.ts** (shared types home). `stage ∈ {interference, value, utility, reranker, goal-boost, retrieval-count-downweight}` — the last names the `score *= max(0.5, count/T)` transform at cli.ts:1223-1252; the exact label is set to match that transform's real name, verified at execute (R2 found `goal-stack-downweight` was a misnomer for the retrieval-count downweight).

The CLI and api.recall work on **different objects** — the trace rides on each pipeline's own working type (this was the R1 crit: the CLI never builds `RecallResultItem`):
- **`SearchResult`** (search.ts:169) gets `rerankTrace?: RerankStep[]` — the CLI's carrier.
- **`RecallResultItem`** (api.ts:378) gets `rerankTrace?: RerankStep[]` + `rerankPipeline?: 'cli' | 'api'` — the api/HTTP carrier (additive optional, back-compat per the existing `windowSize?`/`suppressionSummary?` precedent; `client.ts:110` deserializes `as RecallResult` so the field rides through). The CLI trace does NOT flow through api.recall.

### 2. Opt-in capture, zero-cost default
- **CLI** — gated by `showWhy` (cli.ts:880). Each *inline* transform (interference 1098, value 1118, utility 1144, reranker 1176, retrieval-count downweight 1223-1252) already `.map`s over `SearchResult[]` producing `{...r, score}`; when `showWhy`, also set `rerankTrace: [...(r.rerankTrace ?? []), step]`. When `!showWhy`, the field is never written → byte-identical, zero allocation (one `if (showWhy)` branch per transform). (The `--goal` inline block at cli.ts:1193 is NOT separately instrumented: it is mutually exclusive with goal-boost via the `goalTag===''` gate at cli.ts:1208, so the goal-boost merge step below covers the goal-ranking case without a duplicate stage.)
  - **Goal-boost merge step (R2 fix):** goal-boost is NOT an inline map — it is the shared helper `applyGoalStackBoost` (cli.ts:1211), which writes its steps into a separate `opts.trace` accumulator (per the goals.ts bullet), NOT onto the row. So immediately after the 1211 call, when `showWhy`, **merge** each accumulated `RerankStep` onto the matching `SearchResult.rerankTrace` keyed by `entry.id`. Without this explicit merge the goal-boost stage would be the one stage missing from `--why`.
- **api.recall** — add `RecallOpts.explain?: boolean`. When `explain`, pass an `opts.trace` accumulator into `applyGoalStackBoost` (747). Then **wire it into the item literal (R2 fix):** in the `baseRanked` map (api.ts:807-813), when `explain`, read the accumulator keyed by `entry.id` and attach `rerankTrace` (the goal-boost step) + `rerankPipeline:'api'`; when `!explain`, leave both undefined → byte-identical default. `rerankPipeline:'api'` is set ONLY under `explain`, on every band — `baseRanked` (807-813), `summaryRanked` (817), `freshRanked` (839); under `!explain` it is absent on **all** api bands → byte-identical default (R3 fix). Only `baseRanked` passes through the goal-boost helper, so only it can carry trace steps; the summary/fresh bands set `rerankPipeline:'api'` with no steps when `explain`, and nothing when not.
- **goals.ts `applyGoalStackBoost`** — add an **optional `opts.trace` accumulator** (a `RerankStep[]` the helper pushes into, OR a `Map<entryId, RerankStep>`), **NOT a field on the result row** — the helper re-spreads rows and strips internal markers (`_goalMatches`, goals.ts:382-385), so a row field would be dropped (R1 med). The `score *` mutation + re-sort (331-337) stay untouched → byte-identical. Optional param keeps all callers compatible: api.ts:747, cli.ts:1211, mcp/server.ts:573, and `tests/goals-apply-goal-stack-boost.test.ts`.

### 3. Surfacing
- **`recall --why`** — extend BOTH render branches (R1 crit): the text block (cli.ts:1696-1721) and the JSON block (cli.ts:1569-1602), each emitting the per-result `rerankTrace`, e.g. `ranking: base 0.420 -> interference x0.3 -> 0.126 -> goal-boost x1.5 -> 0.189`.
- **`/v1/recall` (HTTP)** — `opts.explain` → `RecallResultItem.rerankTrace` carries the goal-boost step + `rerankPipeline:'api'`. The response documents (in the field's design + a one-line note) that the api pipeline applies only goal-boost; the richer CLI stages are A7.2. The trace is **complete for the api pipeline**, not "partial" — hence `rerankPipeline`, not a `…Complete:false` flag (R1 high: the single flag was self-contradictory; it is removed everywhere).
- **MCP `hippo_recall`** — **descoped to A7.2.** Its primary band is markdown text via `formatMemories` over `SearchResult` (no per-item JSON channel) and uses divergent `limit` semantics; rendering a trace into that text belongs with the unification work. Documented as a known limitation.

## Out of scope (explicit)
- Unifying the 3 ranking pipelines → **A7.2** (own plan + outside-voice).
- MCP primary-band trace → A7.2 (text-only output, divergent limit).
- Graph code (src/graph*.ts, graph-recall.ts) — the E session owns Track E.
- Default ranking behavior / scores. No DB migration (schema v37; response-shape only).

## Tests (real SQLite DB, no mocks) — per surface
1. **CLI `--why` text** — each fired stage appears in `rerankTrace`: interference (conflicting peer in results), value (value-assoc present), OFC utility (always), goal-boost (active goal — asserts the merge step lands it), retrieval-count-downweight (low `retrieval_count`). Assert ORDER, not just presence: steps appear in pipeline order (interference → value → utility → reranker → goal-boost → retrieval-count-downweight) and each step's `scoreBefore` equals the previous step's `scoreAfter` (the chain is contiguous).
2. **CLI `--why` JSON** — `rerankTrace` present on each item in the JSON branch (cli.ts:1569-1602).
3. **CLI backward-compat** — default recall (no `--why`) → CLI stdout snapshot byte-identical to pre-change AND `SearchResult.rerankTrace` undefined.
4. **api/HTTP** — `recall({explain:true})` → `RecallResultItem.rerankTrace` has the goal-boost step + `rerankPipeline:'api'`; `{explain:false}` → absent; `/v1/recall` JSON body carries it under explain.
5. **`applyGoalStackBoost` parity** — with vs without `opts.trace` → identical ordered output + identical scores (trace is a side-channel); dedicated byte-identity test.
6. **Zero-cost proxy** — on the default path the transforms never receive/allocate a trace accumulator (assert it stays undefined) — the honest, testable proxy for "no latency regression."

## Success criteria
- `recall --why` (text AND JSON) shows, per returned memory, the ordered lifecycle transforms (stage, multiplier, score before→after).
- `/v1/recall` carries `rerankTrace` (goal-boost) + `rerankPipeline:'api'` when `explain`; absent otherwise.
- Default recall byte-identical per surface, zero trace allocation; real-DB tests green for every stage + per-surface backward-compat + the goals.ts parity test.
- Fragmentation + MCP-text limitation documented; **A7.2 (unify ranking + MCP trace) filed in TODOS.md** at ship.

## Risks
- **Byte-identical default** is the load-bearing guarantee — mitigated by: separate `opts.trace` accumulator in goals.ts (untouched score/sort), `if(showWhy)` gate in cli, the goals.ts parity test (#5), and per-surface backward-compat tests (#3).
- **Partial /v1 trace misread** — mitigated by `rerankPipeline:'api'` + the documented note (no misleading "incomplete" flag).
- **Scope creep into unification / MCP** — explicitly fenced to A7.2.
