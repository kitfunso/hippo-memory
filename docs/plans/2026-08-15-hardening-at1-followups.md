# Hardening pass: AT1 follow-ups (episode 01M02X45JWXGB0HTS9VQPFMZB0)

Status: Revised r2 (plan-eng-critic r1 fail 68; both must-fixes + both lows applied)
Base: origin/master 35815a0 (v1.31.0). Branch: fix/hardening-at1-followups. Worktree: C:/Users/skf_s/hippo-wt-hard.
Source: .devrl-backlog.md Candidates (filed from AT1 episode 01M025CW434ZAPVSFC61BGFGCT) + AT1 ship-check flaky-test classification.

One correctness core (T1) + four riders (T2-T5). One PR, one commit per task.

## T1 - Cross-tenant consolidation landing (correctness core)

**Defect (verified 2026-08-15):** consolidate.ts:136 `loadAllEntries` is host-wide. The merge pass (:659-686) filters episodic survivors and clusters purely by `textOverlap` - clusters can span tenants, and `mergeContents` concatenates cross-tenant content into one semantic row. `createMemory` at :709 omits `tenantId`, so the row stamps 'default' (memory.ts:535). The trace pass (:334-380) fetches sessions under `consolidationTenant = resolveTenantId({})` (:342) but `createMemory` at :371 also omits `tenantId`. Two consequences beyond the filed leak:
- Trace idempotency ghost: `traceExistsForSession` (:347) checks under `consolidationTenant`; the trace landed in 'default', so for any non-default tenant the check never hits and the trace regenerates every sleep.
- The AT1 tombstone checks (:390-396, :727-737) already key off the BUILT entry's tenantId, so they follow this fix automatically - no tombstone changes needed.

**Fix:**
1. Merge pass: partition `mergeCandidates` by `tenantId` before the overlap loop (`Map<tenant, MemoryEntry[]>`); run the existing cluster loop per partition; pass the partition tenant into `createMemory` (`tenantId` option exists, memory.ts:481). Cross-tenant clusters become impossible by construction.
2. Trace pass: pass `tenantId: consolidationTenant` into `createMemory` at :371.

**Consumer audit (done at plan time, grill carry-forward):** recall/assemble/search are tenant-scoped per request - rows landing in the source tenant become visible to the CORRECT tenant (today they are visible to the wrong one and invisible to the right one). shared.ts is tenant-aware end-to-end (shareMemory host-passed tenantId :369-379; D4 global filtering :429-447). dag.ts already tenant-partitions L3 building (dag.ts:363-368 acknowledges the mixed-L3 default problem this fix reduces). No consumer depends on 'default' landing. Single-tenant stores: every row is 'default', one partition, byte-identical behavior.

**Tests:** (a) two tenants with overlapping episodic content -> two separate merged rows, each in its source tenant, no content mixing (assert both directions); (b) single-tenant merge unchanged (existing suites are the pin); (c) trace lands in `consolidationTenant` when HIPPO_TENANT is non-default; (d) trace idempotency: second consolidate under non-default tenant creates NO second trace (regression pin for the ghost); (e) merge-tombstone + trace-tombstone checks still fire under the new landing tenant (adjust AT1 destination-tenant tests if they pinned 'default' landing).

**Executor check (grill amendment):** the extraction pass (consolidate 1.6/1.7) is a sibling producer - read how extract.ts storeExtractedFacts stamps tenant on extracted-fact rows. Same defect (rows land in 'default' from non-default sources) -> fold in ONLY if the fix is the same one-line createMemory/threading shape; anything larger gets filed as a backlog candidate, not absorbed.

## T2 - MCP actor threading (5 sites)

**Defect:** server.ts:498, :839, :878, :942, :985 build ApiContext with hardcoded `adminActor('mcp')`; McpContext.actor (:110, a string, auth-resolved for HTTP-MCP) is ignored. Attribution only: api.ts:101 "Role checks happen at the request layer"; every api.ts use of `ctx.actor` is `.subject` into audit rows/writeEntry actor (api.ts:249, :977, :1088...). The house pattern exists at :1169 (`rejectedBy: ctx?.actor ?? 'mcp'`).

**Fix:** at all 5 sites: `actor: adminActor(ctx?.actor ?? 'mcp')` - subject becomes the auth-resolved actor under HTTP-MCP, stdio keeps 'mcp'. Role semantics unchanged by construction (still adminActor). Verify each site actually has `ctx` in scope (executeTool signature :441 `ctx?: McpContext`).
Precondition check at execute: read adminActor's signature in api.ts first - if it does not take a subject parameter, use the correct actor constructor the resolve path / http layer uses instead; do NOT invent a new one.

**Tests:** executeTool with a ctx carrying actor 'user:alice' -> audit_log rows for remember/outcome record subject 'user:alice'; without ctx -> 'mcp' (existing behavior pin).

## T3 - consolidateDb lazy open (perf hygiene)

**Defect (advisory reframed at discover):** consolidate.ts:318 opens the shared handle unconditionally on every non-dry-run sleep even when the cycle has zero auto-promote sessions and zero merge clusters. The filed "defer until MERGE_MIN_CLUSTER" is stale - the handle also serves the auto-promote tombstone checks (:390-396), which run before any cluster sizing.

