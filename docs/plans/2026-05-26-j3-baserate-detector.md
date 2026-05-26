# J3 reference-class / planning-fallacy detector — Plan v1

Status: Draft (not yet engineering-reviewed)
Episode: 01KSJCRSFGYY0KP9W7EEGN553S
Roadmap reference: `ROADMAP-RESEARCH.md` L542, Track J [next]
Branch: `feat/j3-baserate-detector` off master at `0a3d03c`

## Problem

When the calling agent makes a forward-looking claim ("this will take 2 days", "rollout is low-risk", "estimate 5 days"), hippo should surface base-rate stats from closed `prediction` objects in the same class so the agent can anchor on its own track record rather than the inside view. Lovallo-Kahneman (2003) inside-vs-outside view applied to agent estimation. Data substrate (E2 predictions table) just landed at master `0a3d03c`.

## Framing (from brainstorm + grill)

**Reactive (agent calls explicitly via MCP / CLI / HTTP).** v1 = reactive only. The MCP tool description anchors the use case ("call when you make a forward-looking claim"); auto-injection on recall is a research problem (forward-claim NLP detection) and deserves its own follow-up episode (J3 v2 or J4 substitution detector). Grill's weakest premise: "agent self-discovers when to use the tool." Mitigation: tool description + agent prompting carry the discoverability; if v1 use rate is low, v0.32 can add auto-injection.

## Field shape (PredictionBaserate)

```typescript
export interface PredictionBaserate {
  classTag: string;
  nClosed: number;          // count of closure_state='closed' rows with both estimate + actual non-null
  meanEstimate: number | null; // null when n=0
  meanActual: number | null;
  meanRatio: number | null;  // mean(actual / estimate); null when n=0 OR any estimate=0
  p50Ratio: number | null;   // median ratio
  mae: number | null;        // mean(|actual - estimate|)
  /** Human-readable summary, e.g. "Last 5 estimates in class migration-effort averaged 2.1x actual (MAE 1.4 days)." Empty string when nClosed=0. */
  summary: string;
}
```

## In scope

1. `computePredictionBaserate(hippoRoot, tenantId, classTag)` helper in `src/predictions.ts`. Filters closure_state='closed' AND estimate_value IS NOT NULL AND actual_value IS NOT NULL. Computes 5 stats + summary string. Single SELECT (cheap; v1 scale ≪ 10K rows per tenant).
2. New audit op `predict_baserate` lockstep across `src/cli.ts` + `src/server.ts` VALID_AUDIT_OPS + `src/audit.ts` AuditOp union per v1.11.5 CRIT A institutional rule. Audit metadata: `{ class_tag, n_closed }` (no claim_text leakage).
3. CLI `hippo predict baserate --class <c>` subcommand. Routes through `cmdPredict` (new sub-handler). Emits `predict_baserate` audit. Prints the summary string + the 5 numeric stats.
4. HTTP `GET /v1/predictions/stats?class=X` route. Bearer-auth + tenant-scoped. Returns `{ baserate: PredictionBaserate }`. Validates `class` is non-empty.
5. MCP `hippo_predict_baserate` tool. TOOLS array entry with description anchoring the use case ("call when you make a forward-looking claim"). Dispatch case returns the formatted baserate as text. Tool input: `{ class_tag: string }`.
6. Python SDK: `PredictionBaserate` Pydantic model with snake_case fields. `Hippo.get_prediction_baserate(class_tag)` async method + `HippoSync.get_prediction_baserate(class_tag)` sync mirror. Export from `__init__.py`.
7. Tests: store-level computePredictionBaserate cases (empty, one closed, multiple closed, mixed open+closed, all categorical) + HTTP route + MCP tool + Python Pydantic + Hippo method shape.
8. CHANGELOG entry under `## Unreleased` (em-dash-free per recurring failure memory).

## Out of scope (explicit, deferred)

