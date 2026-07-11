# Hippo Brain Observatory — Roadmap

## Next 90 days (2026-05-23 →) — priority queue

Cross-referenced from `ROADMAP-RESEARCH.md` §"Next 90 days". The full execution roadmap (Tracks A-I, sequencing, bets, non-goals) lives there. This file owns the operational post-ship tail.

### Memory scope isolation (v39, merged dc7d3ba / PR #117) — post-ship tail

1. **CLI `hippo recall` private-scope residue — DONE v1.25.0** (`docs/plans/2026-07-04-scope-isolation-post-ship-tail.md`). `cmdRecall` + `cmdExplain` now load via `loadRecallSearchEntries` (SQL default-deny incl. a pre-window `:private:` exclusion — codex review P2: post-window-only JS filtering let private rows starve admitted candidates) + the canonical JS predicate. Explicit `--scope X` is an ADDITIVE unlock (default set + scope X), preserving the flag's tag-boost semantics (`tests/scope-boost.test.ts`); this partially resolves the A3 "--scope CLI semantics" open item for the recall side. `searchBothHybrid` gained the opt-in `recallScope` option for its internal loads. Tests: `tests/cli-recall-scope-deny.test.ts`.
2. **SleepResult secret-veto skip count — DONE v1.25.0.** `SleepResult.secretSkipped` counts shares the veto actually withheld (post score+dedupe gates); `renderSleepResult` prints the line; NOT redacted on egress (sibling of `shared` per the sleep-redact per-invocation class — it joins `shared` under the documented v1.11.4 SleepResult-aggregate posture below). Tests: `tests/api-sleep-secret-skip.test.ts` + secret-detect/sleep-redact/render-snapshot extensions.
3. **Dedicated HTTP/MCP isolation tests — DONE v1.25.0.** Surface-level origin-partition + `cross_project=1` + secret-veto cases at `tests/server-context-route.test.ts`; origin + secret cases at `tests/mcp-context-scope.test.ts`.

