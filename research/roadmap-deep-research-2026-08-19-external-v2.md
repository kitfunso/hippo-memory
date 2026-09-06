# Hippo external roadmap research v2 — missing high-value functionality

**Date:** 2026-08-19  
**Scope:** bounded external review; 12 primary sources; five accepted candidates.  
**Decision frame:** additions beyond commodity vector search and beyond Hippo themes already covered (decay, consolidation, provenance, outcomes, predictions/base rates, active snapshots/handoffs, working memory, first-class operating objects, typed graph, hybrid retrieval, learned lifecycle components, and model-run/cost/outcome memory).

## Executive judgment

Hippo should not chase another memory representation. The sampled leaders already converge on extracted facts, graph links, hybrid retrieval, persistence, and session state. Hippo's more valuable opening is **memory operations as testable, replayable, time-valid, safety-bounded infrastructure**.

Recommended order:

1. **Reproducible retrieval capsules and differential replay**
2. **Declarative memory contracts in CI**
3. **Source freshness and revalidation state**
4. **Untrusted-memory taint and instruction firewall**
5. **Evidence-gated experience-to-procedure induction**

The first four make memory dependable before Hippo lets experience autonomously create procedures. Branching is useful, but full branch/merge memory is deferred until capsules and contracts provide an audit and test substrate.

## What the sampled market and research actually add

| Source family | Verified non-commodity capability | Roadmap implication |
|---|---|---|
| Mem0 | Extracted long-term memory; managed `expiration_date` hides expired memories from ordinary search; its paper reports LoCoMo accuracy, latency, and token-cost results versus baselines/full context. | Expiration is a useful baseline, but Hippo can differentiate with active source revalidation rather than a date-only TTL. |
| Zep / Graphiti | Facts have temporal validity windows, superseded facts are invalidated rather than deleted, and historical truth remains queryable with lineage to episodes. | Freshness is not decay. Hippo needs explicit truth-validity and revalidation state on source-backed claims. |
| LangGraph | Checkpoints support replay and forks; replay deliberately re-executes downstream nodes and may produce different LLM/API results. | Hippo can provide the missing complementary primitive: an immutable record of the exact memory context used, plus strict and live-diff replay. |
| Letta | Eval gates turn agent-quality thresholds into process exit status suitable for blocking CI/deployments. | Memory behavior should have declarative, versioned contracts and merge-blocking gates, not only benchmark scripts. |
| Cognee | Current official index exposes session distillation into permanent lessons, agent session traces, portable COGX exchange, temporal mode, and inspectable retrieval context. | Procedure induction and inspectability are becoming expected; simple storage/search is not differentiating. |
| MCP reference memory server | Atomic observations, entities, relations, mutation tools, full-graph MCP resource, and resource-updated notifications. | This is the interoperability floor, not a roadmap moat; Hippo already exceeds the basic graph-memory shape. |
| AWM / ExpeL | AWM induces reusable workflows from trajectories and reports material success-rate gains on Mind2Web/WebArena; ExpeL extracts natural-language insights from collected experiences without weight updates. | Hippo can turn repeated successful traces into proposed procedures, but promotion must be evidence-gated. |
| MemoryAgentBench | Evaluates incremental memory across retrieval, test-time learning, long-range understanding, and selective forgetting; current systems do not master all four. | CI must exercise changing memory state over turns, not static retrieval only. |
| AgentPoison | Demonstrates that poisoned long-term memory or knowledge bases can cause triggered malicious agent behavior while retaining benign utility. | Provenance and tenant isolation are insufficient by themselves; recalled text needs a data-not-instructions boundary and taint-aware policy. |

## Scoring

Scores are 1–5. Higher is better. **Delivery** is inverted: 5 means low effort/risk. Total is unweighted out of 30 because no evidence supports a more precise weighting.

