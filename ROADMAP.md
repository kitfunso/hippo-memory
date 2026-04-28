# Hippo Roadmap

This roadmap tracks planned work for the hippo-memory codebase. Items are grouped by funding status: committed, conditional on grant award, and speculative.

Current version: v0.33.0

## How to read this document

Each work item has a status tag:

- **[Committed]** - will ship regardless of grant outcome
- **[Grant: FAD]** - conditional on Frontier AI Discovery award (GBP 34,999, Oct-Dec 2026)
- **[Grant: AIC-P1]** - conditional on AI Champions Frontier AI Phase 1 award (up to GBP 122,500, Aug 2026 - Jan 2027)
- **[Phase 2]** - planned follow-on work
- **[Speculative]** - exploratory, no firm date

---

## Grant: Frontier AI Discovery (submitted 2026-04-20)

Status: Submitted. Decision expected summer 2026. Project runs October - December 2026 if awarded.

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

Status: Submitted. Decision expected summer 2026. Project runs August 2026 - January 2027 (6 months) if awarded.

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

---

## Funding status tracker

| Grant | Status | Amount | Decision |
|-------|--------|--------|----------|
| Frontier AI Discovery (comp 2422) | Submitted 2026-04-20 | GBP 34,999 | TBC |
| ARIA Rolling Seeding | Submitted 2026-04-20 | Up to GBP 500K | TBC |
| AI Champions Frontier AI Phase 1 (comp 2419) | Submitted 2026-04-21 | Up to GBP 122,500 | TBC |

See `memory/reference_frontier_ai_hippo_answers.md` for the full application template and reusable assets.
