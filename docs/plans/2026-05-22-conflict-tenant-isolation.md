# Conflict-subsystem tenant isolation (E2)

Status: SHIPPED v1.11.0 — dev-framework-rl episode 01KS7HH20Y6SE3T898P3AE8CPM
Roadmap: v0.40.0 security follow-ups — "Tenant-guard audit on remaining MCP tools"

## Context

v0.39 hardened `recall`/`remember`/`outcome`/`share` for tenant isolation via
`src/api.ts`. The rest of the tenant-isolation pass was deferred to v0.40. A
roadmap reproduce-check sweep confirmed 3 of 6 remaining MCP tools are still
tenant-unguarded; this episode fixes the most severe — the conflict subsystem,
which reaches an unscoped `DELETE FROM memories`.

## Problem

The conflict subsystem is tenant-blind end to end:

- `memory_conflicts` (`db.ts:95`) has no `tenant_id` column.
- `listMemoryConflicts(hippoRoot, status)` (`store.ts:2008`) — `SELECT ... FROM
  memory_conflicts WHERE status=?`, no tenant filter. Returns every tenant's
  conflicts.
- `resolveConflict(hippoRoot, conflictId, keepId, forgetLoser)` (`store.ts:2116`)
  — `SELECT ... memory_conflicts WHERE id=?`, then `DELETE FROM memories WHERE
  id=?` (loser, `--forget`) or `UPDATE memories SET half_life_days...`, all by id
  with no tenant scope.
- `replaceDetectedConflicts` (`store.ts:2024`), the detector, pairs memories from
  a cross-tenant `survivors` set (`consolidate.ts:435`) and can persist a
  conflict row whose two members belong to different tenants.
- MCP tools `hippo_conflicts` / `hippo_resolve` / `hippo_status`
  (`mcp/server.ts:776/788/741`) call the unscoped primitives.

Impact: a Bearer scoped to tenant A can call `hippo_conflicts` to enumerate
tenant B's conflicts, and `hippo_resolve` with `forget=true` to **delete tenant
B's memory by id**. A cross-tenant data-integrity hole, not just disclosure.

## Root cause

Not the MCP layer — the `store.ts` conflict primitives were written before
multi-tenancy and never gained a `tenantId` parameter, unlike the v0.39-hardened
`loadAllEntries`/`loadSearchEntries`/`readEntry`. Guarding only the MCP handlers
would leave the unscoped `DELETE` reachable from any other caller. The fix
belongs in the primitives.

## Scope

IN — the conflict subsystem:
- `store.ts`: `listMemoryConflicts`, `resolveConflict`, `replaceDetectedConflicts`.
- `mcp/server.ts`: `hippo_conflicts`, `hippo_resolve`, `hippo_status`.

OUT — deferred to a follow-up TODO added by this episode:
- The ~10 unscoped `readEntry` call sites in `cli.ts`/`dashboard.ts`/
  `refine-llm.ts` — lower severity (CLI direct mode is single-tenant per
  process); a separate audit.
- `hippo_peers` — intentionally cross-project (peers ARE other projects); not a
  tenant bug.
