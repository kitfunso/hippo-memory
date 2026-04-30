# Hippo Brain Observatory — Roadmap

## v0.26 — UI Redesign (warm parchment + 3D)

Redesign direction confirmed: warm parchment Field Notes aesthetic with 3D Three.js memory map. Mockup at `mockups/hybrid-v4.html`.

### Design Decisions (locked)
- Light theme: warm parchment #f4efe6, not dark mode
- Plain language: "strength" not "magnitude", "retrievals" not "observations"
- Typography: Georgia serif headers, Consolas mono for data
- Layer colors: buffer #7c6caf, episodic #c49a3c, semantic #5a8f6b
- Accent: terra cotta #c45c3c
- 3D map with orbit/zoom/drag (Three.js + OrbitControls)
- Field Notes sidebar with memory details, stats, decay curve, tags
- Bottom drawer memory list (sortable, click to fly camera)
- Hover preview in sidebar
- Selected memory label highlighted in map

### Background Effects
- Golden hour sky dome (shader-based gradient + procedural clouds)
- Living terrain (undulating brain-fold surface)
- Mycelium network (organic branching lines)
- Floating spores (ambient particles)
- Pulsing energy rings at layer boundaries
- Memory halos (BackSide glow spheres)

### TODO: Implement in actual UI
- [ ] Port hybrid-v4 mockup design to `ui/src/` React codebase
- [ ] Replace current dark Three.js scene with warm sky dome + terrain
- [ ] Update all component styles to parchment theme (header, sidebar, tooltips, search)
- [ ] Wire hover preview into sidebar (show memory on hover, full detail on click)
- [ ] Add selected/hovered label highlighting
- [ ] Update FilterPanel to parchment theme
- [ ] Update MemoryList drawer to parchment theme
- [ ] Update StatsPanel chips to parchment theme
- [ ] Test with real data from `hippo dashboard`

## v0.26 — Quality Audit (done)
- [x] `hippo audit` CLI command — scans for junk memories
- [x] `hippo audit --fix` — auto-removes error-severity issues
- [x] Sleep hook — auto-removes junk during consolidation
- [x] Capture parser tightened — rejects vague fragments
- [x] Content validation — minimum 3 chars at createMemory()

## v0.26 — Product Layer (done, needs theme update)
- [x] Project scope filtering (All / Global / per-project)
- [x] Filter panel (layers, strength range, confidence, valence, tags, at-risk)
- [x] Stats panel (health, at-risk, layer breakdown, conflicts)
- [x] Memory list drawer (sortable table, keyboard nav)
- [x] Detail panel with project badge, hidden path: tags, at-risk warning
- [x] Scene filtering (dim non-matching nodes)
- [x] Camera focus on list selection

## Future
- [ ] Search within 3D map (highlight matching nodes)
- [ ] Timeline view — memory creation/retrieval over time
- [ ] Health dashboard — decay forecasts, consolidation stats
- [ ] Memory playground — test recall queries live
- [ ] Export/share memory snapshots

---

## A3 follow-ups (post-review, deferred)

From `/review` on commits 41b1f4d..6456e7d (now hardened to 00764ce). Each item has a target track + revisit condition.

- [ ] **--scope CLI semantics.** `hippo remember --scope <v>` writes both the envelope `scope` column AND a `scope:<v>` tag. Recall's `--scope` filter currently matches the tag form. Decide: rename envelope flag to `--envelope-scope`, OR teach recall to filter the envelope column. Belongs in **A5** (auth/multi-tenancy) where scope semantics tighten. Until then, dual-write is documented in MEMORY_ENVELOPE.md.

- [ ] **Wire `hippo forget` for raw rows.** Today `hippo forget <raw-id>` aborts via the append-only trigger with no user-facing recovery. Add a `--archive --reason --owner` mode to `hippo forget` that routes through `archiveRawMemory`. Belongs in **A4** (lifecycle compliance). Until then, `--kind raw` is gated at the CLI so users can't create unforgettable rows.

- [ ] **--owner format validation.** Currently any string is accepted. The documented contract is `user:<id>` or `agent:<id>`. Add regex validation `^(user|agent):[A-Za-z0-9_-]+$` either as warn-only (log, accept) or strict-reject. Decide alongside A5.

- [ ] **Defensive `kind != 'archived'` filter on recall.** `kind='archived'` is a transient sentinel inside `archiveRawMemory`'s SAVEPOINT and never persists (SQLite atomicity). Adding the filter to candidate queries is belt-and-suspenders against a future bug. Cheap to add when revisiting recall query construction.