| Candidate | User value | Differentiation | Hippo fit | Evidence | Delivery | Falsifiable measure | Total | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Retrieval capsules + differential replay | 5 | 5 | 5 | 4 | 3 | 5 | **27** | Accept |
| Source freshness + revalidation | 5 | 4 | 5 | 5 | 3 | 5 | **27** | Accept |
| Untrusted-memory taint + instruction firewall | 5 | 5 | 5 | 4 | 3 | 5 | **27** | Accept |
| Declarative memory contracts in CI | 5 | 4 | 5 | 4 | 3 | 5 | **26** | Accept |
| Experience-to-procedure induction | 5 | 4 | 5 | 5 | 2 | 5 | **26** | Accept, after trust substrate |
| Portable cross-vendor memory exchange | 3 | 2 | 4 | 3 | 3 | 4 | 19 | Defer |
| Branch/merge memory | 3 | 5 | 3 | 3 | 1 | 3 | 18 | Defer |
| Generic uncertainty/source-reliability score | 3 | 3 | 4 | 2 | 3 | 2 | 17 | Reject as framed |
| Autonomous online memory/prompt evolution | 3 | 4 | 3 | 4 | 1 | 2 | 17 | Defer |

Production traces can seed fixtures and identify failures, but they are observational: only the chosen context/model/action was observed. They cannot establish a causal improvement. Every gate below therefore requires paired replay, a controlled intervention, or a held-out benchmark.

## Accepted recommendation 1 — Reproducible retrieval capsules and differential replay

**Problem.** `recall --why` can explain a result, but debugging an agent failure requires reconstructing the *entire context decision*: memory snapshot, query, filters, ranking build, candidates, omissions, ordering, and rendered payload. Mutable stores and stochastic rerankers make “try it again” non-reproducible.

**Concrete first slice.** Add an immutable, content-addressed retrieval capsule for an opt-in recall:

- query and normalized query hash;
- tenant/scope/filter/budget parameters;
- store schema version and an as-of mutation watermark;
- candidate and returned memory IDs, content hashes, component scores, rank, suppression reason, and renderer version;
- retrieval/reranker configuration hashes and model identity where applicable;
- final rendered context hash.

Provide two read-only operations: **strict replay** reconstructs the recorded payload from versioned rows or reports exactly which dependencies are unavailable; **live diff** reruns against current state and reports additions, removals, reorderings, score deltas, and changed content. Capsules should be exportable without raw content by default.

**External precedent.** LangGraph checkpoints support replay and fork from earlier execution state, while its docs explicitly warn that downstream LLM/API nodes re-execute and can differ [S5]. Cognee exposes agent session traces and inspectable retrieval context [S7]. The opportunity is narrower and memory-specific: freeze the retrieval evidence independently of replaying the whole agent graph.

**Overlap risk.** High adjacency to Hippo recall traces, audit logs, replay, provenance, and model-run memory. It is not a duplicate if the acceptance test requires byte-stable reconstruction of the exact delivered context and a first-class current-vs-recorded diff. Reusing existing trace tables and provenance envelopes is preferable to a parallel telemetry system.

**Privacy/safety boundary.** Default capsules store IDs/hashes and configuration, not raw prompt, memory content, credentials, or model chain-of-thought. Access is tenant-scoped; source deletion/GDPR must either crypto-shred payload material or leave a tombstoned, non-reconstructable receipt. Replay never re-executes tools or external side effects.

**Measurable gate.** On a 100-case fixture spanning lexical, embedding, graph, reranked, budget-truncated, superseded, and deleted-memory recalls: (a) strict replay before mutation reproduces the rendered context byte-for-byte in 100/100 cases; (b) after controlled mutations, live diff identifies every injected addition/removal/content/rank change with zero unreported changes; (c) replay performs zero outbound network/tool calls; (d) a cross-tenant capsule fetch is denied in 100% of negative tests.

## Accepted recommendation 2 — Declarative memory contracts in CI

**Problem.** Memory regressions often preserve service health while changing behavior: a forbidden memory reappears, a required policy disappears, a tenant boundary leaks, stale evidence outranks current evidence, or a budget removes the only critical fact. Benchmark averages can miss these repository- or product-specific invariants.

**Concrete first slice.** Introduce a small versioned contract format and runner, for example:

- fixture setup as ordered memory mutations or a referenced capsule;
- recall query, scope, time/as-of, and budget;
- `must_include`, `must_exclude`, `must_precede`, `max_age`, `source_required`, and `no_cross_scope` assertions;
- exact or tolerance-based score/rank checks only when stable;
- deterministic exit code plus JSON/JUnit report.

Start with local CLI and CI; no hosted service. Support strict fixtures and paired A/B contracts. This is a product surface for users, not only internal tests.

**External precedent.** Letta eval gates block deployment via thresholded metrics and non-zero exit status while preserving full trajectories/results [S3]. MemoryAgentBench shows why static QA is insufficient and evaluates incremental interactions across four memory competencies [S10]. Hippo can specialize this into memory-state contracts rather than a generic agent-eval framework.

