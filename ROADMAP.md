# Hippo Roadmap

> Consolidated 2026-06-09. This single file merges the two former roadmap documents with no content removed:
>
> - **Part I (Grant-Tied Deliverables)** is the former `ROADMAP.md`: work organized by funding status (committed, grant-conditional, speculative) plus the grant work packages (Frontier AI Discovery, AI Champions Phase 1).
> - **Part II (Canonical Execution Roadmap)** is the former `ROADMAP-RESEARCH.md`: the engineering execution plan (Tracks A-F, north star, benchmark priority, schema-migration order, test commitments, bets, non-goals).
>
> `PLAN.md` remains the architecture and CLS-principles document. `RESEARCH.md` remains the research lineage and seven-mechanisms backgrounder.

---

## Part I - Grant-Tied Deliverables (formerly ROADMAP.md)

# Hippo Roadmap

This roadmap tracks planned work for the hippo-memory codebase. Items are grouped by funding status: committed, conditional on grant award, and speculative.

Current version: 1.28.0 (npm `hippo-memory`) + python-v0.3.0 (PyPI `hippo-memory-sdk`)

For non-grant execution status (Tracks A-I, sequencing, shipped items, bets, non-goals) see **Part II** below (formerly `ROADMAP-RESEARCH.md`). For operational follow-ups and per-version post-ship tails see `TODOS.md`. For the research lineage and seven-mechanisms backgrounder see `RESEARCH.md`.

## How to read this document

Each work item has a status tag:

- **[Committed]** - will ship regardless of grant outcome
- **[Grant: FAD]** - conditional on Frontier AI Discovery award (GBP 34,999, Oct-Dec 2026)
- **[Grant: AIC-P1]** - conditional on AI Champions Frontier AI Phase 1 award (up to GBP 122,500, Aug 2026 - Jan 2027)
- **[Phase 2]** - planned follow-on work
- **[Speculative]** - exploratory, no firm date

> **Funding update (2026-08-10):** none of the three 2026 bids was awarded - FAD ineligible (not assessed, seen 2026-07-19), ARIA unsuccessful (confirmed 2026-07-19), AIC-P1 unsuccessful at 60.0% (2026-06-03). All **[Grant: FAD]** and **[Grant: AIC-P1]** items below are unfunded; treat them as [Speculative] unless re-submitted under a future competition.

---

## Grant: Frontier AI Discovery (submitted 2026-04-20)

