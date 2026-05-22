# Hippo Brain Observatory — Roadmap

## v1.7.3 — review-tail from v1.7.2 (SHIPPED 2026-05-07)

All four items closed in v1.7.3. See `docs/plans/2026-05-06-v1.7.3-review-tail.md` and CHANGELOG.

- [x] Module-load assertion runtime test for `RECALL_DEFAULT_DENY_SCOPES` (codex P1-3) — `assertNonEmpty` helper extracted, 3 cases in `tests/store-assert-non-empty.test.ts`.
- [x] `summarize_overflow=0` (false path) thin-client test (codex P2-3) — pin added; serialization was already correct.
- [x] `RecallScopeFilter` parameter naming polish — renamed `recallScope` → `scopeFilter` in `loadSearchRows`.
- [x] README "What's new" backfill for v1.6.5 + v1.7.0 — both sections present in chronological order.

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

- [x] **Wire `hippo forget` for raw rows.** Shipped 2026-05-21 (`docs/plans/2026-05-21-server-lifecycle-hardening.md`, item A3): `hippo forget <id> --archive --reason "<why>"` routes through `api.archiveRaw`, and the non-archive path now distinguishes the append-only abort from a true not-found. Per eng-review decision D1, no `--owner` flag; the envelope owner is a separate A3 concern.

- [ ] **`hippo forget --archive` HTTP route.** `--archive` always takes the direct path (`cmdForget` → `api.archiveRaw`): the `forget` dispatch skips server routing for archive requests, since the HTTP `forget` route does not carry `--archive`. Correct and WAL-safe, but archive is the one `forget` path that does not route through a running server. If strict single-writer routing matters, extend the HTTP `forget` route + `client.forget` to carry the archive intent. Low priority. Noted 2026-05-21.

- [ ] **--owner format validation.** Currently any string is accepted. The documented contract is `user:<id>` or `agent:<id>`. Add regex validation `^(user|agent):[A-Za-z0-9_-]+$` either as warn-only (log, accept) or strict-reject. Decide alongside A5. (Scope note 2026-05-22: `--owner` is parsed by `hippo remember` (`cmdRemember`, `cli.ts:654`) and the Slack backfill path (`cli.ts:5726`), NOT `hippo forget`; `cmdForget` has no `--owner` flag. Target those two call sites.)

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

From the B3 dlPFC ship (v0.38.0). 3 of 5 items closed in v1.7.4 (2026-05-07); contract+harness for the 4th closed in v1.7.5 (2026-05-07) but the eval was inconclusive. v1.7.6 (2026-05-09) tested the budget-reduction workload knob and confirmed it is not discriminating. 1 item remains for v1.8.0 (vlPFC) plus a v1.7.7 followup for the next workload knob.

- [x] **B3 follow-up: sequential-learning adapter contract.** Shipped v1.7.5.
  `pushGoal`/`completeGoal` hooks on `interface.mjs`; `hippo.mjs` implements
  both with `HIPPO_HOME`/`XDG_DATA_HOME` isolation; tag-fix on memory store
  (`[task.trapCategory, ...category.tags, 'error']`); multi-seed harness
  (`--seed`, `--n-seeds`, `--eval-strict`); `aggregate.mjs` with paired
  permutation CI. The mechanism is now exercisable on the public benchmark.

- [x] **B3 follow-up: budget-reduction workload knob (v1.7.6 calibration).**
  Shipped v1.7.6. `--budget` plumbed through `run.mjs` → `adapter.recall(query, budget)`;
  `calibrate.mjs` with mechanical `selectBStar` rule. Calibration sweep
  (5 budgets × 10 seeds) confirmed budget reduction does NOT produce a
  discriminating workload — `phases.late = 0.0` on every run. B* = NULL.
  Hypothesis still untested. Bug-fix on starvation guard (read non-existent
  JSON field) shipped alongside. See `docs/evals/2026-05-09-v1.7.6-calibration-result.md`.

- [x] **B3 follow-up: −10pp goal-stack lift magnitude RETRACTED v1.7.9.**
  Cumulative evidence across three pre-registered workload variants:
  v1.7.5 SANITY_FAIL on full-late (last 7), v1.7.6 B\*=NULL across 5
  budgets × 10 seeds, v1.7.7 SANITY_FAIL on `--restrict-late-to 4`
  (last 4 of 25). Every C2 hippo-base late mean returned 0% across every
  seed. v1.7.9 retracts on cumulative evidence rather than waiting for
  v1.8 — the v1.7.7 prereg's SANITY_FAIL ≠ NOT_SUPPORTED distinction
  was wrong. Mechanism (`pushGoal`/`completeGoal`,
  `--use-goal-stack`, `applyGoalStackBoost`) remains shipped from v1.7.4.
  See `CHANGELOG.md` v1.7.9 entry,
  `docs/evals/2026-05-09-v1.7.9-retraction-inventory.md`,
  and `docs/RETRACTION.md`.

