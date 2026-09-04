# Continuity tables self-heal at every open

Episode `01M1Q7CGXJ0HYVF60QV6KA346E`, backlog A3 item 2. Base `origin/master 90e4344` (v1.38.0).

## Problem

`hippo context` throws when a store stamped `schema_version = 41` has no `session_handoffs` table. The UserPromptSubmit hook runs `hippo context --pinned-only` on every prompt, so the crash kills memory injection for the whole session. It happened on the live home store on 2026-08-15 and was fixed by hand with direct DDL.

## Root cause

`runMigrations` (`src/db.ts:2391-2426`) skips every migration whose version is at or below the stamp. A continuity table lost after its migration ran (restore from an older backup, operator DROP, or an unknown edge case) is therefore never re-created. The readers (`loadLatestHandoff` at `src/store.ts:3322`, `listSessionEvents` at `:2726`, `loadActiveTaskSnapshot` at `:2521`) issue raw SELECTs and surface the SQLite "no such table" error. Twelve call sites across `api.ts`, `cli.ts`, `mcp/server.ts`, `consolidate.ts` and `capture.ts` share the hole; all of them open the DB through `openHippoDb`, so the runner is the one shared seam.

Precedent: migration v27 (`src/db.ts:899-935`) re-asserts `api_keys` and `audit_log` with `CREATE TABLE IF NOT EXISTS` for the same class of loss. It heals once (stores below 27). A v42 clone of it would leave a store already at 42 unhealed the next time a table goes missing. The runner already runs `ensureMetaDefaults` and `ensureOptionalFts` unconditionally after the version loop; the fix joins them.

## Non-goals

- No new schema version. `CURRENT_SCHEMA_VERSION` stays 41; the ensure is idempotent and versionless, like `ensureMetaTable`.
- No guards inside the three readers. The heal makes the tables exist before any reader runs.
- No version bump or release-notes header of its own. PR #158 (same batch) already carries 1.38.1 across the five manifests. This PR adds its CHANGELOG bullet under the same `## 1.38.1` heading and is rebased onto master after #158 merges at the batch gate.
- No heal for `working_memory`, `memory_conflicts`, `consolidation_runs` or the physics tables. The `getContext` hot path (`src/api.ts:2370-2500`) reads only `memories` and the three continuity tables, so those are the ones whose loss kills the per-prompt hook; the rest stay with the v27-style one-shot pattern if they ever surface.
- No archaeology of how the live store lost the table. Same call v27 recorded; the test suite pins the symptom, not the cause.

## Change

### 1. `src/db.ts`: `ensureContinuityTables(db)`

A module-private function next to `ensureMetaDefaults`, called from `runMigrations` right before the migration loop (codex review round 1: after the loop, a store below v22 missing `task_snapshots` still died inside v4, v16 or v22, which ALTER or read it). Body: `CREATE TABLE IF NOT EXISTS` for `task_snapshots`, `session_events`, `session_handoffs` at their current full shape, then `CREATE INDEX IF NOT EXISTS` for every index the migrations create on them.

Column order must match what a fresh store gets from the migration chain, because the parity test compares `PRAGMA table_info` rows exactly:

- `task_snapshots`: id, task, summary, next_step, status, source, created_at, updated_at, session_id (v4), tenant_id NOT NULL DEFAULT 'default' (v16, `db.ts:394`), scope (v23).
- `session_events`: id, session_id, task, event_type, content, source, metadata_json, created_at, tenant_id NOT NULL DEFAULT 'default' (v22), scope (v22).
- `session_handoffs`: id, session_id, repo_root, task_id, summary, next_action, artifacts_json NOT NULL DEFAULT '[]', created_at, tenant_id NOT NULL DEFAULT 'default' (v22), scope (v22).

Do not copy the v23 `CREATE TABLE IF NOT EXISTS task_snapshots` body (`db.ts:719-729`) as the template: it puts `session_id` and `tenant_id` before `created_at` and `updated_at`, which is not the order the ALTER chain produces on a fresh store, so case 3 would fail. Build each body from the column lists above.

Indexes: `idx_task_snapshots_status_updated` (v2), `idx_task_snapshots_tenant_status` (v16, `db.ts:404`), `idx_task_snapshots_tenant_scope` (v23), `idx_session_events_session_created`, `idx_session_events_task_created` (v4), `idx_session_events_tenant_session` (v22), `idx_session_handoffs_session` (v5), `idx_session_handoffs_tenant_session` (v22). Copy each definition verbatim from its migration.

Comment budget: one two-line header on the function saying why it runs every open (a lost table after the stamp is never re-migrated; the 2026-08-15 home-store incident) and pointing at the parity test as the drift guard.

