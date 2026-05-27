# J1 anchoring detector (recall-recurrence) — Plan v3

Status: Round 3 (round 2 plan-eng-critic returned fail score 78 with 2 NEW CRITs from the v2 patches: CHANGELOG row in Files-modified table still pointed at ghost `## Unreleased` even after Task 11 was fixed, and the v2 architectural claim "ONE ring buffer shared across pipelines" contradicted Tasks 4/5/6 each owning their own Map. Round-3 patches: drop shared-ring claim and document explicit per-pipeline rings; fix the Files-modified CHANGELOG row; specify api.recall.anchoringHint is null on CLI-routed paths; update api.ts:483-489 JSDoc; normalize RingBuffer type name; document MCP/HTTP also emit `recall_anchor_skipped_no_session` when sessionId absent.)
Episode: 01KSK37TBH5CP7A8C76BZ34W63
Roadmap reference: `ROADMAP-RESEARCH.md` L546 (Track J [planned])
Branch: `feat/j1-anchoring-detector` off master at `8cdb8b3`

## Problem

When an agent reasons across a session, the same memory can dominate recall results across semantically-distinct queries, OR the agent can re-issue a near-identical query whose top-1 result has gone stale. Both patterns are anchoring (Kahneman TFAS ch.11 / Tversky-Kahneman 1974): the recall acts as a fixed point that pulls subsequent reasoning, regardless of whether the anchor is authoritative or arbitrary.

Hippo currently has no signal for either pattern. The `suppressedByInterference` counter on `RecallResult.suppressionSummary` (api.ts:484) is wired as a placeholder, hardcoded to 0, documented as "populated by future B4-depth or J1-anchoring work" — and tests/api-recall-suppression-summary.test.ts:105 locks "always 0 in v1.12.13 (placeholder for future B4/J1 work)". J1 lights it up.

## Framing (from brainstorm + audit reframe)

The brief originally described a numeric-anchor regex detector (Kahneman TFAS ch.11 anchoring effect on numeric estimates). The pre-plan audit caught that ROADMAP-RESEARCH.md L546 defines J1 differently: recall-recurrence detection (top-1 reuse / same-memory-wins). The roadmap's definition is canonical AND has an existing wire to populate (suppressedByInterference). Reframed to roadmap J1.

