# Changelog

## 1.3.0 (2026-05-04)

GitHub connector. Streams issues, issue comments, pull requests, and PR review comments into hippo as `kind='raw'` rows with full provenance, idempotency, scope tagging, and a dead-letter queue. Built on the v1.2.1 generic `*:private:*` default-deny filter so private GitHub rows cannot leak to no-scope callers.

### Added

- **`POST /v1/connectors/github/events`** webhook route. HMAC verification via `X-Hub-Signature-256`. Idempotency keyed on `sha256(eventName + ':' + rawBody)` — replay-safe even if an attacker mints fresh `X-GitHub-Delivery` UUIDs (codex P0 #3).
- **`hippo github backfill --repo <owner/name>`** CLI. Three independent REST streams (issues, issue comments, PR review comments) with per-stream high-water marks. HWM advances only after a stream fully drains so a crash mid-backfill is safe to restart (codex P1 #3). PRs returned via the `/issues` endpoint are skipped (codex P1 #2).
- **`hippo github dlq list` / `dlq replay <id> [--force]`** CLI. Full replay metadata in `github_dlq` (event_name, delivery_id, signature, installation_id, repo_full_name, retry_count) so replay reproduces the exact dispatch.
- **Tenant routing.** `github_installations` (App-mode) + `github_repositories` (PAT-mode multi-tenant). Fail-closed: a PAT-mode webhook in a multi-tenant install with no repo mapping returns null and DLQs as `unroutable` (codex P0 #4).
- **Comment deletion sync.** `issue_comment.deleted` and `pull_request_review_comment.deleted` archive matching rows via `archiveRaw`. Filtered by `tenant_id + kind='raw'`, archives ALL active matching rows (GitHub edit history can produce multiple rows with the same artifact_ref) — codex P0 #5.
- **Scope mapping.** `github:public:owner/repo` for public repos; `github:private:owner/repo` for private. `repository.private === undefined` falls through to private (fail-safe). Backfilled rows default to private since the REST list endpoints don't reliably surface `private`.

### Schema

- **Migration v24.** Six tables: `github_event_log`, `github_cursors`, `github_dlq`, `github_installations`, `github_repositories`, plus a `meta.min_compatible_binary='1.2.1'` row that older binaries (<1.2.1, no generic-private filter) hit and refuse to open the DB. Rollback safety (codex P0 #2).

### Tests

- 1214 tests passing across the suite (up from 1087 at v1.2.1). 117+ new tests across github-schema, github-types, github-scope, github-transform, github-signature, github-idempotency, github-tenant-routing, github-ratelimit, github-octokit-client, github-ingest, github-deletion, github-backfill, github-dlq, github-webhook-route, github-cli, github-smoke-200, github-provenance-parity.
- 200-event smoke test with explicit security-boundary assertions: idempotency, replay defense, no-scope private denial, cross-source generic-private denial (synthetic `acme:private:demo`), tenant routing failure (codex P2 #2 strengthening).
- Real two-worker race test that exercises the SAVEPOINT collision path (not just the fast-path) — codex P1 #6.

### Plan + audit trail

- `docs/plans/2026-05-04-github-connector.md` — full plan with codex round 1 review report (5 P0, 8 P1, 2 P2 — all consolidated and patched into the plan before any code was written).

## 1.2.1 (2026-05-04)

Pre-flight for v1.3.0 GitHub connector. Codex audit caught that the v1.2 default-deny scope filter only blocked `slack:private:*`, not source-agnostic `*:private:*`. Once a second connector landed (GitHub, Jira, Linear, etc.), no-scope recall would silently leak private rows. v1.2.1 generalizes the rule before any v1.3 work begins, so rolling back is safe.

### Security (CRITICAL)
- **Generic `*:private:*` default-deny.** The recall, continuity, MCP `hippo_recall`, MCP `hippo_context`, and CLI `cmdRecall` filters now reject ANY scope matching `^[a-z][a-z0-9_-]*:private:` for no-scope callers, not just `slack:private:`. Public scopes, null scope, and exact-match scope queries are unchanged. Single source of truth: new `isPrivateScope` export from `src/api.ts`.
- Closes the latent gap that would have exposed `github:private:owner/repo` rows to default-deny callers in v1.3.

### Added
- `tests/scope-filter-generic-private.test.ts`: 13 regression tests covering api.recall (memory + continuity), MCP hippo_recall, MCP hippo_context, with synthetic `acme:private:demo`, `github:private:*`, and `jira:private:*` scopes plus negative tests (substring "private" in middle of public scope, public scopes pass-through).

### Internal
- Comment + MCP tool description updates from "slack:private:* and unknown-legacy" to "ANY *:private:* and unknown-legacy" wherever the filter rule is documented.

## 1.2.0 (2026-05-03)

Closes the v1.0.0 + v1.1.0 known limitations on continuity scope. Continuity is now exposed through MCP and HTTP, and the existing `hippo_context` MCP tool retroactively gets the same scope filter that protects memory recall. The v1.0.0 "Known limitation: scope=NULL on continuity tables" is CLOSED.

### Security (CRITICAL)
- **Cross-scope leak fix on continuity recall.** v1.1.0's filter was `opts.scope || isPublic`, which let any explicit scope see ALL continuity rows regardless of the row's scope. Latent in v1.1 (no scope writers shipped), now fixed to exact-match. Same fix in `api.recall` and `cmdRecall`.
- **`hippo_context` retroactive scope filter.** This MCP tool predates v1.1 and exposed all memories plus the active snapshot to no-scope MCP callers. Now applies the same default-deny rule as `hippo_recall`. Filters BOTH memory results AND the snapshot. New `scope` arg added to the MCP input schema.
- **`loadLatestHandoff` was missing scope on the loaded row.** Caught by codex round 2: SELECTs on `session_handoffs` did not include the new column, so a private handoff would silently surface to no-scope callers because `rowToSessionHandoff` normalized scope to null. All SELECTs now include scope.

### Added
- **MCP `hippo_recall`** accepts `include_continuity: true` and `scope: string`. When continuity is requested, appends a "## Continuity" text section to the existing return string. No structured-shape change to the MCP contract.
- **HTTP `GET /v1/memories?include_continuity=1&scope=...`** propagates both flags to `api.recall`. Sets `Cache-Control: no-store` on responses with continuity.
- **`client.recall`** now sends `include_continuity` and `scope` query params (the v1.1.0 throw guard is gone).

### Schema
- Migration v23: `task_snapshots.scope` added (nullable). Composite index on `(tenant_id, scope, status)`.
- Quarantine policy: pre-existing rows with NULL `scope` on all three continuity tables (`task_snapshots`, `session_events`, `session_handoffs`) are marked `'unknown:legacy'` so the default-deny filter excludes them for no-scope callers. Idempotent via `WHERE scope IS NULL`. Self-heals partial-init stores via `tableExists` guards.

### Writer signatures
- `saveActiveTaskSnapshot`, `appendSessionEvent`, `saveSessionHandoff` accept optional `scope: string | null`.
- `TaskSnapshot`, `SessionEvent`, `SessionHandoff` types carry `scope`.

### Closed from v1.0.0 / v1.1.0
- v1.0.0 "Known limitation: scope=NULL on continuity tables" — CLOSED.
- v1.1.0 "Deferred to v1.2.0: MCP `hippo_recall` continuity + HTTP `GET /v1/memories?include_continuity=true`" — CLOSED.
- v1.1.0 "`client.recall` throws when `includeContinuity` is set" — CLOSED.

### Out of scope (deferred)
- Slack continuity producer. Continuity rows currently only originate from CLI session commands and hooks. Slack-derived continuity (which would set `slack:public:<ch>` / `slack:private:<ch>` automatically) is its own slice.
- Per-scope active snapshots. Active snapshot remains tenant-global; scope is metadata for filtering reads, not a partition key for the active predicate.
- Channel privacy reclassification. Source-time scope is immutable in v1.2. Periodic re-tagging is a v1.3+ concern.

## 1.1.0 (2026-05-03)

Continuity-first recall: one call returns both relevant memories AND where the agent left off. Opt-in via `includeContinuity` (api) or `--continuity` (CLI). Default-off keeps the hot path unchanged.

### Added
- **`api.recall` continuity block.** New `includeContinuity?: boolean` on `RecallOpts`. When true, `RecallResult` includes a `continuity` field (`activeSnapshot`, `sessionHandoff`, `recentSessionEvents`) plus `continuityTokens` for budget visibility. All three reads are tenant-scoped via the v1.0.0 helpers; no risk of cross-tenant leak. Importable: `ContinuityBlock` from `src/api.ts`.
- **`hippo recall <query> --continuity` CLI flag.** Surfaces the snapshot, handoff, and last 5 session events above the memory list. Reuses `printActiveTaskSnapshot` / `printHandoff` / `printSessionEvents` formatters from `cmdContext` for on-screen parity. Zero-result queries with `--continuity` print the resume packet instead of the bare "No memories found" message.

### Design notes
- **No stale-handoff resurrection.** When there is no active snapshot, `sessionHandoff` is null and `recentSessionEvents` is empty. The explicit handoff-without-snapshot path remains `hippo session resume` (src/cli.ts:3022). This avoids surprise resurrection of post-session state in the implicit recall flow.
- **`continuityTokens` reports the FULL payload** (snapshot + handoff + every event's full content). Callers needing a tight resume packet should truncate event content themselves before display. Same `Math.ceil(len/4)` rule used by the existing `tokens` count.
- **Hot path unchanged.** When `includeContinuity` is omitted (or `--continuity` not set on the CLI), no continuity helpers run. The audit log entry for `recall` is identical.

### Performance
- Continuity-on adds ~17ms p99 over the BM25 path on a 2k-store warm-DB benchmark (in-process, no HTTP). Cost is dominated by three additional `openHippoDb`/`closeHippoDb` cycles plus the markdown mirror write inside `loadActiveTaskSnapshot`. This is an opt-in boot-time cost, not per-message hot-path overhead. Optimization (shared connection, readOnly snapshot path) tracked for v1.2.0+.

### Known limitations
- **Continuity tables ship with `scope=NULL`** (carried over from v1.0.0). v1.1.0 adds a forward-compatible default-deny filter in `api.recall` and `cmdRecall`: a no-`scope` caller will not see continuity rows whose `scope` starts with `slack:private:`. This is currently a no-op because no writer sets `scope` on snapshots / handoffs / events. v1.2.0 wires the writers and closes the loop. Until then, callers in multi-tenant deployments with private-channel ingestion should pass an explicit `scope` when calling `recall(..., { includeContinuity: true })` to make the intended scope explicit.
- **`client.recall` throws** when `includeContinuity` is set. HTTP transport for the continuity block lands in v1.2.0; failing loudly is preferable to silently dropping the flag.

### Deferred to v1.2.0
- **MCP `hippo_recall` continuity** and **HTTP `GET /v1/memories?include_continuity=true`** are deferred and will land together with the `scope` read-side filter on continuity tables. Reason: continuity tables ship with `scope=NULL` (v1.0.0 known limitation). Exposing continuity on LLM-facing or remote surfaces before scope filtering widens the unfiltered private-channel surface beyond what v1.0.0 guarantees. The existing `hippo_context` MCP tool (which already exposes the active snapshot) is unchanged in this slice and is included in the v1.2.0 scope-filter audit.

## 1.0.0 (2026-05-03)

Tenant-isolation security release. Closes a cross-tenant data leak on the
continuity tables (snapshots, session events, session handoffs) that the
v0.40.0 measurement gates uncovered. Bumped to 1.0.0 because 7 store
helpers gained a required `tenantId` parameter.

### Security (CRITICAL)
- **task_snapshots cross-tenant leak.** `saveActiveTaskSnapshot`'s supersede UPDATE was tenant-blind: tenant B saving an active snapshot would mark tenant A's row as 'superseded'. Same gap on `loadActiveTaskSnapshot` and `clearActiveTaskSnapshot`. All three now scope reads and writes by `tenantId`.
- **session_events / session_handoffs missing tenant_id.** Both tables predated the v16 tenant migration. Surfacing them through any continuity API would mix tenants. Schema v22 adds `tenant_id` (NOT NULL DEFAULT 'default') with smart backfill via `task_snapshots.session_id` joins. `appendSessionEvent`, `listSessionEvents`, `saveSessionHandoff`, `loadLatestHandoff`, `loadHandoffById`, `findPromotableSessions`, and `traceExistsForSession` are now tenant-scoped.
- **Mirror file leak.** `buffer/active-task.md` and `buffer/recent-session.md` were at fixed paths regardless of tenant. Multi-tenant deployments would have tenant B overwrite tenant A's mirror. Non-default tenants now get `buffer/active-task.<tenantId>.md`; default tenant keeps the unsuffixed path for on-disk back-compat.
- **Slack ingestion missing owner envelope.** `messageToRememberOpts` set `artifact_ref` but not `owner`, so every Slack-ingested raw row failed the v0.40.0 `hippo provenance --strict` gate. Now emits `owner: 'user:<slack_user_id>'` when present. Bot/system messages without `user` keep `owner=null` (correct signal: unattributable, investigate).

### Breaking
- **10 store helpers now take `tenantId` as their second positional argument.** TypeScript callers get a compile error. JS callers from older code would silently misbind a `sessionId` where `tenantId` is now expected. New `assertTenantId` runtime guard rejects the most common misbinding shape (any value matching `/^sess[-_]/i`) with a clear migration message. Affected helpers: `saveActiveTaskSnapshot`, `loadActiveTaskSnapshot`, `clearActiveTaskSnapshot`, `appendSessionEvent`, `listSessionEvents`, `saveSessionHandoff`, `loadLatestHandoff`, `loadHandoffById`, `findPromotableSessions`, `traceExistsForSession`.

### Schema
- Migration v22: `ALTER TABLE session_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'` plus a nullable `scope` column for future read-side default-deny work. Same on `session_handoffs`. Composite indexes on `(tenant_id, session_id, created_at)`. Self-heals partial-init stores via `CREATE TABLE IF NOT EXISTS` before the ALTERs. Migration runs inside the existing `BEGIN`/`ROLLBACK` transaction.
- Smart backfill: rows whose session_id maps to exactly one tenant in `task_snapshots` inherit that tenant; ambiguous or unmapped rows stay at `'default'`. Conservative: never crosses tenant boundaries on guesses.

### Known limitations
- **`scope` column on continuity tables is currently NULL on all writes.** The column was added in v22 to support a future read-side default-deny rule (mirroring the existing private-Slack filter on memories), but the read path is not wired yet. Wiring both sides at once will land in a follow-up release. No regression vs v0.40.0; private-channel handoffs were not filtered there either.
- **Backfill ambiguity.** A pre-v22 store with both real `default`-tenant data and unrelated legacy `default` rows could see legacy rows reassigned to a `default`-tenant `task_snapshots.session_id` if they share session ids. Low real-world impact; flagged for the multi-tenant rollout playbook.
- **Slack bot/system messages without `user`** still produce `kind='raw'` rows with no `owner`, which fail `hippo provenance --strict`. Connectors that need bot attribution should emit `owner: 'agent:slack-bot:<bot_id>'` themselves until the connector grows that path natively.
- **Transitive CVEs in `@xenova/transformers` (4 critical via `protobufjs`).** No clean upgrade in the v2 line; `@huggingface/transformers` v4.2.0 is the official successor and the upgrade is tracked for a follow-up release. The vulnerable code path is ONNX model file parsing, not network input — a real attack requires shipping a malicious model file to the user's machine.

### Deferred from v0.40
- Tenant-guard audit on remaining MCP tools (context, status, learn, conflicts, resolve, peers).
- Request-level rate limit on `/v1/auth/keys` and `/v1/*` (mitigated by localhost-default binding).
- p99 hardening, 24h soak harness as a real release gate, B3 dlPFC sequential-learning adapter contract.

## 0.40.0 (2026-05-02)

### Added
- **Company Brain provenance gate.** `hippo provenance [--json] [--strict]` audits every `kind='raw'` row for `owner` + `artifact_ref`. Reports coverage and per-row gaps; `--strict` exits non-zero so CI can block ingestion regressions. Importable: `buildProvenanceCoverage(entries)` from `src/provenance-coverage.ts`.
- **Correction-latency observability.** `hippo correction-latency [--json]` walks `superseded_by` chains, splits pairs into extraction-driven vs manual cohorts, and reports p50 / p95 / max wall-clock lag from receipt to supersession over the extraction cohort only (manual zeros excluded so they never mask real lag). Importable: `buildCorrectionLatency(entries)` from `src/correction-latency.ts`.
- **NaN / cycle / dangling-pointer resilience.** Latency calculator skips pairs with malformed timestamps and tolerates supersession chains that point at unknown targets.

### Docs
- `docs/plans/2026-04-28-company-brain-measurement.md` scorecard updated: provenance and correction-latency rows moved from "blocked" to "measurable now". All 8 rows now have a runnable evidence path.

## 0.39.0 (2026-04-30)

### Security (CRITICAL)
- **Cross-tenant authorization:** `promote()` now verifies memory belongs to ctx.tenantId before promoteToGlobal. `authCreate` ignores body.tenantId and forces ctx.tenantId at HTTP layer.
- **Supersede CAS race:** `supersede()` wraps the transition in BEGIN IMMEDIATE with `WHERE superseded_by IS NULL`; concurrent attempts now throw CONFLICT instead of producing double chains.
- **MCP cross-tenant outcome poisoning:** `lastRecalledIds` now keyed by per-client `clientKey` (HTTP: hash(bearer + remote IP), stdio: 'stdio-${pid}'). Outcome from client B cannot touch client A's recall set.
- **Slack unknown-team fallback:** when `slack_workspaces` is non-empty and the incoming `team_id` is unmapped, the event is sent to DLQ as `unroutable` instead of silently ingesting into the env-default tenant. Escape hatch: `SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK=1`.

### Privacy (BREAKING data shape)
- **GDPR Path A on raw_archive:** archived memories no longer retain content in `raw_archive.payload_json`. Stored shape is `{redacted:true, archived_at, tenant_id, kind, reason}`. Migration v20 redacts existing rows in place. Compliance audit trail preserved via `audit_log`.
- **Recall audit hashes the query:** `audit_log` rows for op='recall' now store `query_hash` (sha256, first 16 hex chars) and `query_length` instead of the truncated query text. Prevents canary content from persisting in audit_log when a caller queries with text matching an archived (RTBF) memory.
- **Mirror reaper post-migration:** `openHippoDb()` runs `cleanupArchivedMirrors` after migrations to delete `<hippoRoot>/{episodic,buffer,semantic}/<id>.md` for every `raw_archive` row. Closes the gap where pre-v0.39 archives left their original-content markdown mirrors on disk. Idempotent via the `gdpr_v20_mirror_cleanup` meta flag (one-shot per DB). `archiveRaw` mirror cleanup is wrapped in try/catch; orphan files self-heal on a future scheduled scan if the unlink ever fails.

### Hardening
- MCP HTTP handlers route through `src/api.ts` so audit + cross-tenant guards apply uniformly
- Bearer lockdown test parameterized over the full 12-route table
- Auth timing leak reduced: `DUMMY_HASH` precomputed at module load; miss path runs scrypt
- `/mcp/stream` re-validates bearer on a 60s heartbeat; new `MCP_SSE_MAX_AGE_SEC` (default 3600s) caps stream age
- Graceful shutdown awaits `server.stop()` before `process.exit`
- Slack ingest race closed via `afterWrite` hook (atomic event_log + memory)
- Slack deletion idempotency closed via new `afterArchive` hook in `archiveRawMemory`
- Slack DLQ: schema additions (team_id, bucket, retry_count, signature, slack_timestamp); `hippo slack dlq replay <id>` command
- Slack signing-secret rotation: accept `SLACK_SIGNING_SECRET_PREVIOUS` during rollover

### Schema
- Migration v19: slack_dlq columns (team_id, bucket, retry_count, signature, slack_timestamp)
- Migration v20: raw_archive.payload_json redacted in place (Path A backfill)

### Retracted
- v0.36 <50ms p99 latency target. v0.36 ships at 58.4ms (sequential single-thread). No current target; revisit in v0.40+ if a real user asks.

### Deferred to v0.40
- Tenant-guard audit on remaining MCP tools (context, status, learn, conflicts, resolve, peers) + any unscoped readEntry/loadSearchEntries call sites in CLI/dashboard/refine
- Request-level rate limit on /v1/* to bound key-id enumeration
- p99 hardening
- 24h soak harness as a real release gate (currently scaffold)
- B3 dlPFC follow-ups (sequential-learning adapter contract, etc.)

## 0.38.0 (2026-04-29)

### Added
- **B3 dlPFC persistent goal stack depth.** Schema v18 adds `goal_stack`, `retrieval_policy`, `goal_recall_log` (with FKs and CHECK constraints, tenant+session indexed). New CLI: `hippo goal push|list|complete|suspend|resume`. Active goals are tenant-and-session scoped, capped at depth 3 via `BEGIN IMMEDIATE` (oldest auto-suspends). When `HIPPO_SESSION_ID` is set, `hippo recall` auto-applies a goal-tag boost (final multiplier hard-capped at 3.0x). Retrieval policies (`error-prioritized`, `schema-fit-biased`, `recency-first`, `hybrid`) further shape ranking. Goal completion with `--outcome` propagates strength changes onto memories whose recall fell within the goal's lifespan window: `outcome >= 0.7` boosts (×1.10), `outcome < 0.3` decays (×0.85), neutral band leaves strength alone. UNIQUE(memory_id, goal_id) on the recall log prevents double-propagation.
- **B3 cluster-discrimination benchmark.** New `benchmarks/micro/fixtures/dlpfc_depth.json` exercises three disjoint memory clusters under three named goals using the existing `run.py` harness. Each query asserts the active goal's cluster is in top-3 AND the other two clusters are NOT in top-3 — a deterministic test that BM25 alone cannot pass since all 18 memories share the query terms. Result captured in `benchmarks/micro/results/b3-depth.json` (3/3 queries pass). A statistical Wilcoxon-paired version moves to v0.39 stretch.

### Deferred
- **Sequential-learning trap-rate lift** moved from B3 success criterion to v0.39 stretch goal. Requires upstream contract change to `benchmarks/sequential-learning/adapters/interface.mjs` adding `pushGoal/completeGoal` hooks; current adapter shape (recall(query) / store(content,tags)) cannot exercise the goal-stack mechanism. Tracked in TODOS.md.
- **MCP/REST goal-stack boost.** v0.38 surfaces the boost only via the CLI (env-driven `HIPPO_SESSION_ID`). v0.39 plumbs `session_id` through `Context` for `recall(ctx, opts)` so MCP and `/v1/recall` callers get the same boost.

### Schema
- Migration v18: `goal_stack` (tenant_id, session_id, goal_name, level CHECK 0..2, parent_goal_id self-FK, status CHECK, success_condition, retrieval_policy_id, created_at, completed_at, outcome_score CHECK 0..1), `retrieval_policy` (FK to goal_stack ON DELETE CASCADE), `goal_recall_log` (FKs to goal_stack and memories, UNIQUE(memory_id, goal_id)).

## 0.37.0 (2026-04-29)

### Added
- **E1.3 Slack append-only ingestion.** Webhook to kind='raw' memories with full provenance (slack:// artifact_ref, scope from channel privacy). Idempotency via slack_event_log, cursor-based backfill resume via slack_cursors, malformed payloads to slack_dlq. Source deletion (Slack message_deleted) routes through archiveRawMemory for GDPR compliance.
- **PUBLIC_ROUTES allow-list + HIPPO_REQUIRE_AUTH knob.** Slack webhook (HMAC-signed, no Bearer) is the first explicit public /v1/* route. Bearer-lockdown test asserts every other /v1/* route returns 401 without auth when HIPPO_REQUIRE_AUTH=1.
- **slack_workspaces tenant routing.** Multi-workspace deployments map team_id to tenant_id; single-workspace deployments fall back to HIPPO_TENANT.
- **api.remember afterWrite hook.** Connectors now stamp idempotency rows atomically with the memory row via a SAVEPOINT-scoped callback, closing the Slack-retry race.
- **Recall scope filter + default-deny on private channels.** No-scope queries cannot see scope='slack:private:*' memories; frontend callers passing undefined scope no longer leak private content.
- **hippo slack CLI.** `hippo slack backfill --channel <id>` (requires SLACK_BOT_TOKEN), `hippo slack dlq list` for malformed-event review.

### Fixed
- **archiveRaw leaves no orphaned mirrors.** Centralized GDPR fix: api.archiveRaw now removes legacy markdown mirrors (mirroring forget()), so an archived raw row cannot be revived by bootstrapLegacyStore on the next process start. Surfaced by the Slack source-deletion test.
- **Schema-version test pins.** Bumped a3-envelope-migration / a5-tenant-migration / pr2-session-continuity from 16 to 17 (was tracking "latest version", not "this migration's version").

### Changed
- Schema v17 adds slack_event_log, slack_cursors, slack_dlq, slack_workspaces tables.

## 0.36.0 (2026-04-29)

### Added
- **A1 server mode.** `hippo serve` runs a persistent daemon on http://127.0.0.1:6789 (configurable via --port or HIPPO_PORT). Exposes /v1/memories, /v1/auth/keys, /v1/audit, MCP-over-HTTP at /mcp, and /health.
- **CLI thin-client.** When `hippo serve` is running, CLI invocations auto-detect via .hippo/server.pid and route through HTTP. Stale pidfile self-heals on first ECONNREFUSED.
- **MCP-over-HTTP/SSE transport.** Existing stdio MCP path unchanged. POST /mcp for synchronous JSON-RPC; GET /mcp/stream for SSE keepalive (server-pushed messages deferred to v0.37.0).
- **Domain layer src/api.ts.** Pure functions for remember/recall/forget/promote/supersede/archiveRaw/auth*/audit. Both server and CLI handlers delegate through this surface.
- **HTTP auth middleware.** Bearer token via Authorization header; loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) accepts unauthenticated requests as actor='localhost:cli'. Non-loopback no-token returns 401. Server refuses to bind 0.0.0.0 without auth.
- **24h soak harness skeleton** at benchmarks/a1/soak.ts. Manual run; results not gated.
- **p99 recall benchmark** at benchmarks/a1/p99-recall.ts. 10k-memory store, top-10 BM25 against tier-1 queries.

### Fixed
- Audit-log tenant attribution: `audit()` helper now uses the entry's tenant_id instead of HIPPO_TENANT env (latent bug, exposed during A1 refactor).
- api.archiveRaw and api.forget now enforce tenant scope: cross-tenant access returns "memory not found" rather than affecting another tenant's row.
- SIGTERM drain: server.closeAllConnections() before server.close() so SSE keepalive streams don't block shutdown.
- MCP-over-HTTP threads hippoRoot + tenantId from the auth context (was previously resolving its own root via cwd walk).

### Internal
- 99 new tests (730 baseline -> 829 + 2 skipped). Headline parity test (cli-thin-client) spawns real subprocess server and verifies audit discriminator. Concurrent recall+write under SQLite single-writer (10 readers x 50 reads + 1 writer x 50 writes) confirms zero locked errors.
- All 5 /review ship blockers closed (C1 pidfile banner, C2 VERSION constants, C3 MCP context plumbing, H4 drain timeout, H5 tenant deny on archive/forget).

### Known issues (tracked for v0.37.0 in TODOS.md)
- **p99 latency:** measured 58.4ms vs 50ms target on 10k store. Architecture ships; latency hardening lands in v0.37.0. Profiling candidates: per-request DB open, audit-emit roundtrip, JSON serialization, hybrid embedding wiring.
- HIPPO_API_KEY silently dropped on stale-pidfile fallback (HIPPO_REQUIRE_SERVER knob coming in v0.37.0).
- Concurrent `hippo serve` on the same hippoRoot has no winner detection; second serve clobbers the first's pidfile.
- Recall mode=hybrid query param accepted but ignored (BM25-only over HTTP). Hybrid wiring deferred.
- MCP-over-HTTP SSE is keepalive-only; no server-pushed messages.

### Deferred to v2 (full multi-tenant)
No new deferrals. A5 v2 follow-ups still tracked in TODOS.md.

## 0.35.0 (2026-04-29)

### Added
- **A5 stub auth track.** Schema v16 adds `tenant_id` to `memories`, `working_memory`, `consolidation_runs`, `task_snapshots`, `memory_conflicts` (default 'default') plus composite indexes. New tables: `api_keys` (scrypt-hashed) and `audit_log` (append-only mutation trail).
- **API key primitives.** `createApiKey` / `validateApiKey` / `revokeApiKey` / `listApiKeys` in src/auth.ts. scrypt + timingSafeEqual. Plaintext returned exactly once on create.
- **Audit log primitives.** `appendAuditEvent` / `queryAuditEvents` in src/audit.ts. Hooks on every mutation: remember, recall, promote, supersede, forget, archive_raw, auth_revoke.
- **Tenant resolution.** `resolveTenantId({db?, apiKey?})` in src/tenant.ts. Order: explicit api key > HIPPO_TENANT env > 'default'.
- **Cross-tenant isolation at recall.** Tenant A's recall does not return tenant B's memories. Enforced on CLI recall/explain/context, MCP server (`hippo_recall`, `hippo_context`, `hippo_status`), and dashboard.
- **CLI surface.** `hippo auth create [--label X] [--tenant Y]`, `hippo auth list [--all]`, `hippo auth revoke <key_id>`, `hippo audit list [--op X] [--since Y] [--limit N] [--json]`.
- **SSO/SCIM stubs** in src/sso.ts. `ssoLogin`, `scimProvisionUser`, `scimDeprovisionUser` throw `NotImplementedError` referencing v2.

### Fixed
- Empty `HIPPO_TENANT` env coerces to 'default' (whitespace-trimmed).
- bigint-safe JSON serialization for audit metadata (mirrors the raw-archive pattern).
- `archiveRawMemory` audit event now uses the row's tenant_id, not the operator's env.

### Internal
- 30 new tests across schema, auth, audit, tenant, store, CLI surfaces. Cross-tenant isolation negative test covers CLI + MCP + dashboard.
- All review findings closed: 4 HIGH (tenant filter holes on MCP/explain/dashboard/context), 7 MEDIUM, 8 LOW.

### Deferred to v2 (tracked in TODOS.md)
- Multi-tenant per-key isolation (one key -> one tenant). Stub treats deployments as single-tenant.
- OAuth/OIDC, SCIM provisioning.
- Audit log retention policy.
- RBAC, rate limiting per tenant.

## 0.34.0 (2026-04-29)

### Added
- **A3 provenance envelope.** Every memory now carries `kind` (`raw | distilled | superseded | archived`), `scope`, `owner`, and `artifact_ref` columns. `hippo recall --why` surfaces the envelope; `hippo remember` accepts `--kind`, `--scope`, `--owner`, `--artifact-ref` flags. See `MEMORY_ENVELOPE.md`.
- **Append-only invariant on `kind='raw'`.** SQLite trigger `trg_memories_raw_append_only` aborts direct DELETE on raw rows. The only legitimate path is `archiveRawMemory(db, id, { reason, who })` which snapshots into the new `raw_archive` table, purges the FTS row, and removes the memory in one SAVEPOINT (sets up A4 right-to-be-forgotten).
- **Schema v14 + v15.** v14 adds the envelope columns, the `raw_archive` table, the append-only trigger, and INSERT/UPDATE CHECK-substitute triggers (ALTER TABLE cannot add CHECK in SQLite). v15 closes a NULL-kind bypass in those triggers and adds `UNIQUE(memory_id, archived_at)` to `raw_archive`. Backwards compatible, auto-migrates.
- **Pineal salience v2.** `--salience-threshold` flag for the recall pipeline (commit `50528a5`).
- **Enterprise execution roadmap (`ROADMAP-RESEARCH.md`).** 90-day plan re-sequenced after Codex + eng-review pass: A3 envelope first (this release), then A5 stub auth, A1 server, E1.3 Slack ingestion. Cuts 7 deferred items into days 91-180.

### Fixed
- **FTS leak in `archiveRawMemory`.** Archived raw content stayed in `memories_fts` until next DB-open backfill; defeated GDPR right-to-be-forgotten. Archive now purges the FTS row inside the same SAVEPOINT.
- **CLI `--kind raw` gated.** Existing `hippo forget` / consolidation / conflict-resolution paths abort on raw rows via the trigger. Until those paths route through `archiveRawMemory`, the CLI restricts `--kind` to `{distilled, superseded}` so users cannot create unforgettable memories.
- **NULL-kind trigger bypass.** v14 triggers used `WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN (...)`, so a direct `kind=NULL` write silently bypassed the CHECK substitute. v15 rejects NULL.
- **`archiveRawMemory` transaction safety.** Now uses `SAVEPOINT` (nestable) instead of `BEGIN`. BigInt-safe JSON serializer for the audit payload.
- **`--scope` envelope trim.** Matched the pre-existing scope-tag trim behavior.

### Internal
- 730 tests (+15 from v0.33.0). New: `tests/a3-envelope-migration.test.ts`, `tests/raw-archive.test.ts`, `tests/recall-why-envelope.test.ts`.
- Reviewed via `/codex`, `/plan-eng-review`, `/review` (Claude pass + adversarial subagent), `/self-review`, `/ship-check`. All ship-blockers resolved before release.

## 0.33.0 (2026-04-23)

### Added
- **Write-time fact extraction.** During `hippo sleep`, episodic memories are now processed by an LLM to extract standalone facts (up to 8 per memory). Facts are stored as semantic-layer entries with `extracted_from` linking back to the source. Extracted facts get a 1.3x search boost and automatically deduplicate against their source entries in results, so users see the precise fact instead of the raw conversation.
- **DAG summarization.** Extracted facts are clustered by Jaccard similarity (>= 0.5) on speaker:/topic: entity tags, then summarized into dag_level=2 parent nodes. When a summary matches a query, its children are injected into results at 0.9x parent score, giving hierarchical drill-down.
- **Multi-hop retrieval.** `hippo recall --multihop` and `multihopSearch()` run a two-pass entity-chained search. Pass 1 retrieves top-K and extracts entity tags not in the original query. Pass 2 reformulates the query with discovered entities and retrieves again. Results merge by highest score per ID.
- **`hippo remember --extract`** triggers immediate fact extraction on the remembered content.
- **`hippo dag --stats`** shows DAG layer distribution (how many entries at each level).
- **Schema v12-v13.** v12 adds `extracted_from` column, v13 adds `dag_level` + `dag_parent_id` with backfill and index. Backwards compatible, auto-migrates on first open.

### Fixed
- **`temporalBoost` O(N^2) refactored to O(N).** Previously called `Math.min(...timestamps)` per entry inside the search loop, risking stack overflow on large stores. Now precomputes range once via `computeTemporalRange()`.
- **Config scoping bug in `consolidate.ts`.** `config` was block-scoped inside the extraction `if` block but referenced from the DAG section outside it. Would cause ReferenceError when no extraction candidates exist but extracted facts are ready for DAG processing.
- **Dead `seenIds` variables removed** from both search paths (populated but never read).

### Internal
- 674 tests (+41 from v0.32.0). 16 new test files covering extraction, DAG, multi-hop, temporal scoring, CLI commands, and integration smoke tests.
- Reviewed via `/review` + `/self-review` + `/qa` + `/ship-check` + senior code review agent.

## 0.32.0 (2026-04-22)

### Added
- **Bi-temporal memory: correction without deletion.** When a belief changes, the old memory stays as historical truth instead of being overwritten. Default recall filters superseded entries so agents see current reality; historical views are explicit. Schema v11 adds `valid_from` and `superseded_by` columns, backwards compatible with v10 stores (ADD COLUMN only, no data transform).
- **`hippo supersede <old-id> "<new content>"`.** Creates a successor memory and links the old one via `superseded_by`. Cycle prevention: if the target is already superseded, the command errors with the successor's ID so you can supersede that one instead. Reuses `--layer`, `--tag`, `--pin` from `remember`.
- **`--include-superseded`** on `hippo recall` / `explain`. Returns historical memories with a `[superseded]` marker in output. Default recall hides them.
- **`--as-of <ISO-date>`** on `hippo recall` / `explain`. Returns the set of memories that were current at that date. Validates input at CLI entry; invalid dates exit with a clear ISO-format hint.
- **Partial index for fast current-only queries.** `CREATE INDEX idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL` makes the default recall path cheap even with large archives.

### Changed
- **`markRetrieved` is a no-op for superseded entries.** Retrieving a historical memory (via `--include-superseded`) no longer strengthens it or extends its half-life. Historical reads shouldn't revive dead beliefs.
- **`detectConflicts` skips superseded pairs.** No point flagging "these contradict" when one side is historically dead.

### Research
- **Physics search ablation: CUT verdict.** Benchmarked physics-on vs physics-off over 60 stratified LongMemEval-oracle questions (paired bootstrap, 5000 iters). Physics OFF: MRR 0.8388, Recall@5 84.31%, NDCG@5 0.7888. Physics ON: MRR 0.6848, Recall@5 74.17%, NDCG@5 0.6570. All metrics statistically worse with physics; 95% CI excludes zero. Results in `benchmarks/physics-ablation/`. Physics remains in the codebase and is not removed in this release; a decision on removal is tracked as follow-up.
- **LoCoMo harness built.** `benchmarks/locomo/run.py` scores hippo against snap-research's long-conversation memory benchmark using Claude as judge. Sanity run (3 QAs): 2 adversarial abstentions correct, 1 open-domain miss. Full 10-conversation run requires overnight batch due to ~2 turns/sec ingestion.

### Internal
- 633 tests pass (+8 from v0.31.0). 3 new test files: `bi-temporal-migration.test.ts`, `cli-supersede.test.ts`, `bi-temporal-recall.test.ts`.
- 4 commits on master: `091e6de` (schema v11), `026988b` (supersede command), `b538c0d` (recall filters), `7108187` (review fixes).
- Reviewed via `/review` + `/self-review` + `/ship-check`. Two fixes landed: `--as-of` date validation (previously silent no-op on invalid input) and `cmdSupersede --tag` parity with `cmdRemember` (previously only accepted comma-separated, dropped repeated flags).

## 0.31.0 (2026-04-22)

### Added
- **Scope-aware corrections.** Memories can now be tagged with a context scope (e.g. `scope:plan-eng-review`, `scope:qa`) via `hippo remember --scope <name>`. During recall, memories whose scope matches the active scope get a 1.5x boost; memories with a mismatching scope are suppressed 0.5x; unscoped memories stay neutral. A correction said during one skill no longer pollutes unrelated contexts.
- **Auto-detection from env vars.** `detectScope()` reads `HIPPO_SCOPE`, `GSTACK_SKILL`, or `OPENCLAW_SKILL` in priority order. When any is set, `hippo remember` / `recall` / `context` / `explain` auto-apply the scope without explicit flags. Pure env var reads, no I/O on hot paths.
- **`--scope <name>` flag** on `hippo remember`, `hippo recall`, `hippo context`, `hippo explain`. Explicit scope overrides auto-detection.
- **`scopeBoost` in score breakdown.** `hippo explain --why` shows the scope multiplier when it is not 1.0, making scope routing debuggable.

### Internal
- 625 tests pass (+21 from v0.30.1). 3 new test files: `scope.test.ts`, `scope-boost.test.ts`, `scope-context.test.ts`.
- New module: `src/scope.ts` (32 lines). `scopeBoost` added to `src/search.ts` alongside existing `decisionBoost` / `pathBoost` / `outcomeBoost` multipliers.
- Reviewed via `/review` + `/self-review`. Git-branch fallback in `detectScope()` was proposed but dropped after review: it forked git on every UserPromptSubmit hook call (~50-150ms latency per user message) and polluted the tag space with ephemeral branch names.

## 0.30.1 (2026-04-22)

### Fixed
- **`hippo recall --layer <L>` is now a strict filter.** Previously the flag was accepted but silently dropped, so results from other layers leaked in. This broke the intent of `recall --layer trace` and the RSI demo's headline example.
- **`hippo status` now prints a `Trace:` counter.** The new trace layer was tracked internally but never surfaced in the status output.
- **`hippo --version` / `-v` print the package version.** Previously errored with "Unknown command".

### Internal
- 604 tests pass (+5 from v0.30.0). 3 new test files cover the three fixes end-to-end via `execFileSync` against `bin/hippo.js`.
- Caught by `/review` (senior-code-reviewer) + npm smoke test before the GitHub Release for v0.30.0 went public.

## 0.30.0 (2026-04-21) — Sequence binding (recursive-self-improvement foundation)

### Added
- **`Layer.Trace`** — a new memory layer for ordered action→outcome sequences. Traces are first-class `MemoryEntry` rows; they inherit decay, retrieval-strengthening, conflict detection, embeddings, replay, and physics from the existing infrastructure. Four inheritance smoke tests lock that claim.
- **`trace_outcome` + `source_session_id` columns** (schema v3 migration, with a regression test that a pre-v3 store with existing data migrates without loss). `trace_outcome` is `'success' | 'failure' | 'partial' | null`. `source_session_id` is indexed for idempotent auto-promotion.
- **`hippo session complete --session <id> --outcome <...>`** — the terminal event that marks a session as finished with a given outcome. Phase C auto-promotion depends on this event type existing.
- **`hippo trace record --task <t> --steps <json> --outcome <...>`** — explicit trace storage. Takes a JSON array of `{action, observation}` steps plus an outcome. Renders to markdown in the memory's `content` field.
- **`hippo recall --outcome <...>`** — filter results to trace-layer memories with matching outcome. Non-trace entries pass through unaffected.
- **Auto-promotion during `hippo sleep`** — completed sessions (those with a `session_complete` event within `autoTraceWindowDays`, default 7) become bound traces automatically. Idempotent via the `source_session_id` guard; three consecutive sleeps produce exactly one trace per session.
- **`examples/rsi-demo/`** — a minimal recursive-self-improvement agent that uses traces to learn from prior runs. 50-task suite with 10 trap categories. Deterministic. Ships with a measurable pass bar: late-stage success rate must exceed early-stage by at least 20 pp or the demo exits non-zero. Current seed: early 20% → late 100%, gap 0.80.
- **`src/trace.ts`** — `renderTraceContent(rec)` for markdown rendering; `parseSteps(json)` for step validation.

### Changed
- **`detectConflicts` now skips trace-vs-trace pairs.** Two successful traces for "refactor auth" are variants of each other, not contradictions. One-line filter in the conflict pass.
- **Default recall JSON output** includes `layer` always, and `trace_outcome` when present. Additive — existing consumers are unaffected.

### Config
- `config.autoTraceCapture: boolean` (default `true`) — master switch for auto-promotion.
- `config.autoTraceWindowDays: number` (default `7`) — only sessions with a `session_complete` event in the last N days are eligible.

### Grant / positioning
This is the foundation for a recursive-self-improvement story. Three of hippo's primitives (outcome-modulated decay, retrieval-strengthening, conflict resolution) were already aligned with RSI needs. Sequence binding adds the fourth: **bound outcome-linked traces**. Counterfactual memory and executable skill-tier are the next two; they compose on top of this.

### Internal
- 599 tests pass (+28 from v0.29.3). Breakdown: 8 Phase A (enum + fields + v2-with-data migration), 11 Phase B (session complete + trace module + record command + --outcome filter with non-trace pass-through), 9 Phase C (auto-promote + idempotency + windowing + conflict skip + 4 inheritance smokes).
- Phase A applied 3 eng-review blocker fixes before any code: indexed `source_session_id` for idempotency, explicit `hippo session complete` contract, dead `trace_steps_json` column dropped.
- Full plan + post-review revisions at `docs/plans/2026-04-21-sequence-binding.md`.

## 0.29.3 (2026-04-21) — Friendly post-install nudge for Claude Code users

### Added
- **Post-install banner on fresh installs.** `npm install -g hippo-memory` now detects whether Claude Code is present (`~/.claude/` exists) AND whether the Hippo `UserPromptSubmit` hook is already wired (`settings.json` contains `hippo context --pinned-only`). If Claude Code is present and the hook is absent, prints a three-line message pointing the user at `hippo init`. Silent on machines without Claude Code or on reinstalls where the hook is already wired. Opt out with `HIPPO_SKIP_POSTINSTALL=1`.
- **No config writes.** The banner is read-only — it prints to stderr. No surprise edits to `~/.claude/settings.json`, which would be rude and trip security scanners.

### Rationale
Before this, a new user's flow was: `npm install -g` → run some command → "wait, why is nothing happening?" → search docs → find `hippo init`. Three friction points. Now: install → see the banner → copy-paste `hippo init`. One friction point, already highlighted.

## 0.29.2 (2026-04-21) — Fix UserPromptSubmit hook in non-initialized directories

### Fixed
- **`UserPromptSubmit` hook no longer errors in fresh cwds.** The v0.29.x `hippo context --pinned-only` path hard-failed `requireInit` whenever Claude Code opened a session in a directory without a local `.hippo/` store, producing a visible "No .hippo directory found. Run `hippo init` first." error on every user message. Now the pinned-only path falls back to global-only when no local store exists. The non-pinned `hippo context` path still requires init (unchanged).
- **Hook no longer auto-creates `.hippo/` in arbitrary cwds.** Previously, `loadActiveTaskSnapshot` and `loadAllEntries` inside `cmdContext` would silently create `.hippo/` on first invocation. Now both are guarded by `isInitialized(hippoRoot)` so the hook leaves fresh directories untouched.

### Internal
- 571 tests pass (+2): regression tests covering the "missing local .hippo" case and the "neither local nor global has pinned memories" empty-cwd path. Both assert zero `.hippo/` pollution.

## 0.29.1 (2026-04-21) — Raise default pinnedInject.budget to 1500

### Changed
- **`config.pinnedInject.budget` default: 500 → 1500.** The initial 500-token default was too tight for mature hippo installs. Smoke-testing on a store with 10 existing pinned memories (685 tokens) showed new invariants silently dropped off the bottom of the rehearsed set. 1500 matches `defaultContextBudget` and comfortably fits typical pinned-memory counts. Users with a `.hippo/config.json` override keep their explicit value; only the default changes.

### Fixed
- **Test assertion.** `tests/config.test.ts` updated to match the new default.

## 0.29.0 (2026-04-21) — Replay + mid-session pinned re-injection

### Added
- **Replay pass in `hippo sleep`.** Hippo now rehearses a small sample of surviving memories on every consolidation cycle, mirroring hippocampal replay during slow-wave sleep. The sampler weights by reward feedback, emotional valence, under-rehearsal, idle time, and remaining strength. Rehearsed memories get the same retrieval-strengthening that a real `hippo recall` applies (retrieval_count +1, half_life +2 days, last_retrieved refreshed). Exposed via new `src/replay.ts` (`sampleForReplay`, `replayPriority`). Sleep output now emits a `💭 replayed N memories: <ids>` line between the decay and physics passes.
- **`config.replay.count`.** Number of memories to rehearse per sleep cycle (default: 5). Set to 0 to disable. Stale-confidence memories are never rehearsed — staleness is a deliberate signal we don't want to erase.
- **Mid-session pinned-rule re-injection (Claude Code).** Addresses the Opus 4.7 complaint that the model "forgets" rules mid-session. `hippo context` now accepts `--pinned-only` (restrict to pinned memories) and `--format additional-context` (emit Claude Code's `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` JSON shape). `hippo hook install claude-code` (and `opencode`) now installs a `UserPromptSubmit` hook that invokes this every turn, so pinned rules stay in context every message, not just at SessionStart. Read-only: no retrieval_count inflation.
- **`config.pinnedInject.{enabled,budget}`.** Controls the hook behaviour. Defaults: `enabled: true`, `budget: 500` tokens. Disable with `{"pinnedInject":{"enabled":false}}`. Zero output when no pinned memories exist (zero per-turn tax).

### Behaviour changes (users should know)
- **Replay.** Every user's next `hippo sleep` will begin rehearsing up to 5 memories by default. Non-destructive, small positive bias toward high-value memories staying alive. Opt out with `{"replay":{"count":0}}`.
- **Pinned re-injection.** Existing users must re-run `hippo hook install claude-code` (or `opencode`) to pick up the new `UserPromptSubmit` entry — it is NOT auto-added to existing installs. Once installed, every turn's context carries the (read-only) pinned block. Opt out per-user with `{"pinnedInject":{"enabled":false}}`.

### Grant context
Closes the replay gap documented in `docs/plans/2026-04-21-hippocampal-mechanism-audit.md`. The Frontier AI Discovery feasibility study pitch claimed 7 hippocampal mechanisms; pre-audit the code implemented 6. Replay is now `PRESENT` with unit + integration tests.

### Internal
- 569 tests pass (+29 from v0.28.0): 14 unit tests for the replay sampler + priority, 3 integration tests for the consolidation pass wiring, 7 tests for `--pinned-only` command behaviour (filtering, JSON shape, read-only guarantee, config respect, multi-memory injection), 3 tests for the UserPromptSubmit hook install/uninstall/idempotency, 2 tests for the `pinnedInject` config schema.
- Phase A model-profile benchmark infrastructure (`evals/model-profile-bench.json`, `scripts/run-model-profile-bench.mjs`, `scripts/model-profile-judge.mjs`) shipped as a reusable harness. Baseline run produced a null result (4.6 and 4.7 perform identically on our failure modes) — see `docs/plans/2026-04-21-phase-a-decision.md`.
- O1 soak test harness (`scripts/soak-test.mjs`, `scripts/soak-all.mjs`, `benchmarks/soak/`) validates the physics engine stays energy-bounded across 10 synthetic workload profiles. Current sweep at 100 ticks × 80 particles is a smoke scale, not a 100-hour study.
- O2 competitor-benchmark scope documented at `docs/plans/2026-04-21-o2-competitor-benchmark-scope.md` (not started).
- Plan: `docs/plans/2026-04-21-pinned-reinject.md`.

## 0.28.0 (2026-04-20) — Budget saturation fix + LongMemEval parity

### Added
- **`minResults` option on all search functions.** `hybridSearch`, `physicsSearch`, `search`, and `searchBothHybrid` accept `minResults` to guarantee at least N results regardless of token budget. Prevents budget saturation when memories are large (e.g. LongMemEval's 14k-char session dumps fit only 1 per budget=4000). Production default: 1 (backward compatible). CLI: `hippo recall <q> --min-results 5`.
- **`scoring: 'rrf'` option on `hybridSearch`.** Reciprocal rank fusion as an alternative to score blending. Combines BM25 and cosine ranks instead of scores. Available for experimentation; default remains `'blend'`.
- **`hippo refine` command.** LLM-powered semantic rewrite of memories for improved recall quality.

### Fixed
- **LongMemEval regression was benchmark methodology, not scoring.** The v0.27 benchmark runner used `budget=4000` (fitting ~1 memory per query) while v0.11 used FTS5 `top_k=10` with no budget. Corrected benchmark defaults to `budget=1000000, minResults=10`. With fair comparison, v0.27 R@10 = 81.0% vs v0.11 R@10 = 82.6% (1.6pp gap, down from apparent 35pp). v0.27 wins on R@3 (+0.4pp) and answer_in_content@5 (+3.0pp).
- **MMR O(N^2) on large candidate sets.** Capped re-ranking to top-100 candidates. Per-query time dropped from ~50s to ~9s.

### Performance
- **`preparedCorpus` option on `hybridSearch`.** Batch callers skip per-query O(N*docLen) tokenization. Further per-query drop to ~6-7s.

### Internal
- 540 tests pass (up from 537). New coverage: `minResults` guarantees for sync search, async hybridSearch, and edge case (minResults > available).
- Benchmark runner (`retrieve_inprocess.mjs`) defaults updated for fair evaluation.
- Full LongMemEval results documented in `evals/README.md` with corrected methodology.

## 0.27.0 (2026-04-20) — Recall observability + quality

### Added
- **`hippo explain <query>`.** Read-only diagnostic that shows the full score breakdown per retrieved memory: BM25 raw + normalized + weight + matched query terms, cosine + weight, base blend, strength/recency/decision/path/source/outcome multipliers, age, and final composite. Does NOT mark memories as retrieved, so it's safe as a debugging tool. `--json` for programmatic consumers.
- **`hippo trace <id>`.** Single-memory dossier: content, layer/confidence/pinned/tags, age, strength trajectory with 30-day and 90-day projections, effective half-life with reward-factor breakdown, retrieval count + staleness, outcome pos/neg, consolidation parents, and any open conflicts. `--json` supported.
- **`hippo eval [<corpus.json>]`.** Measure recall quality against a test corpus. Metrics: MRR, Recall@5, Recall@10, NDCG@10. `--bootstrap` generates a synthetic corpus from current memories (useful as a smoke test). `--show-cases` prints per-case details so eval doubles as a debugger. `--min-mrr <f>` gates CI by exiting non-zero when mean MRR drops below threshold. `--no-mmr` / `--mmr-lambda <f>` / `--embedding-weight <f>` to A/B tune.
- **MMR diversity re-ranking.** After hybrid scoring, iteratively pick the result maximising `lambda * relevance - (1 - lambda) * max(cos(cand, picked))` so near-duplicate memories don't cluster at the top. Default `lambda=0.7`, configurable via `config.mmr.{enabled, lambda}`. Only applies when embeddings are loaded; pure-BM25 mode is unchanged. Config + CLI off-switches available.
- **Outcome-based retrieval boost.** `hippo outcome --good/--bad` now gives an immediate nudge on the next recall via `1 + 0.15 * tanh((pos - neg) / 2)` clipped to `[0.85, 1.15]`. Distinct from the existing slow reward-factor-via-strength path. `ScoreBreakdown` includes the new field.
- **Real eval corpus** at `evals/real-corpus.json` with 15 hand-curated cases spanning project rules, dev-environment gotchas, external project references, and architecture notes. `scripts/build-eval-corpus.mjs` regenerates from the live store. Baseline numbers documented in `evals/README.md`.

### Fixed
- **Misleading `hybrid` mode label.** When the query was embedded but no document had a cached vector, explain output showed `mode: hybrid` even though only BM25 was contributing. Now split: `hybrid` when a cached vector was used, `hybrid-no-vec` with a hint to run `hippo embed` when not. No scoring change — labeling only.
- **`hippo eval --bootstrap --out <nested/path>.json`** now auto-creates the parent directory instead of failing on ENOENT.

### Internal
- New `src/eval.ts` exports pure-function metrics (`mrr`, `recallAtK`, `ndcgAtK`), a `runEval` driver, and `bootstrapCorpus`.
- `SearchResult.breakdown?: ScoreBreakdown` opt-in via `{ explain: true }` on hybridSearch / physicsSearch / searchBothHybrid. Zero-cost when unset.
- `mmrRerank` helper exported for direct unit testing.
- 523 tests pass (up from 498). New coverage: breakdown math identity, outcomeBoost bounds, MMR reorder at various lambda values, eval metric math, bootstrap filtering.

## 0.26.0 (2026-04-20) — Memory quality

### Added
- **`hippo audit` command.** Checks memory quality and flags low-value entries: too-short content, release/merge/WIP commit noise, sentence fragments, vague entries with no specific details. `--fix` removes errors (auto-deletes). Severities: `error` (removed on fix) and `warning` (reported only).
- **Sleep-time auto-cleanup.** `hippo sleep` now runs the audit and silently removes junk memories (severity `error`). Prevents commit-noise like `"release 0.24.1"` or `"Merge branch main"` from surviving consolidation.
- **Capture quality gate.** `cmdCapture` (markdown importer, Claude Code hooks) filters extractions through `isContentWorthStoring()` so fragments and version bumps never enter the store.

### Fixed
- **Conflict detector over-fires.** Previous detector flagged 800+ spurious "negation polarity mismatch" conflicts from scanning entire memory bodies. Rewritten with stopword-filtered Jaccard, a minimum rare-shared-token gate, and opening-window polarity: enabled/disabled, true/false, and always/never checks now only fire on tokens near the start of a memory. Removes false positives where common English prepositions ("on", "off", "in", "out") happened to co-occur deep in unrelated prose.
- **`hippo remember` accepts empty/tiny inputs.** Now rejects content under 3 characters with a clear error.

### Internal
- New `src/audit.ts` with `auditMemory`, `auditMemories`, `isContentWorthStoring`.
- `scripts/resolve-stale-conflicts.mjs` — one-off migration that marks the pre-0.26 spurious conflicts as resolved so they vanish from the UI and reports.
- Schema migration to version 9 adds `parents_json` and `starred` columns to the memory store (reserved for future UI work; unused in this release).

## 0.25.0 (2026-04-16) — Brain Observatory

### Added
- **Living Map UI.** `hippo dashboard` now serves an interactive particle visualization of your agent's memory. Memories rendered as glowing particles on a 2D canvas with force-directed layout.
  - Color by layer (buffer = blue, episodic = amber, semantic = green)
  - Size by retrieval count, opacity by current strength
  - PCA projection of 384-dim embeddings to 2D with d3-force clustering
  - Hover tooltips, click for full detail panel, search filtering with dimming
  - Red dashed lines between conflicting memories
  - Subtle breathing animation simulating live decay
  - Empty state with getting-started prompt
- **JSON API.** Six endpoints for programmatic access: `/api/memories`, `/api/stats`, `/api/conflicts`, `/api/embeddings`, `/api/peers`, `/api/config`.
- **Static file serving.** Dashboard serves pre-built React SPA from `dist-ui/` with SPA fallback routing. Legacy inline HTML preserved when UI is not built.

### Changed
- `prepublishOnly` now runs `build:all` (TypeScript + UI) to include `dist-ui/` in the npm package.

## 0.24.2 (2026-04-16)

### Added
- **Machine-level daily runner.** `hippo init` now registers each workspace in a global registry and installs one daily runner at 6:15am instead of creating one OS task per project. The new `hippo daily-runner` command sweeps all registered workspaces and runs `hippo learn --git --days 1` followed by `hippo sleep`.

### Changed
- **OpenClaw session-end autosleep is detached.** When the native OpenClaw plugin has `autoSleep` enabled, it now spawns `hippo sleep` in a detached background process on `session_end` so shutdown is not blocked by consolidation.
- **Docs now describe local + global retrieval plus daily refresh separately.** OpenClaw, OpenCode, Pi, and other agent integrations now document the split between query-time retrieval, session-end hooks, and the machine-level daily runner.

### Internal
- Added `src/scheduler.ts` and `tests/scheduler.test.ts` for workspace registry handling, command generation, and daily sweep execution. Full suite passes: 494 tests.

## 0.24.1 (2026-04-15)

### Fixed
- **Conflict detection now gates on content overlap, not shared tags.** `hippo sleep` no longer flags unrelated `feedback` / `policy` memories as contradictions just because they share coarse tags and opposite polarity words.
- **Reworded contradictions still surface.** Opposites like `API auth must be enabled in prod` / `Disable API auth in prod` stay detectable instead of being filtered out by a blunt overlap threshold.
- **`must` and `always` now count as positive polarity.** Contradictions like `Production deploys must require approval` / `Production deploys should not require approval` are caught consistently.

### Internal
- Added regression tests for the exact false-positive pairs from the migrated-store report plus a broader contradiction matrix (`must` vs `should not`, `available` vs `missing`, `works` vs `broken`). Full suite passes: 491 tests.

## 0.24.0 (2026-04-15)

### Added
- **Codex auto-wrap on install and update.** Installing or upgrading `hippo-memory` now runs a postinstall step that looks for `codex` on `PATH`, renames the original launcher to a sibling backup such as `codex.hippo-real.cmd` / `codex.hippo-real.exe`, and drops a Hippo wrapper at the command path users already run. No extra PATH prep, no manual launcher swap.
- **Codex self-heal install path.** Common Hippo commands now opportunistically install the Codex wrapper if Hippo was installed before Codex or the postinstall step could not run at package install time.
- **Codex transcript capture support.** `hippo capture --last-session` now understands Codex rollout transcript JSONL and extracts user and assistant message text from Codex `response_item` payloads.

### Changed
- **Codex integration is no longer AGENTS-only.** `hippo setup` and `hippo hook install codex` now wrap the detected launcher in place instead of asking users to put `~/.hippo/bin` first on `PATH`.
- **Codex docs updated to match the real install path.** README and integration docs now describe automatic wrapping on install/update and the in-place launcher behavior.

### Internal
- Added `src/postinstall.ts` plus `scripts/postinstall.cjs` so published packages apply the Codex integration automatically without making `npm install` fail when Codex is absent.
- Added `tests/codex-wrapper.test.ts` for in-place launcher wrapping, uninstall restore, PATH discovery, and Codex transcript resolution. Full suite passes: 487 tests.

## 0.23.0 (2026-04-13)

### Fixed
- **SessionEnd hook no longer gets SIGTERM'd by TUI teardown.** 0.22.1 installed `hippo sleep --log-file` and `hippo capture --last-session --log-file` as two parallel SessionEnd entries. Claude Code and OpenCode fire SessionEnd hooks while tearing down the TUI, and the process group is killed before the children finish — so the log usually only contained the `consolidating memory...` / `capturing session...` start lines, never the `sleep complete` / `capture complete` markers. 0.23.0 collapses both into a single `hippo session-end --log-file <path>` entry whose parent returns in <100ms after spawning a fully detached Node child (via `child_process.spawn({detached: true, stdio: 'ignore', windowsHide: true}).unref()`). The detached child runs sleep → capture in sequence and writes both outputs to the log. Cross-platform (Windows/macOS/Linux) — no shell wrappers, no `nohup`, no `start /B` quoting hell.

### Added
- **`hippo session-end` subcommand.** Reads stdin synchronously to extract `transcript_path` from the SessionEnd payload, spawns the detached worker, and exits. Short SessionEnd timeout (5s) because the parent returns immediately.
- **Internal `__session-end-worker` subcommand.** Runs sleep → capture sequentially inside the detached child. Failures in one stage do not block the other; both tee their output to the shared log file.

### Changed
- **Auto-migration from 0.22.x split entries.** Re-running `hippo init`, `hippo hook install <target>`, or `hippo setup` detects the old split `hippo sleep --log-file` + `hippo capture --last-session --log-file` SessionEnd entries and collapses them into a single `hippo session-end --log-file` entry. Idempotent — existing 0.22.x installs just need one invocation.
- **Claude Code plugin `hooks.json`** switched its SessionEnd to `hippo session-end`, matching the JSON-hook install path. Also added `hippo last-sleep` to SessionStart so plugin users see the previous session's consolidation output between banners.

### Internal
- `InstallResult` replaced `installedSessionCapture` with `migratedSplitSessionEnd` (the migration flag for the 0.22.x two-entry form).
- `tests/hooks.test.ts` rewritten against the single-entry schema; all 19 cases plus the 481 full-suite tests pass.

## 0.22.1 (2026-04-13)

### Fixed
- **Session-end capture output is no longer invisible.** In 0.22.0 the SessionEnd `hippo capture --last-session` hook printed its "Captured N items" output during TUI teardown, so users never saw it. 0.22.1 adds a `--log-file` flag to `hippo capture` that tees stdout/stderr to the same log file as `hippo sleep`, and `hippo init` / `hippo setup` / `hippo hook install <target>` now install the capture entry as `hippo capture --last-session --log-file "<path>"`. `hippo last-sleep` on the next session start prints both sleep *and* capture output between the banners so you can confirm they ran.
- **Auto-migration from 0.22.0.** Re-running any install path detects legacy `hippo capture --last-session` entries (no `--log-file`) and replaces them with the new form. No manual reinstall needed.

### Added
- **`--transcript <path>` short-circuits stdin read.** When an explicit transcript path is passed, `hippo capture --last-session` no longer attempts to read stdin — avoids blocking in scripted / test contexts.

## 0.22.0 (2026-04-13)

### Added
- **`hippo capture --last-session` is now fully implemented.** Previously a placeholder, it now reads the JSONL transcript of the last agent session and extracts actionable memories (decisions, rules, errors, preferences). Resolution priority: explicit `--transcript <path>` flag, then stdin JSON payload (`{transcript_path, session_id, cwd}` — the shape Claude Code / OpenCode SessionEnd hooks pass), then auto-discovery of the newest `.jsonl` under `~/.claude/projects/`. Skips `thinking` blocks, `tool_use`, and `tool_result` noise; keeps the tail (last 20 user messages, last 10 assistant replies) since session-end is about what was decided near the end.
- **SessionEnd `hippo capture` hook auto-installed.** `hippo init`, `hippo hook install <target>`, and `hippo setup` now install a second SessionEnd entry: `hippo capture --last-session` (timeout 15s). Runs once per session, not per turn — addresses the common request to "capture a session summary at /exit without burning tokens on every reply." Existing installs pick up the new entry automatically on re-run (idempotent).
- **Claude Code plugin (`extensions/claude-code-plugin`) moved `hippo sleep` + `hippo outcome --good` from `Stop` to `SessionEnd`** and added the `hippo capture --last-session` entry alongside. Plugin behavior now matches the JSON-hook install path.

### Internal
- New `summariseTranscript()` and `resolveLastSessionTranscript()` exports in `src/capture.ts`, covered by `tests/capture-last-session.test.ts` (10 cases: tail-truncation, block filtering, malformed JSONL, stdin payload resolution, auto-discovery, graceful fallbacks).
- `InstallResult` gained `installedSessionCapture: boolean`. Uninstall markers now include `hippo capture --last-session` so `hippo hook uninstall <target>` cleans up every entry.

## 0.21.1 (2026-04-12)

### Fixed
- **`hippo init` now installs OpenCode JSON hooks too, not just Claude Code.** The auto-install path was only wiring up `SessionEnd`/`SessionStart` entries for Claude Code, even though `hippo hook install opencode` and `hippo setup` already did so. Now all three entry points behave consistently: any detected JSON-hook tool gets its settings file patched.
- **`hippo setup --dry-run` shows the real filename per tool.** The dry-run message previously hard-coded `settings.json`, so OpenCode was reported as writing to `opencode/settings.json` instead of `opencode.json`.

## 0.21.0 (2026-04-12)

### Added
- **`hippo setup` command.** One-shot configuration across every AI coding tool on the box. Detects installed tools by checking for their config directories (`~/.claude`, `~/.config/opencode`, `~/.openclaw`, `~/.codex`, `~/.cursor`, `~/.pi`) and installs all available SessionEnd + SessionStart hooks in one pass. Idempotent. Supports `--all` (install even if not detected) and `--dry-run`.
- **OpenCode JSON hooks.** OpenCode added Claude-Code-compatible `SessionStart`/`SessionEnd` hooks in Jan 2026, so `hippo setup` and `hippo hook install opencode` now install them into `~/.config/opencode/opencode.json`. Same per-tool log isolation as Claude Code.
- **`hippo last-sleep` command.** Prints the contents of the last `hippo sleep --log-file` output and clears it. Used by the new `SessionStart` hook so users actually see what was consolidated last time (previously, `SessionEnd` stdout was swallowed by the TUI tearing down).
- **`hippo sleep --log-file <path>`.** Tees stdout/stderr to a log file while still printing to the terminal. Cross-platform (no shell redirection needed).

### Changed
- **Claude Code hook now uses `hippo sleep --log-file` + `hippo last-sleep` pair.** Replaces the old `echo ... && hippo sleep` command that produced invisible output. On next session start, the previous consolidation is printed between banners and the log is cleared. Re-running `hippo hook install claude-code` or `hippo setup` migrates existing installs automatically.
- **Per-tool log paths.** Each tool writes to its own log file in `~/.hippo/logs/` (`claude-code-sleep.log`, `opencode-sleep.log`). Prevents Claude Code's SessionEnd from clobbering OpenCode's, and vice versa.

### Internal
- Hook install/uninstall moved from `src/cli.ts` to a dedicated `src/hooks.ts` so tests and third-party callers can use it without running the CLI main().
- New `tests/hooks.test.ts` covers fresh install, idempotency, legacy Stop migration, legacy SessionEnd migration, per-tool log isolation, and uninstall.

## 0.20.3 (2026-04-12)

### Changed
- **Visible confirmation on `SessionEnd` hook.** The `hippo sleep` hook installed by `hippo hook install claude-code` (and the Claude Code plugin) now echoes `[hippo] consolidating memory...` before the run and `[hippo] sleep complete` / `[hippo] sleep failed` after, so users can see that consolidation actually ran on session exit. Previous versions swallowed all output with `2>/dev/null || true`. Existing installs need a reinstall (`hippo hook uninstall claude-code && hippo hook install claude-code`) to pick up the new command — the installer's idempotency check treats any entry containing `hippo sleep` as already installed.

## 0.20.2 (2026-04-12)

### Fixed
- **Claude Code hook now uses `SessionEnd` instead of `Stop`.** Earlier versions installed a `Stop` hook, which fires at the end of every assistant turn — so `hippo sleep` (consolidation + dedup + auto-share) ran on every reply. That was expensive, noisy, and could make the UI feel stuck behind the hook timeout. `SessionEnd` fires once when the session actually terminates, which is the intended behaviour.
- **Automatic migration.** Re-running `hippo hook install claude-code` (or `hippo init` in a project with Claude Code) detects any legacy `Stop` entry that runs `hippo sleep`, removes it, and installs the new `SessionEnd` entry. `hippo hook uninstall claude-code` now cleans up both old and new entries.
- **Never create a new agent-instructions file.** `hippo hook install <target>` and `hippo init` used to create a fresh `CLAUDE.md` / `AGENTS.md` / etc. when none existed in the current directory — polluting the working tree of unrelated projects. Hippo now only patches agent-instruction files that already exist. For `claude-code`, the `SessionEnd` hook in `~/.claude/settings.json` is still installed unconditionally (that's the user-level config, not the project).

## 0.20.1 (2026-04-12)

### Changed
- **Session-end capture in all hook templates.** All agent hooks (claude-code, codex, openclaw, opencode, pi) now instruct the agent to summarize the session (decisions, errors, lessons) into `hippo capture` before exiting. Zero friction — the agent does it automatically as its last action.

## 0.20.0 (2026-04-12)

### Added
- **`hippo dedup` command.** Scans the store for near-duplicate memories (default: 70% Jaccard overlap), keeps the stronger copy, removes the weaker. Shows clear reasoning: count by type (redundant semantic patterns, duplicate episodic lessons, cross-layer duplicates), similarity percentage, and content preview for each pair. Supports `--dry-run` and `--threshold <n>`.
- **Auto-dedup on sleep.** `hippo sleep` now runs dedup after consolidation with a categorized summary of what was removed and why.
- **MEMORY.md import on init and sleep.** `hippo init` and `hippo sleep` scan Claude Code memory files (`~/.claude/projects/<project>/memory/*.md`) and import new entries with deduplication against existing memories.

### Fixed
- **Windows CRLF in MEMORY.md frontmatter.** Frontmatter regex now handles `\r\n` line endings.

## 0.19.1 (2026-04-09)

### Fixed
- **Configured embedding model propagation.** `hippo embed`, hybrid search, and physics search now all respect `embeddings.model` from `config.json` instead of silently falling back to the default model.
- **Stale embedding index on model change.** Switching `embeddings.model` now forces a full embedding rebuild and physics-state reset so query vectors and cached vectors stay compatible.
- **Model-specific pipeline caching.** Embedding pipeline instances are now cached per model instead of being reused across different configured models.
- **Version metadata drift.** Synced package, plugin, MCP server, and dashboard version strings for the 0.19.1 release.

## 0.19.0 (2026-04-08)

### Added
- **Pi coding agent extension.** Native extension at `extensions/pi-extension/` with automatic context injection, error capture (noise filtered + rate limited + deduped), session-end consolidation, and 5 registered tools (hippo_recall, hippo_remember, hippo_outcome, hippo_status, hippo_context).
- `hippo hook install pi` patches AGENTS.md with hippo instructions.
- Pi auto-detected during `hippo init` when `.pi/` directory exists.

## 0.18.0 (2026-04-08)

### Added
- **Multi-project auto-discovery.** `hippo init --scan [dir]` finds all git repos under a directory (default: home, max 2 levels deep) and initializes each one with a `.hippo/` store. Seeds with a full year of git history by default. Also initializes the global store. Use `--days <n>` to control history depth, `--no-learn` to skip git seeding.

## 0.17.0 (2026-04-08)

### Added
- **Auto-share to global on sleep.** `hippo sleep` now promotes high-transfer-score memories (>= 0.6) to the global store after consolidation. Universal lessons (error patterns, tool gotchas) are shared; project-specific memories (file paths, deploy configs) are filtered out. Content dedup prevents duplicates. Configurable via `autoShareOnSleep` in config (default: true). Skip with `--no-share`.

## 0.16.2 (2026-04-08)

### Fixed
- **OpenClaw plugin registers once.** Added module-level guard to prevent repeated tool registration on WebSocket reconnection. Previously, every reconnect attempt re-registered all 10 tools.

## 0.16.1 (2026-04-08)

### Changed
- **`deduplicateLesson` performance.** Accepts pre-loaded `MemoryEntry[]` instead of reloading from disk on every iteration. Eliminates N redundant `loadAllEntries` calls during `hippo learn --git`.

## 0.16.0 (2026-04-08)

### Added
- **Auto-learn from git on init.** `hippo init` now seeds the store with 30 days of git history on first setup. New users get instant memory from their commit history. Skip with `--no-learn`.
- **Auto-learn from git on sleep.** `hippo sleep` now runs `learn --git --days 1` before consolidation, capturing recent commit lessons automatically. Configurable via `autoLearnOnSleep` in config (default: true). Skip with `--no-learn`.

## 0.15.0 (2026-04-08)

### Added
- **Adaptive decay for intermittent agents.** Memories now decay based on how often the agent runs, not just wall-clock time. An agent that runs weekly gets 7x longer half-lives automatically. Three modes available via `decayBasis` in config:
  - `"adaptive"` (default) — auto-scales half-life by average session interval. Daily agents behave identically to before. Weekly agents keep memories ~7x longer.
  - `"session"` — decay by sleep cycle count instead of days. Each `hippo sleep` = 1 "day" in the decay formula. Best for agents with unpredictable schedules.
  - `"clock"` — classic wall-clock decay (previous default behavior).
- `SessionDecayContext` and `loadSessionDecayContext()` exported for programmatic use.
- Sleep counter tracked in meta table, incremented on each consolidation run.

## 0.14.0 (2026-04-08)

### Added
- **Automatic backup cleanup on OpenClaw boot.** The plugin now removes stale `hippo-memory.bak-*` directories from `~/.openclaw/extensions/` at registration time. These leftovers from plugin updates cause duplicate plugin ID errors on next boot.

## 0.13.3 (2026-04-08)

### Fixed
- **`rebuildIndex` ROLLBACK safety.** Wrapped in try-catch to prevent masking the original error if BEGIN fails.
- **MCP bare `require` replaced.** `child_process` now imported at top level instead of dynamic `require()` inside ESM module.
- **MCP notification protocol compliance.** All unknown `notifications/*` methods return null (no response), preventing malformed JSON-RPC responses with `id: undefined`.
- **Dead code in `calculateStrength`.** Removed unreachable `entry.pinned` check (pinned entries return early before reaching the guard).
- **Embedding atomic write cleanup.** `.tmp` file is deleted if `renameSync` fails.
- **`HIPPO_HOME` whitespace rejection.** Environment variables are trimmed before use, preventing whitespace-only values from being treated as valid paths.
- **Autolearn env var regex.** Now handles lowercase env vars (`node_env=prod cmd`). `fetchGitLog` uses `execFileSync` to avoid shell interpolation.

## 0.13.2 (2026-04-08)

### Fixed
- **Windows schtasks `%` expansion.** Schedule setup now rejects paths containing `%` on Windows, preventing environment variable injection in Task Scheduler commands. Also fixed quote escaping from `\"` to `""` (correct for `schtasks /tr`).
- **MCP `conflict_id: 0` rejected.** The `!conflictId` check treated ID `0` as invalid due to JavaScript's `!0 === true`. Now uses `isNaN()`.
- **MCP swallowed async errors.** Failed tool executions now send a JSON-RPC error response instead of silently dropping, preventing clients from hanging.
- **Cross-store budget loop inconsistency.** `searchBoth` and `searchBothHybrid` now always include the first result regardless of budget, matching the fix applied to `search.ts` in v0.13.0.
- **Autolearn env var regex false positives.** Regex anchored to only strip leading `KEY=val` assignments, no longer matching `--ARG=val` mid-command.
- **`bufferToFloat32` crash on corrupt data.** Returns empty array for buffers not divisible by 4 bytes instead of throwing.
- **`embedAll` race condition.** Now uses the same `withEmbedLock` mutex as `embedMemory`, preventing concurrent read-modify-write on `embeddings.json`.

## 0.13.1 (2026-04-08)

### Reverted
- **Physics simulation behavior changes.** Reverted co-location perturbation, position collapse reset, and repulsion direction changes from v0.13.0. These need local validation before shipping. The `velocityAlignmentBonus` NaN guard and `Float32Array` alignment fix are kept (pure safety, no behavior change).

## 0.13.0 (2026-04-08)

### Fixed
- **SECURITY: Command injection in OpenClaw plugin.** `runHippo` now uses `execFileSync` with an args array instead of shell string interpolation. All 15 call sites converted. Tag, ID, and session key parameters are no longer injectable.
- **MCP server Content-Length byte/char mismatch.** Incoming message parser now works with raw Buffers instead of decoded strings, correctly handling multi-byte Unicode characters.
- **NaN propagation in `calculateStrength`.** Added guards for zero `half_life_days` and NaN-safe clamping. Memory IDs now use `crypto.randomUUID` for stronger entropy.
- **Token budget drops top result.** Search now always includes the first (highest-ranked) result regardless of budget, then applies budget logic for subsequent results.
- **Non-atomic embedding writes.** `saveEmbeddingIndex` now writes to a temp file then renames. Added mutex to serialize concurrent `embedMemory` calls.
- **FTS5/LIKE query injection.** Search terms are now properly quoted for FTS5 and escaped for LIKE metacharacters.
- **Physics simulation edge cases.** Zero-magnitude query embeddings guarded against NaN. Co-located particles get random perturbation. Position collapse resets to random unit vector. Float32Array alignment ensured.
- **MCP server swallows all exceptions.** `uncaughtException` and `unhandledRejection` now log to stderr instead of silently swallowing.
- **Recursive DB open in `appendSessionEvent`.** Session event count query now reuses the existing connection.
- **Legacy import not transactional.** `rebuildIndex` legacy import loop now wrapped in BEGIN/COMMIT.
- **Shell injection in schedule setup.** `projectDir` validated for unsafe characters before interpolation into crontab/schtasks.
- **Cross-store dedup ineffective.** Search dedup now uses content hash instead of ID (local/global IDs differ after promote/share).
- **Autolearn stores secrets.** Environment variable assignments are stripped from command text before storing error memories.
- **Silent config parse failure.** Broken `config.json` now warns to stderr instead of silently falling back to defaults.
- **Import truncation silent.** Memories truncated during import now produce a warning.
- **Cached pipeline failure permanent.** Failed embedding pipeline load no longer permanently prevents retries.
- **MCP `notifications/initialized` response.** Notifications no longer receive a JSON-RPC response (protocol compliance).

## 0.12.0 (2026-04-08)

### Added
- **Configurable global store location.** The global Hippo store now respects `$HIPPO_HOME`, then `$XDG_DATA_HOME/hippo`, falling back to `~/.hippo/`. Set `HIPPO_HOME=/path/to/hippo` to keep your home directory clean. Works across CLI, MCP server, and OpenClaw plugin. Closes #5.

## 0.11.2 (2026-04-08)

### Fixed
- **Cross-platform path handling in OpenClaw plugin.** `resolveHippoCwd()` now uses `path/posix` after normalizing backslashes, so Windows-style paths like `C:\repo\.hippo` are correctly parsed on Unix systems. Previously, `path.basename` on Unix treated backslashes as valid filename characters, causing `.hippo` detection to fail. Closes #6.

## 0.11.1 (2026-04-07)

### Fixed
- **OpenClaw plugin: error capture filtering.** The `autoLearn` hook now filters tool errors before storing them as memories. Three filters prevent memory pollution: a noise pattern filter (skips known transient errors like browser timeouts, `ECONNREFUSED`, image path restrictions, `Navigation timeout`), a per-session rate limit (max 5 error memories), and per-session deduplication (same error from same tool captured only once). Previously, every tool failure was stored, causing up to 78% of all memories to be garbage error noise that consolidation then amplified into hundreds of synthetic semantic memories.
- **Orphaned embedding pruning.** `hippo embed` now removes cached vectors for memories that no longer exist. Previously, embedding vectors accumulated indefinitely after memory deletion. `hippo status` and `hippo embed --status` now show orphan counts with a prune hint.

## 0.10.0 (2026-04-07)

### Added
- **Active invalidation**: `hippo learn --git` detects migration/breaking commits and actively weakens memories referencing the old pattern. Manual invalidation via `hippo invalidate "<pattern>"`.
- **Architectural decisions**: `hippo decide` stores one-off decisions with 90-day half-life and verified confidence. Supports `--context` for reasoning and `--supersedes` to chain decisions.
- 1.2x recall boost for decision-tagged memories so they surface despite low retrieval frequency.
- **Path-based memory triggers**: Memories auto-tagged with `path:<segment>` from cwd on creation. Recall boosts memories matching the current directory (up to 1.3x). Works for remember, decide, and learn --git.
- **OpenCode integration**: `hippo hook install opencode` patches AGENTS.md. Auto-detection via `.opencode/` or `opencode.json`. Integration guide with MCP server config and `.opencode/skills/memory/` skill.
- `hippo export [file]` exports all memories as JSON or markdown.
- HippoRAG paper reference added to RESEARCH.md and README.md.

## 0.9.1 (2026-04-06)

### Added
- `hippo hook install claude-code` now also installs a Stop hook in `~/.claude/settings.json` that runs `hippo sleep` automatically when Claude Code exits. No more forgetting to consolidate.
- `hippo init` auto-installs the Stop hook when Claude Code is detected.
- `hippo hook uninstall claude-code` cleanly removes the Stop hook from settings.json.

## 0.8.0 (2026-03-27)

### Added
- Multi-agent shared memory: `hippo share <id>` shares memories with attribution and transfer scoring. Memories tagged with universal patterns (error, platform, gotcha) score higher for sharing; project-specific ones (config, deploy, file-path) are filtered out.
- `hippo share --auto` auto-shares all high-scoring memories. `--dry-run` previews candidates.
- `hippo peers` lists all projects contributing to the global store with memory counts.
- `transferScore()` exported for programmatic transfer quality estimation.
- Conflict resolution CLI: `hippo resolve <id> --keep <mem_id> [--forget]`.
- `hippo dashboard` — local web UI at localhost:3333 with memory health overview, strength distribution chart, conflict management, peer status, and searchable/filterable memory table.
- MCP server: added `hippo_conflicts`, `hippo_resolve`, `hippo_share`, `hippo_peers` tools (10 total).
- OpenClaw plugin: added same 4 tools (9 total).

### Changed
- `hippo resolve` without `--keep` now shows both conflicting memories for comparison.
- Version bumped to 0.8.0 across all manifests.

## 0.7.0 (2026-03-27)

### Added
- Hybrid search: `hippo recall` and `hippo context` now blend BM25 keyword scores with cosine embedding similarity when `@xenova/transformers` is installed. Falls back to pure BM25 otherwise.
- `SearchResult.cosine` field on all search results (0 when embeddings not used).
- `searchBothHybrid()` async function for cross-store (local + global) hybrid search.
- Schema acceleration: `schema_fit` is now auto-computed from tag + content overlap against existing memories. High-fit memories (>0.7) get 1.5x half-life; novel memories (<0.3) get 0.5x.
- `computeSchemaFit()` exported for programmatic use.
- Agent evaluation benchmark: 50-task sequential learning eval comparing no memory, static memory, and hippo. Validates the learning-over-time hypothesis (78% early trap rate -> 14% late).
- `tests/hybrid-search.test.ts`, `tests/agent-eval.test.ts`, `tests/schema-fit.test.ts`.

### Changed
- `hippo recall`, `hippo context`, and MCP tools (`hippo_recall`, `hippo_context`) upgraded from synchronous BM25-only search to async hybrid search.
- MCP server request handling is now async to support embedding pipeline.
- `hippo remember`, `hippo learn --git`, and `hippo watch` now auto-compute schema_fit instead of defaulting to 0.5.

## 0.6.3 (2026-03-21)

### Fixed
- `hippo learn --git` now distinguishes between "not a git repo" and "real repo with no commits in the lookback window", so multi-repo learn reports the correct status instead of false `No git history found` messages.
- Synced release metadata across package, OpenClaw plugin manifests, and MCP server version reporting.

## 0.6.2 (2026-03-19)

### Added
- `hippo-memory` now exposes root-level OpenClaw package metadata and a root plugin manifest, so `openclaw plugins install hippo-memory` works directly from npm.
- Added an OpenClaw npm-install smoke test script to verify the packed tarball can be installed into an isolated OpenClaw state directory.

### Fixed
- Normalized the published CLI `bin` entry to avoid npm auto-correct warnings during publish.

## 0.6.1 (2026-03-19)

### Added
- OpenClaw plugin package is now included in the npm tarball so npm installs carry the integration files as well as the CLI.

### Changed
- OpenClaw plugin now resolves Hippo from the active workspace instead of arbitrary process cwd, preserving the intended local `.hippo/` plus global `~/.hippo/` lookup model.
- OpenClaw plugin `autoLearn` and `autoSleep` config now map to real hook behavior, including failed-tool capture and session-end consolidation.
- Release metadata is aligned across package, MCP server, lockfile, and OpenClaw plugin manifests.

## 0.5.1 (2026-03-15)

### Added
- `hippo init` now auto-creates a daily cron job (6:15am) for `hippo learn --git --days 1 && hippo sleep`. Cross-platform: crontab on Linux/macOS, Task Scheduler on Windows. Use `--no-schedule` to skip.

## 0.5.0 (2026-03-15)

### Added
- Configurable `defaultHalfLifeDays` in `.hippo/config.json` (default: 7). Adjust for teams that code in bursts.
- Configurable `defaultBudget` (4000) and `defaultContextBudget` (3000) for recall and context commands.
- Auto-sleep: triggers `hippo sleep` after 50 new memories in 24 hours. Configure via `autoSleep.enabled` and `autoSleep.threshold`.
- Configurable `gitLearnPatterns` array for `hippo learn --git`. Default now includes: fix, revert, bug, error, hotfix, bugfix, refactor, perf, chore, breaking, deprecate.

### Changed
- Embeddings default to `"auto"`: uses `@xenova/transformers` if installed, falls back to BM25 silently.
- MCP server refactored to use programmatic API directly (no child process spawning). 10x faster tool calls.
- Git learn patterns broadened: now catches refactor, perf, chore, breaking, and deprecate commits in addition to fix/revert/bug.
- Default context budget raised from 1500 to 3000 for main sessions.

## 0.4.1 (2026-03-15)

### Added
- `hippo mcp` command: MCP server over stdio transport. Works with Cursor, Windsurf, Cline, Claude Desktop, and any MCP-compatible client.
- MCP server exposes 6 tools: hippo_recall, hippo_remember, hippo_outcome, hippo_context, hippo_status, hippo_learn.

## 0.4.0 (2026-03-15)

### Added
- `hippo init` auto-detects agent frameworks (Claude Code, Codex, Cursor, OpenClaw) and installs hooks automatically. Use `--no-hooks` to skip.
- `hippo learn --git --repos <paths>` scans multiple repos in one pass (comma-separated paths).
- Codex integration guide (`integrations/codex.md`).
- CHANGELOG.md with full version history.

### Changed
- README rewritten with auto-hook install docs, multi-repo learn section, and updated comparison table.
- PLAN.md updated with shipped feature status.
- All integration guides updated for auto-install workflow.

## 0.3.1 (2026-03-15)

### Added
- `hippo init` auto-detects agent frameworks (Claude Code, Codex, Cursor, OpenClaw) and installs hooks automatically. Use `--no-hooks` to skip.
- `hippo learn --git --repos <paths>` scans multiple repos in one pass (comma-separated paths).
- Codex integration guide (`integrations/codex.md`).

### Changed
- README rewritten with auto-hook install docs, multi-repo learn section, and updated comparison table.
- OpenClaw integration guide updated with auto-install instructions and multi-repo cron example.

## 0.3.0 (2026-03-13)

### Added
- Cross-tool import: `hippo import --chatgpt`, `--claude`, `--cursor`, `--markdown`, `--file`.
- Conversation capture: `hippo capture --stdin` / `--file` (pattern-based, no LLM).
- Confidence tiers: `--verified`, `--observed`, `--inferred`. Auto-stale after 30 days.
- Observation framing: `hippo context --framing observe|suggest|assert`.
- All import commands support `--dry-run`, `--global`, `--tag`.
- Duplicate detection on import.

## 0.2.0 (2026-03-10)

### Added
- `hippo learn --git` scans recent commits for fix/revert/bug lessons.
- `hippo watch "<command>"` auto-learns from command failures.
- `hippo context --auto` smart context injection (auto-detects task from git).
- `hippo embed` optional embedding support via `@xenova/transformers`.
- `hippo promote` and `hippo sync` for local/global memory management.
- Framework hooks: `hippo hook install claude-code|codex|cursor|openclaw`.

## 0.1.0 (2026-03-01)

### Added
- Core memory system: buffer, episodic, semantic stores.
- `hippo init`, `hippo remember`, `hippo recall`, `hippo sleep`.
- Decay by default (7-day half-life).
- Retrieval strengthening (+2 days per recall).
- Error tagging (2x half-life).
- Outcome feedback (`hippo outcome --good/--bad`).
- Token budgets on recall.
- BM25 search (zero dependencies).
- Markdown + YAML frontmatter storage.
- Global store support (`~/.hippo/`).
