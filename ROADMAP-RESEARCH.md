# Hippo Roadmap: Scaling to Enterprise Agent Memory

This is the canonical execution roadmap. Every actionable item from `RESEARCH.md` lands somewhere in here with a status, an owner phase, and a success criterion. Items without a measurable success criterion get cut.

This file supersedes the prior research-only frame. `ROADMAP.md` continues to track grant-tied deliverables. `PLAN.md` documents architecture and CLS principles.

Current version: v0.33.0
Active branch: `feat/pineal-salience-v2`

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
4. **LoCoMo** — informational only until baseline established.
5. **Memory-Augmented Agent Eval** — RESEARCH §"Near-term 1"; 50-task / 10-trap standardised sequence, planned to design.

---

## Track A — Enterprise scaling (the gap-to-product path)

Hippo today: local CLI + MCP, single user, single project, SQLite + markdown. The gaps below are dependency-ordered.

### A1. Server mode [next]
Persistent daemon alongside CLI. `hippo serve` exposes HTTP + MCP, CLI becomes a thin client. SQLite single-writer for v1.
**Effort:** 4-6w. **Success:** runs >24h with no leaks, sub-50ms p99 recall on 10k-memory store. **Unblocks:** every other A item.

### A2. HTTP API [next]
Language-agnostic surface alongside MCP/CLI. RESTish + streaming for context assembly.
**Effort:** 3-4w (depends on A1). **Success:** SDK-free curl examples in README cover remember/recall/snapshot/handoff/inspect.

### A3. Provenance envelope [shipped]
Every memory carries `scope`, `source`, `timestamp`, `owner`, `confidence`, `artifact_ref`, `session_id`, `kind` (raw|distilled|superseded|archived). RESEARCH §"Phase 1: safest bridge" canonical envelope.
**Shipped:** schema v14 in commits `41b1f4d..df4b0b2` (plan + 10 implementation commits). 725 vitest pass, 9/9 micro-eval fixtures at 100% post-migration. Append-only invariant enforced via `trg_memories_raw_append_only`. `archiveRawMemory(db, id, { reason, who })` is the only legitimate raw-deletion path. See `MEMORY_ENVELOPE.md`.

### A4. Lifecycle compliance [planned]
Retention policy enforcement, right-to-be-forgotten (`hippo forget --user X --everywhere`), encryption-at-rest config flag, secret-scrubbing at write-time, PII redaction (regex + simple model).
**Effort:** 4-6w. **Success:** demo "delete everything for user X across all scopes" in one command; secret-scrub catches AWS/OpenAI/Anthropic/GitHub key formats with <1% false positive on synthetic corpus.

### A5. Auth + multi-tenancy [planned]
API keys -> OAuth + scoped tokens. Org > team > project > scope hierarchy. RBAC. Audit log of every read/write/promote/supersede.
**Effort:** 10-12w for full multi-tenant (revised from 6-8w). Only `working_memory` has `scope` today; `memories`, `consolidation_runs`, `task_snapshots`, `memory_conflicts` need scope/tenant columns + every query audited + RLS or app-layer enforcement.
**Stub for v1 hosted (2-3w):** API keys + per-customer single-tenant deployments. Defer multi-tenant isolation to v2 unless a hosted customer needs it sooner.
**Success:** two users on same server can't see each other's scopes; audit log captures every mutation; SSO/SCIM hook points stubbed (not implemented).

### A6. Postgres backend [planned]
For shared deployments only. SQLite stays the local default.
**Effort:** 3-4w. **Success:** `--db postgres://...` boots; eval suites pass; concurrent-write smoke test green.

### A7. Observability [planned]
Per-query cost, retrieval traces, decay/strengthening rates, conflict counts, sleep-cycle metrics. Dashboard + Prometheus exporter.
**Effort:** 4-6w. **Success:** "why did my agent recall X" answerable in <30 seconds via dashboard.

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
Basic novelty + tag-class scoring. Commit `50528a5`. v2 in flight on this branch.

### C2. Salience gate v3 [next]
Physics-energy ambient state injected as scalar; salience tied to ambient delta. **Salience decides promotion (raw → distilled), not receipt capture.** Raw layer remains append-only per RESEARCH §"Phase 1" — every receipt is captured; salience controls whether the receipt promotes to consolidated state during `hippo sleep`.
**Effort:** 8d. **Success:** promotion rate −30% with no fire-rate regression; raw-layer write rate unchanged.

### C3. Ambient state vector [next]
Continuous background representation: physics-engine energy + velocity-distribution scalars injected alongside memory context. Gives the agent a "feel" for its knowledge landscape without retrieving specific memories.
**Effort:** 6d. **Success:** ablation moves fire-rate by ≥2pp on tier-1 micro-eval (either direction is informative).

