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

## Benchmarks (priority order for shipping decisions)

1. **Paired A/B fire-rate** on tier-1 micro-eval — own harness, fastest signal, Wilcoxon-tested. Commit `5ef6d78`.
2. **Sequential-learning trap-rate** — own benchmark, directly tests the agent-learning thesis (78% -> 14% baseline over 50 tasks).
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
**Effort:** 12d. **Success:** sequential-learning trap-rate −10pp; fire-rate lift p<0.05 on goal-tagged subset.

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

### F6. LongMemEval reranker hardening [next]
**Scope correction (eng-review):** PLAN.md:285 already lists hybrid embeddings as shipped. The remaining gap is reranker quality, not embedding integration. Close gap from current R@5 toward MemPalace's 96.6% via reranker tuning + cross-encoder evaluation.
**Effort:** 6d. **Success:** R@5 ≥ 85% on LongMemEval with the existing hybrid path.

### F7. LoCoMo first baseline [next]
Informational only. Never run before. Do not gate any feature on it until baseline exists.
**Effort:** 5d. **Success:** numbers published; comparison against Mem0 / Letta noted.

### F8. Memory-Augmented Agent Eval benchmark [planned]
RESEARCH §"Near-term 1". 50-task / 10-trap standardised sequence. Compares no-memory baseline vs static memory (CLAUDE.md/AGENTS.md) vs full hippo.
**Effort:** 15d to design + harness. **Success:** hippo-equipped agents show downward trap-rate trend; static-memory agents flat. Released as open benchmark.

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
