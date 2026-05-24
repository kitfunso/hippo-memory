# Overnight 2026-05-24 — final wrap

**Session:** 2026-05-24 ~00:00 → ~11:15 GMT (continuation of v1.12.0 sub-1 ship session).
**Mode:** `/dev-framework-rl` overnight loop with HITL deploy gate, then user authorized "merge + publish + continue" at ~09:45 GMT.
**Episodes:** 4 shipped (v1.12.1 / .2 / .3 / .4), 1 aborted (reproduce-check WIN).

## Final state on npm + GitHub

| Version | npm | Tag | Release | PR |
|---|---|---|---|---|
| 1.12.1 | [live](https://www.npmjs.com/package/hippo-memory/v/1.12.1) | `v1.12.1` | [release](https://github.com/kitfunso/hippo-memory/releases/tag/v1.12.1) | [#41](https://github.com/kitfunso/hippo-memory/pull/41) |
| 1.12.2 | [live](https://www.npmjs.com/package/hippo-memory/v/1.12.2) | `v1.12.2` | [release](https://github.com/kitfunso/hippo-memory/releases/tag/v1.12.2) | [#42](https://github.com/kitfunso/hippo-memory/pull/42) |
| 1.12.3 | [live](https://www.npmjs.com/package/hippo-memory/v/1.12.3) | `v1.12.3` | [release](https://github.com/kitfunso/hippo-memory/releases/tag/v1.12.3) | [#43](https://github.com/kitfunso/hippo-memory/pull/43) |
| 1.12.4 | [live](https://www.npmjs.com/package/hippo-memory/v/1.12.4) | `v1.12.4` | [release](https://github.com/kitfunso/hippo-memory/releases/tag/v1.12.4) | [#44](https://github.com/kitfunso/hippo-memory/pull/44) |

**Latest on npm: `hippo-memory@1.12.4`**

## What shipped

### v1.12.1 — L9 conflict-subsystem tenant-scoping (A5 v2 sub-2)
- 11 unscoped reader sites across 8 background-pipeline files classified into 6 PER-TENANT-OPT-IN + 5 HOST-WIDE-DOCUMENTED
- `tenantId?: string` plumbed through `invalidateMatching`, `RefineOptions`, `CaptureOptions`, `ImportOptions`, `autoShare` options bag, `deduplicateLesson` root-string overload
- **WRITE-path tenant scoping** (caught by independent-review-critic round 1): `capture.ts:579` + `importers.ts:103` `createMemory` calls now mirror the dedup-read guard
- 6 host-wide reader sites documented with L9 JSDoc; `api.ts:2041` (`api.sleep` autoShare) intentionally unchanged
- 13 new tests; back-compat-safe; no DB migration

### v1.12.2 — `api.sleep` mid-phase test coverage via `__phases` DI seam
- `SleepOpts.__phases?: Partial<SleepPhases>` opt-in test-only field
- `DEFAULT_SLEEP_PHASES` const preserves all current behaviour when `__phases` is undefined
- 6 cases lock the `partial: true` + `errorMessage` audit-row branch for faults at each of the 5 phase boundaries + happy path
- Closes the v1.11.5 deferral (independent-review-critic MED #2)

### v1.12.3 — `hippo auth` CLI role surfacing
- `hippo auth create --role admin|member` flag (defaults to `admin`); invalid values exit 1 (no silent fallback)
- `hippo auth list` table includes role column between tenant and label
- `POST /v1/auth/keys` accepts optional `body.role`; mirrors CLI flag exactly
- `ApiKeyListItem.role` populated; **fail-safe-to-member cast** on unrecognised values
- 5 new tests

### v1.12.4 — `auth_create` audit emit (closes v1.12.3 deferral)
- `api.authCreate` emits `auth_create` audit row on every successful mint
- Mirrors the existing `auth_revoke` audit pattern
- Metadata: `{ label, role }` — `targetId`: new `keyId` — `actor`: `ctx.actor.subject`
- **Security invariant test**: plaintext key NEVER appears in audit metadata
- 6 new tests including a mint+revoke pair assertion

## Session totals

| Metric | Count |
|---|---|
| Episodes initialized | 5 |
| Episodes shipped | 4 |
| Episodes aborted (reproduce-check) | 1 |
| Direct-to-master commits | 2 (housekeeping + B-trivial snapshot guard) |
| PRs opened + merged | 4 (#41, #42, #43, #44) |
| npm publishes | 4 (1.12.1 → 1.12.4) |
| Tests added | **30** (13 L9 + 6 sleep-phase-faults + 5 auth-role-cli + 6 auth-create-audit) |
| Critic rounds run | 9 (plan ×2, code-review, review ×2, ship-readiness on #41; verify on #42 — #43 + #44 used small-episode exception) |
| **CRITs caught by critics before ship** | **4** (plan round 1: 3 CRITs; review round 1: 1 CRIT — WRITE-path L9 bug) |
| Friction notes recorded | 3 (all on the roadmap-sync gap pattern) |
| Reproduce-check WINs | 1 (Episode 2: 4 of 5 items already shipped) |

## Pending learn proposals (still awaiting your apply/reject)

### Pattern: roadmap-sync gap (3 occurrences in 24 hours)

| Episode | What was stale |
|---|---|
| `01KSBBPKNW9Z1KG4H421WVMZEQ` | F9 hybrid retrieval marked TODO despite shipping 2026-05-20 |
| `01KSB6S9116WGMXW44YFKB1HTR` | v1.11.5 plan stage cap-hit on manifest-count drift surfaced only at round 3 |
| `01KSBPTMRPREAJ7DZ9N96SDCHV` | 4 of 5 "B-batch hardening" TODOS items already shipped in v1.11.5 |

### Proposed delta (Tier 2 — skill prompt edit)

Add to `~/.claude/skills/dev-framework-rl/SKILL.md` under "Reproduce-check every A-item":

> **Pre-plan codebase audit step.** Before drafting any plan: (1) grep the codebase for the specific symbols/files the brief names, (2) grep `docs/evals/` for results docs post-dating the last canonical-doc version mention, (3) grep `git log --since=14d` for commits touching the affected files. Items that no longer reproduce in current master get marked DONE in TODOS.md and the episode aborts at discover with a friction note.

**Cost:** one extra grep step at the start of each episode (~30s of tool calls).
**Benefit:** no more wasted episode setup on already-shipped work.

To apply (I have NOT auto-applied per Hand-Maintained-Files + never-auto-apply rules):
```bash
python ~/.claude/dev-framework/scripts/devrl.py learn-apply \
  --failure-mode <id> \
  --summary "Add pre-plan codebase audit step to dev-framework-rl skill" \
  --skill-changed ~/.claude/skills/dev-framework-rl/SKILL.md
```

The two pending_apply files at `~/.claude/dev-framework/pending_apply/01KSB6S9116WGMXW44YFKB1HTR.json` and `01KSBBPKNW9Z1KG4H421WVMZEQ.json` (plus the friction note on the aborted Episode 2) all carry this signal.

## Why I stopped at v1.12.4

The remaining queue items either need a design decision from you or have diminishing-returns scope for autonomous overnight work:

### Items needing your input
- **`api.recall` last-retrieval-ids parity** (C follow-up). Choice: teach `api.recall` to call `markRetrieved` (lifts SDK + HTTP recall to parity with CLI) vs document the divergence permanently. I'd ship (a) if asked, but the SDK-behaviour-change deserves explicit sign-off.
- **`audit_log` per-phase emission on sleep** (A follow-up). Choice: per-phase rows tagged with `ctx.actor` vs keep current per-invocation row (v1.11.5 ship). Both have merit.
- **`/v1/sleep` response shape cross-tenant leak** (v1.11.4 follow-up). Today: admin-gated since v1.12.0. Full fix needs design (redact or scope counters).
- **`Consolidate` audit row tenant tag** (MED, TODO at api.ts:2050). Synthetic 'host' tenant vs scope api.sleep per-tenant. Blocked until non-loopback serving lands.

### Items where one more ship would be diminishing-returns
- Larger items (Python SDK v0.2 ~5d, v0.26 UI redesign port ~15-20d, audit_log retention/rotation, B-track depth research) all exceed an autonomous overnight session's scope.

## Suggested morning sequence

1. **Verify the 4 releases** (`npm view hippo-memory versions` or `npm install -g hippo-memory@1.12.4 && hippo --version`).
2. **Sip coffee, look at the 4 PRs** (#41-#44) — they're squash-merged but the discussion + critic-trail on #41 is the most interesting (caught a real WRITE-path bug).
3. **Apply the pre-plan-codebase-audit learn proposal** (or reject if you want a different framing).
4. **Decide on `api.recall` parity vs documentation** — pick one and I can ship it autonomously next session.
5. The remaining queue is bigger items; consider whether to scope a multi-day plan vs another bundle of small patches.

## Hard stops honored

- ✅ Deploy gates HITL — only crossed after your explicit "merge + publish + continue"
- ✅ No autonomous `learn-apply` (skill prompt edits + CLAUDE.md edits require human approval)
- ✅ No `--no-verify` on commits
- ✅ No force pushes to `master`
- ✅ Git identity: `Kit <skfsk27@gmail.com>` (single-f, kitfunso GitHub account)
- ✅ All commits Co-Authored-By footer
- ✅ Conflicts on rebase resolved manually (CHANGELOG + version files); no auto-merge of unclear cases
