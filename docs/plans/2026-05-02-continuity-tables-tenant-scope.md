# Continuity Tables: tenant_id Backfill Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the v0.40 deferred tenant-isolation gap on `session_events` and `session_handoffs`. Add `tenant_id` to both, backfill existing rows, gate all read/write helpers on `tenantId`. Unblocks the parked `2026-05-02-continuity-first-recall.md` slice.

**Why now:** Codex review of the continuity-first plan flagged that `session_events` and `session_handoffs` schemas have no `tenant_id` (only `task_snapshots` got it in v16). Any product surface that returns continuity across tenants leaks. CHANGELOG.md v0.39.0 already named this "deferred to v0.40: tenant-guard audit on remaining MCP tools + any unscoped readEntry/loadSearchEntries call sites".

**Architecture:** Schema migration v22. Both tables get `tenant_id TEXT NOT NULL DEFAULT 'default'`. Composite indexes leading with `tenant_id`. Store helpers gain a required `tenantId` parameter (no optional, no `undefined = all tenants` escape hatch — that's the leak vector). All call sites updated to pass `ctx.tenantId` or `resolveTenantId({})`.

**Tech Stack:** TypeScript, node:sqlite, vitest. No new dependencies.

**Effort budget:** 1 session, ~5 tasks, 4 commits.

**Out of scope (explicitly):**
- `scope` column on these tables. Lower priority than tenant; defer to a follow-up unless a private-channel handoff path is wired before then.
- The actual continuity-first product slice. Re-opens once this lands.
- Other v0.40 deferred items (rate limit, p99, soak harness, B3 adapter contract).

---

## Pre-flight

Read before Task 1:

- `src/db.ts:118-135` (session_events schema), `src/db.ts:142-160` (session_handoffs schema)
- `src/db.ts:368-391` (v16 tenant migration — pattern to mirror for v22)
- `src/store.ts:1373` (loadActiveTaskSnapshot), `src/store.ts:1476` (listSessionEvents), `src/store.ts:1780` (loadLatestHandoff), plus the `save*`/`append*` writers
- `src/handoff.ts` (SessionHandoff type — does it carry tenant?)
- All call sites of these six helpers via `grep -n -E "loadActiveTaskSnapshot|loadLatestHandoff|listSessionEvents|saveActiveTaskSnapshot|saveSessionHandoff|appendSessionEvent"`

---

## Task 1: Schema migration v22

**Files:**
- Modify: `src/db.ts:25` (CURRENT_SCHEMA_VERSION 21 → 22), append migration block after v21
- Test: `tests/migration-v22-tenant.test.ts` (new)

**Step 1: Failing test**

Build a v21 store (write rows manually with no tenant_id), run migrations, assert `tenant_id` column exists with value 'default' on existing rows, assert composite indexes are created.

**Step 2: Implement**

```typescript
{
  version: 22,
  up: (db) => {
    if (!tableHasColumn(db, 'session_events', 'tenant_id')) {
      db.exec(`ALTER TABLE session_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    if (!tableHasColumn(db, 'session_handoffs', 'tenant_id')) {
      db.exec(`ALTER TABLE session_handoffs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC)`);
  },
},
```

Also update the *initial create* schema bodies (v4 / v5) ONLY if they're idempotently re-run; if they only fire on fresh DBs, leave them. Verify by reading the migration runner.

**Step 3: Pass + commit**

```bash
git commit -m "feat(schema): v22 adds tenant_id to session_events and session_handoffs"
```

---

## Task 2: Tenant-aware store helpers (writers)

**Files:**
- Modify: `src/store.ts` — `saveActiveTaskSnapshot`, `saveSessionHandoff`, `appendSessionEvent`
- Test: `tests/store-tenant-isolation.test.ts` (new)

Make `tenantId` a REQUIRED parameter on all three writers (additive — readers in Task 3 too). Existing call sites that don't pass it get a typecheck error, surfacing every place that needs updating.

Then update INSERT statements to write the column.

Test: write rows under tenant A, write under B, assert both rows exist with correct `tenant_id`.

---

## Task 3: Tenant-aware store helpers (readers)

**Files:**
- Modify: `src/store.ts` — `loadActiveTaskSnapshot`, `loadLatestHandoff`, `listSessionEvents`
- Test: extend `tests/store-tenant-isolation.test.ts`

Required `tenantId` parameter. SELECTs gain `WHERE tenant_id = ?`.

**Critical adversarial test:** seed a snapshot/handoff/event under tenant A, then call each reader with tenant B — must return `null` / `[]`. Repeat with tenant A — must return the row.

---

## Task 4: Update all call sites

**Files:** every file flagged by `grep -n -E "loadActiveTaskSnapshot|loadLatestHandoff|listSessionEvents|saveActiveTaskSnapshot|saveSessionHandoff|appendSessionEvent"` outside test files.

Known sites (from earlier grep):
- `src/cli.ts` (multiple — `cmdSnapshot`, `cmdSession`, `cmdHandoff`, `cmdContext`)
- `src/consolidate.ts:166`
- `src/index.ts` (re-exports)

Each call site must resolve `tenantId`:
- CLI commands: `resolveTenantId({})` (matches existing CLI tenant pattern)
- API/server callers: pass `ctx.tenantId`
- Consolidation: pass tenant from the consolidation context (verify it has one; if not, use `resolveTenantId({})`)

Run typecheck repeatedly until clean.

---

## Task 5: Adversarial regression sweep

**Files:**
- Modify: existing `tests/pr2-session-continuity.test.ts` and `tests/context-continuity.test.ts` if they implicitly relied on no-tenant behavior
- Add: `tests/cross-tenant-continuity-leak.test.ts`

Cases to assert:
1. Tenant A writes snapshot → tenant B's `loadActiveTaskSnapshot` returns null.
2. Tenant A writes handoff with sessionId='shared' → tenant B's `loadLatestHandoff('shared')` returns null even though session_id matches.
3. Tenant A appends 5 events under sessionId='shared' → tenant B's `listSessionEvents({session_id: 'shared'})` returns [].
4. Same session_id used by both tenants — each gets their own rows back, no cross-pollution.
5. CLI: `HIPPO_TENANT=A hippo session log ...` then `HIPPO_TENANT=B hippo session show ...` — B sees nothing.

Full vitest run must pass.

---

## Definition of Done

1. `npm run build` clean.
2. `npx vitest run` passes (1020+ tests, no regressions).
3. Five adversarial cross-tenant tests pass.
4. `grep -nE "(loadActiveTaskSnapshot|loadLatestHandoff|listSessionEvents)\(" src/` returns zero call sites missing `tenantId`.
5. CHANGELOG.md gets a `## 0.41.0` entry under "### Security" naming the gap closure (will batch with v0.40.1 Slack fix).
6. The parked continuity-first plan can be unparked.