---

## A5 follow-ups (post-review, deferred to v2)

From `/review` on the A5 stub-auth branch (commits 4e7f8e9..fca9fa4, hardened
by post-review fixes 2db5017..38339f4). Each item belongs in **A5 v2**
(full multi-tenant) or **A6** (Postgres backend).

- [ ] **M2 — `auth create` and `auth list` are unauthenticated and unaudited.**
  Local FS access to the SQLite file is sufficient to mint or enumerate keys.
  Acceptable for stub auth (single-tenant, single-machine deployment), but the
  full A5 multi-tenant story needs a real authn boundary (operator API key
  or admin session) plus audit events on `auth_create` / `auth_list`.

- [ ] **M6 — Audit log unbounded growth.** No retention or rotation policy.
  Add a daily `audit prune` cron + `hippo audit prune --older-than 90d` CLI
  in v2. Mind regulatory retention floors (HIPAA, SOX, GDPR) — the prune
  should be opt-in per tenant and emit its own audit trail event.

- [ ] **M7 — `validateApiKey` timing on unknown key_id.** Constant-time scrypt
  comparison only fires when the row exists; an unknown `key_id` short-circuits
  before any hashing. Acceptable for the stub: the 24-char base32 keyspace is
  ~5e36, so timing-side enumeration is not a realistic threat. Document in
  `MEMORY_ENVELOPE.md` and revisit when keys are tenant-routed.

- [ ] **L2 — `promote` emits both `remember` and `promote` on global root.**
  Intentional: `writeEntry` always emits `remember` (the underlying upsert),
  and `cmdPromote` adds a `promote` event so the user-facing intent is visible.
  Side effect: `remember` event count overstates net new content by exactly the
  promotion count. Document in CHANGELOG when surfacing audit metrics.

- [ ] **L8 — `serializeEntry` omits `tenant_id` from frontmatter when value is
  `'default'`.** Manual markdown edits with an explicit `tenant_id:` line are
  honored on `rebuildIndex`. Side effect: hand-rolled markdown without the
  field defaults to `'default'` regardless of `HIPPO_TENANT`. Acceptable for
  single-tenant stub; revisit when tenants ship.

- [ ] **L9 — Background pipelines bypass tenant filter.** `consolidate.ts`,
  `embeddings.ts`, `invalidation.ts`, `refine-llm.ts`, `autolearn.ts`,
  `capture.ts`, `importers.ts`, and `shared.ts` (autoShare,
  syncGlobalToLocal, listPeers) all call `loadAllEntries(root)` with no
  tenant filter. Consistent with the v0.35.0 "single tenant per deployment"
  stub model, but a multi-tenant deployment running `hippo sleep` would
  decay/merge/dedupe across tenants. Cross-tenant isolation must be threaded
  through every background pass before flipping the deployment model. Track
  with the same v2 audit as M2.

---

## v0.39.0 — B3 dlPFC depth follow-ups

From the B3 dlPFC ship (v0.38.0). Deferred items that did not block the
cluster-discrimination receipt but are required for full coverage of the
mechanism on public benchmarks and across MCP/REST surfaces.

- [ ] **B3 follow-up: sequential-learning adapter contract.** Extend
  `benchmarks/sequential-learning/adapters/interface.mjs` with
  `pushGoal/completeGoal` hooks; demonstrate or honestly retire the −10pp
  trap-rate lift claim. Until this lands, the goal-stack mechanism cannot
  be exercised on the public sequential-learning benchmark.

- [ ] **B3 follow-up: MCP/REST session_id plumbing.** Thread `session_id`
  through `Context` so `recall(ctx, opts)` applies the goal-stack boost on
  MCP and `/v1/recall` callers, not just the CLI's env-driven path.

- [ ] **B3 follow-up: vlPFC interference handling.** Multi-goal interference
  suppression. RESEARCH.md folded this into dlPFC depth; v0.38 ships only
  the dlPFC half. v0.39 adds the inhibitory companion.

- [ ] **B3 follow-up: `--no-propagate` flag on `goal complete`.** For users
  who want to close a goal without strength side-effects on recalled
  memories. Default stays as propagate-on-complete with the lifespan window.

- [ ] **B3 v0.39 follow-up: factor `enforceDepthCap` helper to remove DRY
  duplication between `pushGoalWithDb` and `resumeGoal`.** Surfaced by
  plan-eng-review during v0.38 planning; accepted as a post-ship refactor
  rather than blocking the ship.