**Overlap risk.** Hippo already has many tests, eval suites, negative-retrieval work, and benchmark gates. The missing slice is **declarative user-owned contracts over public memory behavior**. Do not create another general grader framework; compile contracts onto existing eval and recall primitives.

**Privacy/safety boundary.** Fixtures must be synthetic or explicitly exported/redacted. CI output defaults to IDs, hashes, and failed predicate names; no raw private memories. Networked LLM graders are opt-in and never required for structural assertions.

**Measurable gate.** Seed at least 30 contracts covering positive recall, negative recall, rank ordering, freshness, scope isolation, supersession, deletion, and budget truncation. Inject one known defect per class: every defect must fail its targeted contract, the clean baseline must pass all contracts, rerunning the same locked fixture must yield identical reports, and a CI example must block on non-zero exit.

## Accepted recommendation 3 — Source freshness and revalidation state

**Problem.** Decay answers “how available/important is this memory?” It does not answer “is the source-backed claim still true?” A strong old policy can remain highly retrievable after the source changed or disappeared. A fixed TTL hides data but does not verify it.

**Concrete first slice.** Restrict v1 to connector-backed receipts with stable source references. Add:

- `observed_at`, `source_version`/ETag or equivalent, `revalidate_after`, and `valid_until` where the source provides it;
- state machine `fresh | due | stale | source_missing | permission_lost | revalidation_failed`;
- conditional source checks that update state/version without re-ingesting unchanged content;
- recall policy `require_fresh`, `allow_stale_with_warning`, or `as_of`;
- an audit record for every revalidation transition.

Start with GitHub because commit/blob identity and conditional requests are explicit; add Slack only after the state semantics are proven. Do not claim that age alone equals falsehood.

**External precedent.** Mem0 supports expiration dates that exclude expired memories from ordinary retrieval [S1]. Graphiti goes further: facts have validity windows, updates invalidate rather than delete old facts, and historical truth remains queryable [S4]; the Zep paper evaluates temporal agent memory [S6]. Hippo can combine this with connector provenance and explicit source checks.

**Overlap risk.** Adjacent to decay, supersession, provenance, connector deletion sync, and typed temporal graph work. Keep one distinction binding: freshness changes a claim's epistemic serving status; decay changes retrieval strength. Reuse source envelopes and supersession rather than creating a second fact store.

**Privacy/safety boundary.** Revalidation uses the original connector credential and cannot widen scope. `permission_lost` must not be treated as evidence that the source was deleted. Cache no extra source body for a no-change check. Rate-limit and honor provider backoff; never crawl arbitrary URLs from recalled text.

**Measurable gate.** In a controlled GitHub fixture, mutate, delete, and permission-hide source artifacts after ingestion. Within the configured revalidation window: all mutations become new source versions, all deletions become `source_missing`, permission loss remains distinct, unchanged sources cause no duplicate memory, `require_fresh` returns zero stale claims, and conditional checks stay within a predeclared request budget. A paired task eval must show fewer stale-answer errors than age-only retrieval without reducing correct-answer rate beyond a preregistered margin.

## Accepted recommendation 4 — Untrusted-memory taint and instruction firewall

**Problem.** Ingested Slack, GitHub, web, email, and MCP content can contain adversarial instructions. Provenance tells where text came from; it does not stop an agent from following recalled text as instructions. A high-scoring poisoned memory can become a durable prompt-injection channel.

**Concrete first slice.** Add a conservative trust label at ingestion (`user_asserted`, `system_of_record`, `external_untrusted`, `derived`) and propagate the least-trusted label through consolidation and graph-derived objects. Render untrusted recalled material inside a typed data envelope that explicitly separates quoted evidence from agent instructions. Add policy hooks to suppress imperative-looking external text from high-authority slots, while retaining it as inspectable evidence. No claim of perfect prompt-injection detection.

**External precedent.** AgentPoison demonstrates triggered malicious behavior from poisoning agent long-term memory or knowledge bases [S12]. The MCP reference server exposes mutation tools and live resource updates [S8], illustrating how easily external clients can become memory writers. This is a stronger near-term alternative to assigning a vague scalar “source reliability” score.

**Overlap risk.** Adjacent to provenance, confidence tiers, auth, tenant isolation, framing, and policy objects. The non-overlapping invariant is **data/instruction separation plus taint propagation across derived memories**. Do not build a generic malware scanner or silently delete suspicious content.