- Auto-injection on recall (J3 v2 or J4 substitution detector). Needs forward-claim NLP detection.
- Persistent base-rate cache. Recompute on demand is cheap at v1 scale; cache adds invalidation complexity.
- Bayesian smoothing for small-n classes (n=2 baserate is noisy). v1 reports raw n + stats; consumers decide whether to trust.
- Per-class thresholds (J3 doesn't classify "clean" vs "regressed" itself; surfaces raw stats and the agent decides).
- 30-task estimation eval (per the roadmap success criterion). Requires a synthetic estimation workload that doesn't exist yet. v1 ships the mechanism; eval is its own follow-up episode.

## Files modified

| File | Change |
|---|---|
| `src/predictions.ts` | New `PredictionBaserate` interface + `computePredictionBaserate(hippoRoot, tenantId, classTag)` helper. Single SQL query against predictions table with WHERE filters; in-memory aggregation for mean/median (predictions per class are small). |
| `src/cli.ts` | Extend `cmdPredict` with `baserate` subcommand. Add `predict_baserate` to `VALID_AUDIT_OPS` set. |
| `src/server.ts` | New `GET /v1/predictions/stats?class=X` route. Add `predict_baserate` to `VALID_AUDIT_OPS` set. |
| `src/audit.ts` | Extend `AuditOp` union with `predict_baserate`. |
| `src/mcp/server.ts` | New `hippo_predict_baserate` tool definition in TOOLS array + dispatch case. |
| `python/src/hippo_memory/models.py` | New `PredictionBaserate` Pydantic model. |
| `python/src/hippo_memory/client.py` | New `Hippo.get_prediction_baserate(class_tag)` async method. |
| `python/src/hippo_memory/sync_client.py` | Sync mirror. |
| `python/src/hippo_memory/__init__.py` | Export `PredictionBaserate`. |
| `tests/predictions-baserate.test.ts` | NEW. Store helper cases. |
| `tests/http-predictions-stats.test.ts` | NEW. HTTP route + audit emission. |
| `python/tests/test_predictions.py` | Extend with baserate Pydantic + method shape tests. |
| `CHANGELOG.md` | Entry under `## Unreleased`. |

## Implementation tasks (ordered)

**Task 1 — computePredictionBaserate helper.** In `src/predictions.ts`, add:
- `interface PredictionBaserate` per field shape above.
- `function computePredictionBaserate(hippoRoot: string, tenantId: string, classTag: string): PredictionBaserate` — opens db, SELECT estimate_value, actual_value FROM predictions WHERE tenant_id = ? AND class_tag = ? AND closure_state = 'closed' AND estimate_value IS NOT NULL AND actual_value IS NOT NULL. Compute stats in JS. Construct summary string. Audit-emit is the caller's job (CLI / HTTP / MCP each emit at their own site).
- Edge cases: nClosed=0 → all stats null + summary "" (consumers render "No closed predictions in class X yet."); estimate_value=0 in a row → exclude from ratio calc but include in nClosed (still useful for MAE).

**Task 2 — Audit op lockstep.** Add `'predict_baserate'` to:
- `VALID_AUDIT_OPS` set at `src/cli.ts` (~L4844)
- `VALID_AUDIT_OPS` set at `src/server.ts` (~L83)
- `AuditOp` union at `src/audit.ts` (~L144 after `predict_close`)

Per v1.11.5 CRIT A institutional rule. Audit metadata: `{ class_tag: string, n_closed: number }`.

**Task 3 — CLI subcommand.** Extend `cmdPredict` in `src/cli.ts`. Route on `args[0] === 'baserate'`. Flag `--class <c>` required. Call `computePredictionBaserate`, print summary + stats table. Emit `predict_baserate` audit via `emitCliAudit`.

**Task 4 — HTTP route.** Add `GET /v1/predictions/stats` in `src/server.ts`. Query param `class` required. Bearer-auth via `buildContextWithAuth`. Returns `{ baserate: PredictionBaserate }`. Emit `predict_baserate` audit via `appendAuditEvent`.

**Task 5 — MCP tool.** Add `hippo_predict_baserate` to TOOLS array with description: "Get base-rate stats for closed predictions in a class. Call this when you make a forward-looking claim (effort estimate, rollout risk, deadline) to anchor on your past track record rather than the inside view. Returns count + mean estimate + mean actual + mean ratio + median ratio + MAE + human-readable summary." Input schema: `{ class_tag: { type: 'string', description: '...' } }`, required `[class_tag]`. Dispatch case returns the summary string + JSON stats block.

**Task 6 — Python SDK.** Add to `python/src/hippo_memory/models.py`:
- `class PredictionBaserate(_Base)` with 8 fields (snake_case, all optional except class_tag + n_closed).

Add to `python/src/hippo_memory/client.py`:
- `async def get_prediction_baserate(self, class_tag: str) -> PredictionBaserate`.

Mirror on `HippoSync`. Export from `__init__.py`.

**Task 7 — Tests.**
- `tests/predictions-baserate.test.ts`: 6 cases. (a) empty class returns nClosed=0 + null stats; (b) one closed prediction returns n=1 stats; (c) multiple closed predictions compute correct mean/median/MAE; (d) open + closed mixed only counts closed; (e) closed-unknown excluded (no actual_value); (f) tenant scoping (cross-tenant returns empty).
- `tests/http-predictions-stats.test.ts`: 3 cases. (a) GET returns baserate JSON; (b) missing class param → 400; (c) audit log has predict_baserate row post-call.
- Extend `python/tests/test_predictions.py`: 2 cases. PredictionBaserate round-trip + Hippo/HippoSync method shape.

**Task 8 — CHANGELOG.** Under `## Unreleased`. Em-dash-free.

## Test commitments

- `npm run build` clean.
- `npm test` full suite green (1939+ pass; pre-existing openclaw failure stays out of scope).
- `cd python && pytest` green.

## Success criteria

1. `hippo predict baserate --class migration-effort` prints "Last N estimates averaged X.Yx actual (MAE Z days)." when N>0.
2. HTTP `GET /v1/predictions/stats?class=X` returns the same PredictionBaserate JSON shape.
3. MCP `hippo_predict_baserate` tool callable by an agent in a hippo MCP session, returns the summary text.
4. Python SDK `await hippo.get_prediction_baserate("X")` returns a PredictionBaserate.
5. `audit_log` records `predict_baserate` events with `{ class_tag, n_closed }` metadata.
6. nClosed=0 returns null stats + empty summary; consumers render appropriate "no data yet" message.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Division by zero (estimate_value=0) in ratio calc | Filter rows with estimate_value=0 from ratio computation; still count in nClosed for MAE. |
| Small-n base rates noisy | v1 reports raw n; consumers decide trust. Bayesian smoothing is a v0.32 follow-up. |
| Categorical predictions (no estimate_value) inflate apparent class size | WHERE estimate_value IS NOT NULL excludes them from baserate calc. nClosed reflects numerically-comparable predictions only. |
| Median computation on tiny arrays | JS array sort + middle pick is fine at v1 scale. |
| Audit emit at 3 sites drift | Use a single helper `appendBaserateAudit(db, tenantId, actor, classTag, nClosed)` in src/predictions.ts so all 3 call sites emit the same shape. |

## Verification approach (verify stage)

1. `npm run build && npm test` full suite green.
2. `cd python && pytest` green.
3. Manual smoke: `hippo predict "test" --class smoke --estimate 1` then `hippo predict close <id> --state closed --actual 2` then `hippo predict baserate --class smoke` → expects `n_closed=1 mean_ratio=2.0`.
4. HTTP smoke: `curl -X GET http://127.0.0.1:6789/v1/predictions/stats?class=smoke -H "Authorization: Bearer ..."`.

## Effort

~4d single engineer. No new table, no schema migration. Adds 1 helper + 1 audit op + 4 surface integrations + tests.

## /grill-me responses (orchestrator self-interrogation, recorded pre-critic)

Adversarial pass on v1 surfaced 3 fixes. Folded into v2 amendments below.

1. **MCP response format claim ("JSON stats block")** is inconsistent with how MCP tools actually return data. MCP `hippo_recall`, `hippo_drill`, etc. return TEXT strings via `formatMemories`-style helpers; there is no structured JSON return surface on the MCP tool wire. **Fix:** Task 5 amended to return a text-only response: the summary string PLUS the formatted stats line (e.g. "n=5, mean_ratio=2.1, p50_ratio=1.9, MAE=1.4 days"). No "JSON stats block" claim.

2. **Audit emit drift across 3 sites.** Risk-row mentioned a shared helper but Tasks 3/4/5 don't reference it. **Fix:** new helper `emitBaseratesAudit(db, tenantId, actor, classTag, nClosed)` in `src/predictions.ts` is the SINGLE call site for the audit op; CLI/HTTP/MCP all call this helper rather than each constructing the audit metadata directly.

3. **estimate_value=0 division-by-zero edge case** is documented in Risks but not in the actual implementation guidance. **Fix:** Task 1 amended to specify: `meanRatio` filters rows where estimate_value=0 before dividing; `mae` and `nClosed` still count those rows. Sub-stat `nRatioEligible` exposed in the response so consumers can spot when ratio reflects fewer rows than the count.

## Plan v2 amendments (override Task descriptions where they conflict)

- **Task 1 amended:** Add `nRatioEligible: number` field to PredictionBaserate (count of rows where estimate_value > 0 AND actual_value IS NOT NULL). meanRatio + p50Ratio computed from that subset. nClosed remains the full closed-with-actual count; MAE uses nClosed.
- **Task 2 amended:** New `emitBaserateAudit(db, tenantId, actor, classTag, nClosed)` helper in src/predictions.ts. CLI/HTTP/MCP all call this. Metadata pinned at one site; drift eliminated.
- **Task 5 amended:** MCP tool response is a single text block: summary line + stats line. No structured JSON. Matches the existing tool-text pattern (formatMemories, etc.).

## Status: Draft v2 (grill responses folded). Awaiting plan-eng-critic.
