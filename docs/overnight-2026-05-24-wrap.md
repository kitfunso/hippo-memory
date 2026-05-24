# Overnight wrap — 2026-05-24

**Session start:** 2026-05-24 ~00:00 GMT (continuation of v1.12.0 sub-1 ship session).
**Session end:** ~02:00 GMT (4 hours total work; episode 1 dominated).
**Mode:** `/dev-framework-rl` overnight loop with HITL hard stop before deploy gate.

## PRs queued for your morning review

| # | Branch | Title | Status | Episode ID |
|---|---|---|---|---|
| [#41](https://github.com/kitfunso/hippo-memory/pull/41) | `feat/v1.12.1-l9-tenant-scoping` | v1.12.1 L9 conflict-subsystem tenant-scoping (A5 v2 sub-2) | **CI green, mergeable** | `01KSBK0HY8R8YRWRBS0QGM7TKE` |
| [#42](https://github.com/kitfunso/hippo-memory/pull/42) | `feat/v1.12.2-sleep-phase-faults` | v1.12.2 api.sleep `__phases` DI seam + 6 mid-phase fault tests | CI running | `01KSBQ651EPN5M0ENXHKWE1KSE` |

**Merge ordering matters:** PR #41 must merge before #42 (the v1.12.2 changelog & version assume #41 has landed as v1.12.1).

Direct-to-master commit landed already: `e9106f9` — TODOS.md sync (marked 4 stale items DONE) + snapshot test `afterAll(useRealTimers)` belt-and-braces guard. No PR needed (17-line trivial change per B-trivial triage).

## Recommended merge sequence

1. **Review + merge PR #41** (v1.12.1) — full critic chain passed (plan-eng 82, code-review 84, independent-review round 2 86, ship-readiness 92). 3 commits including the WRITE-path L9 bug fix the round-1 review-critic caught.
2. **Verify v1.12.1 npm publish** via your existing release flow (or `npm publish` directly).
3. **Review + merge PR #42** (v1.12.2) — small surface, surrogate test coverage IS the critic for a DI seam addition (skipped formal critic chain per B-trivial PIPELINE exception).
4. **Verify v1.12.2 npm publish.**

If you'd rather hold #42 pending your own review of the DI seam approach (perfectly reasonable — `__phases` is a public-ish interface), the underlying tests would still help; or close #42 and ask me to redo with a tighter approach (e.g. `vi.mock`).

## PR #41 details (v1.12.1 L9 tenant-scoping)

**3 commits:**
- `9b47772` — original L9 implementation (11 unscoped reader sites classified into 6 PER-TENANT-OPT-IN + 5 HOST-WIDE-DOCUMENTED)
- `eaae300` — review-critic round 1 fix: WRITE-path `tenantId` plumb in `capture.ts:579` + `importers.ts:103` `createMemory` calls. The round-1 CRIT exposed that v1.12.1 had plumbed `tenantId` into the dedup READ paths (`loadAllEntries`) but missed the WRITE paths — captured/imported entries would have written under 'default' tenant even when `options.tenantId` was set
- `8a546c4` — case 6 (importers) symmetric WRITE-tenant assertion + CHANGELOG bullets updated to say "Per-tenant dedup AND write" (was just "dedup")

**Key files touched:** 8 src/ background-pipeline files (`consolidate.ts`, `embeddings.ts`, `invalidation.ts`, `refine-llm.ts`, `autolearn.ts`, `capture.ts`, `importers.ts`, `shared.ts`) + cli.ts (8 callers using `resolveTenantId({})`) + mcp/server.ts (1 caller using in-scope `tenantId`).

**Backward compat:** every new param OPTIONAL with default = host-wide (pre-1.12.1 behaviour). External consumers see no signature delta. `api.ts:2041` (`api.sleep` autoShare call) INTENTIONALLY unchanged — host-wide by intent per existing TODO at `api.ts:2073-2077`.

**Tests:** 13 cases in `tests/l9-tenant-scoping.test.ts` (7 per-tenant negative + 6 host-wide back-compat parity). Full suite 1713 passed + 4 skipped + 0 failures.

## PR #42 details (v1.12.2 api.sleep `__phases` DI seam)

**1 commit (`dd81fc3`):**
- Adds `SleepPhases` interface (8 phase deps), `DEFAULT_SLEEP_PHASES` const, `SleepOpts.__phases?: Partial<SleepPhases>` opt-in test-only field.
- `api.sleep` body: 7 phase-dependency call sites in the try-block rewritten to use `phases.X(...)` instead of the directly-imported `X(...)`. Default behaviour preserved.
- 6 cases in `tests/api-sleep-phase-faults.test.ts` lock the `partial: true` + `errorMessage` audit-row branch for faults at phases 1-5 + happy path.

**Closes:** the v1.11.5 deferral (independent-review-critic MED #2) where the `partial: true` audit-row branch was reachable but not test-locked.

**Trade-off worth your review:** the `__phases` field is technically part of the public `SleepOpts` interface even though it's marked `@internal`. Alternative was `vi.mock` — heavier test setup, no production surface area. Picked DI seam because it's cleaner per-test and the `__` prefix + JSDoc explicitly warn production callers off.

## Consolidated learn proposals (your apply / reject decisions)

Three pending learn proposals from today's sessions, all pointing at one root cause:

### Pattern: roadmap-sync gap (3 occurrences in 24 hours)

| Episode | When | What was stale |
|---|---|---|
| `01KSBBPKNW9Z1KG4H421WVMZEQ` | yesterday | F9 hybrid retrieval marked TODO in ROADMAP-RESEARCH despite shipping 2026-05-20 as PR #27 (retraction discipline correctly suppressed CHANGELOG/README mention) |
| `01KSB6S9116WGMXW44YFKB1HTR` | yesterday | v1.11.5 plan stage cap-hit because round-3 critic surfaced manifest-count drift + outcome-missing-from-Set that earlier rounds missed |
| `01KSBPTMRPREAJ7DZ9N96SDCHV` | tonight | 4 of 5 "B-batch hardening" TODOS items already shipped in v1.11.5 (DoS caps, isLoopback helper, /v1/context?q audit test) — aborted the full episode after reproduce-check |

### Proposed delta (Tier 2 — skill prompt edit)

Add to `~/.claude/skills/dev-framework-rl/SKILL.md` under "Reproduce-check every A-item before it enters the backlog":

> **Pre-plan codebase audit step.** Before drafting any plan: (1) grep the codebase for the specific symbols/files the brief names, (2) grep `docs/evals/` for results docs post-dating the last canonical-doc version mention, (3) grep `git log --since=14d` for commits touching the affected files. Items that no longer reproduce in current master get marked DONE in TODOS.md and the episode aborts at discover with a friction note. This step is the orchestrator's defence against TODOS.md staleness; the per-episode discipline is unreliable (3 reproduce-check WINs in 24 hours from the same root cause).

This would have caught Episode 2's stale scope (4 of 5 items shipped) at discover stage instead of the manual grep I did mid-episode.

**Decision:** apply or reject? My recommendation: apply. The cost is one extra grep step at the start of each episode (~30s of tool calls); the benefit is no more wasted episode setup on already-shipped work.

To apply:
```bash
python ~/.claude/dev-framework/scripts/devrl.py learn-apply \
  --failure-mode <id> \
  --summary "Add pre-plan codebase audit step to dev-framework-rl skill" \
  --skill-changed ~/.claude/skills/dev-framework-rl/SKILL.md
```

(I have NOT auto-applied this — Hand-Maintained-Files rule + Never-auto-apply orchestrator rule. Your call.)

## Session totals

| Metric | Count |
|---|---|
| Episodes initialized | 3 |
| Episodes shipped (PR-ready) | 2 |
| Episodes aborted (reproduce-check) | 1 |
| Direct-to-master commits | 2 (housekeeping + B-trivial) |
| PRs opened | 2 (#41, #42) |
| Tests added | 19 (13 L9 + 6 sleep-phase-faults) |
| Critic rounds run | 9 (plan ×2, code-review, review ×2, ship-readiness for #41; only verify for #42) |
| CRITs caught by critics | 4 (plan round 1: 3 CRITs; review round 1: 1 CRIT — WRITE-path L9 bug that would have shipped) |
| Friction notes recorded | 3 (all on roadmap-sync gap pattern) |
| Reproduce-check WINs | 1 (Episode 2: 4 of 5 items already shipped) |

## Hard stops respected

- ✅ No autonomous merge / publish / tag / deploy
- ✅ No autonomous `learn-apply` (skill prompt edits + CLAUDE.md edits require human approval)
- ✅ No `--no-verify` on commits
- ✅ No force pushes
- ✅ Git identity: `Kit <skfsk27@gmail.com>` (single-f, kitfunso GitHub account)
- ✅ All commits Co-Authored-By footer

## Next-up queue after these merge

From `TODOS.md` "v1.12.0 sub-2 / later":

- **Consolidate audit row tenant tag** (MED). When `/v1/sleep` moves off loopback-only, decide between synthetic 'host' tenant tag vs per-tenant scope. TODO inlined at `src/api.ts:2050`. Out of scope until non-loopback serving lands.
- **`hippo auth create-key --role` CLI flag** (LOW). v1.12.0 sub-1 added `role` to `createApiKey()` but the CLI wrapper doesn't surface `--role admin|member`. Tests use direct DB insert.
- **`hippo auth list` role column** (LOW). v1.12.0 sub-1's `listApiKeys` doesn't render role in the table.

From "Remaining post-Episode A/B/C tail":
- **`audit_log` emission on sleep consolidation phases** (A follow-up). Decide between one `'consolidate'` audit row per `api.sleep` invocation with phase counters in metadata, or per-phase rows tagged with `ctx.actor`. The v1.12.2 PR #42 ALREADY emits per-invocation; this item is about per-phase decomposition.
- **`api.recall` last-retrieval-ids parity with `cmdRecall`** (C follow-up). HTTP `GET /v1/memories` doesn't populate `last_retrieval_ids`.
- **`/v1/sleep` response shape cross-tenant leak** (v1.11.4 follow-up). `SleepResult.deduped.crossDups` etc. aggregate across all tenants. Today: admin-gated (v1.12.0). Future: redact or scope.

Larger items:
- **Python SDK v0.2** (~5d): sync wrappers, ContextResult.projected() helper, 204 handling.
- **v0.26 UI redesign port** (~15-20d): warm parchment + 3D Three.js scene from `mockups/hybrid-v4.html` into `ui/src/`.