**Privacy/safety boundary.** Labels are policy metadata, not moral judgments about users or sources. Quarantine/suppression is visible and appealable; original evidence remains accessible to authorized reviewers. Derived memories cannot upgrade trust without a recorded human or trusted-system attestation. Never send private content to an external classifier by default.

**Measurable gate.** Build a held-out poisoning suite across direct memories, connector receipts, consolidated summaries, and graph-derived recall. Compared with today's renderer, the firewall must reduce prohibited tool-action execution by a preregistered large margin (target at least 90%) while preserving benign task completion within 3 percentage points; taint must survive 100% of tested derivation paths; zero untrusted record may appear in a system/developer-instruction slot; and every suppression is explainable in the recall trace.

## Accepted recommendation 5 — Evidence-gated experience-to-procedure induction

**Problem.** Hippo can store first-class processes and skills, but repeatedly successful trajectories do not automatically become a reusable *candidate procedure*. Raw episodic recall forces the agent to rediscover action structure and keeps incidental details.

**Concrete first slice.** Offline only. Cluster completed traces by explicit task class; require both successful and failed examples; induce a typed proposed procedure with preconditions, ordered actions, tool/interface assumptions, known failure modes, source trace IDs, and evidence counts. Store it as `proposed`, never active. Promotion requires human approval plus a paired held-out replay against no-procedure baseline. Revocation and source deletion must invalidate or re-review dependent proposals.

**External precedent.** AWM induces reusable workflows from examples and reports relative success improvements of 24.6% on Mind2Web and 51.1% on WebArena, with cross-domain gains [S9]. ExpeL extracts natural-language insights from collected experiences without parameter updates [S11]. Cognee's official docs index now includes session distillation into permanent lessons [S7]. These support the mechanism, not automatic production promotion.

**Overlap risk.** Directly adjacent to shipped first-class skills/processes, sleep consolidation, outcomes, session trails, and learned lifecycle work. The only justified addition is the bridge **traces → typed proposed procedure → controlled validation → reviewed promotion**. Reuse existing process/skill schemas and review status; do not invent another durable object type.

**Privacy/safety boundary.** Strip secrets, user content, and environment-specific identifiers before induction. Cross-tenant induction is prohibited. A procedure cannot acquire permissions not present in its approved policy. Destructive or external-write steps always remain approval-gated. Failed traces are evidence, never executable demonstrations.

**Measurable gate.** Pre-register 40–60 tasks from at least three repeated task classes and hold out evaluation tasks by project/domain. Compare the same agent/model/tool policy with and without approved procedures. Ship only if paired success improves by at least 10 percentage points (95% bootstrap interval excludes zero), median steps do not increase, prohibited-action rate does not increase, every procedure step maps to at least one source trace, and deleting a source trace correctly recomputes dependency/review state. Production logs alone do not satisfy this gate.

## Rejected or deferred

### Defer — Full branch/merge memory

LangGraph establishes replay and fork as useful execution primitives [S5], but it does not establish a safe general merge policy for durable semantic memory. Merging two memory branches is harder than merging graph state: facts may conflict, decay/retrieval events change strength, deletions carry safety meaning, and derived objects have lineage. Build capsules first; allow a later **ephemeral fork** to reference a capsule and isolated overlay. Reconsider merge only with explicit three-way conflict semantics, deletion/tombstone preservation, and contract tests.

### Reject as framed — Generic uncertainty or source-reliability scalar

A single confidence number would overlap Hippo confidence/provenance while creating false precision. Source authority, claim support, freshness, extraction uncertainty, and contradiction are different dimensions and should not be multiplied into an unexplained score. Implement operational freshness and trust labels first. Revisit calibrated claim-level uncertainty only when a labeled prediction target and reliability diagram can be specified.

### Defer — Portable cross-vendor memory exchange

Cognee's COGX exchange and the MCP memory resource show useful portability precedents [S7, S8], but a new exchange format has lower differentiation and high semantic-loss risk across decay, temporal state, outcomes, and tombstones. Hippo should export retrieval capsules and its existing provenance envelope first. Consider a versioned adapter only after two real migration partners commit fixtures.

### Defer — Autonomous online memory/prompt evolution

