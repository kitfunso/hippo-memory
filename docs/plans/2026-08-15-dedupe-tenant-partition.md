# Dedupe tenant partition (episode 01M03MP0G3YDXBQXXWY7DP0PSC)

Status: Draft (plan-eng-critic pending)
Base: origin/master 9cb5616 (v1.32.0). Branch: fix/dedupe-tenant-partition. Worktree: C:/Users/skf_s/hippo-wt-dedupe.

## Defect (proven, not hypothesized)

src/dedupe.ts `deduplicateStore` (:72-136) loads ALL entries host-wide (:78) and its O(N^2) pair loop (:106-127) compares content with zero tenant checks, so a stronger tenant-A row absorbs a byte-identical tenant-B row and `deleteEntry` (:131) removes tenant-B's copy: cross-tenant DATA LOSS. Proven in the v1.32.0 episode's two-tenant E2E drive (tenant-b lost its merged semantic row + 2 episodic rows to tenant-a identicals). Pre-existing; exposed by v1.32.0's landing fix; known-issue note shipped in the v1.32.0 CHANGELOG.

## Fix

Inside `deduplicateStore`: group `entries` by `tenantId` (Map, insertion order - the house pattern from consolidate.ts `mergeCandidatesByTenant` and dag.ts `unparentedByTenant`); run the EXISTING survivor sort (:95-101) and pair loop per group; accumulate `removed`/`pairs` across groups. The v1.26.3 survivor total order (strength bucket desc -> retrieval_count desc -> compareEntryIdentity) is preserved unchanged WITHIN each tenant; cross-tenant pairs simply never form. Single-tenant stores: one group, byte-identical behavior (per-group sort of the only group = the current global sort).

Both callers inherit with no signature change: api.ts:2878 (sleep `phases.deduplicateStore`, injected at :2795/:2808) and cli.ts:2772 (`hippo dedup`). `DedupPair` unchanged (tenant fields rejected at grill - not needed for the fix; the kept/removed ids resolve tenants if an operator ever needs them).

Deliberate non-goal: cross-tenant dedupe is never correct - the tenant boundary is an isolation boundary (v39 scope isolation; v1.32.0 landing fix). The config-audit cron's "local-vs-global duplicates" pass is cross-STORE (different mechanism, untouched).

Stale-objection note (plan-eng-critic r1): docs/design-decisions/2026-05-24-blocked-items.md D1 claims tenant-scoping deduplicateStore would destroy a "cross-tenant crossDups" feature. Verified false: the crossDups counter (api.ts:2887-2889) is cross-LAYER (semantic vs episodic; cli.ts prints it as "cross-layer duplicates"), not cross-tenant. No code depends on cross-tenant matches surviving; the v1.32.0 CHANGELOG labels cross-tenant dedupe a data-loss bug. Do not resurrect D1's objection.

## Tests

Existing: tests/dedupe-survivor-determinism.test.ts is the pin for the total order - must stay green untouched (single-tenant cases exercise the one-group path).
New (same file or tests/dedupe-tenant-partition.test.ts): (a) byte-identical content in tenant-a and tenant-b -> ZERO removals, both rows survive; (b) duplicates WITHIN tenant-a next to an identical pair within tenant-b -> exactly one removal per tenant, survivors correct per the total order in each; (c) dryRun parity for (b).

## Acceptance (E2E, the original repro)

Re-run the v1.32.0 verify drive on the compiled CLI (scratch store, cwd outside any git repo, all output captured): two tenants x identical episodic pairs -> sleep -> BOTH tenants keep their merged semantic row; the dedupe summary reports zero cross-tenant removals. The v1.32.0 drive's failing observation (tenant-b stripped to one episodic row, no semantic) must flip.

## Constraints

- Single file (src/dedupe.ts) + tests; no schema change, no API change, no version bump in this pass.
- Real-DB vitest; no em dashes; commit via Write + git commit -F.
- Ship as v1.32.1 (patch: pure bugfix, no API surface change) at the human gate.