- [x] **B3 follow-up: adversarial trap categories — v1.8.0 SHIPPED.**
  Workload-validity verdict: PASS (C2 lateMean=0.25, 20/20 seeds non-zero).
  Mechanism characterisation (sign-only): C3 = C2 on all 20 seeds
  (0/0/20 STRICTLY_LOWER/STRICTLY_HIGHER/TIED). Hook failures: 0/0.
  The goal-stack mechanism does not detectably change per-seed late-4
  lattice rate on this workload. **This release does not re-assert
  the retracted −10pp magnitude.** Per `docs/RETRACTION.md`, mechanism
  remains shipped; no magnitude is currently claimed. See
  `CHANGELOG.md` v1.8.0 entry and
  `docs/evals/2026-05-09-v1.8.0-adversarial-eval-result.md`.

- [x] **B3 follow-up: v1.9 LongMemEval cross-validation pre-commitment RETRACTED v1.8.1.**
  Outside-voice review on two v1.9 plan iterations (v1 + v2) identified six
  structural barriers preventing the goal-stack mechanism from firing on the
  LongMemEval corpus + canonical harness as shipped: (1) `retrieve_inprocess.mjs`
  calls `hybridSearch` (no boost); (2) ingest tags = session_id + date only
  (no content-derived stems for exact-equality match); (3) `pushGoal` API field
  is `goalName` not `tag`; (4) `MAX_ACTIVE_GOAL_DEPTH=3` suspends first stem
  with top-3 push; (5) cumulative-null trigger AND clause unreachable;
  (6) workload-validity gate ceremonial. Three options (re-ingest, harness
  rewrite, retract); option C chosen per `CLAUDE.md` "Root Cause Over Patches"
  + v1.7.9 pre-emptive retraction precedent. **The dlPFC goal-stack mechanism
  CODE remains shipped from v1.7.4.** No new eval pre-commitment in v1.8.1.
  See `CHANGELOG.md` v1.8.1 entry, `docs/RETRACTION.md` "v1.9 pre-commitment
  retraction" + "Mechanism-effect status" subsections, and
  `docs/evals/2026-05-09-v1.9-pre-commitment-retraction.md`.

- [ ] **Future eval direction (TBD; pre-registered under new discipline rule).**
  Per `docs/RETRACTION.md` "Pre-registration discipline rule" added v1.8.1:
  no pre-commitment is binding without (a) source-read of code paths the
  design depends on, AND (b) a 1-question dry-run confirming the mechanism
  FIRES before pre-reg locks. Candidate workloads where the goal-stack
  mechanism is more likely to be testable: synthesised multi-turn
  conversation eval with explicit per-conversation topic goals;
  mechanism-removal A/B telemetry in dogfood usage; infrastructure-only
  release with no eval. None pre-committed by this TODOS entry.