Research systems show benefits from adaptive memory and experience extraction [S9, S11], but Hippo's existing learned-lifecycle work already covers much of this territory. Unreviewed online evolution compounds poisoning and non-reproducibility; it should wait for contracts, capsules, taint propagation, and controlled rollback.

### Reject — More graph/vector/session primitives as roadmap headline

Mem0, Graphiti, Cognee, and the MCP reference server all reinforce that these are baseline memory-system capabilities [S1, S2, S4, S7, S8]. Hippo already has the relevant themes. Competitive advantage is now verification, time validity, safety, and controlled procedural learning.

## Primary sources

All sources accessed **2026-08-19**. Product claims are treated as vendor claims unless backed by the cited paper/evaluation.

- **[S1] Mem0, “Add Memory” (official docs).** Expiration semantics, inferred vs raw storage, scoped identifiers. https://docs.mem0.ai/core-concepts/memory-operations/add.md
- **[S2] Chhikara et al., “Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory,” arXiv:2504.19413.** Extract/consolidate/retrieve architecture and LoCoMo accuracy, latency, and token-cost evaluation. https://arxiv.org/abs/2504.19413
- **[S3] Letta, “Gates” (official eval docs).** Threshold gates, non-zero exit status, CI/deployment blocking, preserved results. https://docs.letta.com/v1-sdk/evals/concepts/gates
- **[S4] Graphiti (official repository README).** Temporal validity windows, invalidation without deletion, episode lineage, historical queries. https://github.com/getzep/graphiti
- **[S5] LangGraph, “Use time-travel” (official docs).** Checkpoint replay, fork, and downstream re-execution caveat. https://docs.langchain.com/oss/python/langgraph/use-time-travel
- **[S6] Rasmussen et al., “Zep: A Temporal Knowledge Graph Architecture for Agent Memory,” arXiv:2501.13956.** Temporal graph architecture and DMR/LongMemEval results. https://arxiv.org/abs/2501.13956
- **[S7] Cognee, “Cognee Core Documentation” (official curated index).** Session distillation, traces, inspectable retrieval, temporal mode, COGX exchange. https://docs.cognee.ai/llms-core.md
- **[S8] Model Context Protocol, “Knowledge Graph Memory Server” (official reference repository).** Atomic observations, graph mutation tools, MCP resource and update notifications. https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- **[S9] Wang et al., “Agent Workflow Memory,” arXiv:2409.07429.** Offline/online workflow induction and Mind2Web/WebArena evaluation. https://arxiv.org/abs/2409.07429
- **[S10] Hu, Wang, and McAuley, “Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions” (MemoryAgentBench), arXiv:2507.05257.** Four competencies and incremental benchmark design. https://arxiv.org/abs/2507.05257
- **[S11] Zhao et al., “ExpeL: LLM Agents Are Experiential Learners,” AAAI 2024 / arXiv:2308.10144, revised 2024.** Natural-language insight extraction from accumulated task experience without parameter updates. https://arxiv.org/abs/2308.10144
- **[S12] Chen et al., “AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases,” arXiv:2407.12784.** Memory/knowledge-base poisoning attack on LLM agents. https://arxiv.org/abs/2407.12784

## OUTCOME

Completed a bounded, source-verified external research memo with 12 primary sources, five accepted functionality candidates, scores, concrete first slices, precedent, overlap/safety analysis, measurable gates, and a separate rejected/deferred list.

## GOAL CHECK

**PASS.** The memo targets missing high-value functionality beyond the supplied already-covered themes; accepts no more than five items; treats production logs as observational rather than counterfactual evidence; and remains well below 8,000 words.

## CONTINUATION CHECK

**STOP.** No roadmap edit or implementation is warranted by this research-only assignment. A future owner may translate accepted items into roadmap proposals only after reviewing overlap with active work.

## TOKEN BUDGET

Bounded lane honored: 12 primary sources (limit 8–12), five accepted recommendations (limit five), concise claim capture rather than source excerpts, memo under 8,000 words.

## WORKTREE RECEIPT

Read-only inspection found a materially dirty pre-existing worktree, including modified `ROADMAP.md`, source files, tests, and unrelated untracked files. This task wrote only `research/roadmap-deep-research-2026-08-19-external-v2.md`. No other file was edited, and no commit or push was performed.

## STOP RULE

Stopped after writing and verifying this memo. No `ROADMAP.md` edit, implementation, test/source/package/git-config change, commit, push, or additional file write was performed.