- Threading tenant scoping through `consolidate.ts` itself (the detector's
  caller) — that is A5 follow-up L9 ("background pipelines bypass tenant
  filter"), already tracked for A5 v2.

## The fix

Pattern: match `loadAllEntries(hippoRoot, tenantId?)` (`store.ts:1506`) — an
**optional trailing `tenantId?`**; provided → scope the query, omitted → current
behavior. Optional (not required) because all existing callers —
`consolidate.ts`, `tests/resolve-conflict.test.ts`, `tests/consolidate.test.ts`,
`tests/consolidate-extraction.test.ts`, `tests/trace-autopromote.test.ts` — pass
no tenant. Adding an optional param is a non-breaking, minor-version change.

### Layer 1 — `listMemoryConflicts(hippoRoot, status, tenantId?)`

When `tenantId` is provided, JOIN to `memories` on BOTH conflict members and
require each in-tenant:

```sql
SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score, mc.status,
       mc.detected_at, mc.updated_at
FROM memory_conflicts mc
JOIN memories ma ON ma.id = mc.memory_a_id
JOIN memories mb ON mb.id = mc.memory_b_id
WHERE mc.status = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
ORDER BY mc.updated_at DESC, mc.id DESC
```

Column list and order unchanged, so `rowToMemoryConflict` maps the row with no
type change. JOINing on both members (consistent with `resolveConflict`) means
a stale pre-fix cross-tenant row is not surfaced to either tenant — not merely
suppressed for rows written after this fix. Omitted `tenantId` → today's query
verbatim (the `tenantId !== undefined ? scoped : original` shape from
`loadAllEntries`).

### Layer 2 — `resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId?)`

When `tenantId` is provided:

- The conflict-row `SELECT` requires **both** member memories to belong to
  `tenantId`:
  ```sql
  SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score, mc.status,
         mc.detected_at, mc.updated_at
  FROM memory_conflicts mc
  JOIN memories ma ON ma.id = mc.memory_a_id
  JOIN memories mb ON mb.id = mc.memory_b_id
  WHERE mc.id = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
  ```
  No row → `return null` — identical shape to a bad conflict id, so a
  cross-tenant probe is indistinguishable from "not found" (matches the
  `hippo_share` cross-tenant deny shape).
- The loser `DELETE FROM memories WHERE id=?` becomes `... AND tenant_id=?`.
- The loser weaken `UPDATE memories SET half_life_days...` becomes `... AND
  tenant_id=?`.
- The `conflicts_with_json` cleanup `UPDATE`s on keep/loser get `AND
  tenant_id=?` for consistency.

The both-members `SELECT` already proves the loser is in `tenantId`; the `AND
tenant_id=?` on the mutations is defense-in-depth so a future logic slip still
cannot cross tenants. Omitted `tenantId` → today's behavior verbatim.

### Layer 3 — `replaceDetectedConflicts` cross-tenant guard

Build `Map<id, tenant_id>` once from `SELECT id, tenant_id FROM memories`, then
apply it in BOTH of `replaceDetectedConflicts`' write paths:

1. **Insert loop** (`store.ts:2056`): skip any `canonicalDetected` pair whose
   two memories' tenants differ, or where either id is absent from the map — no
   cross-tenant conflict row is ever persisted.
2. **`conflicts_with_json` rebuild** (`store.ts:2075-2093`): when building
   `refMap` from the open-conflicts query, skip any pair that is cross-tenant by
   the same map check. Without this, a stale cross-tenant conflict row (one
   persisted before this fix) keeps seeding a tenant-B id into a tenant-A
   memory's `conflicts_with_json` on every consolidation run — a field surfaced
   by `hippo_status` and the physics `conflictPairs` map. (plan-eng-critic high
   finding.)

Together these make the Layer-1 join-on-`memory_a_id` sound AND make
pre-existing stale cross-tenant rows fully inert. Self-contained in `store.ts`;
`consolidate.ts` is untouched (the broader caller threading is A5 L9).

### Layer 4 — MCP handlers (`mcp/server.ts`)

`tenantId` is already resolved at `mcp/server.ts:405`
(`ctx?.tenantId ?? resolveTenantId({})`). Pass it through:

- `hippo_conflicts` (`:776`): `listMemoryConflicts(hippoRoot, 'open', tenantId)`.
- `hippo_resolve` (`:788`): `resolveConflict(hippoRoot, conflictId, keepId, forget, tenantId)`.
- `hippo_status` (`:741`): `listMemoryConflicts(hippoRoot, 'open', tenantId).length`.

## Tests — `tests/resolve-conflict.test.ts`

- `listMemoryConflicts` with `tenantId` returns only that tenant's conflicts;
  omitted returns all (back-compat).
- `resolveConflict` with a `tenantId` that does not own the conflict → `null`.
- `resolveConflict(..., forget=true, foreignTenantId)` → loser memory is NOT
  deleted (assert it still loads).
- `replaceDetectedConflicts` given a cross-tenant pair → no conflict row
  inserted; given a within-tenant pair → inserted.
- `replaceDetectedConflicts` with a stale cross-tenant conflict row already
  present → after a run, a tenant-A memory's `conflicts_with` does NOT contain
  the tenant-B id (Layer 3 `refMap` guard). (plan-eng-critic med finding.)
- Existing no-`tenantId` tests still pass (back-compat).
- Isolation exercised end to end: write memories under two `tenantId`s, assert
  no cross-tenant list/resolve/delete. Real DB per the hippo test convention.

## Verification

- `npm run build` clean.
- `npm test` (full vitest suite) green, including the existing conflict tests.
- CLI runtime evidence: `hippo` conflict commands still work in single-tenant
  (no-`tenantId`) mode.

## Risks

- Pre-existing cross-tenant conflict rows (persisted before this fix by the
  global detector) are fully inert after it: `listMemoryConflicts(tenantId)`
  does not surface them across tenants (Layer 1), `resolveConflict`'s
  both-members check makes them unresolvable (`null`, Layer 2), and Layer 3's
  `refMap` guard stops them seeding cross-tenant `conflicts_with_json` refs. No
  cleanup script — the detector fix prevents new ones and all three
  read/derive paths skip stale cross-tenant rows.
- Semver: optional trailing params on exported `store.ts` functions →
  non-breaking, minor bump.

## Files

- `src/store.ts` — `listMemoryConflicts`, `resolveConflict`, `replaceDetectedConflicts`.
- `src/mcp/server.ts` — `hippo_conflicts`, `hippo_resolve`, `hippo_status`.
- `tests/resolve-conflict.test.ts` — tenant-isolation tests.
- `CHANGELOG.md` — entry.
- `TODOS.md` — tick the E2 conflict-subsystem item; add the follow-up TODO
  (readEntry call sites + `hippo_peers` review).
- `docs/plans/2026-05-22-conflict-tenant-isolation.md` — this plan.