**New follow-ups from the v1.25.0 episode (review-stage advisories, none blocking):**
- **RESOLVED 2026-07-11 (v1.26.1, episode 01KX85KQ3799P7XG1QT9850RM7) - graph-hop scope parity.** `graphExpandRecall` now applies the recall scope rule to graph-reached memories via `recallScope?: { requested?, additive? }` (cloned from `searchBothHybrid`; fail-closed default for bare/SDK callers; CLI threads explicit `--scope` with additive unlock). Two corrections to this item as filed: (a) api.recall has NO hops path (comment only, api.ts:2733) - the surfaces are cli `--hops` + the public `index.ts` export; (b) `--graph-stream` was already covered BY DESIGN (re-rank-only within the caller's scope-filtered pool, never loads out-of-pool content) - now pinned by a non-vacuous regression test. Audit answer: no shipped write path produces a graph row referencing a scoped memory today (graph derives from the four E2 tables; mirrors carry scope NULL), but the store legally permits such rows (E3.3 guard checks kind, not scope), so the read-side predicate is defense-in-depth plus public-export correctness. Tests: `tests/graph-recall-scope.test.ts` (7 cases incl. red-on-master core, global-root, unlock composition) + the graph-stream pool-only pin.
- **Scope-aware graph traversal (v1.26.1 follow-up; GATED on E2 scope plumbing).** v1.26.1's emit-time scope predicate closes the content leak but leaves three traversal-level channels, all inert until a shipped write path can produce graph rows referencing scoped memories (none can today): (1) denied neighbours consume the `loadNeighborRelations` window + `--max-neighbors` frontier slots (admitted-neighbour starvation under saturated windows - codex P2, same class as the v1.25.0 SQL pre-window fix but requires per-hop memory-scope loads in the BFS); (2) traversal-through-denied-nodes reachability (public row behind a private stepping-stone still surfaces; content never leaks); (3) entity names derived from scoped objects visible to graph observability. Land all three together as one scope-aware-traversal pass WHEN E2 objects gain scopes (customer_notes is the likely first). See CHANGELOG 1.26.1 Known limitations.
- **`tests/server-concurrency.test.ts` parallel-load flake.** fetch failed / ECONNRESET only under full-suite parallel load on Windows (passes in isolation on base and branch, 3 full-suite runs each showed exactly this one failure). Serialize the file or retry-wrap its fetch loop.
- **Value-less `--scope` coercion polish.** A bare `--scope` (no value) coerces to the literal string 'true' and becomes a filter/unlock input; collapses safely to default-deny but should error like `--hops`' value-less guard does.
4. **One-time global-store secret audit — DONE (2026-07-02, v1.24.1).** Root cause found and fixed: the Claude Code memory importer (`learnFromMemoryMd`, cli.ts) ingested `~/.claude/projects/*/memory/*.md` with NO secret veto, so a credential-reference file was pulled into stores on `hippo sleep` — including the *rotated live* 2chain key, already ingested into clawd's store. Producer fix: the importer now runs `detectSecret` per file and skips secret-bearing ones (regression test `tests/importer-secret-veto.test.ts`). Audit: swept all 34 real project stores; scrubbed 16 key rows across 11 stores (14 pure `# 2chain prod API key` dumps + the dogfood + incident memories re-created scrubbed + 1 LIVE-key row in clawd), all removed by id via `api.forget`. Re-swept: 0 residue anywhere.
5. **S5 path-overlap tuning** (deferred by design from the v39 plan). `pathOverlapScore`'s memory-side normalization lives in generic search code shared with recall; isolate behind a helper and measure under the tier-1 micro-eval before changing behavior.

### New follow-ups from the F7 LoCoMo baseline episode (2026-07-05)

Surfaced while publishing the v1.25.0 LoCoMo baseline refresh
(`docs/plans/2026-07-05-f7-locomo-baseline-refresh.md`,
`benchmarks/LOCOMO_INVESTIGATION.md`). Neither blocked the baseline
publication. The first is a recall correctness item; the second was
reattributed and resolved the same day (harness bug, not hippo).

- **RESOLVED 2026-07-09 (v1.26.0, episode 01KX434KMAQSX4HRHYC67WDTJQ) -
  deterministic tie-breaking in recall ranking.** The filed candidate fix
  (content-hash at score ties) turned out to be DOWNSTREAM of the real
  dominant cause: embedding input text included auto `path:*` tags (store
  directory path), so every fresh benchmark run embedded different text for
  identical content. Fixed at the producer (`embeddingInputText` excludes
  `path:*`; stored index identity versioned `#t2` for a one-time reindex)
  PLUS the residual tie keys (leaf `src/compare.ts` comparators at
  first-ranking sorts; `content ASC, id ASC` SQL keys at window-deciding
  loaders; content tie key threaded into the physics cluster_top_k
  selection). Evidence: LoCoMo smoke x2 fresh runs 10/10 byte-identical
  top-5 (was stdev 0.0175); probe deltas 6.6e-2 -> 6.6e-8; micro 11/11.
  See `docs/plans/2026-07-09-recall-determinism.md` + CHANGELOG 1.26.0.
  Follow-ups filed below.
- **Follow-up (eval-gated): strip `path:*` tags from the lexical BM25/FTS
  corpus too.** codex review (v1.26.0 episode, round 2): stores whose
  directory paths differ in DEPTH still get different doc lengths in BM25
  normalization - a residual determinism gap for BM25-only ranking. Blocked
  on an eval because path tokens currently do real lexical work
  (project-name queries match `path:<project>` tags in the FTS index,
  db.ts fts5(id, content, tags)).
- **Follow-up: dedup survivor selection is per-instance nondeterministic.**
  `deduplicateStore` (src/dedupe.ts:41) sorts strength desc ->
  retrieval_count desc with no further key; freshly-ingested near-duplicates
  tie on both, so WHICH duplicate survives `hippo sleep` falls to random-id
  load order. Same class as the v1.26.0 fix but changes surviving CONTENT
  during consolidation - needs its own tests (independent-review finding,
  v1.26.0 episode).
- **RESOLVED 2026-07-05 (same day) — silent loss of user-supplied `--tag`
  values was a harness bug, not a hippo write-path bug.** The rows this
  bullet originally described (13 tagless rows in the LoCoMo v1.25.0 run)
  were caused by `benchmarks/locomo/run.py`'s `run_hippo` using
  `shell=(sys.platform == "win32")`: cmd.exe truncates the built command
  line at the first embedded newline, dropping every `--tag` argument on
  turns whose text ends with `"\n"`. Hippo's write path is exonerated (one
  writer of `tags_json`, unreachable ON CONFLICT branch, both import paths
  hard-gated, markdown mirror carries the same stripped tags). Fixed via
  `benchmarks/locomo/hippo_subproc.py` (never sets `shell=True`), wired into
  `run.py` and `audit_matched_stores.py`, with regression coverage in
  `benchmarks/locomo/test_hippo_subproc.py`. Full root-cause writeup:
  `benchmarks/LOCOMO_INVESTIGATION.md`, "Correction 2026-07-05". Published
  numbers unaffected (content-recovery fallback already absorbed the
  tag-less rows).

### E2/E3 graph track — SHIPPED v1.16.0 → v1.22.0 (2026-06-03)

The Company Brain object + graph layer shipped end-to-end:
- **All eight E2 first-class objects done.** decision (v1.15.0), prediction (v1.13.0), incident / process / policy / skill / project_brief / customer_note (all v1.16.0). `handoff` is the one remaining (session-scoped today; full promotion ~3d).
- **E3 graph layer.** extract + graph-on-consolidated guard + multi-hop `recall --hops` (v1.16.0); cross-object `references` edges (v1.17.0); **sleep enqueue-hook — graph auto-rebuilds during `hippo sleep`, no manual `graph extract`** (v1.19.0); observability + visualization (v1.20.0); graph-retrieval stream fused into RRF (v1.21.0, Track L1); entity/relation provenance anchored to the authoritative E2 object so an in-force object survives mirror decay/forget (v1.22.0, migration v38).