---

## v0.38.0 — E1.3 v2 follow-ups

From the E1.3 Slack ingestion ship (v0.37.0). Operator UX, eval polish, and
ranking improvements; none are correctness blockers.

- [ ] **DLQ replay command.** `hippo slack dlq retry <id>` to re-run a parked event after fixing the underlying parser. Today the DLQ is read-only via `hippo slack dlq list`.

- [ ] **Workspace registration CLI.** `hippo slack workspaces add --team <T> --tenant <t>`. Today the `slack_workspaces` table is populated via direct SQL, which is fine for single-machine deployments but awkward for multi-workspace operators.

- [ ] **Eval scoring by `artifact_ref`.** The 10-scenario incident-recall eval matches on a per-message sentinel today. For real-traffic evals we want to score on `artifact_ref` so the eval doesn't depend on synthetic tokens in content. Would need to extend `RecallResultItem` (or a second SQL round-trip).

- [ ] **Thread-aware ranking.** Treat `thread_ts` as a parent boost so replies surface their thread root in recall. V1 ranks each message independently.

- [ ] **Incremental real-time backfill.** Today `backfillChannel` drains the channel until exhaustion. For live workspaces add a "stop at cursor" mode so the loop terminates when it catches up to the live cursor instead of paginating to history start.

- [ ] **BM25 sentinel-token leakage in evals.** During E1.3 eval authoring, descriptive scenario IDs polluted the ambient noise messages and inflated recall scores. Opaque IDs (e.g. `S1A2B3`) work; document this in any future eval template so the next connector eval doesn't repeat the mistake.

- [ ] **Lockdown test misses `/mcp/stream`.** `tests/server-bearer-lockdown.test.ts` covers `/v1/memories`, `/v1/auth/keys`, `/v1/audit` but not `GET /mcp/stream`. Both routes call `requireAuth` with the same shape, so any future regression there won't fail the lockdown. Add `{ method: 'GET', path: '/mcp/stream' }` to `v1Routes` and assert 401 without Bearer when `HIPPO_REQUIRE_AUTH=1`. Surfaced by /review on the E1.3 branch.

- [ ] **DLQ-on-parse-failure tenant attribution.** When `JSON.parse(rawBody)` fails after a valid Slack signature, we cannot read `team_id` from un-parseable JSON, so the DLQ row lands under `process.env.HIPPO_TENANT ?? 'default'`. On multi-workspace deployments this means a parse failure from workspace A lands in the wrong tenant's DLQ. Document or revisit after multi-workspace adoption.

- [ ] **Audit emit ordering vs mirror write.** `writeEntry` releases the SAVEPOINT before writing the markdown mirror and emitting the audit row. If the mirror write throws (ENOSPC, EACCES), the memory row commits without an audit entry — `bootstrapLegacyStore` self-heals the orphan-row state, but the audit log is permanently missing the `remember` event. Fix: either move audit emit before the mirror write, or wrap mirror writes in try/catch that still emits audit. Surfaced by /review (MEDIUM).

- [ ] **`ingestMessage` skipped→duplicate status string.** Replay of an empty-body event returns `status: 'duplicate'` whereas the first call returned `status: 'skipped'`. Functionally idempotent (same memoryId of `null`), but the differing status strings could confuse a caller that switch/cases on the value. Either unify the status (always 'skipped' for empty bodies) or document the asymmetry.

- [ ] **Multi-workspace tenant-routing e2e test.** `tests/slack-tenant-routing.test.ts` covers the helper unit; no end-to-end webhook test populates `slack_workspaces` and asserts the resolved tenant lands on the memory row. Add one webhook test that mints a row in `slack_workspaces` and asserts the ingested memory's `tenant_id` matches.

---

## v0.40.0 — Security + hardening follow-ups

From the v0.39 security hardening release. Items consciously deferred so
v0.39 could ship the CRITICAL cross-tenant fixes without scope creep.

- [ ] **Tenant-guard audit on remaining MCP tools.** v0.39 hardened
  recall/remember/outcome/share via `src/api.ts`. The remaining MCP tools
  (context, status, learn, conflicts, resolve, peers) plus any unscoped
  `readEntry` / `loadSearchEntries` call sites in CLI / dashboard /
  refine still need a tenant-isolation pass.

