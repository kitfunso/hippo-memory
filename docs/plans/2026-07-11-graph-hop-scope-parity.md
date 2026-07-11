# Graph-hop scope parity (v1.26.1)

Status: Reviewed — plan-eng-critic pass 88 round 1 (opus arm), 1 MED + 2 LOW advisories folded in (test cases 6-7, CHANGELOG behavior-change callout, patch-bump verdict)
Episode: 01KX85KQ3799P7XG1QT9850RM7
Source: TODOS.md "New follow-ups from the v1.25.0 episode" item 1 (review-stage advisory, PR #123)
Branch: `feat/graph-hop-scope-parity` off origin/master @ d325cf1 (v1.26.0)

## Problem

`graphExpandRecall` (src/graph-recall.ts) — the `--hops` graph expansion — injects
out-of-pool memories into recall results, loaded directly by id via `loadEntriesByIds`
(tenant-scoped, archived-excluded). The emit loop re-applies the superseded/asOf hard
filters but NOT the v39 recall scope rule: a private-scoped (`<source>:private:*`) or
quarantine-scoped (`RECALL_DEFAULT_DENY_SCOPES`) memory reached through the graph is
surfaced with full content, bypassing the default-deny that every base recall path
applies (api.ts:752, cli.ts scope-filter block hoisted v1.25.0, shared.ts:249-253,
mcp/server.ts:537/999).

Call surfaces: `cmdRecall` (cli.ts:1125, `--hops`) and the PUBLIC export
(src/index.ts:8) reachable by any SDK consumer.

## Diagnosis (discover-stage mechanism audit, 2026-07-11)

- **Reachability today: no shipped write path produces a leak.** The graph is derived
  exclusively from the four E2 object tables (`extractGraph` reads decisions / policies /
  customer_notes / project_briefs); E2 mirror memories are created via `createMemory`
  with no scope option, so every graph-referenced memory currently has `scope = NULL`.
- **But the store permits the leaking state.** The E3.3 consolidated-source guard checks
  kind/provenance, NOT scope. `api.remember` defaults `kind: 'distilled'` (api.ts:236),
  which passes the no-raw guard, so entities/relations rows referencing a private-scoped
  memory are legal writes today (graph.ts writers, SDK, importers, future E2 scope
  plumbing — customer_notes are the obvious candidate to grow private scopes).
- **The public export is unguarded regardless of extraction.** `graphExpandRecall`
  accepts arbitrary `baseResults` and loads whatever the graph references; SDK callers
  get no scope rule at all.
- **`--graph-stream` is covered by design, not by luck.** graph-stream.ts is re-rank-only:
  it assigns ranks solely to entries already present in the caller's (scope-filtered)
  candidate pool and loads only entity rows, never out-of-pool memory content. It needs a
  regression test pinning that property, not a code change.
- **Corrections to the filed TODOS item:** api.recall has NO hops path (comment only,
  api.ts:2733); MCP has no graph expansion. The "cross-surface parity" is cli + public
  export, not cli + api.

## Design decision: read-side predicate, caller-declared semantics

A write-side ban ("graph rows must not reference private-scoped memories") is the WRONG
layer: the v39 matrix makes private scopes deliberately recallable via explicit
`--scope`, and a deliberately-unlocked private recall must be able to use graph context.
The graph may index scoped rows; the READ side applies the same scope rule as base
recall.

Semantics are caller-declared by cloning the existing `shared.ts` shape verbatim
(shared.ts:206-253): `recallScope?: { requested?: string; additive?: boolean }`,
dispatching to `passesCliRecallScopeFilter` (additive/CLI unlock) vs
`passesScopeFilterForRecall` (exact/api narrowing) from `src/recall-scope.ts`.
**Fail-closed default:** an absent `recallScope` (bare public-export call) normalizes to
`{}` → `passesScopeFilterForRecall(scope, undefined)` = default-deny private + quarantine,
NULL passes — identical to a no-flag base recall.

## Tasks

### T1 — predicate in graph-recall.ts

- Add to `GraphExpandOpts`:
  ```ts
  /** Recall-side envelope scope rule applied to graph-REACHED memories (the injected
   *  rows), mirroring shared.ts SearchBothOptions.recallScope. Omitted = default-deny
   *  (private + quarantine scopes excluded, NULL passes) — the fail-closed default for
   *  bare/SDK callers. { requested, additive: true } = CLI --scope unlock semantics
   *  (passesCliRecallScopeFilter); additive false/absent with requested set = api
   *  exact-narrowing semantics (passesScopeFilterForRecall). Base results are the
   *  caller's responsibility (they passed through the caller's own scope filter). */
  recallScope?: { requested?: string; additive?: boolean };
  ```
- Import `passesCliRecallScopeFilter, passesScopeFilterForRecall` from
  `./recall-scope.js` (leaf module; no cycle — graph-recall.ts already imports from
  store.js/graph.js/compare.js).
- Thread through `graphExpandRecall` → `produceHitsForRoot` (extend the
  `Required<Pick<...>>` opts type with `recallScope: { requested?: string; additive?: boolean }`,
  normalized `?? {}` at the top of `graphExpandRecall`).
- In the emit loop, adjacent to the existing superseded/asOf `continue`s and BEFORE
  `seenMemoryIds.add(mem.id)`:
  ```ts
  const scopeOk = recallScope.additive
    ? passesCliRecallScopeFilter(mem.scope ?? null, recallScope.requested)
    : passesScopeFilterForRecall(mem.scope ?? null, recallScope.requested);
  if (!scopeOk) continue;
  ```
  A denied row must NOT enter `seenMemoryIds` (it was not surfaced; the id-uniqueness
  argument across stores does not need it and adding it would be misleading state).
- NOTE (pre-empting review): the load stays by-id (`loadEntriesByIds`) with a JS filter,
  matching api.ts:752's belt-and-braces JS layer. There is no SQL LIMIT window here to
  starve (ids are explicit, chunked at 500), so the filter-before-window rule does not
  bind; denied rows are loaded then dropped, exactly like base recall's JS half.

### T2 — CLI thread-through

- cli.ts:1125 `graphExpandRecall` call gains
  `recallScope: recallExplicitScope ? { requested: recallExplicitScope, additive: true } : {}`
  — byte-parallel to the `searchBothHybrid` call (cli.ts:1082). Input is
  `recallExplicitScope` (the explicit `--scope` flag), NOT `recallActiveScope`/
  `detectScope()`: auto-detected scope feeds only the tag-boost ranking hint, never the
  envelope unlock, matching every existing envelope-filter call site.

### T3 — tests (real SQLite stores, repo convention)

New `tests/graph-recall-scope.test.ts`:
1. **Core red-on-master case:** store with a NULL-scope seed memory + a private-scoped
   (`slack:private:dm1`, kind `distilled`) memory + entities/relations linking them
   (inserted via graph.ts writers — legal writes). `graphExpandRecall([seed], {hops: 1, ...})`
   surfaces the private row on master; with the fix (no `recallScope`) it is absent.
2. **Deliberate CLI unlock:** `recallScope: { requested: 'slack:private:dm1', additive: true }`
   → the private row SURFACES (parity with base-recall unlock).
3. **Exact/api narrowing:** `recallScope: { requested: 'slack:private:dm1' }` (additive
   absent) → only exact-scope rows pass (the NULL-scope neighbour is dropped too —
   passesScopeFilterForRecall semantics).
4. **Quarantine deny:** a reached row with scope `unknown:legacy` is dropped by default.
5. **CLI e2e:** seeded store, `hippo recall <q> --hops 1` → private content absent from
   stdout; `--scope slack:private:dm1 --hops 1` → present. (Mirror the existing CLI
   harness used by tests/graph-recall.test.ts.)
6. **Global-root case (plan-eng-critic MED):** a private-scoped memory reachable only
   via the GLOBAL store's graph (globalRoot set, local graph empty) is dropped by
   default — pins the cross-root property empirically rather than by "same function
   body" inspection. Mirrors the existing global-store harness at
   graph-recall.test.ts:203.
7. **Unlock composition case (plan-eng-critic LOW):** with
   `recallScope: { requested: 'slack:private:dm1', additive: true }`, a reached
   NULL-scope row surfaces, the dm1 row surfaces, and a SECOND private scope
   (`slack:private:dm2`) stays denied — one integration case closing the
   unlocked-seed × mixed-neighbour composition.

Graph-stream pinning case (in the existing graph-stream test file): a graph-reachable
OUT-of-pool private-scoped memory must not appear in `--graph-stream`/`graphStream`
results — pins the pool-only property the coverage argument rests on.

**Red-on-master proof protocol:** run the new test file in a pristine master worktree
with ONLY the test file added (no src changes); the core case must FAIL there and pass
on the branch. Empirical, recorded in the verify manifest. Per the
measure-before-fixing discipline: the core case asserts on the presence/absence of a
specific memory id in the returned set — no score-tie assumptions anywhere.

### T4 — docs + version (ship stage)

- CHANGELOG 1.26.1: Fixed — graph-hop expansion now applies the recall scope rule
  (default-deny parity + `--scope` unlock parity); honest framing: hardening, no known
  leak via shipped write paths (graph derives only from E2 tables whose mirrors carry
  no scope today). Added — graph-stream pool-only regression pin. MUST explicitly call
  out (plan-eng-critic): `graphExpandRecall` is a public export whose DEFAULT behavior
  changes — a bare call now default-denies private/quarantine reached rows; an SDK
  consumer relying on graph surfacing scoped rows must pass `recallScope` to unlock.
  Patch bump justified per critic verdict: backwards-compatible bug fix closing a
  surface v39 missed (v39 was MINOR because it introduced the feature, not because
  default-deny is intrinsically minor).
- MEMORY_ENVELOPE.md: if it enumerates recall surfaces for the v39 matrix, add the
  graph-expansion row (targeted edit; check at execute).
- TODOS.md: mark the follow-up item resolved with the two corrections (api hops path
  nonexistent; graph-stream covered by design + now pinned).
- Version bump 1.26.0 → 1.26.1 across the 5 lockstep manifests (package.json,
  openclaw.plugin.json, extensions/openclaw-plugin/{package.json, openclaw.plugin.json},
  src/version.ts); `check-manifest-versions.mjs` gate.

## Acceptance criteria (falsifiable)

1. Core regression test proven RED on pristine master, GREEN on branch.
2. Deliberate-unlock parity + exact-narrowing + quarantine cases green.
3. Graph-stream pool-only pin green on branch AND on master (it documents existing
   behavior — if it is RED on master, the coverage claim was wrong: escalate, extend the
   fix to graph-stream with the same recallScope shape, and re-plan the test).
4. Full vitest green (known pre-existing exception: server-concurrency ECONNRESET flake,
   passes in isolation); micro-eval 11/11 (= master baseline); `npm run build:all`;
   manifest-version check OK.
5. Zero behavior change for scope-NULL stores: existing graph-recall/graph-stream/
   tiebreak test files pass unmodified.

## Review-stage deviations (2026-07-11)

- codex round 1 returned 2 P2s, no P0/P1. P2-2 (manifests at 1.26.0 while CHANGELOG says
  1.26.1) was a stage-sequencing artifact: the bump was planned for ship and is pulled
  forward. P2-1 (emit-time filtering lets denied rows consume the relation window /
  frontier slots) is REAL but shares its root and its trigger with both
  independent-review lows (traversal-through-denied-nodes; entity-name observability):
  all three need scope-aware traversal and all three are inert until graph rows can
  reference scoped memories, which no shipped writer produces. Per
  docs/release-policy.md's iteration threshold, shipped as a CHANGELOG Known
  Limitation + one consolidated TODOS follow-up gated on E2 scope plumbing, rather
  than restructuring the BFS hot path for an unreachable population. The
  feedback_sql_filter_before_limit_window probation memory fired on exactly this
  pattern: applied to the by-id load at plan time, missed on the relation window -
  codex caught the residual.

## Out of scope (deliberate)

- **Write-side scope guard on graph rows** — wrong layer (breaks deliberate unlock).
- **Consolidation scope-inheritance audit** (consolidate.ts has no scope handling; if
  merging scoped rows can launder content into NULL-scope consolidated rows, that is a
  base-recall surface independent of graph expansion). Reproduce-check at execute; if
  genuinely uncovered by the v39 work, file ONE TODOS candidate line — do not fix here.
- **Entity NAME leakage in graph observability** (entity names derive from E2 objects,
  never private today; becomes relevant only if E2 objects gain scopes — noted for that
  future plan).
- **MCP/api hops surfaces** — do not exist.

## Risks

- `mem.scope` may be `undefined` on older rows → always coerce `?? null` before the
  predicates (both predicate functions type `scope: string | null`).
- The graph-stream coverage claim is empirical-by-test, with the contingency named in
  acceptance criterion 3.
- Performance: O(1) JS predicate per reached row; no SQL changes; no new queries.