**Next (post-v1.22.0 queue):**
1. **Tenant-level graph-rebuild signal** (v1.22.0 follow-up). `graph_extraction_queue` is memory-keyed, so a whole-tenant re-derive (v38 cache drop on upgrade; mirrorless-object close) cannot be expressed — self-heals on the next memory-write, but a `graph_dirty_tenants` table / tenant-scoped queue entry makes it immediate. Coordinate with the v1.19.0 sleep-enqueue subsystem. See `docs/plans/2026-06-03-graph-e2-provenance.md`.
2. **Recall-surfacing of source-object-anchored entities** (v1.22.0 follow-up). v1.22.0 keeps the object in the graph; recall does not yet preferentially surface it. Self-contained.
3. **A7.2 — unify cli/api/mcp recall re-ranking pipelines** (v1.18.0 follow-up; ROADMAP-RESEARCH Deferred #4). Only `applyGoalStackBoost` is shared across the three surfaces today, so a recall ranks differently per surface. Hot-path refactor; needs its own plan + outside-voice.
4. **A5 v2 sub-2 — L9 background-pipeline tenant-scoping** (8 files). Long-standing; unblocked since the v1.12.0 Actor shape landed.
5. **Track L2 — sleep-built KV cartridge over the consolidated semantic layer** [research/spike]. Grant-relevant 5x-cost lever (ROADMAP.md WP1); gated on a pre-registered feasibility spike.
6. **Track K1 — markdown-vault + `[[wikilinks]]` importer** [next]. Single open-format adapter (Obsidian / Foam / Dendron subset).

Stale-branch note: `feat/e3-sleep-enqueue-hook` is now 8 commits behind master and its one feature commit already shipped as v1.19.0; the branch can be retired. Its plan doc still reads "Draft" (doc-hygiene only).

### v1.11.5 — SHIPPED 2026-05-23

7 of 8 items closed in v1.11.5 (see `CHANGELOG.md` v1.11.5 entry). Items #1, #2, #3, #4, #6, #7, #8 done. Item #5 (per-tenant /v1/sleep scoping) deferred to v1.12.0 because plan-eng-critic surfaced it as MINOR-scope structural work.

### v1.12.0 sub-1 — SHIPPED 2026-05-23 (PR #40)

A5 v2 auth/role plumbing: `Actor` interface promotion (`Context.actor: string` → `Actor` object), `api_keys.role` migration v26, `validateApiKey` returns role with fail-safe-to-member cast, admin-gate on `POST /v1/sleep` (403 for member). See CHANGELOG.md v1.12.0 entry. Sub-2 (L9 background pipelines tenant-scoping, 8 files) deferred and tracked below in the §"Conflict-subsystem tenant-isolation residue" item.

### v1.12.0 sub-2 / later — remaining items from v1.11.5 hardening pass

- [x] **Per-tenant `/v1/sleep` scoping** (item #5 from v1.11.5 plan). DONE in v1.12.0 sub-1 via admin-gate option (a): `POST /v1/sleep` now returns 403 for non-admin Bearer; loopback path stays open. `Context.actor` promoted to `{subject, role}` object across all 5 manifests, `api_keys` migration v26 added `role TEXT NOT NULL DEFAULT 'admin'`.
- [x] **`api.sleep` mid-phase failure test coverage.** SHIPPED v1.12.2 (PR pending) via `SleepOpts.__phases` test-only DI seam. 6 cases in `tests/api-sleep-phase-faults.test.ts` lock the `partial: true` + `errorMessage` audit row for faults at each of the 5 phase boundaries + happy path.
- [x] **Consolidate audit row tenant tag.** SHIPPED v1.12.10 — `api.sleep` tags the consolidate audit row with the synthetic `__host__` tenant (host-wide cross-tenant dedup is intentional); see `src/api.ts:2580`. Closed Independent-review-critic MED #3 from v1.11.5.
- [x] **Snapshot test belt-and-braces `afterAll(useRealTimers)`.** DONE 2026-05-24 — `afterAll(useRealTimers)` added to both describe blocks in `tests/cli-context-render-snapshot.test.ts` as defence-in-depth.
- [x] **`hippo auth create --role` CLI flag.** SHIPPED v1.12.3 — `--role admin|member` accepted (defaults to admin), invalid values exit 1. Mirrored on HTTP route via `body.role`. Tests in `tests/auth-role-cli-surfacing.test.ts`.
- [x] **`hippo auth list` role column.** SHIPPED v1.12.3 — `ApiKeyListItem.role` populated by extending the SELECT to read the column; CLI table header updated to `key_id  tenant  role  label  created  revoked`. Fail-safe-to-member cast on unrecognised values.

### Remaining post-Episode A/B/C tail (deferred items that don't fit v1.11.5 / v1.12.0)

All B-sized originally; bundle when needed.

- [x] **HTTP DoS cap on `POST /v1/outcome` `ids.length`** (1000 max). SHIPPED v1.11.5 — `src/server.ts:728` `throw new HttpError(400, 'ids exceeds 1000-id cap')`.
- [x] **HTTP DoS cap on `GET /v1/context?q=`** (1024 chars). SHIPPED v1.11.5 — `src/server.ts:754` `throw new HttpError(400, 'q exceeds 1024-character cap')`. Tests at `tests/server-context-route.test.ts:176, 184`.
- [x] **`/v1/context?q=foo` test gap**. SHIPPED v1.11.5 — `tests/server-context-route.test.ts:192` asserts exactly one recall audit row emitted per hybrid-search path.
- [x] **`/v1/sleep` non-loopback 403 test gap**. SHIPPED v1.11.5 — `isLoopback` helper extracted at `src/server.ts:243`, unit-tested in `tests/server-isloopback-helper.test.ts` (11 cases per v1.11.5 CHANGELOG entry).
- [x] **Per-tenant `/v1/sleep` scoping decision** (A follow-up). DONE v1.12.0 sub-1 via option (a) admin-gate. Non-admin Bearer → 403. Loopback path unchanged (defaults to admin).
- [x] **`audit_log` emission on sleep consolidation phases**. DONE-by-design v1.11.5 — option (a) chosen: one `'consolidate'` audit row per `api.sleep` invocation with phase counters in metadata (see `api.ts:2086-2100` finally block). v1.12.2 added DI-seam tests for the `partial:true` + `errorMessage` branch of this same row. Per-phase rows (option b) explicitly rejected for the 5× audit-log volume cost. Reproduce-checked 2026-05-24.
- [x] **`api.recall` last-retrieval-ids parity with `cmdRecall`**. DONE-by-design v1.11.5 — option (b) chosen: document the divergence permanently. Locked in 3 places: (1) `api.ts:412-421` JSDoc, (2) `tests/api-recall-no-side-effects.test.ts` runtime contract, (3) `python/README.md` Limitations. Adding the side-effect would break SDK consumers who batch recall calls (each call would overwrite the previous `last_retrieval_ids`). Reproduce-checked 2026-05-24 (mid-episode abort; 4th roadmap-sync gap of the session).
- [x] **CLI render snapshot tests** (`printContextMarkdown`, `renderSleepResult`). DONE-by-design v1.11.5 — `tests/cli-context-render-snapshot.test.ts` ships 12 cases against the renderer layer: 8 `printContextMarkdown` branches (markdown default + 3 framings + verified-only + empty + global-only + no-tags + many-tags) + 4 `renderSleepResult` branches (dry-run + full + minimal + audit-only). Determinism via `vi.useFakeTimers` + `afterAll(useRealTimers)` belt-and-braces. Snapshot file at `tests/__snapshots__/cli-context-render-snapshot.test.ts.snap` (109 lines). The originally-listed dispatch-level cases (pinnedOnly flag, json format, q='*' fallback, hybrid local/global mode) target `cmdContext`'s routing layer, not the renderer — separate task if revived (low priority — render layer is where byte-identical drift actually hides). Reproduce-checked 2026-05-24 (6th roadmap-sync gap of the v1.12.x sweep arc).

### ~~F9 hybrid retrieval~~ — DONE 2026-05-20 (PR #27)

See `docs/evals/2026-05-20-f9-hybrid-rrf-result.md`. Phase 1 oracle: best `turn_asym` R@5=82.0 (+3.0 over dense-only 79.0). Phase 2 `_s` Gate-B FAIL @ 97.7 (best `turn_sym` R@5=50.8 vs F14 baseline 41.0, +9.8 lift at zero LLM cost; ties F14+F9-Sonnet stack). HARD RETRACTION executed on artifacts per prereg. `src/rrf.ts` shipped. Follow-up candidates: F9+F13-stacked rerank on oracle (~+3pp), per-type-routed ensemble (~+4-5pp), F17 once egress opens.

### ~~Conflict-subsystem tenant-isolation residue~~ — SHIPPED v1.12.1 (2026-05-24) for the background-pipelines slice

The 8-file background-pipelines slice shipped as v1.12.1 (A5 v2 sub-2 — `feat/v1.12.1-l9-tenant-scoping`). `tenantId?: string` plumbed as optional through `invalidateMatching`, `RefineOptions`, `deduplicateLesson`, `CaptureOptions`, `ImportOptions`, `autoShare` options bag. 6 host-wide reader sites (consolidate, embeddings×2, shared.ts×3) documented with L9 JSDoc as intentionally cross-tenant. 13-case test file `tests/l9-tenant-scoping.test.ts`. See CHANGELOG.md v1.12.1 entry. RECONCILED 2026-05-29: the residual unscoped readers (cli.ts/dashboard.ts/dedupe.ts/memory.ts) are deferred-by-design under single-tenant-per-process + loopback trust (host-wide reads are correct for operator/maintenance commands); the stale cross-tenant conflict-row cleanup is ALREADY handled by `replaceDetectedConflicts` (store.ts:2148, sameTenant()+crossTenant auto-resolve). Revisit the readers only when non-loopback multi-tenant serving lands.

**Still deferred (not in the L9 brief):**
- `cli.ts` / `dashboard.ts` unscoped reader sites — single-tenant-per-process trust holds until non-loopback serving lands.
- `dedupe.ts` / `memory.ts` unscoped reader sites — separate audit pass.
- `replaceDetectedConflicts` stale cross-tenant rows lingering `status='open'` — auto-resolve in the detector's resolve-stale loop so they self-heal.

### ~~Python SDK v0.2~~ — SHIPPED 2026-05-24 (PyPI `hippo-memory-sdk@0.2.0`)

- [x] **Sync wrappers (`HippoSync`)**. SHIPPED — line-for-line mirror of `Hippo` using `httpx.Client`. Wire-compatible. 8 integration tests.
- [x] **`ContextEntry.projected()` helper**. SHIPPED — projects to CLI shape (id, score, strength, tags, confidence, content, global). 4 unit tests.
- [ ] **204 handling in `_request`** — deferred to v0.3 (current code paths return 200 always; tightening would be 14 method wrappers for a dead code path).
- [x] **`auth_create(role=)` parameter + `AuthCreated.role`/`AuthKey.role`** — BONUS in v0.2.0. Matches hippo-memory v1.12.3 server. Tests cover admin + member roles.
- [x] **Breaking model fix:** `AuthCreated.key` → `AuthCreated.plaintext`. v0.1 had a model bug never exercised by integration tests; v0.2 fixes it. Caught while writing sync test coverage.

### v0.26 UI redesign port — warm parchment + 3D (PARTIAL / DIVERGED, reconciled 2026-05-29)

Detail in §"v0.26 — UI Redesign (warm parchment + 3D)" below. STATUS (reconciled 2026-05-29): a UI revamp DID ship — the "Obsidian-inspired graph" series E1-E5 (v0.2.0-v0.2.5: color-by-tag, real edges, local graph, force-directed layout, per-project anchors) plus Header/Sidebar/FilterPanel/TagCloud + a11y (lighthouse 97). Parchment design tokens exist (`ui/src/tokens.ts`/`tokens.css`, `#f4efe6`) but components are NOT yet fully wired to them (only `SkipLink` consumes them). The specific hybrid-v4 mockup direction (warm-parchment Field Notes + 3D golden-hour sky dome / terrain / mycelium) was NOT pursued. OPEN DECISION: keep the hybrid-v4 3D-sky direction (re-port) or bless the shipped Obsidian-graph as the v0.26 outcome + finish wiring components to the parchment tokens. The `ui-revamp-e0..e5` branches are dead (57 behind master, unmergeable).

### B / C / E track depth items (deferred to days 91-180)

Research-not-enterprise items; re-prioritise only after items 1-5 above. B1 ACC EVC calibration, B3 dlPFC goal-stack depth (MVP+depth shipped, but research workload-validity gates returned mixed signals — see `docs/RETRACTION.md`), C3 Pineal ambient state vector. **E2 first-class objects COMPLETE (2026-06-03):** decision (v1.15.0), prediction (v1.13.0), incident / process / policy / skill / project_brief / customer_note (all v1.16.0); `handoff` remains session-scoped (the one open E2 item). The E3 graph layer shipped v1.16.0 → v1.22.0 — see the top-of-file §"E2/E3 graph track" entry.

### Engineering hygiene (release pipeline)

Cross-cutting tickets surfaced by the week-of-2026-05-21 retro. Small, automate-or-die scope.

- [x] **`prepublishOnly` version-disagreement check** (DONE v1.13.5 ship cycle, 2026-05-27). `scripts/check-manifest-versions.mjs` reads `package.json` version, asserts the 4 lockstep manifests (`package.json`, `openclaw.plugin.json`, `extensions/openclaw-plugin/package.json`, `extensions/openclaw-plugin/openclaw.plugin.json`) match. Wired into `prepublishOnly`. Allowlist-based to skip historical eval snapshots, independent subpackages (`ui/`, `extensions/claude-code-plugin/`).
- [x] **Em-dash guard for release notes** (DONE v1.13.5 ship cycle, 2026-05-27). `scripts/check-em-dashes-in-release-notes.mjs` scoped to the CHANGELOG section for the current `package.json` version. Wired into `prepublishOnly`. Historical entries not in scope. (Pivoted from "pre-commit hook" to "pre-publish hook" because hippo has no husky and a pre-publish gate catches what matters most.)
- [x] **Codex iteration-threshold heuristic** (DONE v1.13.5 ship cycle, 2026-05-27). Lives at `docs/release-policy.md` "Critic chain iteration threshold". Rule: two rounds of only-P2/LOW catches = ship with Known Limitations. Derived from observed convergence on J1/J3.2/J5.

---

## v1.11.4 (Episode B) — follow-ups for Episode C / future

Surfaced by independent-review-critic on PR #37 round 1 (returned FAIL on a cross-tenant ID leak in /v1/outcome which was fixed in the same PR; remaining MED + LOW deferred to TODOS):

- **`/v1/sleep` response shape leaks aggregate cross-tenant counts.** `SleepResult.deduped.crossDups` / `audit.errorsRemoved` / `audit.warningCount` / `ambient.totalMemories` etc. aggregate across ALL tenants in the hippoRoot. Today the loopback-only guard limits blast radius (only the host operator can read), but once non-loopback serving lands (TODOS "Episode A follow-ups" above), this response shape becomes a metadata leak path. Mitigation: scope api.sleep counters by ctx.tenantId before returning, OR redact aggregated counts to the caller's own tenant when non-admin.
- **`GET /v1/context?q=` is not length-capped.** Breaks the 256-char-cap convention established by `scope`, `session_id`, and `fresh_tail_session_id` on the adjacent GET /v1/memories route. Node's 16KB URL header is the de-facto bound but the structural drift makes future audits harder. Add a 1024-char cap on `q` (queries can legitimately be longer than 256 but should still bound).
- **`POST /v1/outcome` does not cap `ids.length`.** A caller could POST `{ids: [10000 ids], good: true}` (within the 1 MB body cap), spawning 10000 sequential `readEntry` + `writeEntry` + `appendAuditEvent` cycles in a single request. /v1/* rate limit is per-request, not per-id. Add a 1000-id cap (or similar) with a clear 400 error. Consistent with the adjacent routes' patterns; worth raising priority because /v1/outcome WRITES per id.
- **`/v1/context?q=foo` test gap.** Existing tests in server-context-route hit no-query default + pinned-only paths only. The hybrid-search path (`q` provided + hasGlobal) emits a 'recall' audit row per api.getContext; this emission is not asserted in any HTTP-level test. Add a test that seeds memories, calls `GET /v1/context?q=foo`, and asserts both the response shape and the `recall` audit_log row.
- **`/v1/sleep` non-loopback 403 test gap.** The 3-line per-request guard is exercised on every request but the negative case (non-loopback origin -> 403) is hard to simulate with vitest+`serve(port:0)` which binds 127.0.0.1. Options: (a) extract the guard logic into a small helper + unit-test the helper directly; (b) once `HIPPO_BIND_ALL` (or similar) env knob exists, spawn serve with a non-loopback bind and assert 403 from a fake-IP socket.

## v1.11.3 (Episode A) — follow-ups for Episode B / Episode C

Surfaced by independent-review-critic on PR #36 (`refactor/api-context-sleep-outcome`). All deferred deliberately — none block the v1.11.3 PATCH release but each should be addressed before the corresponding Episode B / Episode C work.

- **Episode B preflight: tenant scoping for `api.sleep`.** `api.sleep` invokes `deduplicateStore(ctx.hippoRoot)` and `deleteEntry(ctx.hippoRoot, ...)` without `ctx.tenantId` / `ctx.actor`. Matches CLI pre-refactor (operator-invoked, single-tenant assumption). Episode B HTTP `/v1/sleep` MUST either (a) gate the route to a global-admin actor / API-key role, or (b) plumb `ctx.tenantId` into `deduplicateStore` + `auditMemories` + `deleteEntry` so a tenant-A Bearer can't dedupe / delete tenant-B's rows. Likely (a) for simplicity; (b) only if multi-tenant per-tenant sleep is a real product requirement.
- **Episode B preflight: audit_log on consolidation phases.** `api.sleep`'s dedup / audit-delete phases emit no `audit_log` rows. Same CLI/MCP parity gap that T6 just fixed for `cmdOutcome`. Episode B should decide between (a) one `'consolidate'` audit row per `api.sleep` invocation with phase counters in metadata, or (b) per-phase rows (one per dedup deletion, one per audit-delete) tagged with `ctx.actor`. Either is correct; pick before exposing the route.
- ~~**CLI byte-identical regression coverage.**~~ DONE-by-design v1.11.5 — see "CLI render snapshot tests" entry above. 12 renderer-layer cases shipped at `tests/cli-context-render-snapshot.test.ts`. Reproduce-checked 2026-05-24.
- **Ambient block redundant DB load.** `cmdContext` calls `loadAllEntries` for the ambient summary after `api.getContext` already loaded the same entries internally. Pre-refactor was a single load. Optimisation: have `api.getContext` either return the loaded sets (extends ContextResult) or expose an `api.ambientFromEntries(entries)` helper so the CLI computes ambient from the same in-memory rows.
- **Episode C consideration: `ContextResult.entries` exposes full `MemoryEntry`.** `cmdContext`'s json format projects to `{id, score, strength, tags, confidence, content, global}`. Python SDK consumers reading the api directly will receive the full MemoryEntry surface (including `superseded_by`, `embeddings`, `goal_associations`, etc.). Either add a sibling `ContextResultEntryProjected` variant for SDK ergonomics, or document `MemoryEntry` as the stable shape.
- **`api.getContext` pinnedOnly hot-path optimisation (low priority).** pinnedOnly path runs every UserPromptSubmit and currently does `loadAllEntries(...).filter(e => e.pinned)`. A `loadPinnedEntries(hippoRoot, tenantId)` helper with a SQLite `WHERE pinned = 1` would short-circuit the full-scan + filter on stores with thousands of memories. Not a regression vs master; flagged for future indexing work.



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

- [x] **--owner format validation.** SHIPPED v1.12.6 — `OWNER_RE = /^(user|agent):[A-Za-z0-9_-]+$/` + `validateOwner(owner, {strict})` helper at `src/owner-validation.ts`. Wired into both `cmdRemember` direct path (`cli.ts:677`) and the thin-client HTTP fallback (`cli.ts:5680`). WARN-ONLY by default (back-compat for existing scripted callers); strict via `HIPPO_STRICT_OWNER=1` env var. Strict will become default once A5 v2 lands. Scope correction from 2026-05-22 TODO: the "Slack backfill" reference was wrong — Slack backfill derives owner from Slack user_id in `messageToRememberOpts` (no CLI flag). Both `--owner` call sites are `hippo remember` paths. 28 unit tests at `tests/owner-validation.test.ts`.

- [x] **Defensive `kind != 'archived'` filter on recall.** SHIPPED v1.12.6 — `archivedClauseAlias` / `archivedClauseNoAlias` / `archivedClauseTenantOnly` added to all 4 candidate-loading paths in `loadSearchRows` (`src/store.ts`): empty-terms full-scan, FTS path, LIKE fallback, full-store fallback. Belt-and-suspenders against (a) future bugs that drop the SAVEPOINT wrapping in `archiveRawMemory`, (b) future bugs that introduce kind='archived' as a persisted state, (c) external direct-SQL writes that bypass `archiveRawMemory`. 4 tests at `tests/store-recall-archived-filter.test.ts` covering all 4 paths via a SAVEPOINT-bypass simulation.

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

- [x] **M6 — Audit log unbounded growth.** SHIPPED v1.12.9 — `hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>] [--json]`. Per-tenant by default (matches audit CLI conventions). Emits an `audit_prune` event with metadata `{cutoff, count, dryRun, olderThanDays}` after each prune so the maintenance op is itself recorded in the audit trail (regulatory floor friendly). `src/audit-prune.ts` with 23 unit + 8 CLI tests. Daily cron deferred — operators can wrap the CLI in cron/systemd/scheduler of their choice.

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
  with the same v2 audit as M2. (Dependent site: `refine-llm.ts:151`'s
  per-parent `readEntry` was deferred from the v1.11.0 tenant-isolation
  residue episode (01KS8W156) because half-scoping it without first scoping
  the upstream `loadAllEntries(hippoRoot)` on line 130 would silently drop
  parent text; lands together with this L9 work.)

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

- [x] **Sequential-learning C2 lateMean regression: 0.25 (v1.7.7) → 0.11 (v1.12.6).**
  RETRACTED 2026-05-24 13:50 — apples-to-oranges comparison error. The v1.8
  baseline JSON had `restrict_late_to: 4` at the top level; my initial dry-run
  used the default chronological-third split. Two different metrics. Re-run
  with `--restrict-late-to 4` on master v1.12.6 produces lateMean=0.25 across
  3 seeds, identical to v1.8 baseline. **No regression.** See
  `docs/evals/2026-05-24-card4-dryrun.md` "What went wrong" postmortem for
  the workload-config-comparison lesson learned. Card 4 pre-reg lock
  unblocked.

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

- [x] **Workspace registration CLI.** SHIPPED 2026-05-24 — `hippo slack workspaces <add|list|remove>`. `add --team <T> --tenant <t>` upserts on team_id conflict (operators move workspaces between tenants). `list` returns tab-separated rows sorted by team_id. `remove --team <T>` reports not-found on miss. Helper module at `src/connectors/slack/workspaces.ts`; 7 unit + 10 CLI tests at `tests/slack-workspaces.test.ts` + `tests/slack-workspaces-cli.test.ts`.

- [ ] **Eval scoring by `artifact_ref`.** The 10-scenario incident-recall eval matches on a per-message sentinel today. For real-traffic evals we want to score on `artifact_ref` so the eval doesn't depend on synthetic tokens in content. Would need to extend `RecallResultItem` (or a second SQL round-trip).

- [ ] **Thread-aware ranking.** Treat `thread_ts` as a parent boost so replies surface their thread root in recall. V1 ranks each message independently.

- [ ] **Incremental real-time backfill.** Today `backfillChannel` drains the channel until exhaustion. For live workspaces add a "stop at cursor" mode so the loop terminates when it catches up to the live cursor instead of paginating to history start.

- [x] **BM25 sentinel-token leakage in evals.** SHIPPED v1.12.6 — `docs/evals/AUTHORING.md` documents the lesson (descriptive scenario IDs leak into ambient noise via shared tokens, inflating BM25 recall scores) + pre-commit checklist (list every shared string between signal/noise fixtures, confirm it's intentional signal or opaque enough not to bias scoring, run noise-only baseline). Also documents 3 other eval-authoring lessons: pre-registration discipline (v1.8.1 rule), multi-seed harnesses + paired-comparison statistics, workload-validity gate before mechanism gate. Template at end of doc.

- [x] **Lockdown test misses `/mcp/stream`.** Already covered: `tests/server-bearer-lockdown.test.ts:49` includes `{ method: 'GET', path: '/mcp/stream' }` in its authed-routes array, exercised by both the missing-header and bad-token `it.each` blocks asserting 401 under `HIPPO_REQUIRE_AUTH=1`. Verified present 2026-05-22 during the roadmap reproduce-check sweep; the box was simply never ticked.

- [x] **DLQ-on-parse-failure tenant attribution.** SHIPPED v1.12.6 (promoted from doc-only to root-cause code fix). `server.ts:1008` JSON.parse-catch path now uses the regex-extracted `teamIdFromRaw` + `resolveTenantForTeam` (the same helper the happy path uses) instead of `process.env.HIPPO_TENANT`. Workspace A parse failures now land in workspace A's tenant DLQ. Unknown / un-extractable team → null → `'__unroutable__'` sentinel (matches the existing unroutable bucket convention). 4 HTTP integration tests at `tests/slack-webhook-parse-failure-tenant.test.ts`: known team routes correctly, unknown team → unroutable, garbage body → unroutable, single-workspace install preserves env-fallback ergonomics.

- [x] **Audit emit ordering vs mirror write.** Already fixed in v0.39 (commit `39bbee6`, "security hardening + GDPR Path A"): that release split the `writeEntry` monolith into `writeEntryDbOnly` + `writeEntryMirrors`, and `writeEntryDbOnly` emits the `audit('remember', ...)` row INSIDE the `write_entry` SAVEPOINT (`store.ts:1165`), committed atomically with the memory row before `writeEntryMirrors` runs. A markdown-mirror failure (ENOSPC, EACCES) is post-RELEASE and cannot lose the audit event. The `/review` that flagged this ran on the pre-v0.37 E1.3 branch when `writeEntry` was still a monolith; the box was simply never ticked. Verified stale 2026-05-22 via /dev-framework-rl episode 01KS7FRH40M69DBESH8CG75TX4.

- [x] **`ingestMessage` skipped→duplicate status string.** SHIPPED v1.12.6 — option (a) chosen (unify), not (b) document. `src/connectors/slack/ingest.ts:50` now returns `status: 'skipped'` (not `'duplicate'`) when `lookupMemoryByEvent` returns null on a hasSeenEvent hit (the cached memory_id IS NULL discriminator). Non-null cached memory_id still returns `'duplicate'` (an actual memory was written before). Existing `tests/slack-ingest.test.ts:46` updated to assert the new contract; 3 new cases at `tests/slack-ingest-empty-body-replay.test.ts` cover first-call/replay/real-content paths.

- [x] **Multi-workspace tenant-routing e2e test.** SHIPPED v1.12.8 — `tests/slack-webhook-multi-workspace-tenant.test.ts` (4 cases): registered team → memory in mapped tenant; two-workspace isolation (no cross-tenant leak); foreign team fail-closed (no HIPPO_TENANT leak); single-workspace install env-fallback preserved. Closes the gap left after v1.12.5 (workspaces CLI) + v1.12.6 B4 (parse-failure tenant attribution).

---

## v0.40.0 — Security + hardening follow-ups

From the v0.39 security hardening release. Items consciously deferred so
v0.39 could ship the CRITICAL cross-tenant fixes without scope creep.

- [x] **Tenant-guard audit on remaining MCP tools.** Audited in v0.40
  (dev-framework-rl episode 01KS7HH20Y6SE3T898P3AE8CPM). Of the six tools,
  `context`/`status`/`learn` were already tenant-scoped; `hippo_conflicts` and
  `hippo_resolve` (and `hippo_status`'s conflict count) were not, and are fixed
  in v1.11.0 — the conflict subsystem,
  `docs/plans/2026-05-22-conflict-tenant-isolation.md`; `hippo_peers` reads the
  cross-project global store by design. Residual work is split to the
  follow-up below.

- [ ] **Tenant-isolation residue from the v1.11.0 conflict-subsystem pass.**
  (a) Audit and tenant-scope the unscoped `readEntry` / `loadSearchEntries`
  call sites in `cli.ts` / `dashboard.ts` / `refine-llm.ts` (lower severity:
  CLI direct mode is single-tenant per process). (b) `replaceDetectedConflicts`
  skips a stale pre-fix cross-tenant conflict row but never resolves it, so it
  lingers `status='open'` (inert: hidden from scoped reads and the refMap
  rebuild). Auto-resolve such rows in the detector's resolve-stale loop so they
  self-heal — flagged by the v1.11.0 independent-review critic. (c) Confirm
  `hippo_peers`' intentionally cross-project read is the right trust boundary
  when multi-tenancy ships (A5 v2).

- [x] **Request-level rate limit on /v1/*.** Shipped in v1.11.0
  (`docs/plans/2026-05-22-v1-rate-limit.md`): a token-bucket limiter
  (`src/rate-limit.ts`) built in `serve()` from `HIPPO_V1_RPS` (default 20
  rps, burst 2x; a non-positive value disables it), checked in
  `handleRequest` for `/v1/` paths, 429 on exhaustion. Note: under
  loopback-only serving the per-IP key is effectively one global bucket;
  true per-client keying with a trusted `X-Forwarded-For` belongs with the
  A5 v2 non-loopback serving work.

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

- [x] **Migration v16 partial-apply self-heal.** SHIPPED v1.12.7 — migration
  v27 re-asserts the v16 schema (`api_keys` + `audit_log` + indexes,
  CREATE IF NOT EXISTS). Idempotent, zero cost for healthy DBs, fixes any
  DB in the partial state on next open. v26's ALTER also got a
  defensive `tableExists` guard so it can't crash on the partial state
  before v27 can heal. 5 tests at `tests/db-migration-v27-self-heal.test.ts`.

  **Correction to the original 2026-05-24 TODO entry** (which proposed
  wrapping each migration in BEGIN/COMMIT as the root-cause fix): the
  runner has ALWAYS wrapped each migration in BEGIN/COMMIT (since the
  first SQLite commit `2cf72e7`). So atomicity was NOT the bug.
  Possible causes of the observed partial state: (1) `DROP TABLE
  api_keys` issued post-migration (operator action or external SQL),
  (2) restore / import from a pre-v16 backup over a v16+
  schema_version, (3) some edge case the wrapping doesn't catch. Cause
  unknown without forensic logs. The v27 self-heal fixes the symptom
  for all paths.

- [ ] **Migration robustness: investigate why v16 partial-applied at all.**
  The BEGIN/COMMIT wrapping is intact since `2cf72e7`. SQLite DDL inside
  a transaction should be atomic. The partial state on Keith's
  ~/.hippo/hippo.db suggests EITHER (a) the bug exists in some
  SQLite/Node-SQLite edge case we don't understand, OR (b) the partial
  state was induced post-migration (DROP TABLE / restore / import).
  Defense-in-depth options if (a): add a post-migration validation
  step that checks expected tables exist for the current
  schema_version, log a warning + auto-heal if anything's missing.
  This would catch future cases where someone drops a table or
  restores from a stale backup. Low priority since v27 already
  self-heals the known broken table-pair; revisit if a different
  partial-apply surfaces.