**Fix:** memoized lazy getter (`getConsolidateDb(): Database` opening on first call; `null` until used; dryRun still never opens). The finally (:785) closes only if opened. All `if (consolidateDb)` guards become calls through the getter at the existing sites (each already gated on !dryRun by construction).
Risk note: the getter must be a closure over the same handle variable the finally reads - no double-open, no leak on throw between first use and finally.

**Tests:** behavioral pin - no-op sleep completes clean and every existing tombstone suite stays green. Asserting "db never opened" directly is optional: only if a test-only counter or existing debug detail line makes it cheap; do not build observation machinery for a perf-hygiene rider.

## T4 - rebuilt-vs-refused stat split (observability)

**Defect:** store.ts:3452-3463 documents deliberately returning changed=true on a tombstone refusal so the caller's `rebuilt` stat also counts refusals (accepted at AT1 as lesser evil vs infinite retry).

**Fix:** return `{ changed, refused }` from applyRebuildResult. Caller enumeration (plan-eng-critic r1, verified by grep): dag.ts:250 and :285 (rebuildDirtySummaries), PLUS four direct test call sites asserting the current boolean return - tests/rejection-guard.test.ts:215-227 (`expect(changed).toBe(true)`) and :247-256 (`expect(secondPass).toBe(false)`); tests/dag-rebuild-summaries.test.ts:408-417 (`expect(ok).toBe(true)`) and :499-513 (`expect(ok).toBe(false)`). All four assertions MUST be updated to the new shape (`.changed`) in the SAME T4 commit - not discovered via a red test run. dag.ts rebuildDirtySummaries splits counters: refusals increment `refused`, not `rebuilt`; surface `refused` in the summary line/result the same way `rebuilt` is surfaced. Retry semantics unchanged (dirty still cleared, no behavior change - counters only).

**Parallel-surface check (audit rule 2, grill amendment):** grep every consumer of rebuildDirtySummaries' result and the sleep-stats print surfaces (cli sleep command, api sleep, MCP tool, SleepResult threading a la AT1's rejectedSkipped) BEFORE wiring; either surface `refused` at all of them or state in the commit which surface deliberately carries it and why the others do not.

**Tests:** rebuild hitting a tombstone increments refused and not rebuilt; clean rebuild increments rebuilt only.

## T5 - memory-value-wiring wall-clock flake (test determinism)

**Defect (mechanism hypothesis, to be reproduced before fixing; corrected per plan-eng-critic r1):** tests/memory-value-wiring.test.ts:62 pins `NOW = 2026-08-10T12:00:00Z` - a date now in the real past. `condemnedEntry` (:81-100) overrides `created` AND `last_retrieved` to the ancient date, so those are already pinned. The fields genuinely left at REAL now are `valid_from` (memory.ts:526, never overridden) and the entry's initial stored `strength` (computed once inside createMemory via calculateStrength with default real-now, memory.ts:539, BEFORE the override spread applies). Any decay/scoring math touching those yields wall-clock-dependent values, flipping strength assertions (e.g. :427/:439). AT1 observed: fails in full suite, passes in isolation - which a pure NOW-vs-wall-clock mechanism does NOT explain (isolation would fail too). The hypothesis is therefore INCOMPLETE: cross-test interference (shared dir, env/config bleed, suite-length timing) is live. The executor must reproduce and pin the actual mechanism (run the file + the failing case with evidence, in isolation AND in suite) before touching assertions.

**Fix (root cause, not tolerance):** make the file's clock basis single-sourced - condemnedEntry overrides EVERY time field createMemory stamps (`valid_from` + re-derive the initial `strength` post-override; `last_retrieved` is already handled), and/or NOW derives from a fixed offset of a single frozen reference used everywhere. Loosening `=== 1.0` to a tolerance is BANNED unless the executor demonstrates the clock cannot be fully injected; if so, record why in the commit.

**Tests:** the file itself; run it 3x in isolation AND once inside the full suite; all green.

## Shared constraints

- No schema change, no migration, no version-const bump in this pass (release = patch bump at ship, 8-manifest lockstep per check-manifest-versions.mjs).
- Additive public surface only: applyRebuildResult return-shape change is internal (store.ts private helper for dag.ts); verify it is not exported from index.ts before treating as internal.
- Tests: real DB (house convention), vitest; touched suites + full suite before review.
- Commit messages: no em dashes; Write-to-file + `git commit -F`.
- [PROBATION] memories in scope: feedback_codex_review_base_aware (use --base for committed-work reviews, delta-scope re-reviews, 900s+ timeouts), feedback_exposure_audit_mechanism_not_data (T1/T2 classify by mechanism), multitenant-join-table-composite-fks (T1 tests), feedback_background_logs_full_copy_no_tail (suite runs capture BOTH streams to file).

## Out of scope

- Write-path consolidation refactor (shared mutation primitives) - next episode, deliberately after this pass.
- Per-tenant consolidation loop for auto-trace (docs/plans/2026-05-02-continuity-tables-tenant-scope.md) - T1 fixes landing/mixing, not the single-tenant session-window design.
- A5 v2 sub-2 tenant-scoping residue beyond the two createMemory sites.
- mergeContents paraphrase/summary quality - unchanged.
- dag.ts L3 entity profiles: verified ALREADY tenant-scoped (byTenant partition + tenantId threaded into createMemory at dag.ts:397, "HIGH #1 fold") - no open edge, nothing to file (plan-eng-critic r1 correction; the :363-368 comment describes the pre-fix problem).