### C4. Fast-path System 1 heuristic [next]
Sub-millisecond pre-LLM classifier. Cosine of query embedding against particle-cluster centroids. Predicts: relevant knowledge present? familiar vs novel? about to repeat known mistake?
**Effort:** 8d. **Success:** ≥70% accuracy on labeled trace; <1ms p99 latency.

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

#### E1.3. Slack append-only ingestion [next]
Webhook -> raw layer with full provenance. Source remains canonical; hippo distils, doesn't shadow.
**Effort:** 12d. **Success:** 1000-event smoke test with no source-system writes; recall surfaces incident context faster than transcript replay on 10 staged scenarios.

#### E1.4. GitHub append-only ingestion [planned]
PRs, commits, issues, releases. Same model as E1.3.
**Effort:** 10d. **Success:** PR-context recall beats `gh pr view` for "what changed and why" queries.

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
| `decision` | partial (`hippo decide`) | 4d to fully promote | 90-day half-life shipped |
| `handoff` | partial (`hippo handoff`) | 3d to fully promote | session-scoped today |
| `incident` | planned | 8d | postmortem capsules with linked receipts |
| `process` | planned | 10d | living process maps with deltas |
| `policy` | planned | 8d | bi-temporal-first object type |
| `skill` | planned | 12d | executable; exports to AGENTS.md / CLAUDE.md |
| `project_brief` | planned | 8d | repo-scoped; auto-refreshes from receipts |
| `customer_note` | planned | 6d | scoped to account/customer entity |

### Phase E3 — graph layer over consolidated state

**This is "context graph."** RESEARCH §"Phase 2: higher-leverage" + §"Phase 3: graph on consolidated state."

Position: a graph layer sits **on top of** consolidated facts, decisions, processes, and entities — never over raw transcript soup. It exists to support multi-hop reasoning across decisions, policies, owners, customers, systems, and exceptions.

#### E3.1. Entity extraction at sleep [planned]
During `hippo sleep`, extract canonical entities (person, project, customer, system, policy, decision) and relationships (owns, supersedes, depends-on, blocked-by, references) from consolidated objects only.
**Effort:** 12d. **Success:** ≥80% precision on labeled gold set of 200 (entity, relation, entity) triples.

#### E3.2. Multi-hop graph recall [planned]
`hippo recall --hops 2 "incidents linked to decisions about retry-policy"` — traverses decision → policy → incident → owner.
**Effort:** 10d (depends on E3.1). **Success:** answers a 5-question multi-hop benchmark suite faster + more accurately than flat retrieval baseline.

#### E3.3. Graph-on-consolidated guard [next]
Hard rule: graph never indexes raw layer. Three-layer enforcement, not just lint:
1. **DB-level:** `entities` and `relations` tables have FK to consolidated rows only; CHECK constraint `source_kind IN ('distilled','superseded')`.
2. **Pipeline-level:** `graph_extraction_queue` table is fed only by `consolidation_runs` writes that set `kind=distilled`. Graph indexer reads from the queue, never from `memories` directly.
3. **CI-level:** lint rule fails any PR that introduces a code path writing to graph from non-consolidated state.
**Effort:** 4d (revised from 1d after eng-review). **Success:** regression test asserts `INSERT INTO entities` with raw-FK fails; lint catches direct-write code paths.

#### E3.4. Graph quality maintenance [research]
How does the graph stay clean as supersession + invalidation happen? Soft-delete vs cascade vs tombstone vs versioned edges.

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

Cross-track aggregate: **roadmap target R@5 ≥ 85% remains MET on the oracle split as of v1.9.2** (F13 + F9 stack = 86.8). The deployable cross-track best on `data/longmemeval_oracle.json` is still F13 + F9 stack at R@5 = 86.8. On the `_s` split, all four tracks attempted to date (F14 chunked-turn baseline 42.0, F14+F9-Sonnet stack 50.8, F15 Opus rerank 63.6, F16 e5-large baseline 43.6) have Gate-B FAILed against gbrain v0.28.8's 97.6. F15 produced the cleanest within-pool measurement: a maximally-equipped LLM-as-reranker closes 48.9% of the within-pool ranking gap vs F9's 19.9% (~2.5× ratio). F16 settled the embedder question: the locally-runnable embedder lever is **measured and flat** — swapping BGE-base for the only stronger GCS-reachable model (multilingual-e5-large) moved R@5 by +1.6 and R@100 by −1.4, both within noise, and the R@100 candidate-pool ceiling did NOT lift (84.8 vs 86.2). The F14 ceiling is therefore structural to locally-runnable bi-encoders, not a BGE-base artefact. The evidence-backed path forward is now two-pronged: (a) a qualitatively different embedder — F17 `text-embedding-3-large` (blocked on `api.openai.com` egress) or an HF-egress-gated model — and (b) local hybrid BM25+vector+graph RRF fusion, queued as Track F item F9 `[critical]`, which no F-track measurement has yet attempted and which runs entirely inside the sandbox. F9 hybrid fusion is the recommended next track; F17/F18 remain blocked on egress.