Picked C-prime: **both rules R1 + R2 via in-memory ring buffer, caller-tracked**. api.recall reads `opts.recallHistory` (a snapshot of the caller's ring) but never mutates — preserves the locked `api-recall-no-side-effects.test.ts` contract. Callers (CLI cmdRecall, MCP hippo_recall, HTTP /v1/memories) each maintain a `Map<sessionId, RingBuffer>` and pass the snapshot per recall.

Composes with J3.2: both can fire on the same recall (planningFallacyHint + anchoringHint are independent signals).

## Field shape (AnchoringHint)

```typescript
export type AnchoringReason = 'query_repeat' | 'memory_dominance';

export interface AnchoringHint {
  reason: AnchoringReason;
  /** The memory ID that is anchoring the agent's reasoning. */
  memoryId: string;
  /** For 'memory_dominance': how many distinct queries in the recent window
   *  had this memory as their top-1 result. Always >=3 when emitted. */
  queryCount?: number;
  /** Human-readable summary, e.g.
   *  "Memory mem_abc has been the top result for the last 4 distinct queries
   *   in this session — it may be anchoring your reasoning."
   *  or
   *  "Same query phrasing as 2 turns ago returned the same top result (mem_abc)
   *   — you may be re-asking the same question." */
  summary: string;
  /** Discriminator for hint origin; reserved for future variants. */
  source: 'j1-recurrence';
}
```

## In scope

1. **NEW module `src/recall-history.ts`.** Pure data + helpers. No DB. No globals. Exports:
   - `RecallHistoryEntry { queryHash: number, topMemoryId: string | null, ts: string, anchoredOn?: string }` — the optional `anchoredOn` field carries the memoryId of the LAST anchoring hint fired on this entry (set by the caller AFTER `detectAnchoring` returns a hint and the caller records the recall). Used by R1/R2 cooldown logic.
   - `RecallHistorySnapshot = readonly RecallHistoryEntry[]` (caller-passed)
   - `hashQueryText(query: string): number` — lowercase + whitespace collapse + sorted-token FNV-1a hash. Deterministic, no allocation hot-path.
   - `detectAnchoring(history: RecallHistorySnapshot, currentQueryHash: number, currentTopMemoryId: string | null, opts?: { minDominance?: number, recentRepeatWindow?: number, cooldown?: number }): AnchoringHint | null`
     - **R1 query_repeat**: if `currentQueryHash` appears in history within last `recentRepeatWindow=5` entries AND that entry's topMemoryId matches `currentTopMemoryId` AND currentTopMemoryId is non-null → emit query_repeat hint
     - **R2 memory_dominance**: count distinct queryHashes in history where `topMemoryId === currentTopMemoryId` (non-null); if count + 1 (including current) `>= minDominance=3` → emit memory_dominance hint with queryCount
     - **R2 wins on tie** (more cognitively important than literal repeat). When BOTH R1 and R2 fire, return only the R2 hint. Locked by an explicit test case.
     - **Cooldown to prevent spam**: history entries carry an optional `anchoredOn?: string` field (recorded by the caller after a prior fire). If the immediately-prior fire was for the same `topMemoryId` and was within `cooldown=3` history entries, R2 (and R1) suppress and return null. Prevents every subsequent recall in the dominance window from re-emitting the same hint. After cooldown elapses or a different memory takes the top, the hint can re-fire.
2. **Per-pipeline AnchoringHint compute (CRIT 1 architectural fix).** AnchoringHint is computed PER PIPELINE using the shared `detectAnchoring()` pure helper applied to (a) that pipeline's actual top-1 memory and (b) the shared per-(tenant, session) ring snapshot. This mirrors J3.2's per-pipeline planningFallacyHint compute and the C5 per-pipeline suppressionSummary pattern. Three independent compute sites:
   - **api.recall** computes against its `rankedOut[0]?.id`; attaches `anchoringHint` to the returned RecallResult; bumps its OWN buildSuppressionSummary's `suppressedByInterference` on its R2 verdict.
   - **cmdRecall (CLI)** computes against `results[0]?.entry.id` (its own physics/hybrid top-1); attaches to its JSON/text output; bumps `cmdSuppressionSummary.suppressedByInterference` on its R2.
   - **MCP hippo_recall** computes against `results[0]?.entry.id` (its own physics/hybrid top-1, same source as the rendered list); bumps `mcpSuppressionSummary.suppressedByInterference` on its R2; prepends `## Anchoring hint` text block.
   - **Ring ownership: each pipeline owns its OWN ring buffer Map keyed by (tenant, session).** Three independent Maps live in cli.ts / mcp/server.ts / server.ts respectively. R2's dominance threshold N=3 accumulates per-pipeline (CLI's 3 distinct queries are tracked separately from MCP's 3). This is correct because (a) each pipeline has its own top-1 ranking (api.recall's BM25 band vs cmdRecall's physics/hybrid vs MCP's physics/hybrid can disagree on which memory wins), and (b) the typical multi-process deployment (HTTP server + MCP server in different processes) makes IPC ring-sharing impractical anyway. Cross-pipeline anchoring (same memory wins across CLI + MCP in the same session) is genuinely a different signal worth a separate detector; v1 is per-pipeline. Tradeoff documented in §Out of scope below.