Status: **Ineligible - not assessed** (status seen 2026-07-19, app #10200923). Not awarded; O1-O3 below are unfunded unless re-scoped for a future competition.

### O1. Convergence proofs [Grant: FAD]

- Formalise Lyapunov energy functions for particle dynamics
- Prove bounded-energy convergence under standard operating conditions
- Empirical stability tests across 10 synthetic workload profiles
- 100-hour continuous operation test
- Deliverable: convergence proof document and operational envelope spec

### O2. Benchmark vs state-of-the-art RAG [Grant: FAD]

- Build 100K evaluation corpus from public datasets
- Implement baseline wrappers for FAISS, ChromaDB, LlamaIndex
- Run benchmarks at 1K, 10K, 50K, 100K entries with 30 runs per configuration
- 30-day degradation simulation
- Metrics: MRR, NDCG at 10, Recall at 5 / 20, retrieval latency
- Deliverable: benchmark report with bootstrapped confidence intervals

### O3. Multi-agent shared memory specification [Grant: FAD]

- Design shared-memory architecture for multiple agents acting on one particle space
- Conflict resolution simulation
- Partner engagement: 2+ enterprise or academic partners committed
- Deliverable: Phase 2 technical specification

---

## Grant: AI Champions Frontier AI Phase 1 (submitted 2026-04-21)

Status: **Unsuccessful at 60.0%** (2026-06-03). Not awarded; WP1-WP4 below are unfunded. Post-mortem + reusable answers: `memory/reference_ai_champions_hippo_answers.md`.

### WP1. Architecture scaling to 1M+ items [Grant: AIC-P1]

- Replace reference indexing with production HNSW and custom metric
- Parallel sleep-cycle consolidation
- Sub-linear memory compaction
- Profile-driven optimisation on RTX 5080 plus cloud A100 reproducibility runs
- Success: 1M+ items, sub-100ms retrieval, 5x compute cost reduction vs vector RAG

### WP2. Benchmark harness on frontier tasks [Grant: AIC-P1]

- Implement wrappers for vector RAG, long-context Claude, Mem0, Letta
- Run LoCoMo, LongMemEval, MSC, AgentBench, SWE-Bench Lite
- Paired-comparison protocol, 30 runs per configuration
- Success: within 5% of published best on multi-session benchmarks, 10%+ lift on agentic benchmarks, 90%+ retention on 30-day continual-learning task

### WP3. Five agent-framework integration adapters [Grant: AIC-P1]

- LangChain adapter
- LlamaIndex adapter
- Letta adapter
- CrewAI adapter
- AutoGen adapter
- Consistent API semantics across all five

### WP4. Feasibility report and Phase 2 plan [Grant: AIC-P1]

- Synthesise technical outcomes
- Document commercial pathway and partner commitments
- Costed technical plan for Phase 2 demonstrator

### Other WP promises [Grant: AIC-P1]

- Provisional UK patent filings on update dynamics and replay scheduling (month 2)
- Freedom-to-operate review by UK patent counsel (month 1)
- v1.0 release of hippo-memory with production-grade documentation

---

## Committed (ships regardless)

- [Committed] Ongoing bug fixes and minor feature work on main branch
- [Committed] npm publish cadence for point releases
- [Committed] Documentation updates for existing API surface
- [Committed] **Memory scope isolation (stop the agent tracing the wrong memories).** The UserPromptSubmit hook injects `path:skf_s` (home/global-scoped) memories into every session regardless of the active project, so a fact from project A surfaces while the agent works in project B. Two failure modes, both observed 2026-06-30: (1) **wrong-project recommendation** - in a corporate project (RamSky / MR3A) the agent recalled a *personal* hackathon's AWS usage and recommended AWS S3 for the corporate app; a fabrication the user caught and flagged ("please try not to mix what we have with what dmitrii has"). (2) **secret bleed** - a production API key (2chain, tagged `path:skf_s`) sits in the live context of unrelated project sessions. Fix direction: scope-aware retrieval keyed on the active project (cwd / git remote) that demarcates, down-weights, or excludes other-project memories unless explicitly requested; an explicit global-vs-project partition at recall time; and a hard rule that secret-tagged memories never auto-inject outside their owning project. Acceptance: an agent working in project A is not served project B's load-bearing facts or secrets without an explicit cross-project request. Pairs with the per-project + global store split noted under the quiz-me Speculative item.

### Company Brain execution order [Committed]

- [Committed] Measurement-first scorecard for Company Brain work before broad feature rollout
- [Committed] First product slice after the scorecard: continuity-first context assembly built from active snapshots, recent session trails, and handoffs
- [Committed] Provenance-envelope work comes after continuity is measurable, not before

---

## Phase 2 (follow-on, contingent on Phase 1 success)

- [Phase 2] Multi-agent demonstrator with 2+ enterprise partners
- [Phase 2] Managed-inference deployment (hosted Hippo)
- [Phase 2] Continual-learning research at frontier-model scale
- [Phase 2] PCT patent extension

---

## Speculative

- [Speculative] Cross-modal memory (text + vision + action)
- [Speculative] Post-transformer architecture integration
- [Speculative] On-device Hippo (mobile / edge agents)
- [Speculative] Learning-gate cards as first-class memories. Integrate the `/quiz-me` forcing-function skill (`~/.claude/skills/quiz-me/`, currently file-backed at `~/.claude/quiz-me/{deck,results}.jsonl`) with hippo as the storage layer. Each MC / explain-back card becomes a hippo memory tagged `card`; spaced-repetition schedule (1, 3, 7, 14, 30, 60, 120 days) drives the decay curve; failed cards spike retention via the existing outcome mechanism; recall surfaces due cards with the same MMR / value-aware ranking already used for normal recall. Unblocks: cross-project decks (hippo's per-project + global stores), card decay sensitive to actual use, and consolidation passes that merge near-duplicate cards. Blocked on: lossless-claw-style SQLite backbone landing first (per hippo plan correction 2026-03-18) — current `.jsonl` store is the bridge until that ships.

---

## Funding status tracker

| Grant | Status | Amount | Decision |
|-------|--------|--------|----------|
| Frontier AI Discovery (comp 2422) | Ineligible - not assessed (seen 2026-07-19) | GBP 34,999 | Not awarded |
| ARIA Rolling Seeding | Unsuccessful (confirmed 2026-07-19) | Up to GBP 500K | Not awarded |
| AI Champions Frontier AI Phase 1 (comp 2419) | Unsuccessful 60.0% (2026-06-03) | Up to GBP 122,500 | Not awarded |

See `memory/reference_frontier_ai_hippo_answers.md` for the full application template and reusable assets.


---

## Part II - Canonical Execution Roadmap (formerly ROADMAP-RESEARCH.md)

# Hippo Roadmap: Scaling to Enterprise Agent Memory

This is the canonical execution roadmap. Every actionable item from `RESEARCH.md` lands somewhere in here with a status, an owner phase, and a success criterion. Items without a measurable success criterion get cut.

This file supersedes the prior research-only frame. **Part I** above (formerly `ROADMAP.md`) tracks grant-tied deliverables. `PLAN.md` documents architecture and CLS principles.

Current version: 1.28.0 (npm `hippo-memory`, published 2026-07-28) + python-v0.3.0 (PyPI `hippo-memory-sdk`, published 2026-05-28)
Active branch: `master`

## Status as of 2026-05-24

The original 90-day plan (lines below, scoped April→July) is **functionally complete**: A3 envelope shipped v0.39 (security hardening), A5 stub auth shipped, A1 server shipped v0.36, E1.3 Slack ingestion shipped v0.37, F6 reranker hardening shipped v1.9.0, and the F-track hit its roadmap R@5 ≥ 85% target on the oracle split (v1.9.2, F13 chunk-per-turn + F9 sub-agent rerank = R@5 = 86.8). E1.4 GitHub ingestion shipped v1.3.0. The v1.10.x-v1.11.x arc added pidfile-ownership guards, conflict-subsystem tenant isolation, per-IP rate limiting on `/v1`, the opencode plugin installer fix, and the api.ts refactor that unlocked the v0.1.0 Python SDK on PyPI. v1.12.0 sub-1 shipped the A5 v2 auth/role plumbing (Actor object shape + admin-gate on `/v1/sleep`); sub-2 (L9 background pipelines tenant-scoping, 8 files) is next. 33 npm releases from v0.33 (2026-04-23) to v1.12.0 (2026-05-23).

**Next 90 days (2026-05-23 → 2026-08-23) priority queue** (revised at end-of-arc):
- ~~Episode A/B/C tail → v1.11.5 patch or v1.12.0 minor: per-tenant `/v1/sleep` scoping decision~~ — **DONE** in v1.11.5 (7/8 items) + v1.12.0 sub-1 (admin-gate option (a)). Remaining v1.12.0 follow-ups (HTTP DoS caps on outcome+context, audit-emission on sleep phases, api.recall parity, CLI snapshot tests, mid-phase test coverage, afterAll guard) tracked in `TODOS.md` §"v1.12.0 sub-2 / later".
- ~~Python SDK v0.2: sync wrappers (HippoSync), ContextResult.projected() helper~~ — **SHIPPED** python-v0.2.0 (2026-05-24); v0.3.0 (2026-05-28, Decision API). 204 handling deferred-by-design (dead code path).
- ~~F9 hybrid retrieval — the BM25+vector RRF fusion the F-track never actually measured locally~~ — **SHIPPED 2026-05-20** via PR #27 (`feat/f9-hybrid-retrieval-parity`). Phase 1 oracle: 4 hybrid cells all beat dense-only baseline 79.0; best `turn_asym` R@5=82.0 (+3.0). Phase 2 `_s` Gate-B FAIL @ 97.7 (best `turn_sym` R@5=50.8 vs F14 baseline 41.0, +9.8 lift at zero LLM cost; ties the F14+F9-Sonnet-rerank stack). HARD RETRACTION executed per prereg discipline — that's why the canonical-doc trail (CHANGELOG/README/this file pre-correction) didn't mention it. Result + audit trail at `docs/evals/2026-05-20-f9-hybrid-rrf-result.md`. The locally-runnable embedder is the structural ceiling on `_s` (F14 R@100=86.2 confirmed in F16; F9 doesn't lift it).
- Conflict-subsystem tenant-isolation residue — **deferred-by-design**: unscoped readers in `cli.ts` / `dashboard.ts` / `refine-llm.ts` are host-wide-correct under single-tenant-per-process + loopback trust; stale cross-tenant rows already auto-resolved by `replaceDetectedConflicts`. Revisit only when non-loopback multi-tenant serving lands.
- v0.26 UI redesign — **partial / diverged**: an "Obsidian-inspired graph" revamp shipped instead (E1-E5, v0.2.0-v0.2.5) + parchment tokens added (not yet fully wired to components). The hybrid-v4 mockup (3D golden-hour sky / terrain / mycelium + full parchment Field Notes) was NOT pursued — keep/drop decision pending. Track in TODOS.md "v0.26 — UI Redesign".

The per-track status tags below are updated to reflect shipped-vs-active state. Section structure, bets, non-goals, and cross-track invariants are unchanged.

## North star

**Long-term vision** (RESEARCH §"Long-term vision"): LLMs with hippocampal circuits built into the architecture — fast-learning module for deployment interactions, consolidation during idle compute, decay that removes outdated knowledge, emotional tagging for error-corrective learning, retrieval that strengthens useful knowledge. Hippo is the prototype; the data it generates is the evidence base; the research below is the bridge.

**Near-term thesis:** memory lifecycle (decay, strengthening, consolidation, supersession) is the moat. Enterprises won't pay for the moat alone — they pay for it wrapped in trust controls, durable infra, integrations, and observability. The roadmap is the path from "local CLI for one developer" to "memory backbone for an org's agents," while keeping the research moat alive.

## Status legend

- **[shipped]** merged or in-flight on a feature branch
- **[next]** scoped, ready to start within 90 days
- **[planned]** committed direction, scoping pending
- **[research]** open question, needs investigation before scoping
- **[grant]** funded conditional on FAD or AIC-P1 award (see `ROADMAP.md`)
- **[cut]** explicit non-goal; here so it stays cut
- **[critical]** priority overlay, not a lifecycle status — highest-urgency item; always paired with a lifecycle tag, e.g. `[critical, next]`

## Benchmarks (priority order for shipping decisions)

1. **Paired A/B fire-rate** on tier-1 micro-eval — own harness, fastest signal, Wilcoxon-tested. Commit `5ef6d78`.
2. **Sequential-learning trap-rate** — own benchmark, directly tests the agent-learning thesis. ~~(78% -> 14% baseline over 50 tasks)~~ **(RETRACTED v1.7.9 — see `CHANGELOG.md` v1.7.9 entry; magnitude does not reproduce on the formal multi-seed harness across three pre-registered workload variants. Mechanism shipped.)**
3. **LongMemEval** — public-comparability number for README and grants.
4. **LoCoMo** — baseline ESTABLISHED 2026-07-05 (F7): evidence recall@5 = 0.363369 (v1.25.0), 2.10x the April v0.32.0 baseline (single-run point estimate, repeat-run stdev quantified; internal before/after on hippo's own retrieval stack, not comparable to vendor LLM-judge numbers). Still informational only; never gates a shipping decision. See `benchmarks/LOCOMO_INVESTIGATION.md`.
5. **Memory-Augmented Agent Eval** — RESEARCH §"Near-term 1"; 50-task / 10-trap standardised sequence, planned to design.

---

## Track A — Enterprise scaling (the gap-to-product path)

Hippo today: local CLI + MCP, single user, single project, SQLite + markdown. The gaps below are dependency-ordered.

### A1. Server mode [shipped v0.36.0]
Persistent daemon alongside CLI. `hippo serve` exposes HTTP + MCP, CLI becomes a thin client. SQLite single-writer.
**Shipped:** v0.36.0 added `hippo serve` (default 127.0.0.1:6789, configurable via `--port` / `HIPPO_PORT`), thin-client auto-routing via `.hippo/server.pid`, stale-pidfile self-heal. v1.10.x added lifecycle hardening (H1-H3 + L3 + M3: stale-pidfile + PID-reuse detection, `HIPPO_REQUIRE_SERVER`, concurrent-serve detection, pidfile schema version, BodyTooLargeError socket cleanup). v1.10.1 added `removePidfileIfOwned` (pid + started_at match required for unlink). 24h soak harness is scaffold-only (`benchmarks/a1/soak.ts`) — promoting to a CI-integrated release gate remains in TODOS.md. p99 target retracted v0.39 (current p99 = 58.4ms sequential single-thread; not a regression — the harness is not representative of server-mode concurrent load).

### A2. HTTP API [shipped through v1.11.4]
Language-agnostic surface alongside MCP/CLI. RESTish.
**Shipped:** 14 routes on `/v1/*`: memories (remember/recall/drill/forget/archive/supersede/promote), auth (keys list/create/revoke), audit, connectors (slack/github webhooks), sessions/assemble, plus v1.11.4's outcome/context/sleep. Per-IP token-bucket rate limit (`HIPPO_V1_RPS`, default 20 rps) added v1.11.0. All routes Bearer-authed and tenant-scoped except `/v1/sleep` (loopback-only, host-wide; per-tenant scoping deferred to TODOS.md once non-loopback serving lands).

### A12. Python SDK [shipped python-v0.3.0]
Async httpx + Pydantic v2 thin wrapper over the 14 HTTP routes. PyPI distribution name `hippo-memory-sdk` (the bare `hippo-memory` was blocked by PyPI's similarity check against an existing `hippomem` project); Python import name stays `hippo_memory`. Trusted-publisher OIDC workflow at `.github/workflows/pypi-publish.yml`. v0.2.0 (sync wrappers HippoSync + ContextResult.projected()) shipped 2026-05-24; v0.3.0 (Decision API) shipped 2026-05-28; 204 handling deferred-by-design.

### A3. Provenance envelope [shipped]
Every memory carries `scope`, `source`, `timestamp`, `owner`, `confidence`, `artifact_ref`, `session_id`, `kind` (raw|distilled|superseded|archived). RESEARCH §"Phase 1: safest bridge" canonical envelope.
**Shipped:** schema v14 in commits `41b1f4d..df4b0b2` (plan + 10 implementation commits). 725 vitest pass, 9/9 micro-eval fixtures at 100% post-migration. Append-only invariant enforced via `trg_memories_raw_append_only`. `archiveRawMemory(db, id, { reason, who })` is the only legitimate raw-deletion path. See `MEMORY_ENVELOPE.md`.

### A4. Lifecycle compliance [planned]
Retention policy enforcement, right-to-be-forgotten (`hippo forget --user X --everywhere`), encryption-at-rest config flag, secret-scrubbing at write-time, PII redaction (regex + simple model).
**Effort:** 4-6w. **Success:** demo "delete everything for user X across all scopes" in one command; secret-scrub catches AWS/OpenAI/Anthropic/GitHub key formats with <1% false positive on synthetic corpus.

### A5. Auth + multi-tenancy [shipped stub + v2 sub-1; v2 sub-2 next]
API keys + audit log of every read/write/promote/supersede. Tenant scoping added.
**Shipped:** stub auth (v0.34-v0.35): API keys via `hippo auth create-key`, Bearer on `/v1/*` and MCP, `validateApiKey` with constant-time scrypt comparison, `audit_log` table. Tenant_id column added to `memories` + scoped reads (`ctx.tenantId`). Conflict-subsystem tenant isolation shipped v1.11.0 (`hippo_conflicts` / `hippo_resolve` / `hippo_status`). v1.11.1 closed `replaceDetectedConflicts` stale-resolve + `readEntry` audit cleanup. Per-IP rate limit on `/v1/*` shipped v1.11.0. **v2 sub-1 (v1.12.0):** `Actor` interface promotion (`Context.actor: string` → `{subject, role: 'admin' | 'member'}`), `api_keys.role` migration v26 with `'admin'` backfill default, fail-safe-to-member cast in `validateApiKey`, admin-gate on `POST /v1/sleep` (non-admin Bearer → 403). 12 new tests across `auth-role-migration.test.ts` + `api-context-actor-shape.test.ts` + `server-sleep-admin-gate.test.ts`.
**v2 sub-2 next (next minor):** L9 background pipelines tenant-scoping across 8 files (`consolidate.ts`, `embeddings.ts`, `invalidation.ts`, `refine-llm.ts`, `autolearn.ts`, `capture.ts`, `importers.ts`, `shared.ts`). Closes the unscoped `readEntry` / `loadSearchEntries` residue from v1.11.0; unblocked by sub-1's Actor shape.
**v2 deferred to TODOS.md:** `hippo auth create-key --role` CLI flag (programmatic API works); `hippo auth list` role column display; `auth create`/`list` are unauthenticated locally (FS access is the trust boundary); audit-log retention/rotation; SSO/SCIM; OAuth scoped tokens; full multi-tenant org > team > project > scope hierarchy.

### A6. Postgres backend [planned]
For shared deployments only. SQLite stays the local default.
**Effort:** 3-4w. **Success:** `--db postgres://...` boots; eval suites pass; concurrent-write smoke test green.

### A7. Observability [partial: audit + rate-limit shipped; dashboard pending]
Per-query cost, retrieval traces, decay/strengthening rates, conflict counts, sleep-cycle metrics.
**Shipped:** `audit_log` table (every remember/recall/promote/supersede/outcome/forget with actor + tenant). Per-IP rate-limit visibility via 429 responses (`HIPPO_V1_RPS`). Brain Observatory UI (v0.25) surfaces memory state, conflicts, embeddings via JSON API at `/api/{memories,stats,conflicts,embeddings,peers,config}`.
**Pending:** retrieval-trace API ("why did my agent recall X"), per-tenant cost/usage rollups, Prometheus exporter, decay-curve telemetry (D8 below).

### A8. Framework adapter breadth [grant: AIC-P1]
LangChain, LlamaIndex, Letta, CrewAI, AutoGen. Consistent semantics across all five. Already in `ROADMAP.md` WP3.
**Effort:** 8-12w if funded. **Success:** five adapters pass the same conformance test suite.

### A9. Scale to 1M+ [grant: AIC-P1]
HNSW with custom metric, parallel sleep-cycle consolidation, sub-linear memory compaction. Already in `ROADMAP.md` WP1.
**Effort:** ongoing under grant. **Success:** 1M+ items, sub-100ms retrieval, 5x compute cost reduction vs vector RAG.

### A10. Managed cloud [planned]
Multi-tenant SaaS deployment, billing, free tier, paid org tier. After A1-A6.
**Effort:** 3-6 months. **Success:** first paying enterprise customer.

### A11. Convergence proofs + operational envelope [grant: FAD]
Lyapunov energy formalism, bounded-energy convergence proof, 100h continuous operation test. Already in `ROADMAP.md` O1.

---

## Schema migration order (cross-track invariant)

Every new table introduced by Track B (B1-B5 depth migrations: `memory_value_association`, `goal_stack`, `retrieval_policy`, `interference_suppression`, `option_valuation`) and Track E (E2 first-class objects, E3 graph extraction queue) lands **after** A3 envelope so every row has provenance from day 1. Migration sequence:

1. **A3 envelope** — adds `kind`, `scope`, `owner`, `confidence`, `artifact_ref`, `session_id` to `memories`. Backfills existing rows with `kind='distilled'` (best guess; existing memories are already not raw transcripts). Adds `BEFORE DELETE` trigger on `memories` rows where `kind='raw'` raising ABORT. Adds `kind='raw'` archive table for legitimate retention deletions (tied to A4 right-to-be-forgotten path).
2. **A5 stub auth** — adds `tenant_id` to `memories`, `working_memory`, `consolidation_runs`, `task_snapshots`, `memory_conflicts`. Backfills with default tenant. Adds composite index `(tenant_id, created)` everywhere recall touches.
3. **B-track depth tables** (B1-B5) — every new table includes `tenant_id`, `kind`, and FK to `memories.id` where applicable.
4. **E2 first-class objects** — `decision`, `handoff`, `incident`, `process`, `policy`, `skill`, `project_brief`, `customer_note` all carry envelope.
5. **E3 graph extraction queue** — `graph_extraction_queue` fed only by writes that set `kind=distilled` during `hippo sleep`. `entities` and `relations` tables FK to consolidated rows + `CHECK (source_kind IN ('distilled','superseded'))`.

**Iron rule:** any migration that adds a table without `tenant_id` + `kind` is rejected at PR review.

---

## Test commitments (Track A required for ship)

Per project preference: every new path tested against a real SQLite database (no mocks).

### A3 envelope tests
- Schema migration up + down (real DB, real existing data, including pre-migration rows)
- Every existing recall path returns full envelope on `--why`
- Backfill: existing memories assigned correct default `kind`
- Existing eval suites pass post-migration (LongMemEval R@5, fire-rate harness)
- **CRITICAL REGRESSION:** `DELETE FROM memories WHERE kind='raw'` aborts via trigger

### A5 stub auth tests
- API key auth path (positive + negative)
- Audit log captures every mutation (no false negatives across remember / recall / promote / supersede)
- Cross-tenant scope filter (negative test: tenant A's recall does not return tenant B's memories)
- SSO/SCIM hook points exist as stubs with explicit not-implemented errors

### A1 server mode tests
- HTTP server lifecycle (start, drain, shutdown)
- CLI thin-client → server → response round-trip parity with direct CLI
- Concurrent recall + write under SQLite single-writer (real DB)
- 24h soak test harness (success criterion exists; harness is its own item)

### E1.3 Slack ingestion tests (per connector pattern)
- Idempotency: replay same webhook payload → no duplicates
- Cursor / backfill: resume from interrupted state
- Source deletion: Slack message deleted → memory invalidated (GDPR)
- Permission mirroring: Slack-private channel does not leak across scopes
- Rate-limit handling: 429 backoff + retry, no message loss
- Dead-letter queue: malformed events captured for review

### E3 graph invariant tests
- **CRITICAL REGRESSION:** direct INSERT into entities with raw FK fails (CHECK + FK)
- Sleep is the only code path that produces graph nodes
- Supersession of distilled object cascades to graph edges (no orphans)

### Pinning success-criterion ambiguity
- A1 "sub-50ms p99 recall on 10k store": query mix = top-10 BM25 against tier-1 micro-eval queries; cold cache; with hybrid embeddings on; on a single SQLite connection.
- A9 "5x compute cost reduction vs vector RAG": baseline = LangChain + FAISS at the same recall@5 quality. Pin both at scoping time.

---

## Track B — Memory mechanics depth (PFC modules)

Six MVPs shipped on this branch. The depth phase replaces toy heuristics with measured behavior under the paired A/B harness.

### B1. ACC EVC-adaptive recall [shipped MVP, depth next]
**MVP:** commit `a14588b`. **Depth:** EVC formula calibrated on real query traces (`evc = expected_payoff × confidence − cognitive_cost`); adaptive depth gated on `evc > 0.4`; arousal-weighted physics updates for high-EVC queries.
**Effort:** 8d. **Success:** Wilcoxon p<0.05 fire-rate lift on tier-1 micro-eval.

### B2. vmPFC value attribution [shipped MVP, depth next]
**MVP:** commit `54dda6a`. **Depth:** continuous value scores propagated backward through `conflicts_with` and tag-cooccurrence graph; replace scalar `outcome_score` with `memory_value_association` table; integrate with reward-proportional decay (`half_life = base × (1 + value × k)`); per-goal context-dependent value tracking.
**Effort:** 10d. **Success:** fire-rate lift p<0.05 on value-sensitive subset; LongMemEval flat.

### B3. dlPFC goal-conditioned recall [shipped MVP, depth next]
**MVP:** commit `9af9962`. **Depth:** persistent `goal_stack` + `retrieval_policy` tables; multi-goal interference handling; cap concurrent stack depth at 3; `hippo goal push/complete` CLI; goal-completion outcome scoring.
**Effort:** 12d. **Success:** ~~sequential-learning trap-rate −10pp~~ **(RETRACTED v1.7.9 — see Status update below)**; fire-rate lift p<0.05 on goal-tagged subset.

> **Status update 2026-05-09 (v1.7.9 retraction):** the −10pp magnitude is **RETRACTED publicly** based on cumulative evidence from three pre-registered workload variants — v1.7.5 SANITY_FAIL on full-late (last 7), v1.7.6 B*=NULL across 5 budgets × 10 seeds, v1.7.7 SANITY_FAIL on `--restrict-late-to 4` (last 4 of 25). Every C2 hippo-base late mean returned 0% across every seed. v1.7.9 retracts on cumulative evidence rather than waiting for v1.8 — the v1.7.7 prereg's SANITY_FAIL ≠ NOT_SUPPORTED distinction was wrong; three SANITY_FAILs across distinct knobs is meaningful negative evidence regardless of formal verdict label. The mechanism (commit `9af9962` MVP + v1.7.4 depth) remains shipped; **no magnitude is currently claimed.**
>
> **Status update 2026-05-09 (v1.8.0 adversarial categories):** v1.8.0 added 3 adversarial trap categories (timezone_naive, idempotency_retry, float_accumulation; lesson vocabulary <0.30 Jaccard overlap with v1.7.5 lessons). Workload-validity gate: **PASS** (C2 lateMean=0.25, 20/20 seeds non-zero — first non-saturated workload across v1.7.5/6/7/8). Mechanism characterisation (sign-only direction count, NOT magnitude): C3 (goal-stack ON) = C2 (goal-stack OFF) on all 20 seeds; STRICTLY_LOWER=0, STRICTLY_HIGHER=0, TIED=20. The goal-stack boost does not detectably change per-seed late-4 lattice rate on this workload. **This release does not re-assert the retracted −10pp magnitude** per `docs/RETRACTION.md`; mechanism remains shipped, no magnitude is currently claimed. Pre-committed v1.9 direction (named BEFORE v1.8 ran): LongMemEval R@5 cross-validation. See `CHANGELOG.md` v1.8.0 entry and `docs/evals/2026-05-09-v1.8.0-adversarial-eval-result.md`.
>
> **Status update 2026-05-09 (v1.8.1 v1.9 pre-commitment retraction):** the v1.8 prereg's v1.9 LongMemEval cross-validation pre-commitment is **RETRACTED publicly**. Outside-voice review on two v1.9 plan iterations identified six structural barriers (canonical harness bypasses `applyGoalStackBoost`; ingest tag namespace excludes content-derived stems; `pushGoal` API field mismatch; depth-cap suspension; cumulative-null trigger AND clause unreachable; workload-validity gate ceremonial). Three options considered (re-ingest, harness rewrite, retract); option C chosen per Root Cause Over Patches + v1.7.9 pre-emptive retraction precedent. **`docs/RETRACTION.md` updated** with: pre-registration discipline rule (no pre-commitment without source-read + dry-run validation); v1.9 retraction subsection; "Mechanism-effect status (cumulative null escalation)" subsection acknowledging that the mechanism's effect, as measured on the workloads tested, is null. **Mechanism CODE is preserved from v1.7.4.** No new eval pre-commitment in v1.8.1. See `CHANGELOG.md` v1.8.1 entry and `docs/evals/2026-05-09-v1.9-pre-commitment-retraction.md`.

### B4. vlPFC interference filter [shipped MVP, depth next]
**MVP:** commit `0f1d19e`. **Depth:** `interference_suppression` table with `expires_at`-based suppression decay; `--show-suppressed` override; goal-aware suppression reasons (conflict-with-goal | outdated-schema | error-tagged | context-switch).
**Effort:** 7d. **Success:** conflict-resolution pass-rate >85% on synthetic test set.

### B5. OFC option-value re-ranker [shipped MVP, depth next]
**MVP:** commit `1cdae1c`. **Depth:** `option_valuation` table; per-(query, context) cache; net-utility formula tuned by reward replay; common-currency scoring across heterogeneous attributes.
**Effort:** 9d. **Success:** same fire-rate at −20% token budget.

### B6. mPFC self-model + meta-memory [planned]
Highest-effort, lowest-immediate-delta PFC item per RESEARCH §priority (rank 6). `self_model` + `meta_memory` tables; `hippo introspect`; `hippo goal align --to <identity>`; `hippo consolidate --identity-aware`.
**Effort:** 14d MVP. **Success:** `hippo introspect` outputs known/unknown buckets per domain; identity-aware consolidation passes 3-task benchmark within ±5% of hand-curated baseline.

### B7. PFC-stack composition A/B [research]
Do ACC + vmPFC + dlPFC + vlPFC + OFC compound or interfere when all on?
**Effort:** 5d. **Success:** documented interaction matrix; recommended default-on combinations.

---

## Track C — Pineal Gland (intuition + awareness layer)

RESEARCH §"AI Pineal Gland". Three components.

### C1. Salience gate v1 [shipped]
Basic novelty + tag-class scoring (`src/salience.ts`). Commit ref `50528a5` no longer resolves in current history (pre-squash SHA; the CHANGELOG v0.2x entry cites the same dead pointer). v2 shipped as the `--salience-threshold` recall flag.

### C2. Salience gate v3 [next]
Physics-energy ambient state injected as scalar; salience tied to ambient delta. **Salience decides promotion (raw → distilled), not receipt capture.** Raw layer remains append-only per RESEARCH §"Phase 1" — every receipt is captured; salience controls whether the receipt promotes to consolidated state during `hippo sleep`.
**Effort:** 8d. **Success:** promotion rate −30% with no fire-rate regression; raw-layer write rate unchanged.

### C3. Ambient state vector [next]
Continuous background representation: physics-engine energy + velocity-distribution scalars injected alongside memory context. Gives the agent a "feel" for its knowledge landscape without retrieving specific memories.
**Effort:** 6d. **Success:** ablation moves fire-rate by ≥2pp on tier-1 micro-eval (either direction is informative).

### C4. Fast-path System 1 heuristic [next]
Sub-millisecond pre-LLM classifier. Cosine of query embedding against particle-cluster centroids. Predicts: relevant knowledge present? familiar vs novel? about to repeat known mistake?
**Effort:** 8d. **Success:** ≥70% accuracy on labeled trace; <1ms p99 latency.

### C5. WYSIATI cutoff transparency [SHIPPED 2026-08-24, PR #154, v1.38.0]
When `hippo recall --budget N` truncates the candidate set, surface the suppressed-set summary in the response: "showing 5/47 by strength; 38 below decay threshold; 4 suppressed by interference filter." Today the cut is silent and the calling agent treats the cutoff as the full picture (Kahneman, "What You See Is All There Is", TFAS ch. 7). Hippo's lifecycle metadata is uniquely positioned to surface *what was excluded and why* -- a signal no static-store competitor has.
**PREMISE CORRECTION (measured 2026-08-24).** This item was not unbuilt: it shipped in v1.12.13 and was refined in v1.13.3 with passing tests. Driving the live binary showed it could not FIRE on the CLI path - cmdRecall derived droppedByBudget from the post-search --limit slice, after the search had already truncated, so the counter read 0 while hundreds of candidates vanished and the guard suppressed the line. The tests passed because they exercise api.recall, the path that was already correct. v1.38.0 derives the count arithmetically so the published invariant (totalCandidates == droppedPreRank + droppedByBudget + returned) holds by construction, including on --hops recalls where graph expansion adds out-of-pool rows. **Success (met):** the Cutoff line prints on truncated --why recalls, pinned by tests verified red against the pre-fix code on the budget, limit and graph paths. **Not done, deliberate:** the paired tier-1 micro-eval (decision-quality non-regression) was not run this episode; the accounting-convention change is documented in the CHANGELOG including cross-surface non-comparability.

**Effort:** 1-2d. **Success:** `recall --why` output includes a suppressed-tier breakdown on every truncated recall; integration test asserts the breakdown appears whenever total_candidates > budget; paired tier-1 micro-eval shows agent decision quality non-regression with the breakdown injected.

---

## Track D — Hippocampal mechanism foundations (the seven CLS mappings)

RESEARCH §"Seven mechanisms, mapped to ML". Each mapping is both a shipped hippo feature and an open ML research direction.

| # | Mechanism | Hippo status | ML research direction (RESEARCH §) |
|---|-----------|--------------|------------------------------------|
| D1 | Two-speed CLS (buffer / episodic / semantic) | shipped | Continual-learning pipeline: adapter captures deployment, background distillation back into base [research, long-horizon] |
| D2 | Decay by default | shipped (reward-proportional v0.11) | Time-weighted training: older examples contribute less unless retrieved [research] |
| D3 | Retrieval strengthening | shipped | RLHF on knowledge, not just outputs; `outcome --good/--bad` is the signal [partially shipped via R-STDP-style decay] |
| D4 | Emotional / error tagging | shipped (2x half-life) | Error-prioritized continual training: 2-5x replay rate on error interactions [research] |
| D5 | Sleep consolidation | shipped (`hippo sleep`) | Offline distillation as training pipeline: compress -> merge -> brief fine-tune -> clear buffer [research] |
| D6 | Schema acceleration | shipped (`schema_fit`) | Curriculum-aware continual learning: high-fit data integrates faster [research] |
| D7 | Interference detection | shipped (`conflicts_with`) | Contradiction-aware training: flag for human review before learning [research] |

### D8. Decay-curve telemetry [next]
Log per-domain decay parameters seen in deployed instances. Opt-in only.
**Effort:** 3d code + 1d privacy/opt-in spec. **Pre-req:** opt-in flag and local-only aggregation spec drafted. **Success:** dashboard surfaces median half-life by tag class across ≥3 user instances.

### D9. Optimal-decay sensitivity sweep [planned]
RESEARCH §"Near-term 2". Half-life range (1-90d), retrieval boost (+1 to +5d), error multiplier (1.5-3x).
**Effort:** 5d. **Success:** report identifying parameter region maximising sequential-learning score within ±5% of best.

### D10. Consolidation quality A/B [research]
RESEARCH §"Near-term 3". Rule-based merge vs LLM-merge vs embedding-cluster merge.
**Pre-req:** offline judge harness reusable. **Success:** measured per-strategy retrieval usefulness on held-out tasks.

### D11. Cross-agent transfer learning [research]
RESEARCH §"Near-term 4". Which memory types transfer? language rules vs tool gotchas vs architectural patterns vs file paths. Schema_fit as transferability predictor.
**Success:** transferability matrix per memory tag class.

---

## Track E — Company Brain product

RESEARCH §"Hippo as a Company Brain" + `RESEARCH.md` "Product spec" + `docs/plans/2026-04-28-company-brain-measurement.md`.

### Phase E1 — read-mostly bridge

The product thesis: separate memory into three layers — raw receipts, current truths, active work state. Moat = continuity + correction + distillation.

#### E1.1. Continuity-first context assembly [shipped]
Active snapshot + recent trail + matching handoff in the default resume path. Commit `e2e9637`.

#### E1.2. Provenance envelope [next] — see A3
Required for everything below.

#### E1.3. Slack append-only ingestion [shipped v0.37.0]
Webhook -> raw layer with full provenance. Source remains canonical; hippo distils, doesn't shadow.
**Shipped:** signed webhook handler, idempotency on `(team_id, event_id)`, cursor-based backfill, DLQ for malformed events (`hippo slack dlq list`), tenant routing via `slack_workspaces` table, rate-limit handling, owner envelope (`user:<slack_user_id>` since v1.1+). v0.38 added test pass + workspace registration plumbing.
**Open follow-ups (TODOS.md):** DLQ replay command, workspace registration CLI (vs direct SQL), thread-aware ranking, eval scoring by `artifact_ref`, multi-workspace tenant-routing e2e test.

#### E1.4. GitHub append-only ingestion [shipped v1.3.0]
PRs, commits, issues, releases. Same model as E1.3.
**Shipped:** v1.3.0 streams issues + issue comments + PRs + PR review comments into hippo as `kind='raw'` rows with full provenance, idempotency, scope tagging, DLQ. Built on the v1.2.1 generic `*:private:*` default-deny filter (codex-flagged pre-flight) so private GitHub rows cannot leak to no-scope callers.

#### E1.5. Jira / Linear ingestion [planned]
Ticket lifecycle events into raw layer; distil to incident / decision objects.
**Effort:** 8d per connector.

#### E1.6. Notion / Docs ingestion [planned]
Append-only ingestion of doc updates with version history.
**Effort:** 10d.

#### E1.7. Email summary ingestion [planned]
Per-thread summaries, not full message bodies.
**Effort:** 6d.

#### E1.8. Meeting-transcript slicing [planned]
Distil weekly slices into decisions/handoffs. Never store full transcripts long-term.
**Effort:** 8d.

#### E1.9. Internal-DB export adapter [planned]
Cron-scheduled exports from internal databases via canonical envelope.
**Effort:** 6d framework + per-DB adapter.

### Phase E2 — first-class operating objects

RESEARCH §"Phase 2: operating objects". Each object gets its own table, recall rule, lifecycle, supersession path.

| Object | Status | Effort to first-class | Notes |
|--------|--------|----------------------|-------|
| `decision` | **shipped v1.15.0** (`decisions` table + lifecycle) | done | first-class object; supersede/close ops |
| `handoff` | partial (`hippo handoff`) | 3d to fully promote | session-scoped today |
| `incident` | **shipped v1.16.0** | done | open/resolve/close lifecycle; `incidents` table, migration v31 |
| `process` | **shipped v1.16.0** | done | living process maps with deltas |
| `policy` | **shipped v1.16.0** | done | bi-temporal-first (`valid_from`/`valid_to`) |
| `skill` | **shipped v1.16.0** | done | executable; exports to AGENTS.md / CLAUDE.md |
| `project_brief` | **shipped v1.16.0** | done | repo-scoped; auto-refreshes from receipts (migration v35) |
| `customer_note` | **shipped v1.16.0** | done | entity-scoped (`customer:<id>`); last of the eight E2 objects |
| `prediction` | **shipped v1.13.0** | done | ex-ante claim closed against ex-post outcome; powers J3 reference-class forecasting |

**Status (2026-06-03): all eight E2 objects are first-class and shipped.** Only `handoff` remains partial (session-scoped; full promotion ~3d) — the single open E2 item.

### Phase E3 — graph layer over consolidated state

**This is "context graph."** RESEARCH §"Phase 2: higher-leverage" + §"Phase 3: graph on consolidated state."

Position: a graph layer sits **on top of** consolidated facts, decisions, processes, and entities — never over raw transcript soup. It exists to support multi-hop reasoning across decisions, policies, owners, customers, systems, and exceptions.

#### E3.1. Entity extraction at sleep [shipped v1.16.0; cross-object `references` edges v1.17.0]
During `hippo sleep`, extract canonical entities (person, project, customer, system, policy, decision) and relationships (owns, supersedes, depends-on, blocked-by, references) from consolidated objects only.
**Effort:** 12d. **Success:** ≥80% precision on labeled gold set of 200 (entity, relation, entity) triples.

#### E3.2. Multi-hop graph recall [shipped v1.16.0]
`hippo recall --hops 2 "incidents linked to decisions about retry-policy"` — traverses decision → policy → incident → owner.
**Effort:** 10d (depends on E3.1). **Success:** answers a 5-question multi-hop benchmark suite faster + more accurately than flat retrieval baseline.

#### E3.3. Graph-on-consolidated guard [shipped v1.16.0]
Hard rule: graph never indexes raw layer. Three-layer enforcement, not just lint:
1. **DB-level:** `entities` and `relations` tables have FK to consolidated rows only; CHECK constraint `source_kind IN ('distilled','superseded')`.
2. **Pipeline-level:** `graph_extraction_queue` table is fed only by `consolidation_runs` writes that set `kind=distilled`. Graph indexer reads from the queue, never from `memories` directly.
3. **CI-level:** lint rule fails any PR that introduces a code path writing to graph from non-consolidated state.
**Effort:** 4d (revised from 1d after eng-review). **Success:** regression test asserts `INSERT INTO entities` with raw-FK fails; lint catches direct-write code paths.

#### E3.4. Graph quality maintenance [research]
How does the graph stay clean as supersession + invalidation happen? Soft-delete vs cascade vs tombstone vs versioned edges.

#### E3 shipped status (2026-06-03) + open follow-ups
The E3 graph track shipped end-to-end v1.16.0 → v1.22.0: extract + guard + multi-hop `recall --hops` (v1.16.0), cross-object `references` edges (v1.17.0), **sleep enqueue-hook so the graph auto-rebuilds during `hippo sleep`** with no manual `graph extract` (v1.19.0), graph observability + visualization (v1.20.0), graph-retrieval stream fused into RRF (v1.21.0; see Track L1), and entity/relation provenance anchored to the authoritative E2 object so an in-force object survives mirror decay/forget (v1.22.0, migration v38). Two follow-ups remain open (tracked in `TODOS.md`):
- **Tenant-level graph-rebuild signal.** `graph_extraction_queue` is memory-keyed, so a whole-tenant re-derive (the v38 cache drop on upgrade; a mirrorless-object close) cannot be expressed; it self-heals on the next memory-write dirty event, but a `graph_dirty_tenants` signal / tenant-scoped queue entry would make it immediate. Coordinated with the v1.19.0 sleep-enqueue subsystem.
- **Recall-surfacing of source-object-anchored entities.** v1.22.0 keeps the object in the graph; recall does not yet preferentially surface it.

### Phase E4 — trigger-based recall [planned]
Cheap trigger routing happens before expensive global recall: file path, service, repo, ticket type, customer, workflow stage, on-call context.
**Effort:** 6d. **Success:** recall p99 latency −40% on cwd/path-scoped queries.

### Phase E5 — security and trust [merged into Track A]
Tenancy, RBAC, audit, scope/provenance/RBAC enforcement, approval boundaries for write-backs. Tracked in A4 + A5.

### Phase E6 — explicit non-goals (cuts) [cut]
RESEARCH §"Phase 3: what is not worth integrating at all". Documented here so they stay cut.
- Duplicating whole source systems (do not become a second Slack/Jira)
- Ingesting every raw transcript forever
- Always-on graph over uncurated raw text
- Forcing local zero-dep core to become heavy enterprise backend
- Browser-automation as primary ingestion when APIs / exports / event streams exist
- Auto-promoting workflows or skills without provenance + invalidation paths
- Optimising for perfect recall of everything

### Phase E7 — Company Brain MVP scorecard
Per `docs/plans/2026-04-28-company-brain-measurement.md`. The five things V1 must do reliably:
1. Ingest raw receipts from a small set of tools (E1.3-E1.9)
2. Maintain active-task continuity for agents (E1.1 ✓)
3. Promote decisions/facts/handoffs into durable memory with provenance (E2 + A3)
4. Correct current truth safely via supersession (shipped: bi-temporal v0.31)
5. Assemble high-signal task context faster than transcript replay (measured per E1.x)

---

## Track F — Comparative positioning + things to borrow

RESEARCH §"Related Work".

### F1. AAAK-style compression [research]
MemPalace's 30x lossless compression dialect. Could improve how hippo stores + compresses semantic memories.
**Pre-req:** AAAK spec available + license-compatible. **Effort:** 15d if pursued.

### F2. Spatial organization [research]
MemPalace wings/halls/rooms metaphor. Could complement hippo's lifecycle moat with their organization moat.
**Status:** philosophical contrast in README; not actively pursued because hippo's bet is "earn persistence" not "store everything."

### F3. R-STDP reward-proportional decay [shipped]
Borrowed from MH-FLOCKE in v0.11.

### F4. HippoRAG graph-based pattern separation [research]
Knowledge-graph indexing as analog to entorhinal cortex. Could feed E3.1 entity extraction.

### F5. LongMemEval ability matrix [shipped baseline, hybrid pending]
Five abilities mapped to hippo features:

| LongMemEval Ability | Hippo Feature | Status |
|---------------------|---------------|--------|
| Information extraction | `hippo remember` + `capture` | shipped |
| Multi-session reasoning | `hippo recall` (BM25 + embeddings) | shipped |
| Temporal reasoning | timestamps, `--framing observe` | shipped |
| Knowledge updates | `hippo invalidate`, `hippo decide --supersedes`, conflict detection | shipped |
| Abstention | confidence tiers (`stale`, `inferred`) | shipped |

### F6. LongMemEval reranker hardening [shipped v1.9.0; features track retracted v1.9.1; roadmap R@5 ≥ 85% target met on oracle split v1.9.2]
**Scope correction (eng-review):** PLAN.md:285 already lists hybrid embeddings as shipped. The remaining gap is reranker quality, not embedding integration. Close gap from current R@5 toward MemPalace's 96.6% via reranker tuning + cross-encoder evaluation.
**Effort:** 6d (actual: in-tree). **Result:** `docs/evals/2026-05-10-f6-reranker-result.md`. v1.9.0 ships the reranker seam and three reranker tracks (features, cross-encoder, LLM-skeleton). Workload-validity gates per the prereg: Gate-A PASS for the features track, Gate-A PASS-with-caveat for cross-encoder (identity-fallback only — HF model download was blocked in the test environment), Gate-B FAIL on features hyperparameters (the three top-K settings produced byte-identical R@K, so no per-hyperparameter effect is claimed). The "R@5 ≥ 85%" target is not met on the workload tested (observed 75.4% features / 75.6% baseline). Per the v1.8.1 retraction discipline (`docs/RETRACTION.md`) this is descriptive characterisation, not a binding gate; the mechanism ships and the path to a real R@5 ≥ 85% attempt requires either a real cross-encoder evaluation (HF access) or a richer ingest path that populates entry-level reranker signals. **This release does not re-assert the retracted −10pp magnitude.**

**Follow-up tracks (2026-05-11):**

- **F8 hybrid tuning** (`docs/evals/2026-05-11-r5-track1-tuning-result.md`): 28-run staged sweep over `embeddingWeight`, `mmrLambda`, `budget`, `min-results`. Gate-A PASS (28/28 runs). Gate-B FAIL: best R@5 = 76.8 vs threshold 77.6 (baseline + 2pp). Descriptive only.
- **F9 v2 sub-agent LLM rerank** (`docs/evals/2026-05-11-r5-track2-cross-encoder-result.md`, the cross-encoder substitute): 50 sub-agent dispatches reranking top-20 candidates per query. Gate-A PASS (500/500 differing orderings). Gate-B FAIL: R@5 = 78.0 vs threshold 80.6 (baseline + 5pp). R@1 moves from 50.0 to 59.4. Descriptive only; no retraction (cross-encoder code path unexercised).
- **F11 embedding upgrade to BGE-base** (`docs/evals/2026-05-11-r5-track4-embedding-upgrade-result.md`): vendored `BAAI/bge-base-en-v1.5` from Qdrant fastembed GCS, added `poolingFor` per-model dispatch in `src/embeddings.ts`. Gate-A PASS (940 × 768 × L2-normalised). Gate-B FAIL: R@5 = 77.0 vs threshold 81.8 (F8 best + 5pp). MiniLM remains default; descriptive only.
- **F10 richer ingest** (`docs/evals/2026-05-11-r5-track3-richer-ingest-result.md`): 19 Claude-sub-agent invocations populated entry-level signals for all 940 LongMemEval sessions. Gate-A PASS (100% any-field non-default; 3/5 fields ≥ 50% per-field coverage). Gate-B FAIL: features-enriched R@5 = 59.2 vs features-default R@5 = 75.8 (same bge-base embedding model), 21.6pp short of the +5pp threshold. **HARD RETRACTION triggered in v1.9.1:** `src/rerankers/features.ts` + test + micro-fixture + dispatcher case removed.
- **F11 + F9 rerank stack** (exploratory follow-up appended to F11 result doc 2026-05-11): 50 sub-agent LLM rerank invocations against the bge-base top-20 candidate pool. Gate-A PASS (500/500 differing orderings). Gate-B FAIL @ 81.8 with R@5 = 78.2; new cross-track best with margin 0.2 over F9 v2 (78.0). The two strongest standalone mechanisms (sub-agent rerank, BGE-base) move R@5 in similar directions; cross-track best of 78.2 still falls 6.8pp short of the 85% roadmap target.
- **F12 multilingual-e5-large + top-100 + F9** (`docs/evals/2026-05-11-r5-track5-e5-large-top100-result.md`): vendored `intfloat/multilingual-e5-large` from the Qdrant fastembed GCS, added `prefixFor` (e5 "query: " / "passage: " convention) and `preferredBackend` (@xenova/transformers v2.17 cannot load multilingual-e5-large's ONNX external-data format; @huggingface/transformers v4 fork can) dispatch helpers to `src/embeddings.ts`. Widened candidate pool to top-100. Gate-A PASS. Gate-B FAIL @ 83.2 with best variant (F12 + F9 stack) R@5 = 78.8 (margin 0.6 over F11+F9). **HARD RETRACTION executed:** the `hippo_store2/` embedding index reverted to BGE-base, dispatch helpers retained in `src/` per the prereg's dispatch-shape carve-out. The vendored e5-large weights remain on-disk under `benchmarks/longmemeval/data/model-cache/` (gitignored) for follow-up tracks.
- **F13 chunk-per-turn ingestion** (`docs/evals/2026-05-12-r5-track6-chunk-per-turn-result.md`): the structural lever the prior tracks all missed. Every prior track embedded each 14,292-char-median session as a single 512-token-truncated vector, throwing away 80–90% of the content (including the answer-bearing turn in ~84% of queries). F13 embeds each turn separately (10,866 turns over the 940 oracle sessions) and max-pools by `session_id` at retrieval time. Gate-A PASS (turn count in range, dim 768, all 940 sessions covered). **Gate-B PASS @ 83.2 with F13 + F9 sub-agent rerank stack R@5 = 86.8** (margin 3.6 over Gate-B). Per-K: R@1 = 70.8, R@3 = 84.2, R@5 = 86.8, R@10 = 90.2, R@20 = 93.4. The F9 reranker captured 7.8 / 14.4 = 54 % of the F13 baseline's top-20 headroom on focused 500-char turns, vs ~7–10 % capture on unfocused 14,000-char session-level inputs in F11+F9 / F12+F9. No `src/` changes; F13 is implemented as `benchmarks/longmemeval/chunk_per_turn_{embed,retrieve}.mjs` and reuses F11/F12's dispatch helpers.
- **F14 chunk-per-turn pipeline on `_s` split** (`docs/evals/2026-05-12-r5-track7-s-split-result.md`): the first F-track measurement against gbrain v0.28.8's split rather than the easier `oracle` (~48 sessions per haystack, 19,195 unique sessions, 500 questions). Source data re-acquired via `Sanderhoff-alt/longmemeval-zh` GitHub mirror (SHA-256 d6f21ea9d..., 500/500 question_id match with oracle, no signed chain-of-custody to canonical HF release). Gate-A PASS (199,509 turns indexed across all 19,195 sessions, dim 768, L2-norms in [0.999999, 1.000000], session_id tag coverage 19,195/19,195). Gate-B FAIL @ 97.7 with F14 + F9 stack R@5 = 50.8 (F14 baseline alone = 42.0). Shortfall 46.9pp dominated by the embedder: gbrain's own ablation shows their pure-vector adapter (text-embedding-3-large alone) at R@5 = 97.40 vs their hybrid+RRF at 97.60 — a 0.2-point top-up over the embedder. F14's BGE-base baseline (42.0) sits between gbrain's BM25-only (19.80) and gbrain's vector-only (97.40), consistent with BGE-base being meaningfully better-than-keyword but qualitatively below text-embedding-3-large at this distractor density. **HARD RETRACTION executed:** `data/lme_s/` (265 MB) and `benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl` (3.3 GiB) deleted; CHANGELOG/README/ROADMAP/RETRACTION canonical docs NOT updated; result doc retained as negative-result audit trail. Cleanest scaling measurement produced: F13 vs F14 (same pipeline, same embedder, oracle vs `_s`) shows R@5 collapses 86.8 → 50.8 under a 16x increase in distractors per haystack.
- **F15 stronger sub-agent rerank on top-100** (`docs/evals/2026-05-12-r5-track8-subagent-rerank-result.md`): originally registered as a neural cross-encoder rerank (commits `e4525b6`/`8a88880`); the cross-encoder spike (Task 4 of the impl plan) discovered the sandbox egress allowlist denies all HF endpoints + all HF mirrors AND the Qdrant fastembed GCS bucket carries embedding models only (verified by reading `fastembed/rerank/cross_encoder/` source: every reranker has `sources={'hf':'...', 'url': None}`). Pivoted to a maximally-equipped LLM-as-reranker mechanism (commit `458f006`): Claude Opus 4.7 vs F9's Sonnet, top-100 pool vs F9's top-20, 1000-char context vs F9's 600, structured rubric (topical-match + evidence-specificity + recency-of-claim) vs F9's "rank these", 100 dispatches vs F9's 50. Gate-A PASS (500/500 permutation-invariant + tags-intact + dispatch-success; 64.6% top-1 changes vs F14 baseline). **Gate-B FAIL @ 97.7 with F15 R@5 = 63.6 (shortfall 34.1pp)**, pre-acknowledged as the expected outcome per the prereg's structural-ceiling clause (F14's R@100 = 86.2 is the absolute upper bound on any rerank over the F14 pool; 86.2 < 97.7 by design). Mechanism finding: F15 closes 21.6 of the 44.2-point within-pool ranking gap (48.9% closure) vs F9's 8.8 points (19.9% closure) — a maximally-equipped LLM-as-reranker closes ~2.5× as much of the within-pool gap as F9 on the same candidate pool. Per-type gains over F14+F9 stack concentrated in `single-session-user` (+20.0pp), `temporal-reasoning` (+18.8pp), `multi-session` (+12.0pp). **HARD RETRACTION executed:** `data/lme_s/` (265 MB), `results/f15_subagent_rerank/` (28 MB), `/tmp/rerank_f15_batches/` + `/tmp/rerank_f15_outputs/` (33 MB) deleted; CHANGELOG/README/ROADMAP/RETRACTION canonical docs NOT updated; result doc retained as negative-result audit trail (commit `2b2edd2`). Path to clearing Gate-B remains F15+F16 combined (rerank on top of a stronger bi-encoder lifting R@100 closer to 100); F16 attacks the structural bottleneck F15 demonstrated. Neural cross-encoder track still queued conditional on HF egress widening or a user-supplied model tarball.
- **F16 multilingual-e5-large chunked-turn on `_s`** (`docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md`): the only GCS-reachable embedder structurally stronger than F14's BGE-base. F16 swapped `BAAI/bge-base-en-v1.5` (768-dim) for `intfloat/multilingual-e5-large` (1024-dim) in the F14 chunked-turn pipeline — a strict 1-axis swap, baseline-only, no LLM reranker. Index build: 199,509 turns embedded over ~28 h cumulative CPU compute across several VM suspend/resume cycles (lossless JSONL-partial resume). Gate-A PASS (all 5 conditions; 199,509 turns at dim 1024, norms 1.0; 500/500 retrieved; 74.6 % top-1 changes vs F14). **Gate-B FAIL @ 97.7 with F16 baseline R@5 = 43.6 (shortfall 54.1pp)** — the expected outcome per the prereg's structural-ceiling clause. Mechanism findings: (1) the embedder swap is inert — R@5 moves +1.6 (42.0 → 43.6) and R@100 moves −1.4 (86.2 → 84.8), both within run-to-run noise; F12 saw +0.6 at session-level, F16 sees +1.6 at chunked-turn, so the chunking lever does not amplify the embedder swap. (2) The candidate-pool ceiling did NOT lift — F16 R@100 = 84.8 < F14's 86.2, so the F14 ceiling is **not a BGE-base artefact**; it is structural to locally-runnable bi-encoders on this workload (a 3×-larger, higher-dimensional model surfaces the answer into top-100 at the same ~85 % rate). (3) The locally-runnable embedder lever is exhausted — both GCS-reachable embedder options are now measured and flat. Per-type R@5 is noise (3 up, 3 down, no pattern). **HARD RETRACTION executed:** `data/lme_s/` (265 MB), `results/f16_e5_large/` (31 MB), `turn_index_e5_s.json.jsonl` (4.3 GB), `/tmp/f16_*.log` deleted; `model-cache/Xenova/multilingual-e5-large/` retained (weights pre-date F16, F12 carve-out); CHANGELOG/README/ROADMAP/RETRACTION canonical docs NOT updated; result doc retained as negative-result audit trail (commit `535b57b`). Outside-voice review PASS_WITH_NOTES (13/13). The evidence-backed path to clearing Gate-B on `_s` now requires a qualitatively different embedder — `text-embedding-3-large` (F17, blocked on `api.openai.com` egress) or an HF-egress-gated model — plus the local hybrid BM25+vector+graph RRF fusion queued as Track F item F9.
- **F17 `text-embedding-3-large` via OpenAI API** [deferred]: would essentially close the gap with gbrain, but `api.openai.com` is host-blocked from this sandbox (verified 2026-05-11 and 2026-05-12 egress audits). Changes the deployable from "MIT locally-runnable" to "needs external service". Revisit when sandbox egress to `api.openai.com` (or a self-hosted equivalent like Vespa's E5-Mistral endpoint) becomes available.
- **F18 fine-tune BGE-base on LongMemEval-style contrastive pairs** [research]: hard-negative mining from F14's R@100-misses (the 14% of queries where the answer-bearing session is outside top-100 even at BGE-base level). Training-on-eval contamination risk is real; would require a held-out subset and pre-registered split discipline. Probably not the next track to pursue unless F15 + F16 stall.

> **CORRECTION 2026-06-09 (see Part III).** The `_s` numbers throughout this F-track (F14 = 42.0, F14+F9 = 50.8, F15 = 63.6, F16 = 43.6) were measured **global-pool**: each question's answer session was ranked against the union of all 19,195 `_s` sessions, with no per-question haystack filter. Standard LongMemEval-S (and gbrain's 97.6) score within each question's own ~48-session haystack. On the standard per-haystack task, hippo's zero-dependency MiniLM default scores R@5 = 98.6 and voyage-3-large scores 99.8, both above gbrain's 97.6 (see `docs/evals/2026-06-09-longmemeval-per-haystack-dual.md`). The "locally-runnable embedder is the structural ceiling / need F17 `text-embedding-3-large`" conclusion that follows is an artifact of the global-pool harness and does NOT hold for standard LongMemEval-S. Global-pool remains a legitimate, harder eval (one unified store) and is retained below as such, not as a comparison to gbrain.

Cross-track aggregate: **roadmap target R@5 ≥ 85% remains MET on the oracle split as of v1.9.2** (F13 + F9 stack = 86.8). The deployable cross-track best on `data/longmemeval_oracle.json` is still F13 + F9 stack at R@5 = 86.8. On the `_s` split, all four tracks attempted to date (F14 chunked-turn baseline 42.0, F14+F9-Sonnet stack 50.8, F15 Opus rerank 63.6, F16 e5-large baseline 43.6) have Gate-B FAILed against gbrain v0.28.8's 97.6. F15 produced the cleanest within-pool measurement: a maximally-equipped LLM-as-reranker closes 48.9% of the within-pool ranking gap vs F9's 19.9% (~2.5× ratio). F16 settled the embedder question: the locally-runnable embedder lever is **measured and flat** — swapping BGE-base for the only stronger GCS-reachable model (multilingual-e5-large) moved R@5 by +1.6 and R@100 by −1.4, both within noise, and the R@100 candidate-pool ceiling did NOT lift (84.8 vs 86.2). The F14 ceiling is therefore structural to locally-runnable bi-encoders, not a BGE-base artefact. The evidence-backed path forward is now two-pronged: (a) a qualitatively different embedder — F17 `text-embedding-3-large` (blocked on `api.openai.com` egress) or an HF-egress-gated model — and (b) local hybrid BM25+vector+graph RRF fusion, queued as Track F item F9 `[critical]`, which no F-track measurement has yet attempted and which runs entirely inside the sandbox. F9 hybrid fusion is the recommended next track; F17/F18 remain blocked on egress.

### F7. LoCoMo first baseline [shipped 2026-07-05]
Informational only; never gates a feature. `benchmarks/locomo/` was run
extensively in April 2026 (v0.32-v0.34 era) — the stale claim here was
"never run before"; what was actually missing was a *publishable current*
baseline, since every April judged score was contaminated by judge failures
and current master had moved on to v1.25.0. **Publishable deterministic
baseline ESTABLISHED 2026-07-05:** evidence recall@5 = 0.363369 (v1.25.0),
2.10x the April v0.32.0 baseline (0.172748) under an identical protocol
(single-run point estimate, repeat-run stdev quantified; internal
before/after on hippo's own retrieval stack, not comparable to vendor
LLM-judge numbers).
Full table, regeneration commands, determinism characterization, and
Mem0/Letta context table: `benchmarks/LOCOMO_INVESTIGATION.md`.
**Effort:** 5d. **Success:** numbers published; comparison against Mem0 / Letta noted. Met.

### F8. Memory-Augmented Agent Eval benchmark [planned]
RESEARCH §"Near-term 1". 50-task / 10-trap standardised sequence. Compares no-memory baseline vs static memory (CLAUDE.md/AGENTS.md) vs full hippo.
**Effort:** 15d to design + harness. **Success:** hippo-equipped agents show downward trap-rate trend; static-memory agents flat. Released as open benchmark.

### F9. Hybrid-retrieval parity + competitive consolidation [shipped 2026-05-20, Gate-B FAIL on _s]

**Status update 2026-05-23:** SHIPPED via PR #27 (`feat/f9-hybrid-retrieval-parity`, 7 commits ab6c5eb..bd921b1). Phase 1 oracle: best `turn_asym` R@5=82.0 (+3.0 over dense-only 79.0); all 4 hybrid cells lift. Phase 2 `_s`: Gate-B FAIL @ 97.7 with best `turn_sym` R@5=50.8 (vs F14 baseline 41.0, +9.8 lift; ties F14+F9-Sonnet stack at zero LLM/API cost). HARD RETRACTION executed on artifacts per prereg discipline (`data/lme_s/` deleted, BM25 corpora deleted); result doc `docs/evals/2026-05-20-f9-hybrid-rrf-result.md` retained as negative-result audit trail. `src/rrf.ts` extracted from `src/search.ts` (behaviour-preserving refactor, commit 43966c5). `benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs` + `chunk_per_turn_hybrid_retrieve.mjs` shipped (commit c62df66). **Mechanism finding:** local hybrid fusion is the strongest locally-runnable lever measured — same R@5 as Sonnet rerank at zero inference cost. **Structural finding:** the locally-runnable BGE-base embedder is the `_s` ceiling, not the signal mix (corroborates F16). Path to clearing Gate-B on `_s` remains F17 (`text-embedding-3-large`, blocked on `api.openai.com` egress) or F9-on-top-of-richer-pool. Below is the original 2026-05-16 framing kept for historical context.

Triggered by a 2026-05-16 review of `rohitg00/agentmemory` (GitHub), an open agent-memory project that overlaps hippo's concept space heavily: SQLite-local, MCP-first, sleep-tiered 4-stage consolidation (Working→Episodic→Semantic→Procedural), write-time secret-scrubbing. Its README claims **95.2 % R@5 on LongMemEval-S** via **triple-stream retrieval** — BM25 + dense vector + knowledge-graph traversal, fused with Reciprocal Rank Fusion (RRF, k=60) and session-level diversification. These are the project's own README claims, unverified by hippo — treat as directional, not established.

**Why critical.** An independent open project corroborates what the F-track's own gbrain comparison target already shows: the frontier on LongMemEval `_s` is *hybrid retrieval + RRF fusion*, not pure-vector. Yet the entire F8–F18 retrieval experiment log has measured only (a) pure dense-vector retrieval and (b) vector + LLM-rerank. **The F-track has never measured BM25 + dense-vector RRF fusion locally** — even though hippo's own `recall` already combines BM25 + embeddings (see the F5 ability matrix) and both signals run inside the sandbox with no blocked egress. With the F16/F17 embedder paths dead-ending on egress limits, local hybrid fusion is the single highest-value retrieval lever still untried.

**Consolidate (table-stakes — reach parity with open projects):**
- **F-track hybrid-RRF experiment.** Pre-register a track fusing BM25 + BGE-base chunked-turn dense vectors via RRF on `_s` (and oracle for cross-comparison). **Success:** pre-registered, measurable R@5 lift over F14's pure-vector baseline (42.0 on `_s`); gbrain's published ablation (BM25-only 19.8, vector-only 97.4, hybrid 97.6) sets the expected shape. **Effort:** ~5d — reuses the F13/F14 chunked-turn index plus a local BM25 index; no blocked dependency.
- **Graph retrieval stream.** Once E3 `entities`/`relations` tables land, add knowledge-graph traversal as a third RRF input — the agentmemory pattern, and the HippoRAG idea already filed as F4. **Success:** graph-stream ablation measured against the 2-stream fusion. **Effort:** depends on E3.
- **Auto-capture hooks.** agentmemory captures with zero manual effort via SessionStart / PostToolUse / Stop hooks; hippo today needs explicit `hippo remember` / `capture`. **Success:** a Claude Code session auto-populates hippo with no manual call, opt-in. **Effort:** ~4d. Adoption lever, distinct from the retrieval gap.

**Differentiate (the moat — do NOT converge here):** agentmemory, gbrain, mem0 and Letta all do *static* hybrid retrieval over an effectively append-only store; none rank by memory *state*. Hippo's differentiated retrieval is *dynamic* — ranking modulated by decay half-life, strengthening history, supersession status, and goal-stack context. The B-track PFC modules (B1 ACC EVC-adaptive recall, B3 dlPFC goal-conditioned recall, B5 OFC option-value re-ranker) ARE that differentiated retrieval system. Frontier position: **table-stakes hybrid+RRF retrieval as the candidate generator, lifecycle-aware PFC-modulated re-ranking as the differentiator.** This is consistent with Bet #1 ("memory lifecycle is the moat, not retrieval quality") — hybrid retrieval is the parity floor, not the moat; the moat is what hippo does to the ranking *after* candidate generation, and what it forgets.

**Do NOT borrow:** agentmemory's "iii engine" substrate (HTTP-trigger / KV / stream primitives) — hippo has its own server-mode path (A1). Scope this item to retrieval architecture and capture ergonomics only.

---

## Track G — Long-horizon ML research (the bridge to hippocampal-circuits-in-LLMs)

RESEARCH §"Long-term vision" + §"Seven mechanisms" open problems. These are research bets, not product commitments. Hippo's data is the evidence base.

**Not part of the 90-day or 180-day execution plan.** Tracked here so the bridge from product data to architecture research remains visible. Productization of any G item requires a separate scoping pass and is gated on hippo-data-corpus volume (G8).

### G1. Adapter + base model continual loop [research]
LoRA captures deployment interactions; background process distils adapter back into base; reset adapter. Maps to D1.

### G2. Time-weighted training data curation [research]
Hippo's strength formula applied to training corpus weighting. Maps to D2.

### G3. Knowledge-RLHF [research]
Reinforce the *knowledge* that produced preferred outputs, not just the outputs. Hippo's `outcome --good/--bad` is the signal source. Maps to D3.

### G4. Error-prioritized replay for LLM training [research]
2-5x sampling on error-tagged interactions during continual training. Maps to D4.

### G5. Sleep cycle as training pipeline [research]
Periodic offline passes: compress -> merge -> brief fine-tune -> clear buffer. Sharp-wave ripple replay implemented as training infra. Maps to D5.

### G6. Curriculum-aware integration rate [research]
High schema-fit data uses higher LR, fewer epochs; novel data uses lower LR, more careful curriculum. Maps to D6.

### G7. Contradiction flagging pre-training [research]
Detect contradictions before training rather than averaging the signal. Hippo's conflict detection as prototype. Maps to D7.

### G8. Hippo data corpus [planned, gated on adoption]
RESEARCH §"What hippo collects that nobody else has". The asset:
- which memories matter over time
- outcome-labeled retrievals
- decay curves by domain
- consolidation patterns
- error taxonomy

Productize as opt-in research-data export once adoption supports it. Pre-req: A4 lifecycle compliance + A5 multi-tenancy.

---

## Track H — Cross-cutting research questions

These don't fit one phase but block confident decisions across multiple. Each is a deliberate "we don't know yet."

### H1. Goal-aware decay dynamics [research]
Should memories retrieved for goal A but producing a bad outcome decay faster, or persist as anti-pattern? Tests whether outcome valence and goal relevance should be coupled or decoupled. Blocks: B2 + B3 depth design.

### H2. Conflict resolution under uncertainty [research]
When ACC detects high-conflict + high-EVC, choose retrieval-depth expansion vs decision-deferral? What loss function guides this trade-off? Domain-dependent (safety-critical vs exploratory)? Blocks: B1 depth.

### H3. Self-model calibration [research]
How to prevent overconfidence in `competence_score` in domains where the model is genuinely weak? Compare agent self-assessments against objective task success across many sessions. Blocks: B6 (mPFC).

### H4. Cross-session transfer via semantic gates [research]
Do vlPFC-style suppression patterns learned for goal A transfer to semantically similar goal B? Transfer learning at memory-system level, not weight level. Blocks: D11.

### H5. Ambient state as behavioral proxy [research]
Does high ambient energy during low-EVC queries signal reduce-effort or healthy-exploration? Hippo's query+outcome dataset is unique for testing this. Blocks: C3 + C4.

---

## Track I — Generative memory (constructive episodic recombination)

The hippocampus does not only store and retrieve. During rest and sleep it replays and recombines stored fragments into novel constructions — the same constructive machinery that lets a person imagine a future scene they have never experienced, and the substrate of remote-associative insight ("connecting dots across unrelated fields"). A hippocampal memory system that only retrieves leaves its namesake mechanism unbuilt. This track builds the analog: spontaneous cross-domain ideation over hippo's own stored memories. Hippo itself was born from one such connection (neuroscience ↔ AI memory systems); Track I is hippo doing to its contents what that connection did to two fields.

**Differentiator:** agentmemory, mem0, Letta and gbrain retrieve and store; none *generate*. "Memory that has ideas" is a categorically different product, and it is squarely on the hippocampal thesis rather than a bolt-on.

**Dependency gate (binding):** Track I is gated on **E3 (typed entity/relation graph)** — this is the key milestone, not an optional accelerant. Embedding distance measures *semantic* distance; analogy is *relational* match, a different axis. "Hippocampus consolidates memory ↔ hippo consolidates memory" is an analogy because the relation matches across domains whose surface terms are embedding-distant. Finding such pairs is a graph-topology operation — semantically-distant subgraphs with isomorphic relational shape (Gentner structure-mapping) — that embeddings cannot do. An embeddings-only v1 is possible but "occasionally-surfaces" rather than "reliably-finds." See I4: E3 must additionally be built with a *domain-general relation vocabulary* or no cross-domain isomorphism is visible.

### I1. Incubation pass [research]
A new pass inside `hippo sleep`: sample memory pairs that are (a) mid-range in embedding distance — the "remote associates" band, far enough to surprise, near enough to mean something — and (b) biased toward pairs whose E3 subgraphs share relational topology with differing node types. An LLM judges each candidate: is there a non-obvious, useful connection, and if so, what is the hypothesis? Maps to constructive episodic simulation; reuses the existing sleep/idle-compute loop.
**Pre-req:** E3 typed graph (I4). **Effort:** 15d after E3. **Success:** on a pre-registered held-out set of memory pairs seeded with planted analogies + distractor non-analogies, the pass surfaces planted analogies at precision/recall measurably above an embedding-distance-only baseline.

### I2. Novelty/usefulness filter [research]
The make-or-break component. Most random recombinations are slop; too loose drowns the user in junk, too tight surfaces only the obvious. The salience gate (Track C) feeds the surfacing decision.
**Effort:** TBD (depends on I1 findings). **Success:** on a human-rated sample, conjectures the filter surfaces rate "non-obvious AND plausibly useful" at a pre-registered rate materially above the I1 embedding-distance-only baseline.

### I3. Conjecture lifecycle [planned]
Surviving connections are written as a new memory kind `kind='conjecture'` — tagged speculative, provenance pointing at both parent memories, **never auto-promoted to `distilled`**. Conjectures participate in normal decay/strengthening: one the user acts on is strengthened; one ignored decays out. This is Bet #1 applied to creativity — ideas earn persistence, and ideas that do not pan out are forgotten.
**Pre-req:** A3 envelope + E3. **Effort:** 8d. **Success:** a conjecture acted-upon by the user is strengthened and survives ≥ N sleep cycles; an ignored conjecture decays below the recall threshold within N cycles.

### I4. E3 domain-general relation vocabulary [research, feeds E3]
A spec constraint on E3's relation extraction, surfaced here so E3 is built recombination-ready rather than retrofitted. The same relation concept (e.g. "X consolidates Y") must receive the same relation type across distinct knowledge domains, or relational isomorphism between domains is invisible.
**Effort:** folded into E3 design. **Success:** a relation-typing audit shows one relation concept receiving a consistent type across ≥ 3 distinct knowledge domains in the corpus.

**Discipline note (binding).** Track I produces unverifiable speculative claims by design — it collides with `docs/RETRACTION.md`'s "earn persistence / do not assert what you cannot verify." The resolution is quarantine: conjectures are explicitly speculative, never auto-promoted, and must earn their way up through use. Any release framing must say hippo's recombination *surfaces candidate connections*; it does not assert them as facts. This keeps Track I consistent with the retraction discipline rather than exempt from it.

---

## Track J — Cognitive diagnostics (biases-over-memory-state)

Existing agent-memory systems retrieve (D) and store. Track I generates. Track J *flags*: pre-recall and post-recall diagnostics that score the query + current memory state for known cognitive-bias surfaces and emit soft warnings the calling agent can choose to act on. Distinct from the cognitive-biases-in-LLMs literature (anchoring in GPT-4, etc.) which studies the model itself; this is biases over the *memory substrate* the model retrieves against. Hippo's lifecycle metadata (decay state, conflict pointers, retrieval history, schema-fit, sleep-cycle accounting) is the unique signal source -- no other agent-memory system has the substrate to do this.

Inspired by Kahneman's *Thinking, Fast and Slow* (2011) and the Tversky-Kahneman heuristics-and-biases program (1974), but the framing is **biases-over-memory-state** rather than dual-process (which Track C Pineal Gland + B1 ACC already cover via the more rigorous PFC / neuroscience substrate). TFAS vocabulary is not used in user-facing surfaces -- the neuroscience-rigor framing is an explicit moat (RESEARCH §"Strategic positioning"); TFAS is the *concept source*, not the *brand*.

**Differentiator:** adds a fourth verb to the lineage -- Track D retrieves, Track E consolidates, Track I generates, Track J diagnoses. "Memory that notices when the calling agent is about to fool itself" is a categorically different surface than retrieval-quality benchmarks measure.

**Dependency gate (binding):** built on existing PFC plumbing rather than a parallel stack. J3 needs the `prediction` first-class object (E2 row above). J4 needs C4 fast-path landing. J1 / J2 / J5 / J6 / J7 stand alone.

### J3. Reference-class / planning-fallacy detector [shipped v1.13.1 + v1.13.4 + v1.14.0]
When the agent makes a forward-looking claim ("this will take 2 days", "the change is low-risk", "rollout in 1 week"), hippo automatically surfaces base-rate stats from closed `prediction` objects in the same class: "your last 5 estimates in class `migration-effort` averaged 2.1x actual". Direct application of Lovallo-Kahneman (2003) inside-vs-outside view; no agent-memory competitor tracks ex-ante claim closure against ex-post outcome.
**Pre-req:** E2 `prediction` object. **Effort:** 6d after pre-req. **Success:** on a 30-task estimation workload, agent-side estimates with J3 active have lower mean absolute error than without; paired Wilcoxon p<0.05.

### J1. Anchoring detector [shipped v1.13.2]
Flag when a query phrase reuses a stale top-1 result from the last N recalls, OR when one memory has been top-result for >N consecutive semantically-distinct queries in a session. Surface as `[anchored_on: mem_xyz]` in `recall --why`. **Effort:** 4d. **Success:** on a synthetic 50-trace test set with planted anchoring sequences, J1 fires at >80% precision and >60% recall vs hand-labeled.

### J-Wire. Agent-prompt wiring + dogfood validation [done 2026-05-27: dogfood 8/9 organic read-rate, no system-prompt addendum needed]
Track J ships *soft warnings* on `RecallResult`: C5 `suppressionSummary` (v1.13.0), J3.2 `planningFallacyHint` (v1.13.1), J1 `anchoringHint` (v1.13.2). All three are passive fields the calling agent must KNOW to read. No agent prompt today instructs Claude to scan them on every recall, which means the warnings may ship dark. Before J5 / J2 / J6 / J7 add more detectors to the same unread surface, prove (or disprove) that the existing three reach the agent. **Deliverable:** MCP-host system-prompt addendum + dogfood diary capturing whether Claude organically references each warning. **Effort:** 1-3h smoke test; 1-2d wiring if smoke test confirms warnings do not surface organically. **Success:** during dogfood, >=1 instance of Claude either (a) quoting the warning verbatim, (b) changing recommended action based on it, or (c) asking the user to confirm in light of it. Failure -> ship J-Wire prompt addendum, then re-run dogfood. **Blocks:** J5, J2, J6, J7 (do not ship more Track J detectors against an unread surface).

### J2. Availability-bias detector [shipped v1.14.0]
Flag when top-K is dominated by recent entries (>70% in last 24h) on a query class whose historical answers have averaged older. Uses tag-class base rates from `audit_log`. **Effort:** 4d. **Success:** on the LongMemEval temporal-reasoning slice, fires on queries whose correct-answer `created` predates top-K median by >X days at >70% precision.
**Shipped v1.14.0** as Framing B+: compares the returned top-K age distribution against the same query's MATCHED candidate pool (`src/availability.ts` `detectAvailabilityBias`), soft warning only on `RecallResult.availabilityHint`, per-pipeline. The `audit_log` tag-class historical-answer-age base rate is deferred to follow-up J2.2 (cold-start + complexity; mirrors J3.1 -> J3.2 incremental shipping).

### J4. Substitution detector [research]
Detect when an agent's recall query is a heuristic substitute for the harder question being asked. Concretely: query embedding is >cos 0.4 from any cluster centroid but a high-strength fast-path hit exists at a different abstraction -- flag that the agent may be answering an easier related question. **Pre-req:** C4 fast-path. **Effort:** TBD. **Success:** human-labeled accuracy on a 100-query substitution test set >65% precision.

### J5. Loss-aversion calibration [shipped v1.13.5]
TFAS empirics: losses loom ~2x larger than equivalent gains. Hippo's current emotional multipliers are error=1.5 / success=1.3 (nearly symmetric, slightly wrong direction). Move default to error=2.0 / success=1.0; expose `HIPPO_LOSS_AVERSION_RATIO` env var for per-domain tuning. Tiny code change; the framing + calibration eval is the contribution. **Effort:** 1d code + 2d eval. **Success:** retrieval-relevance of error-tagged memories at 30d holds at >baseline; success-tagged memory recall does not regress on tier-1 micro-eval.

### J6. Cognitive-load-aware EVC [planned, B1 extension]
Add `turns_since_last_sleep` as a fatigue scalar in B1's EVC formula. When fatigue > threshold, lower the System-2-escalation threshold (force more deliberate retrieval). TFAS: System 2 over-trusts System 1 under cognitive load; hippo's sleep accounting is the natural fatigue proxy. **Effort:** 3d. **Success:** A/B on a sleep-deprived synthetic workload (no sleep cycle for >20 turns) shows fire-rate non-regression with J6 on; off-baseline shows the expected degradation.

### J7. Peak-end outcome weighting [planned, B2 extension]
Strength formula today uses cumulative reward ratio. TFAS remembering-self: peak intensity + final state dominate, not average. Add `peak_outcome_magnitude` to `memory_value_association`; weight peak ~equally with cumulative so one critically-correct recall counts heavily without needing many mild successes to average up. **Effort:** 2-3d. **Success:** memories with one critical-positive outcome survive 30d decay; equivalent memories with twenty mild-positive outcomes also survive (within 10%).

### J8. Bias-detector composition matrix [research]
Do J1-J7 compound or cancel? J1 (anchoring, recurrence-biased) + J2 (availability, recency-biased) can fire on the same query in opposite directions. Documented interaction matrix per pair; recommended default-on combinations. **Effort:** 5d after J1-J7 ship.

### Discipline note (binding)
J1-J8 emit *soft warnings* the calling agent decides whether to act on; hippo never auto-rewrites a recall result or suppresses a memory based on a bias score. Same quarantine logic as Track I conjectures: surface, don't assert. Detector firing rates are observability-first; precision/recall reported in `recall --why` and the brain observatory dashboard, never silently applied as a filter. This keeps Track J consistent with `docs/RETRACTION.md` discipline.

**Wire-or-don't-ship discipline (added 2026-05-27):** detectors land on the response payload AND in the MCP host system prompt within the same arc; the next-J item never ships against an unread surface. J-Wire dogfood gates J5+.

---

## Track K — Knowledge-graph interop (PKM bridges)

Hippo already builds a typed knowledge graph (Track E3: `entities`/`relations` over consolidated state). External personal-knowledge-management tools (Obsidian, Logseq, org-roam, ...) build their *own* graphs over markdown + `[[wikilinks]]`. Track K bridges the two — but every direction routes through the existing raw→distil→graph pipeline so no Bet is violated.

**Reframe (the unit of work is the open format, not the app).** Research scan (2026-06-02, sourced below) says: do NOT build 14 connectors. A single **Markdown + `[[wikilinks]]` vault adapter** covers the common markdown+wikilink subset of Obsidian (~1.5M MAU — fueler.io / BigGo), Foam, and Dendron with one adapter; the per-dialect specifics (Dendron dot-hierarchy filenames, Obsidian block refs / embeds / Canvas, Foam's near-plain markdown) are fixture-gated extensions on top, not separate connectors. **JSON Canvas** (`jsoncanvas.org`, MIT spec, `nodes[]`/`edges[]`) gives a free visual-graph export that opens natively in Obsidian. **org-roam** (`.org` + `[[id:...]]`, SQLite is a derived cache) covers the Emacs cohort. So the roadmap is "2 local-file adapters + 1 canvas exporter + optional cloud later," not 14 integrations. Cloud-only tools (Notion/Roam/Tana/Capacities/Reflect/Mem/Heptabase) require accounts + OAuth and several have crippled surfaces (Reflect is append-only and can't read note bodies; Tana is write-mostly; Capacities' API is immature) — deferred; Notion ingestion is already E1.6.

**Two directions, two Bets.**
- **IMPORT (vault → hippo):** ingest a vault's markdown as `kind='raw'` receipts (Bet #3 read-mostly; reuses the E1.x connector pattern — idempotency, cursor/backfill, source-deletion sync). `hippo sleep` then distils them and E3.1 proposes `entities`/`relations`. Wikilinks become relation *candidates* the sleep extractor proposes with provenance — never auto-asserted edges, never direct graph writes (E3.3 / Bet #5).
- **EXPORT (hippo → vault):** project hippo's *consolidated* E3 graph as a wikilinked markdown vault + a `graph.canvas` (JSON Canvas) file — a read-only, regenerable **view** (Bet #3; non-goal #8 human-approved write-back). Delete it and re-run export to rebuild it. The vault is a projection, not a system hippo shadows.

### K1. Markdown-vault + `[[wikilinks]]` importer [next]
Extend `src/importers.ts` (already imports ChatGPT/Claude/Cursor/generic-md) with a **baseline** vault-folder adapter over the common markdown+wikilink subset: frontmatter→A3 envelope mapping, `[[wikilink]]`→relation-candidate parse, idempotency on `(path, content-hash)`, source-deletion sync (vault file deleted → memory invalidated, GDPR per E1.x). Provenance `source=vault:<name>`. Per-dialect features (Dendron dot-hierarchy filenames, Obsidian block refs `^id` / embeds `![[...]]` / Canvas, Foam's near-plain markdown) are explicit fixture-gated extensions, not assumed to "just work."
**Effort:** 6-8d. **Success:** a per-dialect fixture vault (Obsidian, Foam, Dendron) each imports with ≥95% notes as raw + full provenance and no parser crash on dialect-specific syntax; re-import idempotent (0 dups); deleting a note invalidates its memory; wikilinks surface as E3.1 relation candidates at the next sleep.

### K2. Consolidated-graph → markdown + JSON Canvas exporter [planned, blocked-on-E3.1]
New read-only consumer of the E3 substrate (mirrors `src/graph-recall.ts`). Walks `entities`/`relations`, emits one `.md` per entity with `[[wikilinks]]` to neighbours + a `graph.canvas` for the visual graph. **Why blocked-on-E3.1, not [next]:** today the graph holds only `supersedes` edges (see `graph-recall.ts`), so a real knowledge-graph export needs E3.1's cross-object edges (owns/depends-on/blocked-by/references) first — the "knowledge-graph connection" is only as rich as E3.1's extraction. Split accordingly: **K2a thin supersession-export** (doable now, low value) vs **K2b full PKM graph export** (after E3.1, the actual deliverable).
**Effort:** 5-7d (K2b). **Success:** the exported `graph.canvas` edge set exactly equals tenant X's consolidated `relations` rows (zero raw-source rows, E3.3 guard test); idempotent re-export; opens in Obsidian with the graph visible.

### K3. Obsidian Local REST API live adapter [planned]
Section-level live read/write via the community Local REST API plugin, for users wanting continuous hippo↔Obsidian sync rather than batch export. Gated behind human-approved write-back (non-goal #8); avoid the known POST-overwrite data-loss bug (issue #237) by using PATCH/section-targeting.
**Effort:** 5d. **Success:** live-update a note section from a hippo supersession without clobbering unrelated content; opt-in, off by default.

### K4. Logseq adapter [planned]
Markdown-graph folder (reuses K1) + token-gated Local HTTP API; block-reference granularity maps onto fine-grained memories. The new Logseq DB (SQLite) version is a separate later target — do the markdown-graph format first.
**Effort:** 6d. **Success:** import a Logseq markdown graph; block refs become relation candidates.

### K5. org-roam adapter [research]
`.org` files + `[[id:...]]` links; files are the source of truth, `org-roam.db` is a derived cache (do not write the cache).
**Effort:** 5d. **Success:** import/export `.org` with id-links round-trips.

### K6. Cloud PKM connectors [deferred]
Notion (official hosted MCP; ingestion already E1.6), Roam (Graph API / EDN), Tana (Input API, write-mostly), Capacities (immature REST). Revisit per buyer pull — account/OAuth requirement violates the local-first weighting (Bet #2).

**Discipline note (binding).** Import = raw receipts only, never direct graph writes (E3.3 + Bet #5); export = read-only projection of consolidated state, never autonomous write-back into a user-edited vault (non-goal #8). Imported wikilinks are relation *candidates* (provenance-tagged), never auto-asserted edges: a candidate promotes to an `entities`/`relations` edge only when *both* endpoints are already consolidated E3 objects, and a regression test asserts raw-imported links never write `entities`/`relations` directly — preserves graph-on-consolidated quality (E3.3 + Bet #5). Import fidelity tracked per RESEARCH §"Cross-tool import fidelity": measure what fraction of imported notes survive 30d decay+sleep, and consider a reduced starting half-life for bulk imports so a dumped vault doesn't crowd out earned memories (Bet #1).

**Sources:** Obsidian MAU/format [fueler.io], [coddingtonbear/obsidian-local-rest-api]; JSON Canvas [jsoncanvas.org] (MIT); Logseq [github.com/logseq/logseq] (~43k★) + [db-version.md]; org-roam [orgroam.com/manual]; Notion hosted MCP [developers.notion.com/guides/mcp]; Reflect append-only [reflect.app/blog/reflect-update-api]; Tana Input API [tana.inc/docs/input-api].

---

## Track L — Latent memory: layer, not substrate

A recurring question: should hippo adopt "latent memory" as a new layer, or as its **key feature**? This track settles it with a debate, then files the surviving pieces as scoped items. (Paper lineage cross-refs `RESEARCH.md`; all citations verified 2026-06-02.)

**What "latent memory" means (verified).** A spectrum, not one thing: (1) **vector/embedding** memory — external store, lossy-encode but inspectable via the source text, rebuildable; (2) **KV-cache** memory — lives in GPU RAM, opaque, rebuildable by replay; (3) **parametric/test-time** memory written to weights/fast-weights — opaque, lossy, not cleanly rebuildable: **Titans** (Behrouz et al., Google, arXiv 2501.00663), **Memory Layers at Scale** (Meta FAIR, arXiv 2412.09764, ICLR'25); (4) **distilled-KV cartridges** — trained KV, opaque, rebuildable by re-distill: **Cartridges** (Stanford Hazy, arXiv 2506.06266); (5) **neural memory modules** — NTM lineage (arXiv 1410.5401), **Larimar** (IBM+Princeton, arXiv 2403.11901), **Memory³** (arXiv 2407.01178), **Memorizing Transformers** (arXiv 2203.08913), **RMT** (arXiv 2207.06881).

**What hippo already has.** The *weak* form is shipped: recall is hybrid BM25 + BGE-base dense vectors fused with RRF (`src/rrf.ts`, F-track) — a **derived embedding index over the markdown of record**. So "add latent memory as a layer," in the vector sense, is done. The live question is the *strong* forms (KV/parametric/cartridge): substrate or layer?

### The debate

**FOR latent-as-key-feature (steelman).** The frontier moved. Titans (2501.00663) learns to memorize *and forget* at test time via gradient on its own memory weights — that is hippo's decay+strengthening thesis in parametric form, at >2M-token context. Cartridges (2506.06266) distil a corpus into a small trained KV cache for ~26x throughput. Memory Layers (2412.09764) beat 2x-compute dense models on factual recall. Latent delivers associative/fuzzy/multimodal/cross-lingual recall that grep + a small embedding index cannot. Competitors are vector/graph-core and growing — Mem0 (57.4k★, hybrid vector+graph), Zep/Graphiti (26.9k★, temporal graph), Letta (23.1k★, vector archival) — and a purely symbolic store risks looking dated on LongMemEval/LoCoMo, exactly where the F-track's local-embedder ceiling (F14–F16 R@5 plateau on `_s`) already bites. The biological metaphor arguably maps *more* cleanly onto a parametric fast-weight memory than onto markdown files.

**AGAINST (and FOR latent-as-optional-layer).** It contradicts the founding bet. Bet #7 already states it: "MH-FLOCKE proves the sub-symbolic version works; hippo proves the symbolic + inspectable version is the right substrate." The competitive scan (verified) is decisive: Mem0, Zep, Letta, Cognee all store memory as embeddings/graph nodes in opaque DBs; **none** combine human-readable markdown-of-record + single-file local SQLite + biological lifecycle. That triple intersection is hippo's *entire* white space — latent-as-substrate walks into the red ocean. Three further failures: **(a) portability dies** — KV/weights are tied to a model's dim/tokenizer/architecture; you cannot migrate them across models or git-diff them (kills Bet #2 and the Track K multi-tool import thesis). **(b) the lifecycle moat is only legible over symbolic memory** — `supersede`-with-reason, A3 provenance envelopes, C5 WYSIATI "what was excluded and why," the A5 audit log, Track J soft-warnings all require inspectable, addressable units; you cannot supersede-with-reason or audit a region of opaque weights (kills Bet #1 and Bet #4 trust-over-recall). **(c) local-first feasibility** — the vector index is trivial (shipped), but KV/parametric/cartridge memory needs training loops + VRAM, dragging the zero-dep core toward a heavyweight GPU backend (non-goal #5) and toward becoming an inference provider (non-goal #6); the F-track already documents that even a *stronger embedder* is egress/compute-bound locally (F16–F17), and a training loop is a far bigger ask.

### Recommendation

**Two questions, kept separate (so the verdict isn't read as dodging the F-track).** (a) *Retrieval capability gap* — is recall good enough? Real and open: the F-track R@5 plateaus on the `_s` split and latent techniques could lift it. (b) *System-of-record substrate* — what holds the canonical memory? These are independent. The recommendation answers (b) "no" while keeping (a) wide open via L1/L2 — better recall is welcome, it just doesn't get to own the source of truth.

**Latent memory is a LAYER, never the substrate.** Three rules + three scoped items:
- **Rule 1 — the memory of record stays symbolic** (markdown + SQLite). Non-negotiable; it is the moat (Bets #1/#2/#4/#7).
- **Rule 2 — every latent form is a derived, rebuildable index/accelerant** over the text-of-record, never the source of truth. Delete any latent artifact and `hippo sleep` regenerates it. (This is exactly how the embedding index already behaves.)
- **Rule 3 — latent forms that cannot be made rebuildable-from-symbolic-state** (parametric memory written to weights) do not enter the product; they live in Track G research only.

#### L1. Graph-retrieval stream into RRF [shipped v1.21.0]
A **new** graph ranked-list *producer* that feeds `src/rrf.ts` as a third fusion input beside BM25 + dense — distinct from `src/graph-recall.ts`, which today does seed-adjacent injection with a per-hop score discount (not a ranked list, and not RRF-fused). Already filed (F-track "graph retrieval stream" + F4 HippoRAG). Pure win, no new substrate. Spec needed: the graph-score→rank function, the RRF weight/`k` for the graph stream, and tests. **Success:** a graph-stream-vs-no-graph-stream ablation under `rrf.ts` fusion lifts R@5 over the 2-stream (BM25+dense) baseline on the oracle split. Cross-ref F9.

#### L2. Sleep-built KV "cartridge" over the consolidated semantic layer [research]
The one strong-latent form that fits the Bets. At `hippo sleep`, optionally distil the *stable semantic store* into a reusable trained-KV cartridge (Cartridges, 2506.06266) for fast, cheap recall over a large stable corpus. Fits because it is (i) built offline during sleep (Bet #6), (ii) derived from consolidated symbolic state (Bet #5), (iii) rebuildable — delete it and the next sleep regenerates it (Rule 2), (iv) opt-in + GPU-gated (local core stays zero-dep). Candidate **5x-cost lever for the scale grant** (ROADMAP.md WP1: 1M+ items, sub-100ms, 5x cost reduction vs vector RAG).
**Gated on a feasibility spike** that must answer the open unknowns before any roadmap promotion: tokenizer/model binding (which local model the cartridge is keyed to), artifact size per 100k items, rebuild time per sleep, GPU-VRAM floor, invalidation strategy on supersession/decay, and the tenant privacy boundary. **Success:** the spike *pre-registers* its thresholds (corpus size, hardware, latency, rebuild-time, and the hybrid-RRF R@5 baseline it must match or beat) before any build, satisfying the doc's cut-criteria; promotion out of `[research]` requires hitting them. **Discipline:** the cartridge never becomes the source of truth and never indexes the raw layer.

#### L3. Parametric test-time memory (Titans-style) [research → Track G]
Titans' learn-to-memorize/forget-at-test-time is hippo's D2 decay + D3 strengthening in parametric form — but it lives in weights (opaque, non-portable, non-rebuildable), failing Rule 3 for the product. File it where it belongs: the **Track G** bridge (hippocampal-circuits-in-LLMs), as the parametric realization of D2/D3. NOT a product layer. Cross-ref G1/G2/G3 and Deferred #2 (post-transformer integration).

**Binding output:** the debate adds non-goal #10 below (latent/parametric memory as the system of record). Outside-voice review (`/plan-eng-review` or `/codex`) on Tracks K and L is the natural gate before either item leaves `[research]`/`[next]`.

---

## Sequencing (next 90 days, single-engineer cadence)

**Sequence revised after Codex + eng-review (consolidated patch).** Original sequence had Wks 1-4 over-budgeted ~3x and put A1 server before A3 provenance, despite A3 being a prerequisite for E1 ingestion. Cut to 4 items max for 90 days; everything else moves to days 91-180.

### Effort & calendar reconciliation
Weeks of work (calendar) for Wks 1-12, single engineer, assuming 4 productive days/week:
- A3 envelope: 6-8w
- A5 stub auth (single-tenant API key path, multi-tenant deferred): 2-3w
- A1 server: 4w
- E1.3 Slack ingestion (with idempotency, cursors, source-deletion sync, permission mirroring): realistic 4-5w (not 12d)

Total: 16-20 weeks of work compressed to 12 weeks calendar. Lane B parallelism (F6 reranker, F7 LoCoMo) buys some recovery; the budget is still tight by design.

### v0.33 → v1.11.4 arc (2026-04-23 → 2026-05-23) — 90-day plan delivered

The original Weeks 1-12 plan landed in 30 calendar days through 32 npm releases. Shipped in dependency order: A3 envelope (v0.39), A5 stub auth (v0.34-v0.35), A1 server (v0.36), E1.3 Slack ingestion (v0.37), F6 reranker hardening (v1.9.0), E1.4 GitHub ingestion (v1.3.0), A2 HTTP API completion (v1.11.4), Python SDK A12 (python-v0.1.0). Plus v1.10.x lifecycle hardening, v1.11.0 tenant-isolation + rate-limit, v1.11.1 isolation residue, v1.11.2 opencode plugin installer fix, v1.11.3 api.ts refactor.

### Next 90 days (2026-05-23 → 2026-08-23) — priority queue

Priority overlay: short post-ship tail first (close the Episode A/B/C critic-deferred items), then the structural leverage items.

1. **Episode A/B/C tail → v1.11.5 / v1.12.0** (~5d): HTTP DoS caps on `/v1/outcome` ids.length + `/v1/context` q length; per-tenant `/v1/sleep` scoping decision (admin-role gate or plumb `ctx.tenantId` into `deduplicateStore` + `auditMemories` + `deleteEntry`); `audit_log` emission on sleep consolidation phases; `api.recall` last-retrieval-ids parity with `cmdRecall`; CLI render snapshot tests for `printContextMarkdown` + `renderSleepResult`.
2. **~~F9 hybrid retrieval — first measurement~~ — DONE 2026-05-20 (PR #27).** See F9 §status update for full result. Follow-up candidates from the F9 result doc §"Next steps": (a) F9 + F13-stacked rerank on oracle (plausible +3pp to ~89.8 R@5), (b) per-type-routed ensemble (~+4-5pp on oracle at no inference cost), (c) F17 if `api.openai.com` egress ever opens.
3. **Conflict-subsystem tenant-isolation residue** (~3d): audit and tenant-scope the unscoped `readEntry` / `loadSearchEntries` call sites in `cli.ts` / `dashboard.ts` / `refine-llm.ts` (deferred from v1.11.0 because half-scoping without first scoping upstream `loadAllEntries(hippoRoot)` would silently drop parent text).
4. ~~**Python SDK v0.2**~~ — **SHIPPED** v0.2.0 (2026-05-24) + v0.3.0 (2026-05-28). 204 handling deferred-by-design.
5. **v0.26 UI redesign** — *partial / diverged*: an Obsidian-inspired graph revamp shipped (E1-E5, v0.2.0-v0.2.5) + parchment tokens (not fully wired); the hybrid-v4 3D-sky mockup was not pursued. Open: keep/drop the hybrid-v4 direction + finish wiring components to the parchment tokens. Track in TODOS.md "v0.26 — UI Redesign".
6. **B1 ACC EVC calibration, B3 dlPFC goal-stack depth (already shipped MVP+depth)**: B-track depth items are research-not-enterprise — re-prioritise only after platform items 1-5 above.
7. **E2 first-class objects**: `decision` **shipped v1.15.0**, `prediction` **shipped v1.13.0**, `handoff` built (session-scoped). Remaining: incident / process / policy / skill / project_brief / customer_note (~4-7d each).

### Days 181+ (Aug 2026 onwards) — research and platform
- A6 Postgres backend (only when a hosted customer requires shared deployment)
- A7 observability dashboard
- A8 framework adapters (grant: AIC-P1 if funded)
- A9 scale to 1M+ (grant: AIC-P1 if funded)
- A10 managed cloud
- A11 convergence proofs (grant: FAD if funded)
- B6 mPFC self-model
- E3 graph layer (E3.3 invariant lands with A3, but E3.1 / E3.2 wait for first-class objects to exist)
- F1, F2 MemPalace borrows
- F8 Memory-Augmented Agent Eval
- All Track G research lines

**Cadence note:** Single-engineer sequence. With two engineers, parallelize Lane A (A3 → A5 → A1 → E1.3, all touch `src/db.ts`) against Lane B (F6 reranker, F7 LoCoMo, observability scaffolding). With grant funding, A8 + A9 split out under WP3 + WP1.

**Why this sequence:** A3 is a prerequisite for everything in Track E (E1 ingestion needs envelope), Track B depth (new tables need provenance from day 1), and A5 (auth scopes ride on the envelope). Codex correctly flagged the original ordering as putting research items (B3, F6) ahead of enterprise prerequisites. Eng-review math showed even the original ordering was 3x over its 4-week window.

---

## Bets

1. **Memory lifecycle is the moat, not retrieval quality.** Compete on what hippo forgets, not what it stores. Other systems will close the retrieval gap; few will commit to forgetting as a feature.
2. **Local-first stays the default.** The OSS local CLI never gets worse. Hosted is for teams that need it.
3. **Ingestion is read-mostly.** Hippo never replaces source systems. We distil; we don't shadow.
4. **Trust > raw recall numbers in enterprise sales.** Audit, supersession, provenance, confidence beat benchmark scores when buyers evaluate.
5. **Graph sits on consolidated state, never raw text.** This is the only way graph quality stays high and cost stays sane.
6. **Hot path stays cheap.** Heavy LLM extraction, graph building, skill synthesis happen during sleep / background. Recall stays fast unless the query genuinely needs deeper traversal.
7. **Symbolic memory plus inspectability is durable.** MH-FLOCKE proves the sub-symbolic version works; hippo proves the symbolic + inspectable version is the right substrate for LLM agent knowledge management.

---

## Explicit non-goals

Things hippo will not do. Each one is a deliberate position derived from the product thesis (memory lifecycle is the moat; we distil, don't shadow; trust over raw recall). Source documented per item.

**What makes something a hard non-goal:** doing it would either contradict the moat thesis (lifecycle / forgetting), force the local-first core to compromise for enterprise scale, or duplicate a system of record we should integrate with instead.

| # | Non-goal | Why | Source |
|---|----------|-----|--------|
| 1 | Browser-automation as primary ingestion | Brittle, slow, breaks on UI changes; APIs / webhooks / exports always exist | RESEARCH §"Phase 3" |
| 2 | Always-on graph over uncurated raw text | Graph quality dies under noise; graph stays on consolidated entities only (E3.3) | RESEARCH §"Phase 3" |
| 3 | Replacing Slack / Jira / GitHub / Notion / email as systems of record | Hippo distils; doesn't shadow. Source systems stay canonical | RESEARCH §"Phase 3" |
| 4 | Auto-rewriting company truth without provenance + approval paths | Compliance disaster. Every truth change must be `supersede`d with reason and provenance | RESEARCH §"Phase 3" |
| 5 | Forcing the zero-dep local core to be the heavyweight enterprise backend | Compromises local UX. Hosted enterprise is a separate deployment mode (A6 Postgres optional) | RESEARCH §"Phase 3" |
| 6 | Becoming an inference provider (custom LLM hosting as a product) | Hippo is memory infra, not inference infra. Customer-supplied LLM endpoints (extraction, reranking, regulated deployments) are explicitly supported | thesis-derived; rephrased after Codex review |
| 7 | Retaining everything forever | The thesis is *better forgetting*. Decay, supersession, and consolidation are features. This does not mean underperforming on correct recall of what is retained | RESEARCH §"Phase 3", RESEARCH §"forgetting is a feature" |
| 8 | Autonomous write-back / actuation into source systems in V1 | Every write-back to Slack/Jira/Gmail/etc. must be human-approved. RESEARCH §"Phase 1" says write-backs stay human-approved. Auto-actuation invites compliance disasters and trust failures | RESEARCH §"Phase 1: safest bridge" |
| 9 | Employee-surveillance / compliance-archive product | Hippo helps agents do the work, not record people. Surveillance use cases are out of scope and will be refused | thesis-derived (eng-review) |
| 10 | Opaque, non-rebuildable, or model-locked latent/parametric artifacts as the *system of record* | Such artifacts (weights, or KV/vectors that cannot be regenerated from the markdown) are non-portable + non-auditable and destroy the lifecycle + inspectability moat (Bets #1/#2/#4/#7). ALLOWED as derived caches: rebuildable latent artifacts over the markdown of record (Track L Rule 2), including the L2 sleep-built KV cartridge | Track L debate 2026-06-02 |

## Deferred / speculative

Things hippo might do later. Not active scope, not non-goals. Each item names the condition under which it gets revisited.

| # | Item | Revisit when |
|---|------|--------------|
| 1 | Cross-modal memory (text + vision + action) | Core text product is at v1.0 + has paying customers; vision-language modeling is a separate problem |
| 2 | Post-transformer architecture integration (Mamba / RWKV / future) | D1-D7 ML research lines mature; current architecture saturates a measurable bottleneck |
| 3 | On-device hippo (mobile / edge) | Hosted product is shipping; embedded agents become a buyer-pulled use case |
| 4 | A7.2: unify the cli/api/mcp recall re-ranking pipelines + MCP primary-band rerank-trace | A7 recall-trace (v1.18.0) surfaced that only `applyGoalStackBoost` is shared across the three pipelines (cli applies interference/value/OFC/reranker/downweight that api + mcp do not), so a recall ranks differently per surface. Unifying them is a hot-path refactor needing its own plan + outside-voice; until then the trace honestly reports each pipeline's own stages via `rerankPipeline`. See `docs/plans/2026-06-02-a7-recall-trace.md`. |
| 5 | ~~Anchor graph entity/relation provenance to the authoritative E2 object~~ **SHIPPED v1.22.0 (migration v38).** In-force E2 objects (decision/policy/customer_note/project_brief) now stay in the graph after their mirror memory is forgotten or consolidation-pruned; provenance anchored to the authoritative E2 row, the no-raw guard extended to accept E2-object provenance, no cascade/block on forget. Two follow-ups remain open (tenant-level rebuild signal; recall-surfacing) — see the E3 shipped-status block above + `TODOS.md`. See `docs/plans/2026-06-03-graph-e2-provenance.md`. |
| 6 | Agent-maintained codebase map: per-directory structural summaries agents update as they touch code, so future sessions navigate without re-exploring (the "MD version of my codebase" pattern circulating on X, 2026-07; naive loose-MD version rots — hippo's decay/invalidate machinery is the differentiator) | An agent workload shows measurable re-exploration cost (repeated Glob/Read of unchanged dirs across sessions); prototype as a consolidation output over path-tagged memories before adding any new store surface |

---

## Cut criteria (when something currently scoped gets cut)

A feature gets cut from the active list if any of:
- No measurable success criterion within 2 weeks of starting
- Two consecutive sprints with no benchmark movement after merge
- Conflicts with a non-goal listed above
- Becomes blocked by a research question (H1-H5) without a clear path to resolve

Reviewed at end of each 4-week cycle by reading the A/B harness ledger; cuts logged in `docs/plans/cuts.md`.

---

## Cross-references

- `RESEARCH.md` — full research narrative; this roadmap derives from it
- `ROADMAP.md` — grant-funded deliverables (FAD + AIC-P1 + ARIA) only. Execution claims removed; this file is the source of truth for non-grant sequencing. Drift between the two documents is a bug.
- `PLAN.md` — architecture, CLS principles, strength formula. Note PLAN.md:285 says hybrid embeddings shipped; F6 scope corrected to reranker-only above.
- `docs/plans/2026-04-28-company-brain-measurement.md` — measurement-first scorecard
- `docs/plans/2026-04-21-hippocampal-mechanism-audit.md` — coverage audit
- `docs/plans/2026-04-23-extraction-dag-multihop.md` — multi-hop retrieval foundation (shipped)
- `docs/plans/2026-04-22-bi-temporal.md` — supersession + `--as-of` (shipped)

---

## Part III - 2026-06-09 update: LongMemEval per-haystack correction + lifecycle pivot

Added 2026-06-09 after re-measuring LongMemEval-S retrieval correctly (per-question haystack) and validating the v1.23.0 pluggable embedding provider at 199k-turn scale. Full data + reproduce steps: `docs/evals/2026-06-09-longmemeval-per-haystack-dual.md`. These items follow an outside-voice (senior-code-review) pass; the revisions are folded in. Items are named descriptively to avoid collision with the lettered tracks above.

### Correction: F-track `_s` was global-pool; dual-number publish [critical, shipped]

The Part II F-track concluded "the locally-runnable embedder is the structural ceiling on `_s`; only `text-embedding-3-large` (F17) closes the gap to gbrain's 97.6." That was a **global-pool measurement artifact**: the harness (`chunk_per_turn_retrieve.mjs`, `chunk_per_turn_hybrid_retrieve.mjs`) ranked each answer session against all 19,195 `_s` sessions, with no per-question haystack filter. Standard LongMemEval-S scores within each question's own ~48-session haystack (verified: mean 47.7, all 948 answer sessions in-haystack). The same harness was near-per-haystack on `oracle` (union ~940, mean haystack ~1.9) but ~400x harder on `_s`, so F13's 86.8 and F14's 42 were never the same measurement.

Re-labelled, not retracted (global-pool is a legitimate harder eval). Dual numbers, best cell:

| `_s` regime | MiniLM-L6 (zero-dep default) | voyage-3-large (opt-in) |
|---|---|---|
| Per-haystack R@5 (standard, gbrain-comparable) | 98.6 | 99.8 |
| Global-pool R@5 (one 19,195-session store) | 47.2 | 56.4 |

gbrain v0.28.8 reports 97.6 per-haystack with `text-embedding-3-large`. The zero-dep default (98.6) is at or above that. **F17 is NOT a blocker for standard LongMemEval-S.** Done: per-haystack harness committed (`chunk_per_turn_haystack_retrieve.mjs`), result doc written, README updated. The F-track aggregate above carries a correction banner.

### Memory-system eval methodology and metric [next, research]

The category lacks a good way to measure what a memory system is *for*. LongMemEval and LoCoMo measure retrieval recall on a fixed corpus, and per-haystack recall is saturated by any competent embedder (this update), so it does not discriminate memory systems on the thing that actually matters: deciding what to keep, forget, consolidate, supersede, and strengthen over time. Define that methodology and a composite metric, and release it as an open benchmark so the field (and hippo) is measured on the lifecycle, not just retrieval. This is the umbrella; the lifecycle stress eval below is its first concrete instance.

- **Methodology:** a growth-over-time protocol (a single store grows 10x-100x with controlled redundancy, staleness, and conflict from a held-out injector), measured at checkpoints, comparing memory systems and naive baselines under a fixed context budget.
- **Candidate metric axes (compose into one score, weights pre-registered):** answer correctness; active-context token cost (efficiency); stale-answer rate (supersession-correctness); retention quality (keeps the useful, drops the noise); and learning slope (does task N+k beat task N). Retrieval recall is one input, not the headline.
- **Why hippo should own it:** hippo's lifecycle metadata (decay, outcomes, supersession, conflicts) is exactly what such a metric needs and what static-store competitors cannot report. Defining the metric is both a research contribution and positioning. F8 (Memory-Augmented Agent Eval, Part II) and the retracted sequential-learning trap-rate fold into this.
- **Deliverable:** a methodology doc + reference harness + a public, reproducible result, pre-registered per the `docs/evals` discipline.

### Lifecycle stress eval (keystone) [shipped first slice 2026-06-09; headline NULL]

> **Status 2026-06-09 (first measurement, `docs/evals/2026-06-09-lifecycle-stress-eval-result.md`):** the ruler is built and works - it cleanly separates retrieval (hippo) from recency (naive) and can detect a lifecycle effect when one exists. The pre-registered headline hypothesis - sleep consolidation frees active-context budget - measured **NULL-to-slightly-negative** on current hippo. Mechanistic root cause (verified in source): the merge "summary" is a concatenation comparable-or-larger than its sources, and the `strength * 0.3` write on merged episodics is inert because `calculateStrength()` never reads the stored `strength` field. This is what motivated the DAG item below.

The differentiator hippo claims is the memory lifecycle, and no existing benchmark (LongMemEval, LoCoMo) measures it: per-haystack retrieval recall is saturated by any competent embedder, and none of them ever force a forget/consolidate/supersede decision. Build the eval that does, in the large-store regime where retrieval stops being free (the correction above shows recall collapses to ~47-56 there).

- **Setup:** grow a single store 10x -> 100x by injecting memories with controlled redundancy, staleness, and conflict, generated by a **held-out** process whose staleness/conflict labels are NOT visible to hippo's consolidation heuristics (no train-on-eval). Measure at each growth checkpoint.
- **Axes (three, pre-registered thresholds set BEFORE running):** (1) QA accuracy on held-out questions; (2) active-context token cost to answer; (3) **stale-answer rate** (does it answer from superseded info) - the axis pure retrieval cannot fake, and the one that isolates the lifecycle.
- **Baselines:** naive append-everything; recency-window (last-N, the real-world default); **naive-append + a frontier 1M-context model** (stuff everything in - if hippo does not beat this, the moat is unproven); hippo-no-lifecycle ablation; hippo-full.
- **Success (pre-register exact bar):** hippo-full holds QA accuracy within a set floor (e.g. <=2pp drop) and stale-answer rate low while active-context tokens stay a set fraction of naive at 100x; naive degrades or blows the context window. Pre-registered per `docs/evals` discipline.
- Subsumes/sharpens F8 (Memory-Augmented Agent Eval) and the retracted sequential-learning trap-rate. **Gates the DAG build below** (build the ruler before the thing it measures).

### DAG consolidation hierarchy (the "next major feature") [planned; slice 1 MEASURED-FALSE 2026-06-10]

> **Status 2026-06-10: slice 1 MEASURED-FALSE** (`docs/evals/2026-06-10-dag-consolidation-slice1-result.md`). The pre-registered hypothesis - compressed summaries substituting for redundant children free active-context budget and lift budget-bounded QA - was falsified: substitution **regressed** QA by **-6.3pp** under a binding budget; compression alone was neutral on the relevance path. The mechanism was built and fully tested (14/14 real-DB); the *idea* failed its eval, which is exactly what the lifecycle stress eval exists to catch. Any further DAG work starts from a new hypothesis, not a re-run of this slice.

Lossless-claw-style hierarchical summarization on the SQLite backbone: raw receipts (lossless) -> episodic -> consolidated DAG summary nodes, so active context is a small top-of-DAG slice while detail stays retrievable on demand; decay/outcomes drive which branches consolidate vs prune. Fixes hippo's flat-store weakness and lossless-claw's keep-everything weakness. Distinct from E3 (entity graph for multi-hop): this DAG is for context compression.

- **Hard dependency:** design DAG-node **invalidation-under-supersession** first. A summary node whose child is later superseded is now lying - the exact "graph that lies" failure Part II Bet #5 and E3.4 (`[research]`) warn about. Do not ship summarization before the tombstone/invalidation story exists.
- **Smallest first slice:** one consolidation level (raw -> episodic summary node) with recall fallthrough to children; measure token reduction at fixed accuracy on the lifecycle stress eval. Each subsequent slice ships only with a measured eval delta.
- SQLite backbone is already shipped (Part II Track A). Effort/success criteria scoped after the lifecycle stress eval exists.

### Reposition: lifecycle layer on any embedder [next]

"Retrieval is solved; remembering the right things over time is not." hippo is the memory-lifecycle layer that runs on any embedder (zero-dep local default OR frontier via the v1.23.0 provider, Part II A-track / B episode).

- **Parity-then-pivot** (avoids reading as goalpost-moving to grant reviewers, given the Part I / Part II benchmark WPs): lead with the per-haystack parity number (default 98.6, above gbrain's 97.6) as proof of competitiveness, then pivot to the lifecycle stress eval as the differentiator. Not "benchmarks do not matter."
- LongMemEval becomes a reproducible parity footnote with the harness in-repo, not the headline. The lifecycle stress eval becomes the headline once it exists.
- README updated 2026-06-09 with the dual-number parity table + lifecycle pivot.

### Embedder track status

The pluggable embedder (v1.23.0) is the right and final amount of embedder investment. With the correction above showing the zero-dep default already clears the published frontier on the standard task, the retrieval/embedder line of work is **DONE**; further retrieval gains are not the priority. The lifecycle (stress eval, then the DAG build) is.

---

## Part IV - 2026-08-01 update: learned memory components (deep-research findings + LC track)

Added 2026-08-01 after a deep-research pass on learned components for agent memory (replacing hand-tuned saliency / decay / ranking heuristics with small models trained on the agent's own outcome logs), plus a grounding audit of the live store. Research provenance: 23 sources fetched, 112 claims extracted, 25 verified — 5 via 3-0 adversarial votes in the workflow, the remaining 20 via direct primary-source fetch the same day (all quotes matched; zero refuted). All claims below are **[verified]**.

### Findings: the field

- **[verified] Outcome-driven RL memory controllers work at tiny data volumes.** Memory-R1 (arXiv 2508.19828) fine-tunes a Memory Manager (ADD/UPDATE/DELETE/NOOP) plus an Answer Agent with PPO/GRPO, rewarded on downstream answer correctness. 152 training QA pairs outperform strong baselines and generalize across LoCoMo, MSC, LongMemEval and 3B-14B model scales. Mem-alpha (arXiv 2509.25911) trains a GRPO controller for a core/episodic/semantic memory with a 4-part reward (QA correctness, tool-call format, compression, content quality) on a Qwen3-4B backbone.
- **[verified] No shipped competitor learns its memory heuristics.** Mem0 does ADD/UPDATE/DELETE/NOOP by LLM tool-call ("rather than using a separate classifier, we leverage the LLM's reasoning capabilities", arXiv 2504.19413). MemoryBank's decay is a hand-set Ebbinghaus rule and its strengthening a fixed +1 increment (arXiv 2305.10250). Generative Agents scores retrieval as recency+relevance+importance with all weights set to 1, and saliency by prompting for a 1-10 "poignancy" integer (UIST 2023). Four independent sources agree: the learned-lifecycle position is unoccupied.
- **[verified] The closest published recipe to hippo's exact stack is a learned LINEAR memory-value function, and it is cheap.** arXiv 2606.12945 fits a linear multi-factor memory value with a gradient-free hill-climb (CMA-ES stand-in) against gold-evidence retention on LongMemEval-S under a 30% keep budget. Learned weights retain 0.770 of gold evidence in the blind (query-unaware) regime vs 0.657 uniform weights, 0.518 best single factor, 0.368 recency. Trained on ~240 cases (60 sufficed in their synthetic study), single CPU, no API calls, all-MiniLM-L6-v2 — hippo's zero-dep default embedder. Two methodology rules transfer directly: (1) score relevance ONLY from consolidation-time information — query-aware scoring is an oracle that saturates retention at ~0.98 and measures retrieval, not forgetting; (2) evaluate under a fixed keep budget.
- **[verified] Experience retrieval gives most of the gain before any learned component; learned rerankers must beat strong lexical baselines to earn a slot.** ExpRAG (arXiv 2603.18272): trajectory retrieval alone lifts ALFWorld success 4.48% → 64.18% with zero training. The skeptic anchor (Yang et al., SIGIR 2019, arXiv 1904.09171): most neural-ranking "wins" evaporate against well-tuned lexical baselines. Hippo's BM25+RRF is exactly such a baseline — any learned reranker ships only if it beats it under a pre-registered paired eval.

### Findings: hippo's own state (audited 2026-08-01, live store `~/.hippo/hippo.db`)

- 1,550 memories; 439 (28%) carry outcome labels (`outcome_positive` / `outcome_negative` counters, `src/memory.ts`).
- `audit_log` 8,868 rows: remember 5,702 / forget 2,688 / recall 288 / outcome 109 / consolidate 76.
- **The blocking gap is instrumentation, not modeling.** Recall audit rows persist only `{query, results: <count>}` — the returned memory ids are never logged, and `outcome` rows are not linked to the recall that preceded them. The (query → candidates shown → outcome) triple that any learned reranker or saliency model would train on does not exist on disk. G8 names "outcome-labeled retrievals" as the corpus asset, but the producer never writes it. Root cause first: fix the producer, then train.

### Track LC — Learned lifecycle components (dependency order)

#### LC1. Retrieval-trace persistence (the training-data producer) [SHIPPED 2026-08-02, PR #135, schema v40]
Persist per-recall: query text/hash, returned memory ids + ranks + per-stage scores (the A7 `rerankPipeline` trace already computes these in-memory), session id, tenant. Link `outcome` events to the recall ids that preceded them (cmdRecall's last-retrieval-ids mechanism already exists for credit assignment — persist the linkage durably instead of dropping it). Feeds G8; unblocks LC2, LC3, B1/B5 depth calibration, and F18.
**Effort:** 2-3d. **Success:** every recall writes a trace row with returned ids; every outcome row references the recall trace(s) it scores; 30 days of dogfood accumulates a re-loadable (query, shown, outcome) dataset; storage overhead <5% of DB size.

#### LC2. Learned memory-value v1: linear keep/forget/promotion scorer [E3 SHIPPED 2026-08-10 — wired, opt-in, default off; LC2 COMPLETE]

> **Status 2026-08-09 (LC2-E1, `docs/evals/2026-08-09-lc2-memory-value-result.md`):** retention harness + v4 registered baselines shipped on LongMemEval-S cleaned (500/500 questions, deterministic, test-enforced). Held-out bars for the E2 fitter: best single factor = recency at **0.4203**; uniform equal-weighting lands *below* chance (0.2468) on hippo's substrate - inverting the paper's ordering (paper: uniform 0.657 > recency 0.368), so E2's bars are relative to hippo's own baselines, not the paper's.
>
> **Status 2026-08-10 (LC2-E2, `docs/evals/2026-08-10-lc2-e2-fit-result.md`): BARS MET.** Seeded (1+lambda)-ES fit (5 restarts, train-only, prereg locked pre-fit) produced learned weights at held-out retention **0.4897** vs recency 0.4203 (+0.0695, paired bootstrap 95% CI [0.017, 0.127] excluding 0) and vs uniform 0.2468 (+0.243, CI [0.175, 0.312]). Artifact: `benchmarks/memory-value/weights-learned.json` (+ meta sidecar) - derived, rebuildable, git-diffable (Track L Rule 2), consumed by nothing in src/ yet. Caveat that rides the artifact: usage-feature signs reflect E1's anti-oracle simulation, not real usage value (LC3 tests that). Next: E3 wires the scorer into a real decision site behind an opt-in flag, default off.
>
> **Status 2026-08-10 (LC2-E3, `docs/evals/2026-08-10-lc2-e3-wiring-result.md`): SHIPPED — ALL GATES GREEN.** The scorer is wired into the sleep decay pass as a rescue-only veto behind `memoryValue.enabled` (default off): flag-on can only RESCUE a strength-condemned memory (top-30% learned rank within its own tenant), never condemn — deletes(on) ⊆ deletes(off) by construction, neutralizing the usage-sign hazard at a hard-delete site. G1 code parity passed at **delta 0** (src scorer over rebuilt fit-time stores = registered 0.48973684210526314 exactly); default-off bit-identity test-proven; per-tenant isolation + subset + fail-loud property-gated; rescue rate 17.7% characterized at 2k/3-tenant scale. Flag-flip preconditions pre-registered (dogfood via `mv_rescue` audit rows + full LongMemEval + micro-eval battery). LC2 (E1 substrate → E2 fit → E3 wiring) is complete; LC3 (outcome-trained reranker, ~90d LC1 data clock) is the track's open item.
Replicate the 2606.12945 recipe on hippo's substrate: a linear (inspectable) value function over consolidation-time lifecycle features hippo already stores — age, decay state, strength, retrieval count, outcome ratio, error tag, schema_fit, tag class, scope. Fit gradient-free (CMA-ES / hill-climb) against (a) gold-evidence retention on LongMemEval with a held-out split and (b) the Part III lifecycle stress eval once it exists. Blind features only — no query-aware oracle. The learned weights replace the hand-set constants in the strength/salience formulas as an opt-in, derived, rebuildable, git-diffable config artifact (Track L Rule 2; a linear model is itself inspectable, so Bet #7 holds).
**Guard (binding):** the C1 salience-gate regression (recall 81 → 15 when the gate was enabled; do-not-re-enable memory `feedback_hippo_salience_regression`) is the cautionary precedent. LC2 ships ONLY behind pre-registered paired A/B + LongMemEval non-regression gates per `docs/RETRACTION.md` discipline.
**Effort:** 8-10d. **Success (pre-register exact bars before running):** learned weights beat uniform weights AND the best single factor on gold-retention at a fixed keep budget on the held-out split; tier-1 micro-eval fire-rate non-regression; LongMemEval per-haystack R@5 non-regression.

#### LC3. Outcome-trained reranker head over RRF [planned, gated on ~90d of LC1 data]
A small learning-to-rank head (logistic / GBDT over lifecycle + match features — NOT a neural cross-encoder) re-scoring the RRF candidate pool, trained on LC1's (query, shown, outcome) triples. SIGIR-2019 is the null hypothesis: BM25+RRF is a strong baseline and the head ships only if it beats it under a pre-registered paired eval. The differentiator is per-store personalization — each store learns from its own outcome history, which no static-store competitor can do.
**Effort:** 6-8d once data exists. **Success:** pre-registered R@5 / fire-rate lift over the shipped RRF pipeline on own-store traces; identity fallback when a store has fewer labeled triples than a pre-set floor (cold-start).

#### LC4. RL memory controller (Memory-R1 / Mem-alpha class) [research → Track G]
Verified feasible at 152-QA-pair scale, but it requires fine-tuning a 3B-14B backbone and a training loop — as a product default this conflicts with the zero-dep local core (non-goals #5/#6). File as the Track G realization (G3 knowledge-RLHF, G5 sleep-as-training-pipeline); candidate for grant-funded research (a GRPO run on a ~4B model is locally feasible on the RTX 5080 for the research track). Any product surface is an optional trained artifact under Track L Rules 2/3.

### Adjacent hooks item — compaction survival (added 2026-08-01, AutoCompact follow-up)

#### CS1. PreCompact capture + compact-aware re-injection [SHIPPED 2026-08-03, PR #136]
Source: AutoCompact (Du et al., autocompact.github.io, 2026-07-30) fine-tunes Qwen3-30B-Coder to call `compact()` itself (judge-guided SFT + GRPO; post-RL it compacts proactively in 58.5% of tasks). Its supervision splits into when-to-compact 24%, **what-to-preserve 53%, how-to-continue 23%**. The when-decision needs a fine-tuned policy model — not hippo's lane (same verdict as LC4). The preserve/continue 76% is external-memory territory: make working state survive compaction independently of summary quality, with no model training.

Mechanism (both hook events verified against code.claude.com/docs/en/hooks 2026-08-01):
- **PreCompact hook** (fires on manual and auto compaction): run `hippo capture` over the tail of the session transcript before the summary is written — decisions, open items, ids, next step, tagged with session id. The transcript parser already exists (`src/capture.ts`); `hippo setup` currently installs only SessionEnd + SessionStart (`src/hooks.ts`), so mid-session compaction is a blind spot today.
- **SessionStart `source: "compact"`**: re-inject the pre-compact snapshot plus task-relevant recalls, restoring what the summary dropped.
- Non-goal v1: PreCompact can block compaction — leave that knob alone; blocking an auto-compact on a full context risks wedging the session.

Feeds LC1/G8: pre-compact snapshots linked to post-compact outcomes are (state → outcome) training data for the learned lifecycle. Additive only — new hook entries + capture path, no public CLI renames.
**Effort:** 2-3d. **Success:** `hippo setup` installs the PreCompact hook for claude-code; a compaction mid-session writes a working-state snapshot memory; the following SessionStart(compact) injects it; E2E test drives a synthetic transcript through simulated PreCompact + SessionStart(compact) hook input and asserts snapshot + re-injection; SessionEnd capture is unchanged.

### Positioning note

Hippo already owns the substrate a learned lifecycle needs (outcome counters, decay state, provenance envelope, audit log) and the eval harness to gate it (LongMemEval per-haystack + the Part III lifecycle stress eval). Competitors hand-tune or LLM-prompt these decisions. "The memory layer that learns what to keep from its own outcomes" is Bet #1 made trainable — the moat stays lifecycle, not retrieval quality, and the learned artifact stays derived + inspectable.

**Research provenance:** deep-research workflow run `wf_00c80a74-033` (2026-08-01); 5 claims verified 3-0 in-workflow, remaining 20 verified same day by direct primary-source fetch (all quotes matched; zero refuted). Key sources: arXiv 2508.19828 (Memory-R1), 2509.25911 (Mem-alpha), 2506.15841 (MEM1), 2504.19413 (Mem0), 2305.10250 (MemoryBank), 2606.12945 (learned linear memory value on LongMemEval), 2603.18272 (ExpRAG), 2606.02204 (cross-environment reranker), 1904.09171 (neural-hype skeptic), Generative Agents (UIST 2023).

---

## Part V - 2026-08-09 update: agent-memory-atlas comparative gap analysis (source-verified)

Triggered by GitHub issue #137 (neoneye, author of the agent-memory-atlas, 2026-08-04): a Claude Opus 5 authored audit of hippo against 238 other agent-memory systems, at `neoneye.github.io/agent-memory-atlas/systems/hippo-memory/` and `/compare/`. Two verification passes went into this section: (1) the atlas's comparison-matrix membership claims were checked against the atlas page itself (curled and grepped); (2) every claim about hippo's own code behavior was checked against hippo source on 2026-08-09 - and that second pass found the atlas report **wrong or overstated on three of its findings** (noted per item below). An earlier draft of this section propagated those errors; this rewrite corrects them.

**Atlas score: hippo carries 4 of 7 rubric marks** - trust state, bi-temporal validity, scope-enforced retrieval, append-only mutation audit. Marks withheld: rejected-value tombstone (12/238 systems carry it), human review surface (59/238), negative-retrieval eval (50/238). Four systems carry all 7: `memsem`, `perseus-vault`, `provem`, `verel`. Source-verification verdict per withheld mark: the tombstone gap is **real** (AT1); the other two are **partial** - hippo has `hippo conflicts` / `hippo resolve` (cli.ts) and committed cross-tenant negative tests (`tests/l9-tenant-scoping.test.ts`), so the genuine gaps are narrower than the atlas scored (AT4, AT5).

### AT1. Rejected-value tombstone [SHIPPED 2026-08-15, PR #142, v1.31.0]
**Verified real.** `deleteEntry` is a hard `DELETE FROM memories` (src/store.ts:1654); no tombstone / rejected-value / suppression-by-value vocabulary exists anywhere in src (grep 2026-08-09). Supersession hides rows on read but keys nothing on the *value* - re-extraction can silently re-assert a fact a human already rejected. `perseus-vault` refuses on every remember-path write via a digest-keyed tombstone table (with an audited trusted-override escape hatch); `memsem` writes a durable value-keyed suppression on human rejection and refuses `memory_add` when the normalized value matches. This is also the same mechanism the Part III DAG consolidation item is blocked on ("do not ship summarization before the tombstone/invalidation story exists") and that E3.4 lists as `[research]`.
**Effort:** 5-6d (new table, write-path check in `capture`/`remember`/auto-learn, migration, tests). **Success:** reject value X; re-run an extraction pass that would re-assert X; assert the write is refused and `audit_log` records the refusal; existing supersession behavior unchanged for non-rejected corrections.

### AT2. Stale tier masks the stored epistemic tier for non-verified memories [planned, small]
**Atlas overstated; corrected against source.** `resolveConfidence` (src/memory.ts:447-455) exempts `verified` and `pinned` entries from staleness - a verified fact never degrades to `stale`, so the atlas's "verified facts marked outdated regardless of truthfulness" is wrong. The residual issue is real but smaller: for `observed`/`inferred` entries, 30+ days of disuse returns `stale` in place of the stored tier, so recall surfaces cannot distinguish a stale-observed from a stale-inferred memory. Disuse (a recency signal) overwrites the epistemic tier (an evidence signal) in one field.
**Effort:** 1-2d. **Success:** `recall --why` shows both the stored tier and the staleness flag as separate facets (e.g. `observed+stale`); no fire-rate regression on tier-1 micro-eval.

### AT3. Quarantine tier before sleep-audit hard-delete [planned]
**Verified real (wording corrected).** The sleep pipeline's audit phase flags junk (too short / empty / version-bump / non-substantive - `isContentWorthStoring`, src/audit.ts:116-124) and removes it via the hard-delete path (`errorsRemoved`, cli.ts:2859); `auditMemories` + `deleteEntry` run host-wide in sleep, not tenant-scoped (the known A5 v2 sub-2 residue). No recoverable step exists between "flagged" and "gone". `memory-project`'s archive -> cold-storage -> `revive_from_cold()` two-speed pattern and `perseus-vault`'s staged supersede/demote/archive/forget/purge both keep one.
**Effort:** 3-4d. **Success:** a junk-flagged entry moves to a quarantined state for N days before permanent deletion; a `revive` command restores it and it recalls normally; `audit_log` distinguishes quarantine events from hard-delete events.

### AT4. Approval gate on unattended destructive passes [planned]
**Scoped narrower than the atlas's "no human review" verdict.** Humans CAN adjudicate conflicts today (`hippo conflicts` / `hippo resolve`, cli.ts:8704/8708). What has no approval surface is the *unattended* destructive work: sleep's junk deletion (AT3) and consolidation merges act without a person in the loop. `provem` models admission with discrete statuses (`hypothesis`/`accepted`/`proposed`/`pending review`/`quarantined`).
**Effort:** 4-6d (review-queue table + CLI + dashboard surface, opt-in flag so single-user local mode is unaffected by default; overlaps AT3's quarantine table - build together). **Success:** with review mode on, a junk-flagged entry or auto-merge sits in `pending_review` until approve/reject, logged to `audit_log`; review mode off (default) behavior unchanged. Outside-voice pass before leaving `[planned]`, same gate Tracks K/L use.

### AT5. Negative-retrieval assertions in the eval suites [next, small]
**Atlas overstated; corrected against source.** Committed negative tests DO exist - `tests/l9-tenant-scoping.test.ts` et al. assert cross-tenant isolation (the README/site "proven by a negative test" claim is accurate). What the eval suites (tier-1 micro-eval fixtures, LongMemEval harness) lack is must-NOT-appear assertions: superseded values, suppressed memories, and (once AT1 ships) rejected values. The atlas's own reading of the split matters here: of the 50 systems with the mark, only five assert a *boundary*; the rest assert *content* exclusions - hippo has the boundary tests and lacks the content ones.
**Effort:** 1-2d. **Success:** micro-eval fixtures gain must-not-appear cases for superseded + suppressed content; once AT1 ships, a paired case asserts a rejected value never resurfaces via recall.

### AT6. Document successor-derived expiry on `memories` [resolved 2026-08-10, doc-only]
**Atlas wrong; corrected against source - and the first draft of this item was wrong too.** The atlas claimed memories' bi-temporal columns "carry no read-path filter" - false: `--as-of` recall filters on `valid_from` and derives expiry from the superseding row's `valid_from` (src/search.ts:417-435, both pipelines). The earlier draft here then asserted a dead `memories.valid_to` column; a second source pass (2026-08-10) found `memories` has **no `valid_to` column at all** - the bi-temporal migration adds only `valid_from` (src/db.ts:238-240). The only `valid_to` in src belongs to the `policies` table, where it IS read by the as-of query (src/policies.ts:533). Nothing to retire or wire up.
**Effort:** 0 (code). Optional: one doc line in `MEMORY_ENVELOPE.md` stating memory expiry is successor-chain-derived with no explicit `valid_to` column.

**Not adopted from the atlas scan:** `perseus-vault`'s AES-256-GCM at-rest encryption and hash-chained journal (out of scope - hippo's local-first zero-dep core is the explicit bet, non-goal #5); `provem`'s pluggable-backend governance layer (hippo's SQLite-first architecture is Bet #7, not a plugin host).

**Discipline note:** the three atlas errors (AT2, AT5, AT6) were only caught by reading hippo's source; the atlas is an LLM-authored report and inherits LLM-report failure modes. Any future item sourced from an external audit of hippo's code gets a source-verification pass before it lands in this file. The pass must also cover this file's own drafts: the first draft of AT6 asserted a dead `memories.valid_to` column that does not exist (memories carries only `valid_from`, src/db.ts:238-240) - caught 2026-08-10 by a second read of the migrations.

---

## Part VI - 2026-08-23 update: live-store dogfood defect audit

Triggered by a working-as-intended audit of the live store on Keith's machine (2026-08-22/23): `hippo status` (1518 memories, 100% embedded), `hippo audit` (1474 clean / 44 issues), and inspection of what the UserPromptSubmit hook actually injects into every Claude Code prompt. All three defects were then root-caused against source at v1.33.0 (e928179). These are dogfood-visible quality bugs in the capture-to-injection loop - the loop every hippo user runs on every prompt - so they rank above new capability work. Ordering: DF1 and DF2 are [next]; DF3 and DF4 ride along as small items.

### DF1. Active task snapshot never expires; stale snapshots inject into every later session [SHIPPED 2026-08-23, PR #146, v1.34.0]
**Incident (live store):** a snapshot written by `hippo pre-compact` on 2026-08-15 (session f235ebd3, task "/compact", status `active`) was still being injected into every prompt of every session seven days later - roughly 800 tokens of dead context per prompt, carrying a week-old summary as if current.
**Root cause (source-verified):** `loadActiveTaskSnapshot` selects `WHERE status = 'active'` with no age bound and no session match (src/store.ts:2521-2530). The only paths that end a snapshot are supersession by the NEXT snapshot write (src/store.ts:2475) and the manual clear command (`clearActiveTaskSnapshot`, sole caller cli.ts:3927). `hippo session-end` never closes the ending session's snapshot, so a session that dies after a pre-compact leaves an immortal `active` row. Both injection surfaces load it unguarded: `apiContext` (src/api.ts:2401) and the `--continuity` recall block (src/api.ts:1021).
**Fix shape:** (a) `hippo session-end` closes the ending session's active snapshot; (b) `loadActiveTaskSnapshot` gains a freshness bound (default ~48h) for callers that do not present the snapshot's own `session_id` - same-session reads stay unbounded so compact-resume is unaffected; (c) `apiContext` threads the current session id (HIPPO_SESSION_ID) so a live session's own snapshot always wins.
**Effort:** 2-3d. **Success:** a red-under-old test pins the incident (snapshot from session A, aged past the bound, injects into session B's context - must NOT); compact-resume within the same session still restores; `session-end` leaves no `active` snapshot behind; the live Aug-15 row is closed by the migration or first `session-end`.

### DF2. Capture distiller stores mid-sentence fragments as high-confidence rules [SHIPPED 2026-08-23, PR #152, v1.36.0]
**Incident (live store):** `g_782a9ac59e12` holds "got entries), plus one documented exception in the list-sync validator, ..." - a sentence chopped mid-clause, tagged `rule, captured`, kind `distilled`, retrieved 0 times, yet injected into every prompt via the recent-writes path. A second fragment ("fetches a quote -> blank price") has the same shape.
**Root cause (source-verified):** three stacked holes. (1) Transcript lines are hard-sliced BEFORE extraction - `.slice(0, 500)` per user message, `.slice(0, 2000)` per assistant text (src/capture.ts:424-434) - so extraction runs over text that can begin or end mid-clause. (2) `splitSentences` splits on every newline as well as terminal punctuation (src/capture.ts:83-89), multiplying fragment starts. (3) `extractFromPatterns` accepts any pattern hit whose capture is 8-500 chars (src/capture.ts:98-116) - patterns match anywhere inside a fragment, captures are `.{5,200}` so tails chop at 200 chars, and no coherence check runs on the result.
**Fix shape:** boundary-aware source truncation (cut at the last sentence boundary inside the cap, the same discipline `truncateCodePointSafe` applies to surrogate pairs); require extracts to start at a clause boundary (reject leading lowercase-continuation and unbalanced closing brackets); run the extract through the existing junk heuristic (`isContentWorthStoring`, src/audit.ts) before `remember` - the verifier already exists, it just runs post-hoc today.
**Effort:** 3-4d. **Success:** a fixture built from the real g_782a9ac59e12 source text goes red-under-old / green-under-new; capture yield on a clean transcript corpus does not drop more than ~10% (guard against over-filtering); no stored capture begins mid-clause across the micro-eval fixture set.

### DF3. `--include-recent` injects the last N writes with no quality floor [SHIPPED 2026-08-23, episode 01M0Q4BMEZZE2EX0YRHJ102RV6]
**Root cause (source-verified):** the UserPromptSubmit hook runs `hippo context --pinned-only --include-recent 5`; the includeRecent branch (src/api.ts:2439-2458) takes the newest N rows as-is, with no quality predicate. Junk goes from "stored" to "read on every prompt" with no gate between.

**PREMISE CORRECTION (measured at plan time, 2026-08-23).** This item originally claimed the floor "is the amplifier that turned DF2's fragments into per-prompt noise". **That was wrong.** Running `isContentWorthStoring` against the actual live entries:

| Case (real store content) | `isContentWorthStoring` | Filtered by DF3? |
|---|---|---|
| Fragment "got entries), plus one documented exception…" | `true` | **No** |
| Fragment "fetches a quote → blank price" | `true` | **No** |
| Auto-learn "fixed signals" | `false` | Yes |
| Auto-learn "globe view on by default" | `false` | Yes |

The fragments pass because `capture.ts:174` already applies that exact gate at write time. So DF3's real coverage is the **vague / no-specificity / version-bump / too-short class — i.e. DF4's auto-learn class**, not DF2's fragments. Mid-sentence fragments are indistinguishable from good content at the read surface and can only be fixed at the producer (DF2's boundary-aware truncation). This *strengthens* the Part VI pattern note rather than weakening it.

**Shipped:** `isContentWorthStoring` filter placed BEFORE the slice in the includeRecent block, so a caller asking for N gets N *qualifying* entries (backfilled past junk) rather than N-minus-junk. Skip-only. Pinned entries unaffected — they inject via the separate pinned block, so no bypass clause is needed. Deliberately NOT strengthening `isFragment`: it also gates capture writes, so widening it would silently under-store good memories (note: an earlier draft justified this by claiming `isFragment` feeds the sleep hard-delete path — false, verified at api.ts:2971, only `severity === 'error'` is deleted and `isFragment` is `warning`).
**Effort:** 1d (actual: 1 episode). **Success (met):** a store seeded with one junk and four clean recent writes injects only the clean four; pinned injection unchanged. Plus a measured-limitation test pinning that fragments are NOT caught, so no future reader assumes DF3 covers DF2's class.

**Two defects the cross-model gate caught that every Claude reviewer missed** (5 parallel reviewers + 2 plan-critic rounds all passed the code these describe):
1. **Pinned displacement under shared-budget pressure.** The recent loop and the pinned block draw on ONE budget (`usedP` / `effBudget`). Filtering a pinned entry out of the recent slice let an unpinned row backfill and spend that budget, so the pinned block then hit `continue` and omitted the pin entirely. The plan had carried an `entry.pinned ||` clause, the round-1 critic correctly showed its *stated* justification was wrong, and I removed it — introducing the bug. **Generalizable rule, worth applying repo-wide: when a review argues a guard is redundant because "a later step handles it", verify the later step handles it under RESOURCE PRESSURE, not just in the unconstrained case. A wrong justification for a guard does not make the guard wrong.**
2. **CJK content classified as junk.** `substantiveWordCount` split on `/\s+/`, so a whitespace-free Japanese/Chinese sentence scored one "word" and failed the `>= 2` check. Fixed by counting CJK characters as substantive units — strictly more permissive, which is what makes it safe in a predicate shared with capture's write gate. This also surfaced a **pre-existing silent data-loss bug: `capture.ts:174` has been dropping CJK content at write time**, so any non-Latin-script user has been losing captured memories. Worth its own follow-up to check the rest of the pipeline for the same whitespace-tokenization assumption (BM25 indexing, `estimateTokens`, dedupe overlap).

**Round 2 of the same review found two regressions in that CJK fix itself** — worth recording because the failure shape is the interesting part, not the bug. The sub-fix was added mid-episode to close a review finding, so it never passed through the plan stage, the plan critic, or a self-grill, and it shipped: (a) kana punctuation counted as substantive (the Katakana BLOCK contains the middle dot, so punctuation-only junk was newly admitted), and (b) stripping CJK before the latin split REDUCED the count for short mixed tokens, newly rejecting content the gate previously accepted. Both landed in the exact property asserted as the fix's safety justification — "strictly more permissive" — which was stated in the commit message, the plan and this roadmap **without being tested**. Final form: match CJK letters by Unicode script (not block range), and ADD to the unmodified latin count rather than stripping.

**Two rules earned here, both generalizable beyond hippo:**
- *Scope that grows mid-episode does not inherit the plan's rigor.* A fix that changes a SHARED predicate in response to a review finding needs the same evidence treatment as a planned change: name the property being claimed, then test it against pre-change behavior on adversarial inputs (punctuation-only, mixed-script, boundary lengths) before asserting it.
- *A safety claim stated in prose is not a safety property.* "Strictly more permissive" was falsifiable in one line of code and was false; it survived three documents because nobody ran it.

**Round 3 made it a three-strike pattern, so the fix moved to the cause.** The `\p{Script=Han}` replacement was itself wrong: Script properties are not restricted to letters, so Kangxi radicals and the old Chinese hook mark counted as substantive and symbol-only strings passed the floor. Three defects, one shape every time — *a property of a character class asserted in a code comment and never executed*, with the cross-model review supplying the adversarial input I had not imagined (middle dot, then mixed-token counts, then Han non-letters). Each assertion had already propagated into a commit message, the plan doc and this roadmap before any test touched it.

Fixed at the cause rather than the instance: a `(?=\p{L})` lookahead makes "letters only" true *by definition* instead of by assertion, and a **category sweep test pins the invariant itself** (punctuation, symbols and marks across all three scripts) rather than pinning the three specific inputs review happened to supply. The sweep was verified load-bearing by reverting the lookahead and watching it go red.

**Rule earned (applies well beyond hippo):** when a fix depends on a claimed property of a character class, encoding, locale or collation, execute that property against an adversarial category sweep BEFORE writing it down as justification. Reasoning about Unicode is not evidence about Unicode.

**The deepest finding came from the ship-gate pass, and it was architectural, not textual.** `getContext`'s pinnedOnly branch runs two admission loops against ONE budget: recents spend first, pins take the remainder and skip whatever no longer fits. DF3's filter replaced short junk rows with full-size qualifying entries, so recents systematically spend MORE and a pin that fit before silently stops being injected. Codex had caught one manifestation (pins *inside* the recent window) and the `entry.pinned ||` bypass patched it; the ship-gate review found the second (pins *outside* the window) and identified that both were the same mechanism. Fixed at the mechanism: pins are ranked and their budget reserved BEFORE the recent loop runs, so explicit user intent gets first claim and automatic backfill is capped to the remainder.

**Rule earned:** when a change alters how much of a shared budget an earlier consumer spends, the later consumers on that budget are all in the blast radius — enumerate them explicitly. Patching the first displaced consumer you find is patching a symptom; two consumers displaced by one mechanism means the mechanism is the bug.

**A sixth round found the reserve itself over-charged mirrored pins** (`syncGlobalToLocal` copies global rows preserving `entry.id`, so a synced pin sits in both `pinnedLocal` and `pinnedGlobal`; the admission loop deduped via `selectedIds` but the reserve did not, starving recents of budget a single returned pin never needed). Deduped, and the fix is one `Set`.

**The most useful lesson of the episode came from writing that regression test.** Its first draft PASSED against the unfixed code: at budget 46 the reserve left 34 tokens deduped versus 22 double-charged, and the recent entry needed only 17 — it fit either way, so the test asserted nothing. It was caught only by running the revert-and-check step rather than assuming a fresh test must be red. Sizing the budget from the MEASURED costs (pin 12, recent 17) gave the real distinguishing window of 29-40.

**Rule earned:** a regression test is not evidence until you have watched it fail against the unfixed code. When the test turns on a numeric threshold, derive the threshold from measured values — a round number that *looks* tight is how a test ends up green in both worlds. This is the same failure as the prose-assertion rule above, wearing a test's clothing: the whole episode's defect class was *claims never executed*, and an unverified test is just another claim.

### DF4. Git auto-learn seeds no-information commit subjects as memories [SHIPPED 2026-08-23, PR #153, v1.37.0]
**Incident (live store):** `hippo audit` flags 44 entries, dominated by bare commit subjects ("fixed signals", "globe view on by default", "corrected entry prices") seeded by auto-learn (src/autolearn.ts) - the audit heuristic calls them "no specific details (names, paths, numbers, code)".
**Root cause:** the quality verifier exists only downstream (audit) while the producer ingests unconditionally - the same shape as DF2/DF3. A subject line without a path, number, or code token carries no recall value on its own.
**Fix shape (as shipped):** gate auto-learn ingestion on the audit heuristic at the producer. The "merge subject+body" alternative was MEASURED and dropped: across 4 repos and 1053 commits the body rescues ZERO subjects the gate rejects, and fetchGitLog pulls subjects only so merging would mean changing the fetch format. One-time cleanup of the existing 44 via the audit flow - route through AT3's quarantine once it ships rather than hard-delete, per the "never delete when weakening preserves recoverability" rule.
**Effort:** 1-2d (actual: 1 episode). **Success (met):** re-running auto-learn on a repo with junk subjects stores none of them, verified end to end through the built CLI; detail-carrying subjects still store; the drop count is reported per repo and rolled up. **NOT met, and not attempted:** "audit issue count drops to single digits after cleanup" - cleanup is blocked on AT3 quarantine [planned], and hard-delete is barred by the never-delete rule. The 36 existing rows remain. **Measured scope:** 24 of 413 real auto-learn rows (6%) would be gated.

**Pattern note (binding for this part):** all four defects are one failure shape - a producer writes without the quality check that already exists elsewhere in the system (audit heuristic, sentence-boundary discipline, lifecycle close). The fix discipline is the one Part V's tombstone item set: move the verifier to the producer; post-hoc cleanup passes are the patch, not the fix. Cross-reference: the cross-tenant consolidation/trace leak recorded in the v1.31.0 episode notes was verified FIXED in v1.32.0/v1.33.0 (changelog: merge/trace tenant inheritance, tenant-partitioned dedupe) and is deliberately absent here.