### F7. LoCoMo first baseline [next]
Informational only. Never run before. Do not gate any feature on it until baseline exists.
**Effort:** 5d. **Success:** numbers published; comparison against Mem0 / Letta noted.

### F8. Memory-Augmented Agent Eval benchmark [planned]
RESEARCH §"Near-term 1". 50-task / 10-trap standardised sequence. Compares no-memory baseline vs static memory (CLAUDE.md/AGENTS.md) vs full hippo.
**Effort:** 15d to design + harness. **Success:** hippo-equipped agents show downward trap-rate trend; static-memory agents flat. Released as open benchmark.

### F9. Hybrid-retrieval parity + competitive consolidation [critical, next]

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

## Sequencing (next 90 days, single-engineer cadence)

**Sequence revised after Codex + eng-review (consolidated patch).** Original sequence had Wks 1-4 over-budgeted ~3x and put A1 server before A3 provenance, despite A3 being a prerequisite for E1 ingestion. Cut to 4 items max for 90 days; everything else moves to days 91-180.

### Effort & calendar reconciliation
Weeks of work (calendar) for Wks 1-12, single engineer, assuming 4 productive days/week:
- A3 envelope: 6-8w
- A5 stub auth (single-tenant API key path, multi-tenant deferred): 2-3w
- A1 server: 4w
- E1.3 Slack ingestion (with idempotency, cursors, source-deletion sync, permission mirroring): realistic 4-5w (not 12d)

Total: 16-20 weeks of work compressed to 12 weeks calendar. Lane B parallelism (F6 reranker, F7 LoCoMo) buys some recovery; the budget is still tight by design.

### Weeks 1-4 (May) — provenance first
1. **A3 Provenance envelope** (6-8w, starts here, finishes early June) — gates everything in Track E + Track A. Real schema split, not a column add.
2. **F6 reranker hardening** (6d, lane B parallel) — uses existing hybrid path; no schema dependency.

### Weeks 5-8 (June) — server + auth stub
3. **A5 stub auth** (2-3w) — single-tenant API keys + audit log scaffolding. Multi-tenant isolation deferred to v2.
4. **A1 Server mode** (4w) — daemon + HTTP/MCP surface, thin CLI client. Depends on A3 envelope being live.
5. **F7 LoCoMo first baseline** (5d, lane B parallel) — informational.

### Weeks 9-12 (July) — first ingestion connector end-to-end
6. **E1.3 Slack append-only ingestion** (4-5w) — first source-of-record connector. Tests the full A3 → A5 → A1 stack under realistic load. Includes idempotency, cursor / backfill, source-deletion sync, permission mirroring, rate-limit handling, dead-letter queue.

### Days 91-180 (Aug–Oct) — deferred from current 90-day plan
- **A2 HTTP API hardening** (was Wk 5-8) — A1 ships RESTish surface; A2 polishes contract + SDK examples
- **B3 dlPFC persistent goal stack depth** (was Wk 1-4) — best trap-rate lever, but research not enterprise; ships after E1.3 proves the platform
- **B1 ACC EVC calibration** (was Wk 5-8)
- **C3 Pineal ambient state vector** (was Wk 9-12)
- **E2 first-class `decision` object promotion** (was Wk 9-12)
- **B7 PFC-stack composition A/B** (was Wk 9-12)
- **A4 lifecycle compliance** (right-to-be-forgotten first; encryption/secret-scrub/PII split into separate items)

### Days 181+ — research and platform
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

## Deferred / speculative

Things hippo might do later. Not active scope, not non-goals. Each item names the condition under which it gets revisited.

| # | Item | Revisit when |
|---|------|--------------|
| 1 | Cross-modal memory (text + vision + action) | Core text product is at v1.0 + has paying customers; vision-language modeling is a separate problem |
| 2 | Post-transformer architecture integration (Mamba / RWKV / future) | D1-D7 ML research lines mature; current architecture saturates a measurable bottleneck |
| 3 | On-device hippo (mobile / edge) | Hosted product is shipping; embedded agents become a buyer-pulled use case |

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