- [ ] **Request-level rate limit on /v1/*.** The reduced auth-timing
  leak in v0.39 narrows but does not eliminate key-id enumeration.
  Bound enumeration attempts with a per-IP rate limit on /v1/* (token
  bucket, configurable via `HIPPO_V1_RPS`).

- [ ] **p99 hardening (long-term, no current target).** The v0.36 <50ms
  target was retracted in v0.39 (CHANGELOG). v0.36 ships at 58.4ms
  (sequential single-thread on a 10k store). No active target until a
  real user asks. When/if revived, server-mode concurrent measurement
  is the right baseline, not the current single-thread harness.

- [ ] **24h soak harness as a real release gate.** `benchmarks/a1/soak.ts`
  is scaffold-only in v0.39. Promote to a CI-integrated, evidence-bearing
  release gate (RSS / heap / FD / WAL drift bounds) before claiming
  "soak-tested" anywhere user-facing.

- [ ] **B3 dlPFC stretch items.**
  - Sequential-learning adapter contract (pushGoal/completeGoal hooks
    on `benchmarks/sequential-learning/adapters/interface.mjs`).
  - vlPFC interference suppression companion to dlPFC depth.
  - `--no-propagate` flag on `goal complete` (close without strength
    side-effects on recalled memories).
  - Refactor `enforceDepthCap` helper to remove duplication between
    `pushGoalWithDb` and `resumeGoal`.
  - `goal_recall_log` compaction policy (table grows unbounded today).
  - `paired_ab.py` for paired-comparison goal-stack evaluations.

---

## Long-term — no current target

- [ ] **A1 p99 latency hardening — current p99 = 58.42ms, retracted target.**
  Measured via `benchmarks/a1/p99-recall.ts` on a 10k synthetic store
  (1000 BM25 queries, cold cache, single SQLite connection, full HTTP
  round trip). p50 = 39.5ms / p95 = 54.9ms / p99 = 58.4ms / mean = 41.0ms.
  v0.39 retracted the <50ms target; the harness is sequential single-thread
  and not representative of server-mode concurrent load. Likely candidates
  if/when revived:
    1. FTS5 candidate load in `loadSearchEntries` — current path scans
       all rows then ranks; a tighter `MATCH` query plan + LIMIT inside
       the FTS subquery should shave the tail.
    2. JSON serialization of 10 results — `recall` walks each entry to
       compute token count; pre-compute or stream.
    3. Audit-emit roundtrip on every `recall` — opens + closes the DB to
       insert one row. Cache the prepared stmt against a long-lived
       handle, or batch via the same connection the recall already uses.
    4. Hybrid embeddings: ROADMAP pins "hybrid ON" but `src/api.ts:recall`
       is BM25-only today. Wiring hybrid will likely make p99 worse, not
       better — re-baseline after that lands.

---

## v0.37.0 — server hardening follow-ups

- [ ] **H1 — stale-pidfile + PID-reuse-with-different-port.** A
  detectServer caller can read a pidfile whose pid was reused by an
  unrelated process on a different port; current detection only checks
  pid liveness. Fix: round-trip the `started_at` value from `/health`
  against the pidfile's recorded server start so a reused pid with a
  fresh boot timestamp is treated as stale.

- [ ] **H2 — HIPPO_API_KEY silently dropped on fallback.** When the CLI
  thin-client cannot reach the server, it falls back to direct mode and
  silently ignores the configured api key. That's the right default for
  dev ergonomics but masks production misconfiguration. Add a
  `HIPPO_REQUIRE_SERVER` env knob: when set, the fallback is an error
  instead of a silent direct-mode call.

- [ ] **H3 — concurrent serve, no winner detection.** Two `hippo serve`
  invocations on the same hippoRoot race the listen() and overwrite
  each other's pidfile; the loser exits with EADDRINUSE but the winner
  may already have lost its pidfile entry. Call `detectServer` at boot
  and refuse to start if a live peer responds on the recorded port.

- [ ] **L3 — pidfile JSON has no schema version.** Adding a field today
  requires sniffing the shape. Add a `schema: 1` field so future
  pidfile readers can branch on a real version instead of `'startedAt'
  in payload` checks.

- [ ] **M3 — BodyTooLargeError mid-stream leaves the socket open.**
  When `readBody` aborts on the 1MB cap, the rest of the request body
  drains into the listener after the response is sent. Call
  `req.destroy()` on the BodyTooLargeError path so the socket closes
  cleanly instead of accepting another MB of bytes the server will
  immediately discard.
