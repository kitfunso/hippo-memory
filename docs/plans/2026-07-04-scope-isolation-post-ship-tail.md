# Memory scope isolation — post-ship tail (v39 follow-ups)

Status: Draft (episode 01KWQF28KH757WRV2P1HJ0MEJ7)
Date: 2026-07-04
Base: origin/master 3418b92 (v1.24.1)
Branch: feat/scope-isolation-post-ship-tail

Closes the three promised follow-ups from `docs/plans/2026-07-01-memory-scope-isolation.md`
(TODOS.md §"Memory scope isolation post-ship tail" items 1-3). Item 4 (secret audit)
shipped v1.24.1; item 5 (S5 path-overlap tuning) stays deferred by design.

## Problem

1. **CLI `hippo recall` private-scope residue.** The direct CLI recall path loads
   candidates via unscoped `loadSearchEntries` (cli.ts:903-904). The scope filter at
   cli.ts:1565-1584 covers ONLY the `--continuity` block; the search functions'
   `scope` option is a rank boost (1.5x/0.5x, search.ts:602-605), not a filter. So
   `slack:private:*` / `github:private:*` / `unknown:legacy` rows reach direct-CLI
   recall output for no-scope callers, while `api.recall` (HTTP/MCP/server-routed
   CLI) denies them. Sibling surface `cmdExplain` (cli.ts:1888, load at 1968 path)
   has the identical gap.
2. **Silent secret-veto in sleep.** `autoShare` drops secret-flagged rows
   (shared.ts:445) with no observability; the v39 plan promised a skip count in
   `SleepResult` plus a sleep output line.
3. **Isolation coverage is engine-level only.** `/v1/context?cross_project=1` and
   the MCP `hippo_context` origin/secret filters are exercised only via
   `getContext` engine tests; no surface-level cases in
   `tests/server-context-route.test.ts` / `tests/mcp-context-scope.test.ts`.

## Non-goals (explicit)

- Graph-hop expansion scope parity (`--hops` / `--graph-stream` load reached
  memories by id and bypass scope filters; **api.recall has the same behavior**, so
  this is cross-surface parity, not a CLI residue — new TODOS follow-up line).
- S5 path-overlap tuning (deferred by design, needs retrieval eval).
- A7.2 pipeline unification (own plan + outside voice per TODOS).
- `hippo share --auto` CLI skip-count line (v39 promise covers the sleep surface).
- Background pipelines stay on unscoped `loadSearchEntries` (L9 host-wide reads
  are correct by design; documented at store.ts:665-667).

## Design

### T1 — cmdRecall scope default-deny (root fix, mirrors api.recall exactly)

Semantics contract (REVISED during execute — the original "mirror api.recall
exactly" contract broke `tests/scope-boost.test.ts`, which locks the CLI
`--scope` flag's ESTABLISHED tag-boost semantics over scope-NULL rows;
narrowing to the envelope column returns zero rows for every tag-scoped
workflow, e.g. `scope:plan-eng-review`-tagged skill memories):
- no `--scope` → identical to api.recall: SQL default-deny (`unknown:legacy`
  via `RECALL_DEFAULT_DENY_SCOPES`) + JS regex deny `<source>:private:*`
  (`isPrivateScope`). This is the security fix and is uncontested.
- explicit `--scope X` → **ADDITIVE UNLOCK** (CLI-specific, new
  'default-deny-or-exact' SQL mode + `passesCliRecallScopeFilter`): the
  default-admitted set PLUS rows whose envelope scope is exactly X. Deliberate
  access to the named private scope works; OTHER private scopes and quarantine
  buckets stay denied; tag-boost ranking over scope-NULL rows is preserved.
  Strictly safer than the legacy behavior (which admitted everything) and
  strictly compatible with the boost feature. `api.recall` keeps its narrowing
  exact-match — its opts.scope is an envelope request, the CLI flag is a
  ranking hint that now also unlocks; both documented in recall-scope.ts.