- [ ] **Re-enable starvation guard in `calibrate.mjs` with correct schema** → **v1.7.7+**.
  v1.7.6 dropped the broken `j.conditions[cn].results[]` extraction (run.mjs::buildOutput
  doesn't serialize per-task results in single-seed JSON). Either expose per-task
  results from `buildOutput` or rewrite the guard against multi-seed `seeds[].phases`.

- [x] **B3 follow-up: MCP/REST session_id plumbing.** Shipped v1.7.4 as
  `RecallOpts.sessionId` + `RecallOpts.goalTag`. Wired into `api.recall`
  (primary BM25 band, single db handle, before fresh-tail / summary
  appendix) AND MCP `hippo_recall`'s separate `physicsSearch`/`hybridSearch`
  path. HTTP `/v1/memories?session_id=...` query param added. Lives on
  `RecallOpts` not `Context` (codex finding: Context shared across all api
  ops; goal-stack boost is recall-scoped only).

- [ ] **B3 follow-up: vlPFC interference handling** → **v1.8.0**. Multi-goal
  interference suppression. RESEARCH.md folded this into dlPFC depth; v0.38
  ships only the dlPFC half. v1.8.0 adds the inhibitory companion. Real
  feature work — own plan + outside voice.

- [x] **B3 follow-up: `--no-propagate` flag on `goal complete`.** Shipped
  v1.7.4. CLI flag + `CompleteGoalOpts.noPropagate?: boolean`. Default
  unchanged (propagate). Status-check idempotency unaffected: a second call
  after a propagating first call is a true no-op regardless of `noPropagate`.

- [x] **B3 v0.39 follow-up: factor `enforceDepthCapWithinTx` helper to
  remove DRY duplication between `pushGoalWithDb` and `resumeGoal`.**
  Shipped v1.7.4. Renamed from `enforceDepthCap` per outside-voice review:
  the explicit `WithinTx` suffix makes the transactional precondition
  impossible to misread at a call site. Helper docstring documents that
  caller MUST already be inside `BEGIN IMMEDIATE`.

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

- [x] **Lockdown test misses `/mcp/stream`.** Already covered: `tests/server-bearer-lockdown.test.ts:49` includes `{ method: 'GET', path: '/mcp/stream' }` in its authed-routes array, exercised by both the missing-header and bad-token `it.each` blocks asserting 401 under `HIPPO_REQUIRE_AUTH=1`. Verified present 2026-05-22 during the roadmap reproduce-check sweep; the box was simply never ticked.

- [ ] **DLQ-on-parse-failure tenant attribution.** When `JSON.parse(rawBody)` fails after a valid Slack signature, we cannot read `team_id` from un-parseable JSON, so the DLQ row lands under `process.env.HIPPO_TENANT ?? 'default'`. On multi-workspace deployments this means a parse failure from workspace A lands in the wrong tenant's DLQ. Document or revisit after multi-workspace adoption.

- [x] **Audit emit ordering vs mirror write.** Already fixed in v0.39 (commit `39bbee6`, "security hardening + GDPR Path A"): that release split the `writeEntry` monolith into `writeEntryDbOnly` + `writeEntryMirrors`, and `writeEntryDbOnly` emits the `audit('remember', ...)` row INSIDE the `write_entry` SAVEPOINT (`store.ts:1165`), committed atomically with the memory row before `writeEntryMirrors` runs. A markdown-mirror failure (ENOSPC, EACCES) is post-RELEASE and cannot lose the audit event. The `/review` that flagged this ran on the pre-v0.37 E1.3 branch when `writeEntry` was still a monolith; the box was simply never ticked. Verified stale 2026-05-22 via /dev-framework-rl episode 01KS7FRH40M69DBESH8CG75TX4.

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

- [x] **H1 — stale-pidfile + PID-reuse-with-different-port.** A
  detectServer caller can read a pidfile whose pid was reused by an
  unrelated process on a different port; current detection only checks
  pid liveness. Fix: round-trip the `started_at` value from `/health`
  against the pidfile's recorded server start so a reused pid with a
  fresh boot timestamp is treated as stale.

- [x] **H2 — HIPPO_API_KEY silently dropped on fallback.** When the CLI
  thin-client cannot reach the server, it falls back to direct mode and
  silently ignores the configured api key. That's the right default for
  dev ergonomics but masks production misconfiguration. Add a
  `HIPPO_REQUIRE_SERVER` env knob: when set, the fallback is an error
  instead of a silent direct-mode call.

- [x] **H3 — concurrent serve, no winner detection.** Two `hippo serve`
  invocations on the same hippoRoot race the listen() and overwrite
  each other's pidfile; the loser exits with EADDRINUSE but the winner
  may already have lost its pidfile entry. Call `detectServer` at boot
  and refuse to start if a live peer responds on the recorded port.

- [x] **L3 — pidfile JSON has no schema version.** Adding a field today
  requires sniffing the shape. Add a `schema: 1` field so future
  pidfile readers can branch on a real version instead of `'startedAt'
  in payload` checks.

- [x] **M3 — BodyTooLargeError mid-stream leaves the socket open.**
  When `readBody` aborts on the 1MB cap, the rest of the request body
  drains into the listener after the response is sent. Call
  `req.destroy()` on the BodyTooLargeError path so the socket closes
  cleanly instead of accepting another MB of bytes the server will
  immediately discard.

- [x] **`stop()` can unlink a newer server's pidfile.** Shipped 2026-05-21 in
  v1.10.1 (`docs/plans/2026-05-21-stop-pidfile-ownership.md`). `serve()`'s
  `stop()` and the `cli.ts` stale-pidfile self-heal both called `removePidfile`
  unconditionally; the new `removePidfileIfOwned` (`src/server-detect.ts`)
  unlinks the pidfile only when its recorded `pid` + `started_at` match the
  caller, and both call sites are rewired to it. A residual microsecond
  read-to-unlink window is documented and accepted, consistent with
  `detectServer`.

- [ ] **Version-parity guard across all manifests.** The v1.10.1 release found
  `src/version.ts` `PACKAGE_VERSION` stranded at `1.8.1` and the
  `extensions/openclaw-plugin` manifests at `1.9.3`: v1.9.x and v1.10.0 bumped
  only some version fields. `tests/openclaw-package.test.ts` checks the root
  `openclaw.plugin.json` against `package.json` only. Add a test or
  release-script check asserting `package.json`, `openclaw.plugin.json`,
  `src/version.ts`, and both `extensions/openclaw-plugin` manifests all carry
  the same version, so the drift cannot recur. All five were synced to
  `1.10.1` in that release.