## GSTACK REVIEW REPORT

Codex review 2026-05-02 round 3 (post-implementation):

| # | Severity | Status | Note |
|---|---|---|---|
| 1 | P0 | FIXED | scope write-only on session_handoffs — code removed; column kept for future read-side enforcement |
| 2 | P0 | FIXED | scope write-only on session_events — same fix |
| 3 | P1 | FIXED | tableExists silent skip — replaced with self-healing CREATE TABLE IF NOT EXISTS |
| 4 | P1 | DEFERRED | Backfill ambiguity (legacy 'default' vs real 'default'). Documented; conservative behavior is safe; refinement requires inferring legacy via row age + audit_log timestamps. |
| 5 | P1 | DEFERRED | Public API break for JS callers. v0.41.0 should be bumped as MAJOR or include a JS-side runtime arg-shape guard. |
| 6 | P1 | DEFERRED | Markdown mirror files (`buffer/active-task.md`, `buffer/recent-session.md`) are at fixed paths — multi-tenant deployments will overwrite cross-tenant. Tracked separately. |
| 7 | P2 | KNOWN | Slack bot/system messages without `user` create raw rows with no owner. Documented in transform.ts. Connector workaround: emit `owner: 'agent:slack-bot:<bot_id>'` when bot_id is present. |

## Remaining work for true continuity-first unblock

- Read-side scope filter on session_events / session_handoffs (re-add the `scope` writer code AT THE SAME TIME).
- Tenant-aware mirror paths.
- Major-version bump or JS-side runtime guard against arg misbinding.
- Per-tenant consolidate loop.