- `detectScope()` auto-detection stays a BOOST input only — it must NOT become
  a filter input (would change detected-project recalls' shape).
- Partially resolves the open "A3 --scope CLI semantics" TODOS item for the
  recall side: the envelope column now participates as an additive unlock;
  the remember-side dual-write is unchanged.

Changes:
1. **New leaf module `src/recall-scope.ts`** (mirrors the v39 `project-identity.ts`
   precedent for cycle-free sharing): move `PRIVATE_SCOPE_RE`, `isPrivateScope`,
   `passesScopeFilterForRecall` out of api.ts; import `RECALL_DEFAULT_DENY_SCOPES`
   from store.ts. api.ts **imports them for its ~9 internal call sites AND
   re-exports them** (a bare `export { x } from` does not bind local names —
   plan-eng-critic round 1 low). Back-compat: both are referenced as
   `api.isPrivateScope` / test-imported from api.ts today.
2. **cli.ts cmdRecall:** swap both loads (cli.ts:903-904) to
   `loadRecallSearchEntries(root, query, undefined, tenantId, recallExplicitScope ?? undefined)`
   and post-filter both entry sets with
   `passesScopeFilterForRecall(e.scope ?? null, recallExplicitScope ?? undefined)`.
   Drops are counted into `droppedPreRankCountCmd` (C5 WYSIATI suppression summary,
   mirroring api.recall's droppedPreRankCount at api.ts:790-793).
   NOTE: `recallExplicitScope` (the `--scope` flag) is the filter input;
   `recallActiveScope` (flag ?? detectScope()) remains boost-only.
3. **shared.ts searchBothHybrid** (the hasGlobal path re-loads internally,
   shared.ts:208-209): add optional `recallScope?: { requested?: string }` to
   `HybridSearchOptions` consumed by searchBothHybrid. Absent = legacy behavior
   (unscoped, background pipelines untouched); present = recall mode — `{}` is
   default-deny, `{ requested: 'X' }` is exact match. Object form deliberately
   avoids a second null-bearing field: `scope` on the SAME options bag already
   uses `null` = "no boost" / `undefined` = auto-detect (search.ts:546), so a
   `requestedScope: string | null` tri-state would give null two contradictory
   meanings one bag apart (grill finding #1).
   When present: internal loads go through `loadRecallSearchEntries` and a
   `passesScopeFilterForRecall` post-filter (from the leaf module — no api.ts
   cycle). Only cmdRecall sets it (`recallExplicitScope`); api.ts:2364 (ambient
   context), cli.ts:1968 (cmdExplain, gets its own fix), eval.ts:137 unchanged.
   `loadRecallSearchEntries` tenantId param widens `string` → `string | undefined`
   (pass-through; loadSearchRows already handles undefined; non-breaking widening).
   The `entryFilter` alternative was rejected: it lifts the candidate window to
   5000 rows (shared.ts:207) — a perf regression for every global-store recall —
   and filters post-load JS-only instead of pushing the predicate into SQL.
4. **cmdExplain:** same loader swap + post-filter (same leak class, found by the
   §3b sibling-clone audit). Minimal: default-deny mode only unless it already has
   a `--scope` flag (mirror whatever surface exists; no new flags). To avoid
   gaslighting an operator who is debugging why a private row does not surface
   (grill finding #2), when the scope filter dropped candidates print one note:
   `[note] N candidate(s) hidden by recall scope policy (explicit --scope to inspect)`.

### T2 — autoShare secret-veto skip count

1. `shared.ts autoShare`: optional `stats?: { secretSkipped: number }` out-param in
   the options bag. **Increment only when the row passes every OTHER admission
   gate (transferScore >= minScore, not already in global) and the secret veto is
   the sole reason it is withheld** — otherwise the counter over-reports (a
   low-transfer secret row was never going to share; plan-eng-critic round 1
   low). Implementation: evaluate score + dedup gates first, check
   `detectSecret` last, increment on veto. Return type unchanged;
   `SleepPhases.autoShare: typeof autoShare` DI seam stays type-identical; both
   prod callers unchanged unless they opt in.
2. `api.ts` sleep Phase 4 (api.ts:2716-2724): pass a stats object; set new optional
   `SleepResult.secretSkipped?: number` when > 0 (absent when 0, consistent with
   `shared`/`audit` fields). JSDoc: cross-tenant aggregate (autoShare in sleep runs
   host-wide), zeroed on egress like `graph`.
3. `src/sleep-redact.ts`: **do NOT redact `secretSkipped`** (plan-eng-critic
   round 1 resolution). Its nearest sibling `shared` — produced by the SAME
   host-wide autoShare call — is explicitly not redacted (sleep-redact.ts:48-51,
   "counted within api.sleep's per-call work"); redacting one sibling and not
   the other is field-by-field improvisation. `secretSkipped` therefore joins
   `shared` under the documented v1.11.4 SleepResult-aggregate posture (open
   MED in TODOS.md, resolved when non-loopback serving lands). Add a JSDoc
   cross-reference on the field + extend the existing TODOS aggregate-leak
   follow-up line to name both fields.
4. `cli.ts renderSleepResult`: when `secretSkipped > 0`, print
   `Auto-share: withheld N secret-flagged memories (secret veto).`

### T3 — surface-level isolation tests

1. `tests/server-context-route.test.ts`: (a) default `GET /v1/context` excludes
   cross-project rows; (b) `?cross_project=1` includes them; (c) secret-flagged row
   never returned, even with `cross_project=1`. Reuse the file's existing serve()
   harness.
2. `tests/mcp-context-scope.test.ts` (EXISTS — extend, do not create): add
   `hippo_context` origin-partition + secret-veto cases at the MCP surface,
   mirroring the engine-level `tests/context-scope-isolation.test.ts` cases.
3. T1 regression tests (new `tests/cli-recall-scope-deny.test.ts`, real SQLite per
   project rule): seed store with scope-NULL + `slack:private:*` +
   `github:private:*` + `unknown:legacy` rows; assert (a) no-scope direct recall
   returns only scope-NULL; (b) `--scope slack:private:C1` returns exactly that
   row; (c) hasGlobal path (searchBothHybrid with `requestedScope`) equally
   filtered; (d) suppression summary counts the drops; (e) cmdExplain path denied.
   Follow the existing direct-function CLI test pattern (no subprocess spawning
   where the suite avoids it).
4. T2 tests: autoShare stats unit case (next to tests/secret-detect.test.ts:101
   pattern); api.sleep secretSkipped via the `__phases` DI seam or a real
   secret-seeded store; sleep-redact zeroing case; renderSleepResult line — extend
   the existing snapshot block in `tests/cli-context-render-snapshot.test.ts`
   (NOTE: another session has uncommitted edits to this snapshot file's
   printContextMarkdown entries on the MAIN tree; our worktree edit touches only
   renderSleepResult entries — disjoint hunks, trivial merge if they land first).

## Ship

- Version: **v1.25.0** (additive public API: `HybridSearchOptions.recallScope`
  (object form, per Design T1.3), autoShare stats, SleepResult.secretSkipped;
  behavior fix on CLI recall).
- 5 version manifests (package.json, openclaw.plugin.json,
  extensions/openclaw-plugin/{package.json, openclaw.plugin.json}, src/version.ts);
  `check-manifest-versions.mjs` guards at prepublishOnly. Before bump:
  `git fetch && git show origin/master:package.json | grep version` (concurrent-
  merge guard).
- CHANGELOG entry + README "What's new" per repo convention; em-dash guard runs at
  prepublishOnly. `npm run build:all` before release (AGENTS.md hard rule).
- TODOS.md: tick items 1-3 of the post-ship tail; add the graph-hop scope-parity
  follow-up line.

## Execute-stage entry checks (unverified premises — resolve BEFORE coding)

1. **api.sleep Phase 4 under dry-run** (grill finding #3): the call at api.ts:2719
   passes no dryRun to autoShare. Confirm whether an upstream guard skips Phase 4
   under `--dry-run`; the secretSkipped counter and its tests must match the
   actual behavior (and if dry-run really shares, STOP — that is a separate bug
   to surface, not silently absorb).
2. **CLI recall test pattern** (grill finding #4): `cmdRecall` is not exported
   (cli.ts:878). Find how existing tests exercise the direct CLI recall path
   (exported dispatch? subprocess against dist?) and shape
   `cli-recall-scope-deny.test.ts` accordingly; if subprocess-only, account for
   the build prerequisite.
3. **cmdExplain flag surface**: confirm whether `--scope` exists there.
4. **sleep-redact.ts full policy read** (grill finding #5).

## Acceptance criteria

1. Direct `hippo recall` (no `--scope`) on a store seeded with private/legacy rows
   returns none of them; `--scope <private>` returns exact matches only;
   suppression summary counts the drops. Same via the hasGlobal path.
2. `hippo sleep` with a secret-flagged high-transfer row reports
   `secretSkipped: 1` + output line; field follows the `shared` sibling's
   redaction posture (not redacted; documented aggregate).
3. New surface tests green; full `npm test` green (real DB); `npm run build:all`
   green.

## Risks

- **Behavior change on direct recall**: operators who relied on no-scope recall
  surfacing private rows lose that (by design — parity with every other surface).
  Escape hatch documented: explicit `--scope`. CHANGELOG calls it out.
- **searchBothHybrid option**: additive; `recallScope?: { requested?: string }`
  (object form — presence enables recall-mode filtering; `{}` = default-deny,
  `{ requested: 'X' }` = exact). JSDoc must state plainly that ABSENCE is the
  only unfiltered mode, so background-pipeline callers never pass an empty
  object casually. (plan-eng-critic round 1: Ship/Risks previously drifted back
  to the rejected flat tri-state; reconciled to the object form everywhere.)
- **Snapshot-file contention** with the other session's uncommitted change
  (disjoint hunks; noted above).