3. **api.recall "purity" definition (CRIT 2).** `api.recall` is pure in the sense of "does NOT mutate `index.last_retrieval_ids`" (the contract locked by `tests/api-recall-no-side-effects.test.ts`). It DOES write to `audit_log` (already established at api.ts:802 for the 'recall' op; adding `recall_anchor_detected_*` ops follows the precedent). The new purity test asserts return-value equality across two consecutive calls with the same `opts.recallHistory` snapshot — NOT audit_log row equality (audit_log emits per call by design).
4. **`suppressedByInterference` wire-up (CRIT 1 follow-through).** Each pipeline's `buildSuppressionSummary` call increments `suppressedByInterference` by 1 when ITS OWN R2 fires. Visible on all three user-facing surfaces (api.recall response body, cmdRecall --why WYSIATI line, MCP WYSIATI line) — lights up the placeholder counter that has been hardcoded to 0 since v1.12.13. R1 query_repeat does NOT count as interference (re-ask, not memory competition).
5. **CLI integration.** `cmdRecall` instantiates a process-local `Map<sessionKey, RingBuffer>` at module scope (matches the existing `lastRecalledIds` pattern in src/mcp/server.ts:559). Ring buffers keyed via `buildSessionKey(tenantId, sessionId)` (NOT colon string-concat). Snapshot ring BEFORE compute → call `detectAnchoring(snapshot, queryHash, cmdTop1Id)` → attach `anchoringHint` to JSON/text output AND bump `cmdSuppressionSummary.suppressedByInterference` on R2. AFTER the response is built: `appendRecall(ring, queryHash, cmdTop1Id, anchoredOn=hint?.memoryId)` (the anchoredOn write feeds the cooldown logic). Cap total tracked session-keys at 1000 (LRU evict). Export `__resetSessionRecallHistoryCli()` for test isolation.
6. **MCP integration.** Same pattern in `hippo_recall` handler: module-level `Map` keyed via `buildSessionKey(tenantId, sessionId)`. Sessionid comes from `args.session_id` (already read at L463-466). Compute against MCP's `results[0]?.entry.id` (the physics/hybrid pipeline top-1, same source as the rendered list — per the C5 per-pipeline lesson). Bump `mcpSuppressionSummary.suppressedByInterference` on R2. Append after response. Export `__resetSessionRecallHistoryMcp()` for test isolation.
7. **HTTP integration.** Same pattern on `/v1/memories` route handler. session_id from query param. Compute via shared helper; bump suppressedByInterference on R2 (which rides in the response body since /v1/memories returns api.recall's RecallResult directly). Export `__resetSessionRecallHistoryHttp()`.
8. **`recall --why` render** (CLI). When `cmdResult.anchoringHint` present AND `--why` flag is set, print `[anchored_on: ${memoryId}] ${summary}` line above the result list (JSON.stringify-safe on the summary against control chars, same hardening as J3.2 round 2). Surface matches the roadmap's literal example.
9. **MCP render.** When MCP-computed hint present, prepend `## Anchoring hint\n${summary}\n[anchored_on: ${memoryId}]\n\n---\n\n` to the text response (matches the J3.2 prepend pattern). Goes ABOVE any planning-fallacy block (anchoring is the more cognitive-pull warning).
10. **HTTP response.** Auto-serializes `anchoringHint` on the wire (no extra code in server.ts beyond auto-include via RecallResult).
11. **Python SDK lockstep.** `AnchoringHint` Pydantic model with snake_case→camelCase alias; optional `anchoring_hint: Optional[AnchoringHint] = None` on `RecallResult`. Export from `__init__.py`. `source: str` (forward-compat, not Literal — same lesson as J3.2 round 2). **Note: the wider `str` type means JSON round-trip TS→Python→TS allows arbitrary `source` strings to leak back; SDK consumers MUST NOT dispatch on `source` for control flow.**
12. **THREE new audit ops** lockstep across `src/audit.ts` AuditOp union + `src/cli.ts` VALID_AUDIT_OPS + `src/server.ts` VALID_AUDIT_OPS (v1.11.5 CRIT A institutional rule):
    - `recall_anchor_detected_query_repeat` — emitted by api.recall when R1 fires (api.recall pipeline only; cmd/MCP audit-emit also via their own pipeline-local sites)
    - `recall_anchor_detected_memory_dominance` — emitted on R2 fire
    - `recall_anchor_skipped_no_session` — telemetry: caller-side ring-buffer write skipped because no sessionId
13. **`HIPPO_ANCHORING=off|track` env knob.** Default `track`. `off` short-circuits the detector AND caller-side ring writes — caller-side `appendRecall` calls in CLI/MCP/HTTP check the env first; on `off` they return immediately so disabled tenants TRULY pay zero work (including no hash + no Map lookup + no ring push). Knob is parallel to `HIPPO_AUTODEBIAS`. The env check is read per-call (same per-call cost pattern as J3.2; trades a process.env read for test-time togglability without module reload).
14. **Tests** (real-DB per project rule):
    - `tests/recall-history.test.ts` — pure module: hashQueryText determinism + collision properties, buildSessionKey + null-char-delimiter collision-safety, detectAnchoring R1 + R2 + **explicit tie-test (both conditions true → only R2 returned)** + **explicit R1/R2 cross-rule cooldown boundary test (R2 fires on M with cooldown=3, next recall has top=N + repeated query → R1 fires on N because cooldown is per-memory not per-rule)** + minDominance threshold + recentRepeatWindow + cooldown behavior (consecutive recalls for the same memory don't re-emit) + tenant-key cross-session isolation, edge cases (empty history, single entry, null topMemoryId, history-entry with anchoredOn set)
    - `tests/api-recall-anchoring.test.ts` — integration: snapshot passed → hint surfaces; HIPPO_ANCHORING=off short-circuit; no-sessionId silent path; R1 happy path; R2 happy path; cross-tenant scoping; **api.recall return-value purity (calling twice with the same opts.recallHistory snapshot returns identical RecallResult, ignoring audit_log row deltas which are expected per call)**
    - `tests/cli-recall-anchoring.test.ts` — CLI ring-buffer state: first recall has no history → no hint; subsequent recall with same query → R1 fires; subsequent recall with different queries returning same top → R2 fires at threshold; --why render shows `[anchored_on: ...]`; **assert cmdSuppressionSummary.suppressedByInterference increments on R2**; **assert caller writes anchoredOn back into the ring after a hint fires (cooldown is dead code without this)**
    - `tests/mcp-recall-anchoring.test.ts` — MCP text block render with `## Anchoring hint` heading; ring updates per session_id arg; absent session_id → no tracking; **assert mcpSuppressionSummary.suppressedByInterference increments on R2**
    - `tests/audit-ops-anchoring-lockstep.test.ts` — parse-source verification of 3 new ops × 3 sites = 9 cells (audit.ts AuditOp union + cli.ts VALID_AUDIT_OPS + server.ts VALID_AUDIT_OPS — exactly 3 sites despite cli.ts having multiple edit regions in the diff)
    - `tests/api-recall-suppressed-interference-j1.test.ts` — assert `suppressedByInterference` is non-zero when R2 fires across ALL THREE pipeline surfaces (api.recall RecallResult + cmdSuppressionSummary in CLI --why text + mcpSuppressionSummary in MCP WYSIATI text). **Relaxes the locked invariant in `tests/api-recall-suppression-summary.test.ts:105`** ("always 0 in v1.12.13") to "0 when J1 is off OR no R2 detected; non-zero when J1 R2 fires." Update that test's header comment to document the relaxation.
    - `python/tests/test_models.py` — extend with AnchoringHint roundtrip + RecallResult parse + source forward-variants
    
    **Per-test-file boilerplate for caller-side reset:**
    ```typescript
    // tests/cli-recall-anchoring.test.ts header
    import { __resetSessionRecallHistoryCli } from '../src/cli.js';
    beforeEach(() => { __resetSessionRecallHistoryCli(); });
    
    // tests/mcp-recall-anchoring.test.ts header
    import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
    beforeEach(() => { __resetSessionRecallHistoryMcp(); });
    ```
15. **CHANGELOG entry** under `## 1.13.2 (2026-05-26): J1 anchoring detector` — matches the existing versioned-header convention (no `## Unreleased` section in this CHANGELOG).

## Out of scope (explicit, deferred)

- **Embedding-based semantic distinctness** (J1-v2): textual hash for v1 is good enough for the synthetic test set the roadmap success metric targets.
- **Cross-session anchoring**: anchoring across server restarts. v1 is within-session only.
- **Persistent recall_history table** (option D in brainstorm): no schema migration; defer until a real cross-process or cross-restart need surfaces.
- **30-trace synthetic test set + 80%/60% precision/recall measurement** (the roadmap's success metric). v1 ships the mechanism with unit + integration tests of the detection rules. The full eval is its own follow-up episode.
- **R3 cross-anchor interactions** (J8 composition matrix): how J1 + J2 + J3 fire together. Documented in J8 [research].

## Files modified

| File | Change |
|---|---|
| `src/recall-history.ts` | NEW. Pure module: types + hashQueryText + detectAnchoring. ~100 LOC. |
| `src/api.ts` | Extend `RecallOpts` with `recallHistory?`. Extend `RecallResult` with `anchoringHint?`. Import + invoke detectAnchoring near return. Increment suppressedByInterference on R2. |
| `src/cli.ts` | TWO edit regions but ONE audit-lockstep site: (a) module-level `Map<sessionKey, RingBuffer>` + helper functions, cmdRecall snapshots+computes+bumps+renders+appends; (b) `VALID_AUDIT_OPS` Set extended with 3 new ops. The audit-ops-anchoring-lockstep test counts cli.ts as ONE lockstep site (one VALID_AUDIT_OPS Set despite two physical edit regions). |
| `src/mcp/server.ts` | Per-process Map; hippo_recall handler tracks ring; prepend ## Anchoring hint block when hint present. |
| `src/server.ts` | Per-process Map; /v1/memories route tracks ring per (tenant, session). Add 3 new audit ops to VALID_AUDIT_OPS. |
| `src/audit.ts` | Extend AuditOp union with 3 new ops. |
| `python/src/hippo_memory/models.py` | NEW `AnchoringHint` Pydantic + optional `anchoring_hint` on RecallResult. |
| `python/src/hippo_memory/__init__.py` | Export `AnchoringHint`. |
| `tests/recall-history.test.ts` | NEW. ~15 cases. |
| `tests/api-recall-anchoring.test.ts` | NEW. ~10 cases. |
| `tests/cli-recall-anchoring.test.ts` | NEW. ~5 cases. |
| `tests/mcp-recall-anchoring.test.ts` | NEW. ~4 cases. |
| `tests/audit-ops-anchoring-lockstep.test.ts` | NEW. ~3 cases. |
| `tests/api-recall-suppressed-interference-j1.test.ts` | NEW. Asserts non-zero counter on R2. |
| `tests/api-recall-suppression-summary.test.ts` | EXTEND — relax "always 0" lock to "non-zero when J1 R2 fires; 0 otherwise". Update header comment. |
| `python/tests/test_models.py` | +4 cases (AnchoringHint roundtrip + RecallResult parse + source forward-variants + RecallOpts shape). |
| `CHANGELOG.md` | Insert new versioned section `## 1.13.2 (2026-05-26): J1 anchoring detector` directly below `# Changelog` heading. No `## Unreleased` section exists in this CHANGELOG; use the existing versioned-header convention. |

## Implementation tasks (ordered)

**Task 1 — recall-history module.** Create `src/recall-history.ts`:
- `RecallHistoryEntry` interface as in the field shape.
- `hashQueryText(query: string): number` — FNV-1a 32-bit over lowercased + whitespace-collapsed + sorted-token query. Deterministic across processes.
- `detectAnchoring(history, currentQueryHash, currentTopMemoryId, opts?): AnchoringHint | null` — implements R1 + R2 per the rules in §In scope item 1. R2 wins on tie.
- No DB. No global state. Pure functions.

**Task 2 — Caller-side RingBuffer helper.** Inside `src/recall-history.ts`, also export:
- `RingBuffer` class with `MAX_HISTORY = 10` entries, FIFO eviction
- `buildSessionKey(tenantId: string, sessionId: string): string` returns `${tenantId}\x00${sessionId}` (null-char delimiter; tenantId/sessionId validators elsewhere reject null chars so collision impossible)
- `getOrCreateRing(map: Map<string, RingBuffer>, key: string, maxSessions: number): RingBuffer` with LRU on session-key cap (default 1000)
- `appendRecall(ring: RingBuffer, queryHash, topMemoryId, anchoredOn?)` mutator — the optional `anchoredOn` is the memoryId of the hint that just fired (used for R1/R2 cooldown)
- `snapshotRing(ring: RingBuffer): RecallHistorySnapshot` returns readonly view
- For test isolation: callers expose a `__resetSessionRecallHistory()` helper so test `beforeEach` can wipe the module-level Map. Document explicitly in the test file header that the reset is required.

**Task 3 — api.recall integration.** In `src/api.ts`:
- Extend `RecallOpts` interface with `recallHistory?: RecallHistorySnapshot` (optional).
- Extend `RecallResult` interface with `anchoringHint?: AnchoringHint`.
- Import `detectAnchoring`, `hashQueryText`, `type AnchoringHint, RecallHistorySnapshot` from `./recall-history.js`.
- In `recall()`, after the ranked result is computed, derive `topMemoryId = rankedOut[0]?.id ?? null`, compute `queryHash = hashQueryText(opts.query)`, call `detectAnchoring(opts.recallHistory ?? [], queryHash, topMemoryId)`. Env check `HIPPO_ANCHORING === 'off'` short-circuits to null BEFORE the call.
- On R2 verdict, bump the suppressedByInterference counter in the buildSuppressionSummary call (the only counter currently always 0).
- Attach `anchoringHint` to return only if non-null (spread pattern, same as planningFallacyHint).
- Audit emission: when anchoringHint surfaces, emit `recall_anchor_detected_query_repeat` or `recall_anchor_detected_memory_dominance` with metadata `{reason, memory_id, query_count?}`. (api.recall already calls appendAuditEvent for the recall row; adding another is consistent.)
- **JSDoc update on the existing src/api.ts:483-489 comment for `suppressedByInterference`**: replace "Populated by future B4-depth or J1-anchoring work that reads from the `interference_suppression` table during recall" with "Populated by J1-anchoring work (v0.33 / v1.13.2) when api.recall's own R2 memory_dominance verdict fires, using a caller-supplied in-memory ring snapshot via `opts.recallHistory`. Future B4-depth work may add additional sources." No `interference_suppression` table is created — that earlier comment was speculative and is now stale.
- **CLI-routed-call behavior note**: CLI's `cmdRecall` does NOT pass `opts.recallHistory` to its api.recall invocation (CLI computes its OWN anchoringHint via the shared helper against CLI's pipeline top-1, then bumps cmdSuppressionSummary directly — see Task 4). On CLI-routed call paths, `RecallResult.anchoringHint` returned by api.recall is therefore always null and `suppressedByInterference` stays 0 from api.recall's perspective. The user-visible counter on CLI is cmdSuppressionSummary's, which IS bumped correctly. Document this in the RecallResult.anchoringHint JSDoc: "May be null on CLI-routed call paths even when an anchoring hint fires at the CLI surface, because CLI computes its own hint and does not thread its recallHistory snapshot through. Non-null only on direct SDK / HTTP-routed invocations." Acceptance §6 reflects this.

**Task 4 — CLI ring-buffer state + per-pipeline anchoring compute + render.** In `src/cli.ts`:
- Module-level `const sessionRecallHistoryCli = new Map<string, RingBuffer>()`.
- Export `__resetSessionRecallHistoryCli()` for test isolation (clears the Map).
- In `cmdRecall` after sessionId resolution: env check `HIPPO_ANCHORING === 'off'` → skip the ring entirely (truly zero work). Else, get-or-create the ring keyed by `buildSessionKey(tenantId, sessionId)` (NOT colon-concat).
- **Compute cmdAnchoringHint via the shared helper** AFTER cmdRecall's results are ranked (not from api.recall — cmd has its own physics/hybrid top-1): `cmdAnchoringHint = detectAnchoring(snapshotRing(ring), hashQueryText(query), results[0]?.entry.id ?? null)`.
- **Bump cmdSuppressionSummary.suppressedByInterference by 1 when cmdAnchoringHint.reason === 'memory_dominance'** in the existing api.buildSuppressionSummary({ ..., suppressedByInterference: ... }) call.
- Render: when cmdAnchoringHint truthy in --why text output, print `[anchored_on: ${memoryId}] ${summary}` line ABOVE the result list. JSON.stringify-safe the summary. Add cmdAnchoringHint to jsonOut object too.
- **AFTER the response is built**: `appendRecall(ring, queryHash, results[0]?.entry.id ?? null, cmdAnchoringHint?.memoryId)` — the third arg `anchoredOn` carries the memoryId of the hint that fired (or undefined if no hint). Feeds cooldown logic for the NEXT recall.
- When no sessionId: skip the ring entirely, emit `recall_anchor_skipped_no_session` audit op (telemetry).

**For Tasks 5 (MCP) and 6 (HTTP) — same `recall_anchor_skipped_no_session` emit behavior when sessionId absent.** Mirror Task 4's pattern: env-off check first, sessionId check second, if sessionId missing emit the skipped audit op + skip ring/compute. Consistency across all three surfaces gives uniform telemetry for the embedding-fallback decision in J1-v2.

**Task 5 — MCP integration.** In `src/mcp/server.ts`:
- Module-level `const sessionRecallHistoryMcp = new Map<string, RingBuffer>()`.
- Export `__resetSessionRecallHistoryMcp()` for test isolation.
- In the `hippo_recall` handler, after sessionId resolution (already at L463): env check `HIPPO_ANCHORING === 'off'` → skip. Else get-or-create ring keyed by `buildSessionKey(tenantId, sessionId)`.
- **Compute mcpAnchoringHint via the shared helper against MCP's OWN top-1 — NOT apiResult.anchoringHint.** MCP runs its own physics/hybrid pipeline AFTER api.recall (per C5 lesson); the rendered memory list comes from MCP's pipeline, so the anchoring hint must describe MCP's pipeline top-1: `mcpAnchoringHint = detectAnchoring(snapshotRing(ring), hashQueryText(query), results[0]?.entry.id ?? null)` where `results` is the MCP physics/hybrid result list. This replaces apiResult.anchoringHint in the user-facing response (same pattern as `mcpSuppressionSummary` replaces apiResult.suppressionSummary).
- **Bump mcpSuppressionSummary.suppressedByInterference by 1 when mcpAnchoringHint.reason === 'memory_dominance'** in the existing buildSuppressionSummary call.
- When mcpAnchoringHint truthy, prepend `## Anchoring hint\n${summary}\n[anchored_on: ${memoryId}]\n\n---\n\n` to response. Goes ABOVE any planning-fallacy block.
- **AFTER response built**: `appendRecall(ring, queryHash, results[0]?.entry.id ?? null, mcpAnchoringHint?.memoryId)`.
- **Session key shape note**: this Map uses `buildSessionKey(tenantId, sessionId)` from args.session_id — distinct from `resolveClientKey(ctx)` used by `lastRecalledIds` at mcp/server.ts:559. Rationale: lastRecalledIds tracks per-client-process state for the outcome-after-context workflow; anchoring tracks per-(tenant, session) state for cross-pipeline ring sharing. Different keys are intentional.

**Task 6 — HTTP integration.** In `src/server.ts`:
- Module-level `const sessionRecallHistoryHttp = new Map<string, RingBuffer>()`.
- Export `__resetSessionRecallHistoryHttp()` for test isolation.
- In `/v1/memories` route handler: env check `HIPPO_ANCHORING === 'off'` → skip. Else get-or-create ring keyed by `buildSessionKey(tenantId, sessionId)` from `session_id` query param.
- Snapshot, pass to api.recall via `opts.recallHistory`. api.recall computes its OWN anchoringHint (which is what /v1/memories returns directly since the route response IS api.recall's result; HTTP doesn't run a second pipeline like MCP does).
- **After response**: append the recall to the ring with `anchoredOn` set from the returned `recallResult.anchoringHint?.memoryId`. This is the only caller that uses api.recall's hint directly (not a separately-computed one) because HTTP doesn't have a second physics/hybrid pipeline.
- `anchoringHint` rides on the JSON response body as part of RecallResult; suppressedByInterference is already correctly bumped by api.recall's buildSuppressionSummary call.

**Task 7 — Audit op lockstep.** Add ALL THREE to:
- `src/audit.ts` AuditOp union (after `recall_autodebias_hint_tiebreak`)
- `src/cli.ts` VALID_AUDIT_OPS Set
- `src/server.ts` VALID_AUDIT_OPS Set

Verified by NEW `tests/audit-ops-anchoring-lockstep.test.ts` (parse-source pattern matching the J3.2 audit-ops-autodebias-lockstep test).

**Task 8 — Python SDK.** In `python/src/hippo_memory/models.py`:
```python
class AnchoringHint(_Base):
    """v0.33 / J1 — anchoring detector hint."""
    reason: str  # 'query_repeat' | 'memory_dominance'; loose for forward-compat
    memory_id: str
    query_count: int | None = None
    summary: str
    source: str = "j1-recurrence"

class RecallResult(_Base):
    # ... existing fields ...
    anchoring_hint: AnchoringHint | None = None
```
Export `AnchoringHint` from `__init__.py`.

**Task 9 — Tests.** All listed in §Files modified.

**Task 10 — Relax the locked `suppressedByInterference == 0` invariant.** In `tests/api-recall-suppression-summary.test.ts:105`, change the assertion + header comment so it now reads "asserts suppressedByInterference is 0 when J1 is OFF or no R2 detection, but documents that it CAN be non-zero when J1 R2 fires." Add a new test in `tests/api-recall-suppressed-interference-j1.test.ts` that explicitly sets up R2 conditions (mock recall history with 3 distinct queries returning same top) and asserts the counter is incremented.

**Task 11 — CHANGELOG.** CHANGELOG.md uses versioned section headers (no `## Unreleased` section). Insert a new section directly below `# Changelog`:

```markdown
## 1.13.2 (2026-05-26): J1 anchoring detector
```

Then add:
```markdown
### Added
- **J1 anchoring detector (recall-recurrence).** When a session's recall
  history shows the same memory winning top-1 across N >= 3 semantically-
  distinct queries (R2 memory dominance), OR the same query is re-issued
  within 5 turns returning the same top-1 (R1 query repeat), hippo surfaces
  an `anchoringHint` on `RecallResult` flagging the anchoring pattern.
  Caller-tracked ring buffer keeps api.recall pure. Composes with J3.2:
  planning-fallacy + anchoring hints can fire on the same recall.
  - CLI `recall --why`: prints `[anchored_on: mem_xyz] <summary>`.
  - MCP: `## Anchoring hint` block prepended to response.
  - HTTP: optional `anchoringHint` field on GET /v1/memories.
  - Python SDK: `AnchoringHint` Pydantic.
  - `HIPPO_ANCHORING=off|track` env knob (default `track`).
  - Three new audit ops: `recall_anchor_detected_query_repeat`,
    `recall_anchor_detected_memory_dominance`,
    `recall_anchor_skipped_no_session` (telemetry: caller had no sessionId).
  - First wire-up of the `suppressedByInterference` counter on
    RecallResult.suppressionSummary (was always 0; now increments on
    R2 memory-dominance verdicts). The "always 0" lock in
    tests/api-recall-suppression-summary.test.ts:105 relaxes to "0 when
    J1 is off or no R2; non-zero when R2 fires."

### Changed
- `RecallResult.suppressionSummary.suppressedByInterference` semantics: was
  hardcoded 0 (placeholder for B4-depth or J1 work), now reflects J1 R2
  detections per recall. Downstream consumers reading the field as a
  reliable zero need to update.
```

## Latency budget

- `hashQueryText`: lowercase + whitespace collapse + sorted-token (split + sort) + FNV-1a over ~50-char query. Order-of-magnitude ~10us (V8 split + sort + hash on 8-10 tokens).
- `detectAnchoring`: scan up to 10 history entries with O(N) integer comparisons. ~2-5us.
- Caller-side ring append + Map lookup: ~3-5us.
- **Per-recall J1 cost when ON**: roughly 15-25us per pipeline-compute site. Three sites (api.recall + cmdRecall pipeline + MCP pipeline) can each pay this independently. Total worst case <100us across all three sites in a single recall.
- **Per-recall J1 cost when HIPPO_ANCHORING=off**: zero — env check is the only work, ring-write call is the first line and returns immediately, detectAnchoring is never invoked.

Well under the J3.2 budget of 50ms even in the worst case. No microbench-test commitment in v1; if cost becomes contended a benchmark can land in J1-v2.

## Acceptance criteria

1. All TypeScript tests green (current 2019 + new ~40 ≈ 2059).
2. All Python tests green (current 53 + new ~4 ≈ 57).
3. `HIPPO_ANCHORING=off` cleanly disables on ALL THREE pipelines (api.recall + cmdRecall + MCP); env-off truly costs zero (caller-side ring writes skipped).
4. **api.recall return-value purity**: calling twice with the same `opts` (including same `opts.recallHistory` snapshot) returns RecallResult objects with deep-equal structure. Audit_log row deltas between the two calls are EXPECTED (api.recall has always written audit rows; this contract is unchanged).
5. `tests/api-recall-no-side-effects.test.ts` continues to pass unchanged (the test asserts `index.last_retrieval_ids` invariance only; api.recall does NOT touch it).
6. `suppressedByInterference` counter is incremented on R2 across ALL THREE user-facing surfaces (api.recall response body + cmdRecall WYSIATI text + MCP WYSIATI text). The v1.12.13 "always 0" lock in `tests/api-recall-suppression-summary.test.ts:105` is relaxed to "0 when J1 is off or no R2; non-zero when R2 fires" with a documented test-header explanation.
7. 3 new audit ops in all 3 sites (lockstep test — `audit-ops-anchoring-lockstep.test.ts` parses src/audit.ts AuditOp union + src/cli.ts VALID_AUDIT_OPS + src/server.ts VALID_AUDIT_OPS).
8. Python SDK round-trips AnchoringHint via Pydantic with snake_case ↔ camelCase; `source: str` accepts future variants without ValidationError.
9. CHANGELOG entry under versioned header `## 1.13.2 (2026-05-26): J1 anchoring detector` (matches existing convention; no ## Unreleased). Em-dash-free.
10. Plan-eng + code-review + independent-review + codex-review + ship-readiness all pass.
11. **buildSessionKey threaded** through CLI + MCP + HTTP ring lookups (no `${tenantId}:${sessionId}` string-concat anywhere; verified by grep in the lockstep test or a separate structural test).
12. **Caller-side `anchoredOn` write** verified by cli/mcp test asserting that after a hint fires, the next ring snapshot contains the previous topMemoryId in the `anchoredOn` field of the latest entry (cooldown read-side has nothing to read without this).

## Open questions

None — all settled in brainstorm + audit reframe + this plan. Edge cases for the detector rules (empty history, single entry, null topMemoryId, R1+R2 tie) are explicit in §Task 1 and covered by tests.
