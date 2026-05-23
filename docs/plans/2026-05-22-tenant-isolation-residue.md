# v1.11.0 tenant-isolation residue (`readEntry` call-site audit + cross-tenant conflict auto-resolve)

Status: SHIPPED v1.11.1 — dev-framework-rl episode 01KS8W15619CC6CCW5HPMHCSN6
Roadmap: v0.40 follow-up — direct v1.11.0 residue, flagged by the v1.11.0 independent-review critic and tracked in `TODOS.md` "Tenant-isolation residue from the v1.11.0 conflict-subsystem pass".

Revision 1 folds in the plan-eng-critic review (which failed Revision 0 at
score 58 on 7 must-fix items): drop the proposed new `cliTenantId()` helper in
favour of the existing canonical `resolveTenantId({})` from `src/tenant.ts`;
correct the `promoteToGlobal` edit site from `cmdPromote` to `api.ts:1146`
(the only direct caller); fold in the sibling unscoped
`listMemoryConflicts`/`resolveConflict` calls in `cmdResolve` (same function
as the in-scope reads); defer `refine-llm.ts:151` alongside its unscoped
upstream `loadAllEntries` to L9 / A5 v2 (half-scoping would silently drop
parent text); correct mis-labelled per-site annotations
(`cmdOutcome` / `cmdInspect` / `cmdDecide --supersedes`); add a dashboard
`POST /api/star/:id` cross-tenant mutation test and a `cmdTrace` cross-store
test.

## Context

v1.11.0 shipped tenant-scoped `listMemoryConflicts` and `resolveConflict`
(`docs/plans/2026-05-22-conflict-tenant-isolation.md`, episode 01KS7HH2). Two
residues were carved out and tracked:

- (a) Unscoped `readEntry` call sites in `cli.ts`, `dashboard.ts`,
  `refine-llm.ts` (per the TODO text; `shared.ts`/`api.ts` carry the same
  defect class via `promoteToGlobal` and are folded in here).
- (b) `replaceDetectedConflicts` skips re-detected cross-tenant pairs in its
  insert and refMap loops but leaves them `status='open'` in its resolve-stale
  loop.

Out of scope per the TODO: (c) `hippo_peers`' intentionally cross-project read
(A5 v2 trust-boundary work).

## Problem

### (a) Unscoped `readEntry` call sites

`readEntry(hippoRoot, id, tenantId?)` (`src/store.ts:1210`) gained an optional
trailing `tenantId` in v0.39: when set, `WHERE id = ? AND tenant_id = ?`; when
omitted, unscoped (legacy behaviour, preserved for single-tenant deployments
and consolidation paths). `loadSearchEntries` got the same treatment, and
every `loadSearchEntries` call site already passes `tenantId`. `readEntry` has
11 in-scope unscoped sites that need to gain `tenantId`:

- `src/cli.ts` — 9 sites: line 757 (`cmdSupersede`), 1799 + 1803 + 1829
  (`cmdTrace` local-root, global-root, and parent walk on both roots), 2694
  (`cmdOutcome` — apply-good/bad outcome loop), 2760 (`cmdInspect`), 2897 +
  2898 (`cmdResolve`'s conflict-display lookups for memories A and B), 6283
  (`cmdDecide`'s `--supersedes` lookup).
- `src/dashboard.ts` — 1 site: line 415 (the `POST /api/star/:id` toggle, the
  only MUTATION path in (a)).
- `src/api.ts` — 1 site: line 1146 (`promoteToGlobal` call — the only direct
  caller of `promoteToGlobal` in `src/`; this replaces what Revision 0
  incorrectly addressed as a `cmdPromote` edit).

`src/refine-llm.ts:151` is **deferred** — see "Deferred to L9" below.

`cmdResolve` also runs unscoped sibling calls in the same function as
2897/2898: `cli.ts:2885` (`listMemoryConflicts(hippoRoot, 'open')`) and
`cli.ts:2913` (`resolveConflict(hippoRoot, conflictId, keepId, forgetLoser)`).
Same defect class. Folded into this episode rather than deferred: leaving the
same-function siblings unscoped would let a multi-tenant CLI user enumerate
and resolve a cross-tenant conflict by id in the very function being edited.

In a single-tenant deployment (`HIPPO_TENANT` unset → `'default'`) every memory
carries `tenant_id='default'`, so unscoped reads return the right rows by
coincidence. In a multi-tenant deployment a CLI / dashboard process running
under `HIPPO_TENANT=tenant_b` can read (or, via `POST /api/star/:id`, mutate)
a memory belonging to `tenant_a`.

### (b) Stale cross-tenant rows lingering in `memory_conflicts`

`replaceDetectedConflicts` (`src/store.ts:2042`) builds a `tenantById` map and
a `sameTenant(a, b)` helper, and uses it to skip cross-tenant pairs in the
insert loop (line 2089) and the `conflicts_with_json` rebuild (line 2117). But
its resolve-stale loop (lines 2081-2086) resolves an open row only when the
row's key is absent from `detectedKeys`. If the detector re-detects a
cross-tenant pair (the detector calls `loadAllEntries(root)` with no tenant
filter — the broader L9 concern), the cross-tenant key IS in `detectedKeys`.
The insert loop skips re-inserting (cross-tenant), the refMap loop skips it
(cross-tenant), and the resolve-stale loop sees the key in `detectedKeys` and
does NOT resolve. The open cross-tenant row stays `status='open'`.

## The fix

### (a) Tenant-scope every in-scope unscoped `readEntry` site

**Reuse the canonical `resolveTenantId({})` helper** from `src/tenant.ts:9`.
The helper already exists and is used 17+ times in `cli.ts` (imported on line
159) and in `dashboard.ts` (imported on line 16). It returns
`process.env.HIPPO_TENANT?.trim() || 'default'` for the no-`apiKey` path
(and validates via api key when one is supplied — irrelevant for CLI direct
mode). Every unscoped CLI / dashboard `readEntry` site gains
`, resolveTenantId({})` as the third argument. Three legacy inline
`process.env.HIPPO_TENANT ?? 'default'` reads (`cli.ts:4974`, `5237`, `5257`)
are switched to `resolveTenantId({})` in the same pass — they predate the
helper, use the strictly-less-safe `??` form (which lets a literal empty
`HIPPO_TENANT=""` through), and the DRY win is free.

Per-site mapping (each gains `resolveTenantId({})` as the in-scope tenant):
- `cli.ts:757` — `cmdSupersede`, `readEntry(hippoRoot, oldId)`.
- `cli.ts:1799`, `:1803`, `:1829` — `cmdTrace` local-root, global-root, and
  parent walk on both roots. See "cmdTrace cross-store" below.
- `cli.ts:2694` — `cmdOutcome`, outcome loop over `index.last_retrieval_ids`.
- `cli.ts:2760` — `cmdInspect`.
- `cli.ts:2885` — `cmdResolve`, `listMemoryConflicts(hippoRoot, 'open',
  resolveTenantId({}))` (sibling-defect-class, folded in).
- `cli.ts:2897`, `:2898` — `cmdResolve`'s conflict-display readEntries for
  memories A and B.
- `cli.ts:2913` — `cmdResolve`, `resolveConflict(hippoRoot, conflictId,
  keepId, forgetLoser, resolveTenantId({}))` (sibling-defect-class, folded
  in).
- `cli.ts:6283` — `cmdDecide`'s `--supersedes` lookup.
- `dashboard.ts:415` — `POST /api/star/:id`.

**cmdTrace cross-store.** `cmdTrace` reads from both local and global roots
(lines 1799 / 1803, plus the parent walk at 1829 against both). The global
store preserves `tenant_id` on promoted entries (`shared.ts:66` spreads the
entry — the source `tenant_id` is preserved). The scoping is applied to BOTH
local and global reads: tracing under `HIPPO_TENANT=tenant_b` no longer
returns a memory promoted to global by `tenant_a`. This is consistent with the
security tightening across every other site in this pass; a user who needs to
trace cross-tenant can set `HIPPO_TENANT` explicitly. The behaviour change is
named in Risks and covered by a `cmdTrace` cross-store test.

**`promoteToGlobal` at `api.ts:1146`.** `cmdPromote` does NOT call
`promoteToGlobal` directly — it routes through `api.promote(ctx, id)`, which
calls `promoteToGlobal` on line 1146. Extend `shared.ts:52`'s
`opts?: { actor?: string }` to `opts?: { actor?: string; tenantId?: string }`
and pass it to `readEntry`. Update `api.ts:1146` to:

```ts
const globalEntry = promoteToGlobal(ctx.hippoRoot, id, {
  actor: ctx.actor,
  tenantId: ctx.tenantId,
});
```

`api.promote` already verifies tenant ownership at lines 1130-1140 (an
`ownerDb` check that throws if the local memory's `tenant_id` doesn't match
`ctx.tenantId`). Passing `tenantId` into `promoteToGlobal` is defence in
depth — no behaviour change for valid promotions, an extra safety net against
any future caller that skips the ownership pre-check.

### Deferred to L9 — `refine-llm.ts:151`

`refineStore(hippoRoot, opts)` (`refine-llm.ts:118`) calls
`loadAllEntries(hippoRoot)` on line 130 with no tenant filter, then for each
consolidated entry walks `entry.parents` with a per-parent
`readEntry(hippoRoot, pid)` on line 151. Scoping only the per-parent
`readEntry` in isolation would silently drop parent text whose tenant differs
from the caller's — the unscoped loader produces an entry, the scoped per-parent
read fails to find its parents (because they sit under another tenant), and
`sources` ends up empty for that entry. Refine itself needs Context-style
tenant routing: thread `tenantId` through `refineStore`, scope BOTH the loader
AND the per-parent read together. That is squarely L9 "background pipelines
bypass tenant filter" work — already named in TODOS as A5 v2 scope.
`refine-llm.ts:151` stays unscoped, and the L9 TODOS entry gets a one-line
back-reference so the dependency is visible.

### (b) Auto-resolve cross-tenant rows in `replaceDetectedConflicts`

Extend the resolve-stale loop condition:

```ts
for (const row of openRows) {
  const key = `${row.memory_a_id}::${row.memory_b_id}`;
  const stale = !detectedKeys.has(key);
  const crossTenant = !sameTenant(row.memory_a_id, row.memory_b_id);
  if (stale || crossTenant) {
    db.prepare(
      `UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ?`,
    ).run(detectedAt, row.id);
  }
}
```

`sameTenant(a, b)` returns `false` when one of the ids is missing from
`tenantById` (orphan pair) OR when the two tenants differ — both warrant
resolution. The `tenantById` map is already built one block up (lines
2057-2060); no extra DB query. The resolution carries the same `detectedAt`
timestamp as a normal stale resolution; no schema change.

## Tests

- `tests/resolve-conflict.test.ts` (E2's existing file) gains one case: seed
  two memories under tenants `t_a` and `t_b`, manually insert a cross-tenant
  `memory_conflicts` row with `status='open'`, run `replaceDetectedConflicts`
  with a `detected` set that includes the cross-tenant pair. Assert the row
  is now `status='resolved'` with `updated_at = detectedAt`.
- `tests/cli-tenant-scoping.test.ts` (new) — two cases:
  - `hippo trace <id>` spawn under `HIPPO_TENANT=t_b` against a LOCAL store
    holding the same `id` under both `t_a` and `t_b`. Asserts only `t_b`'s
    memory is shown.
  - `hippo trace <id>` spawn under `HIPPO_TENANT=t_b` against a GLOBAL store
    holding a `g_*` memory with `tenant_id=t_a`. Asserts "not found" (the
    cross-store tightening behaviour change).
- `tests/dashboard-tenant-scoping.test.ts` (new) — a real `http.request`
  against the `serveDashboard` handler. Seed two memories under `t_a` and
  `t_b`, set `HIPPO_TENANT=t_b`, send `POST /api/star/:id` for the `t_a`
  memory's id, assert the response is 404 and the `t_a` memory's `starred`
  field is unchanged (mutation denied).
- `tests/shared.test.ts` gains one `promoteToGlobal` case covering the new
  `tenantId` opt: seed under two tenants, promote with `opts.tenantId = t_a`,
  assert only `t_a`'s entry is promoted.
- All against real DB / real CLI spawn / real `http.request` — no mocks.

## Verification

- `npm run build` clean.
- `npm test` exits 0 — full suite.

## Risks

- **Behaviour change: `hippo trace` cross-store.** A multi-tenant CLI
  invocation that previously traced a memory promoted to global by another
  tenant will now return "not found". Intended (consistent across every site
  in this pass); covered by the `cmdTrace` cross-store test.
- **Behaviour change: dashboard `POST /api/star/:id`.** A multi-tenant
  dashboard process running under `HIPPO_TENANT=t_b` can no longer mutate a
  `t_a` memory by id. Intended; covered by the new dashboard test.
- **`refine-llm.ts:151` stays unscoped pending L9.** A multi-tenant
  deployment running `hippo refine` today already crosses tenants via the
  unscoped `loadAllEntries`; this episode does not change that. The TODOS
  cross-reference on the L9 line makes the dependency visible so the refine
  scoping lands as one coherent change with the loader.
- **Out-of-scope items, kept honest.** `hippo_peers` cross-project read
  (A5 v2). L9 background-pipelines unscoped reads (A5 v2). The (b)
  auto-resolve handles cross-tenant rows regardless of how they got there, so
  the detector's unscoped read remains acceptable until L9 lands.

## Files

- `src/store.ts` — extend `replaceDetectedConflicts` resolve-stale loop with
  the `crossTenant` condition.
- `src/cli.ts` — tenant-scope 11 sites (9 `readEntry` + the two cmdResolve
  sibling calls `listMemoryConflicts` and `resolveConflict`); switch 3 legacy
  inline `HIPPO_TENANT ?? 'default'` reads to `resolveTenantId({})`.
- `src/dashboard.ts` — tenant-scope the 1 `readEntry` site
  (`POST /api/star/:id`).
- `src/shared.ts` — extend `promoteToGlobal` opts with `tenantId?`; pass it
  to `readEntry`.
- `src/api.ts` — update the `promoteToGlobal` call at line 1146 to pass
  `tenantId: ctx.tenantId`.
- `tests/resolve-conflict.test.ts` — new cross-tenant-resolve case.
- `tests/cli-tenant-scoping.test.ts` (new) — two `cmdTrace` cases (local and
  cross-store).
- `tests/dashboard-tenant-scoping.test.ts` (new) — `POST /api/star/:id`
  cross-tenant mutation denial.
- `tests/shared.test.ts` — new `promoteToGlobal` `tenantId` opt case.
- `TODOS.md` — add a one-line cross-reference on the L9 entry pointing at
  `refine-llm.ts:151` as a dependent site.
- `docs/plans/2026-05-22-tenant-isolation-residue.md` — this plan
  (Revision 1).