Order matters: the ensure runs before the loop. Every ALTER in the chain is guarded by `tableHasColumn` and every CREATE is `IF NOT EXISTS`, so a table the ensure created at full shape makes the later migrations no-ops; a table that already exists is untouched and migrates as before.

### 2. `tests/db-continuity-tables-self-heal.test.ts` (new, real DB, mirrors `tests/db-migration-v27-self-heal.test.ts`)

Fixture: `mkdtempSync` project dir, `initStore(<dir>/.hippo)`, `afterEach` rm. Helpers: `tableNames`, `columns(db, table)` returning `PRAGMA table_info` rows mapped to `{name, type, notnull, dflt_value, pk}`, `indexNames(db, table)` from `PRAGMA index_list`.

Cases:

1. **Heals a v41 store missing `session_handoffs`.** Open, `DROP TABLE session_handoffs`, assert `schema_version` is still '41', close. Reopen: table present, `schema_version` still '41' (no migration ran).
2. **Heals all three continuity tables in one open.** Drop all three, reopen, all three present.
3. **Column parity with a fresh store.** For each of the three tables: `columns()` from a fresh store equals `columns()` from a store where that table was dropped and re-created by the heal. Exact array equality, so any future ALTER on these tables that is not mirrored in the ensure body fails here.
4. **Index parity with a fresh store.** Sorted `indexNames()` equal for each table, same construction.
5. **No-op on a healthy store.** Row counts and `schema_version` unchanged across an extra open/close on a store with one snapshot, one event and one handoff written through the store API.
6. **`hippo context` runs on the incident shape (compiled CLI, real store).** `initStore`, `saveActiveTaskSnapshot` with `session_id 'sess-heal'` (read the signature at `src/store.ts:2456` first), then drop `session_handoffs` and `session_events`. Run `node dist/cli.js context --pinned-only --budget 1500` and `node dist/cli.js context --auto --budget 1500` via `execFileSync` with `cwd = <project dir>` and `HIPPO_SESSION_ID=sess-heal` in env. Both exit 0. Mirror the process setup of `tests/context-continuity.test.ts` (it drives the `context` command through `bin/hippo.js`, which imports `dist/cli.js`; `tests/cli-tenant-scoping.test.ts` calls `dist/cli.js` directly, either is fine). `autoDetectContext` (`src/cli.ts:6162`) wraps its git call in try/catch, so a non-git tmp dir is safe for `--auto`.

Red-before check (execute stage, recorded in the manifest): with the `ensureContinuityTables(db)` call commented out, cases 1, 2, 3, 4 and 6 fail and case 5 still passes. Restore and all six pass. Case 7 (store rolled back to 19, `task_snapshots` dropped) fails with the call after the loop and passes with it before.

### 3. `CHANGELOG.md`

Under a `## 1.38.1 - 2026-09-04` heading (identical text to PR #158's heading so the rebase conflict is a one-hunk merge), a `### Fixed` bullet: **`hippo context` no longer crashes on a store missing a continuity table.** Two or three sentences: the incident shape, why the version stamp could not heal it, what now runs at every open, and that it is a no-op for healthy stores. No em dashes.

## Risks

- **Ensure body drifts from a future migration.** Closed by cases 3 and 4: parity is exact, so the drift fails CI on the migration PR.
- **Cost per open.** Three `CREATE TABLE IF NOT EXISTS` plus eight `CREATE INDEX IF NOT EXISTS` on an existing schema are sqlite_master lookups. `ensureOptionalFts` already pays the same class of cost every open.
- **Column order on old stores.** Not touched: the ensure never alters an existing table, it only creates absent ones.
- **`--auto` in a non-git tmp dir.** Handled in case 6 by checking first and `git init`ing if needed.

## Verification

- `npm run build` green; targeted `npx vitest run tests/db-continuity-tables-self-heal.test.ts tests/db-migration-v27-self-heal.test.ts tests/v22-continuity-tenant-migration.test.ts tests/continuity-tables-tenant-isolation.test.ts tests/pr2-session-continuity.test.ts` green.
- Red-before check as above.
- `npm run lint` clean on changed files; em-dash grep on the diff empty.
- Full `npx vitest run` at verify; per-test `STACK_TRACE_ERROR` timeouts under load are the known harness artifact, confirm by re-running the timed-out files in isolation.

## Ship

PR against master, titled `fix: heal missing continuity tables at every store open`. Body declares: cherry-pick of `e67712e` (ui lockfile) so CI's audit step passes until #159 merges; no version bump because #158 carries 1.38.1; rebase after #158 at the batch gate. Ship stage stops before deploy; publish rides the batch deploy gate.
