# Research notes: papers for hippo-on-Kubernetes design (2026-09-25)

Scope: hippo-memory is considering deployment as a shared memory service, or a
per-agent sidecar, for many agent pods on Kubernetes, and as memory for
Kubernetes/SRE ops agents. This is a literature scan, read-only, no code
changes. Every paper below was fetched this session (arXiv abstract page).
Quotes are verbatim from the fetched page. "UNVERIFIED leads" at the end
lists titles that came up in search but were not fetched.

All papers are dated by arXiv submission (v1) unless noted.

---

## A. Shared / multi-agent memory: consistency, access control, sharing

### A1. Collaborative Memory: Multi-User Memory Sharing in LLM Agents with Dynamic Access Control
arXiv 2505.18279, May 2025. Rezazadeh, Li, Lou, Zhao, Wei, Bao.

Introduces a framework for multi-user, multi-agent memory with asymmetric,
time-evolving permissions encoded as bipartite graphs linking users, agents,
and resources. Two-tier memory (private + shared) with immutable provenance
on every fragment, so permission checks can be done retrospectively.

Quote: "Our system maintains two memory tiers: (1) private memory—private
fragments visible only to their originating user; and (2) shared
memory—selectively [distributed to others]."

For hippo on k8s: this is close to hippo's tenant-scoping problem directly.
The bipartite user/agent/resource permission graph plus per-fragment
provenance is a concrete pattern for a shared memory service backing many
agent pods with different owners.

### A2. MemOS: A Memory OS for AI System
arXiv 2507.03724, Jul 2025 (revised through v4, Dec 2025). Li, Xi, Li, Chen,
Chen, Song, et al. (35 authors).

Proposes treating memory as a first-class, schedulable OS resource rather
than an ad hoc RAG add-on, unifying plaintext, activation, and parametric
memory behind one abstraction (MemCube) with provenance and versioning.

Quote: "As the basic unit, a MemCube encapsulates both memory content and
metadata such as provenance and versioning."

For hippo on k8s: the "memory as an OS resource with scheduling, permission
control, exception handling" framing is the closest existing description of
what a hippo sidecar-vs-shared-service split is actually deciding between.

### A3. G-Memory: Tracing Hierarchical Memory for Multi-Agent Systems
arXiv 2506.07398, Jun 2025. Zhang, Fu, Wan, Yu, Wang, Yan.

A three-tier graph memory (insight / query / interaction graphs) for
multi-agent systems, built specifically because flat single-agent memory
schemes ignore collaboration trajectories between agents.

Quote: system "manages the lengthy MAS interaction via a three-tier graph
hierarchy: insight, query, and interaction graphs," giving gains "up to
20.89% and 10.12%" on embodied-action and knowledge-QA tasks respectively.

For hippo on k8s: evidence that a single flat memory store under-serves
multi-agent fleets; a hippo-as-shared-service design should keep a
per-team/per-collaboration layer distinct from per-agent memory, not just
a global namespace.

### A4. MIRIX: Multi-Agent Memory System for LLM-Based Agents
arXiv 2507.07957, Jul 2025. Wang, Chen.

Six specialized memory types (Core, Episodic, Semantic, Procedural,
Resource, Knowledge Vault), each with its own manager agent under a Meta
Memory Manager, instead of one flat store.

Quote: "MIRIX consists of six distinct, carefully structured memory types:
Core, Episodic, Semantic, Procedural, Resource Memory, and Knowledge Vault."
Results: "35% higher accuracy than the RAG baseline while reducing storage
requirements by 99.9%" on ScreenshotVQA; "85.4%" state of the art on LOCOMO.

For hippo on k8s: the 99.9% storage cut from typed memory vs. flat RAG is
directly relevant if hippo is going to hold memory for hundreds of agent
pods rather than one user's chat history — undifferentiated storage will
not scale to a fleet.

### A5. Intrinsic Memory Agents: Heterogeneous Multi-Agent LLM Systems through Structured Contextual Memory
arXiv 2508.08997, Aug 2025 (v2 Jan 2026). Yuen, Gomez Medina, Su, Du, Sobey.

Argues context-window limits break "memory consistency, role adherence, and
procedural integrity" in multi-agent systems, and fixes it with
agent-specific memory that evolves with each agent's own outputs rather
than one shared blob.

Quote: "Multi-agent systems...face fundamental challenges stemming from
context window limitations that impair memory consistency, role adherence,
and procedural integrity." Fix: "agent-specific memories that evolve
intrinsically with agent outputs."

For hippo on k8s: names memory consistency across agents as a named failure
mode with a named fix (role-scoped memory, not one shared context) —
relevant to whether a shared hippo service returns identical results to
every calling pod or per-role views.

### A6. Governed Shared Memory for Multi-Agent LLM Systems
arXiv 2606.24535, Jun 2026. Margalit, Cohen-Inger, Avram, Taig, Margalit.

Formalizes the "fleet-memory problem": what breaks when many agents share
one memory store. Names four failure modes and ships a production
multi-tenant memory service (MemClaw) with governance primitives.

Quote: "This paper formalizes the fleet-memory problem and identifies four
foundational failure modes: unauthorized leakage, stale propagation,
contradiction persistence, and provenance collapse." MemClaw is "a
production multi-tenant memory service," evaluated on four governance
dimensions via an "ArgusFleet" test harness.

For hippo on k8s: this is the single most directly relevant paper found.
The four failure modes (leakage, staleness, contradiction, provenance
collapse) map onto exactly what a shared hippo service exposed to many
agent pods needs to defend against, and it is evaluated as a production
system, not a toy.

### A7. A Survey on Long-Term Memory Security in LLM Agents: Attacks, Defenses, and Governance Across the Memory Lifecycle
arXiv 2604.16548, Apr 2026 (v3 Sep 2026). Lin, Hao, Fu, Cui, Chen, Li, Li,
Xiong.

Organizes memory security around a six-phase lifecycle (Write, Store,
Retrieve, Execute, Share & Propagate, Forget & Rollback) crossed with four
objectives (Integrity, Confidentiality, Availability, Governance), and
argues security cannot be bolted on at retrieval time.

Quote: "robust Long-Term Memory (LTM) security cannot be retrofitted at
retrieval or execution time alone, but must be anchored in storage-time
provenance, versioning, and policy-aware retention from the outset."

For hippo on k8s: gives a checklist (the lifecycle x objective grid) to
audit a k8s deployment of hippo against, especially the "Share &
Propagate" and "Forget & Rollback" phases, which map to cross-pod sharing
and hippo's own decay/consolidation.

### A8. Governing Evolving Memory in LLM Agents: Risks, Mechanisms, and the Stability and Safety Governed Memory (SSGM) Framework
arXiv 2603.11768, Mar 2026 (v2 May 2026). Lam, Li, Zhang, Zhao.

Names semantic drift and topology-induced knowledge leakage as risks of
mutable, self-evolving memory, and proposes decoupling memory evolution
from execution with consistency checks before consolidation.

Quote: "SSGM can mitigate topology-induced knowledge leakage where
sensitive contexts are solidified into long-term storage, and help prevent
semantic drift where knowledge degrades through iterative summarization."

For hippo on k8s: directly applicable to hippo's own "sleep"/consolidation
step — the paper argues consolidation must be gated by a consistency check
before it writes to long-term storage, not run as an unchecked background
job, which bears on how a k8s CronJob or sidecar should run hippo's
consolidation.

### A9. Kernel-Managed Shared Memory for System-Wide Personalization
arXiv 2609.10144, Sep 2026. Lum, Zhang.

Puts memory retrieval, privacy enforcement, and injection control in the
agent-system kernel (evaluated on AIOS) instead of leaving each agent to
manage its own memory calls, and measures the cost of doing so.

Quote: "the agent-system kernel, not individual agents, governs retrieval,
privacy enforcement, and prompt injection." Versus unmanaged Mem0: "kernel-
managed retrieval and injection improve personalization scores by 2.4-4.0
points on a 5-point scale... with every comparison significant at p <
10^-18." Versus full context concatenation: "end-to-end latency is 15-61%
lower across all three models."

For hippo on k8s: the closest existing experiment to "hippo as a
cluster-level kernel service vs. hippo as a per-agent sidecar." Centralized
governance won on personalization and latency/cost versus both an
unmanaged shared backend and per-agent unfiltered context — an argument for
a shared hippo service over N independent sidecars, if privacy enforcement
is centralized in the service rather than left to caller discipline.

---

## B. Serving and scaling agent memory

### B1. Agent Memory: Characterization and System Implications of Stateful Long-Horizon Workloads
arXiv 2606.06448, Jun 2026 (revised Sep 2026). Omri, Gan, Broveak, Geens,
He, Pentland, Verhelst, Weissman, Tambe.

First systems-level characterization of agent memory workloads: a
four-axis taxonomy (construction, storage, retrieval, mutability), a
phase-aware cost-profiling harness, and ten system recommendations.

Quote: "We present the first systems characterization of agent memory...
we build a phase-aware profiling harness attributing cost to construction,
retrieval, and generation... we derive 10 system recommendations covering
construction scheduling, capability floors, amortization via query volume,
freshness-latency tradeoffs, and fleet-scale management."

For hippo on k8s: literally titled around "fleet-scale management" of
agent memory — this is the paper to pull the ten system recommendations
from before sizing a shared hippo deployment.

### B2. Total Recall at What Cost? Benchmarking the Serving Cost of Agentic Memory Systems
arXiv 2608.11879, Aug 2026. Pollertlam, Kornsuwannawit.

Benchmarks Mem0, Hindsight, and Mastra Observational Memory against a
rolling window and full-transcript resubmission, pairing cost with LoCoMo
accuracy across up to 400 turns.

Quote: "a memory system's serving cost cannot be predicted from
conversation length and message size alone... [regressions] missing these
systems by 18-69%," and "no system excels on both accuracy and cost axes,
with accuracy spanning 21-54%."

For hippo on k8s: a warning against sizing a shared hippo service (CPU/
memory requests, HPA thresholds) off conversation length or message count;
serving cost is dominated by each system's internal write/consolidation
behavior, so capacity planning needs hippo-specific measurement, not a
generic proxy metric.

### B3. Autellix: An Efficient Serving Engine for LLM Agents as General Programs
arXiv 2502.13965, Feb 2025. Luo, Shi, Cai, Zhang, Wong, Wang, Wang, Huang,
Chen, Gonzalez, Stoica.

Serving engine that treats an agent's full call graph, not each LLM call in
isolation, as the scheduling unit, fixing head-of-line blocking across
calls in the same program.

Quote: "Autellix intercepts LLM calls submitted by programs, enriching
schedulers with program-level context," improving "throughput of programs
by 4-15x at the same latency compared to state-of-the-art systems, such as
vLLM."

For hippo on k8s: if hippo calls (read/write/consolidate) are treated as
opaque requests by whatever serves the underlying LLM calls around them,
they inherit the same head-of-line blocking Autellix fixes; argues for
making memory calls program-aware in any scheduler sitting in front of a
pod fleet, not just raw request-level load balancing.

### B4. Agentic Plan Caching: Test-Time Memory for Fast and Cost-Efficient LLM Agents
arXiv 2506.14852, Jun 2025 (v2 Jan 2026). Zhang, Wornow, Wan, Olukotun.

A specific, narrow form of agent memory (cached plan templates from prior
runs, reused on semantically similar tasks) shown to cut cost and latency
directly.

Quote: "our system can reduce costs by 50.31% and latency by 27.28% on
average while maintaining [96.61% of optimal application performance]."

For hippo on k8s: a concrete, cheap memory product (plan/procedure caching,
close to hippo's "outcome" feedback) with a measured cost/latency payoff —
a candidate feature to prioritize for SRE-agent pods where the same
remediation plans recur.

### B5. Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving
arXiv 2407.00079, Jun 2024 (v4 Sep 2025). Qin, Li, He, Zhang, Wu, Zheng, Xu.

Not agent-memory-specific, but the reference architecture for disaggregating
state (KV cache) from compute across a cluster, with CPU/DRAM/SSD tiers and
SLO-aware scheduling — the same shape of problem as tiering hippo's SQLite
store away from each agent pod.

Quote: "It features a KVCache-centric disaggregated architecture that
separates the prefill and decoding clusters" and "leverages the
underutilized CPU, DRAM, and SSD resources of the GPU cluster." Result: "up
to a 525% increase in throughput in certain simulated scenarios while
adhering to SLOs."

For hippo on k8s: the production precedent for "disaggregate stateful
memory from compute, tier it across CPU/DRAM/SSD, schedule against SLOs" —
the architectural pattern a shared hippo service would want if backing many
pods rather than co-locating a SQLite file per pod.

---

## C. LLM agents for Kubernetes / cloud operations, and incident memory

### C1. AIOpsLab: A Holistic Framework to Evaluate AI Agents for Enabling Autonomous Clouds
arXiv 2501.06706, Jan 2025. Chen, Shetty, Somashekar, Ma, Simmhan, Mace,
Bansal, Wang, Rajmohan.

Multi-institution (Microsoft Research, UC Berkeley, UIUC, IISc) framework
that deploys microservice environments, injects faults, and gives agents a
standard interface to detect, diagnose, mitigate, and resolve incidents
end to end — coins the term "AgentOps."

Quote: "we present AIOPSLAB, a framework that not only deploys microservice
cloud environments, injects faults, generates workloads, and exports
telemetry data but also orchestrates these components and provides
interfaces for interacting with and evaluating agents," toward "a paradigm
we term AgentOps."

For hippo on k8s: the standard benchmark environment to validate any
hippo-backed SRE agent against before claiming it improves incident
handling; also the reference framing ("AgentOps") for the whole product
category hippo would be entering.

### C2. ITBench: Evaluating AI Agents across Diverse Real-World IT Automation Tasks
arXiv 2502.05352, Feb 2025. Jha, Arora, Watanabe, Yanagawa, et al. (IBM +
UIUC).

94 real-world IT automation scenarios across SRE, CISO (security/
compliance), and FinOps, with state-of-the-art agents resolving very few of
them.

Quote: "Our initial release targets three key areas: Site Reliability
Engineering (SRE), Compliance and Security Operations (CISO), and Financial
Operations (FinOps)." Results: "agents powered by state-of-the-art models
resolve only 13.8% of SRE scenarios, 25.2% of CISO scenarios, and 0% of
FinOps scenarios."

For hippo on k8s: sets a low current baseline (13.8% SRE resolution, 0%
FinOps) for agents without persistent incident memory — the gap that a
hippo-backed retrieval layer would need to show it closes, and a ready
benchmark to run that comparison on.

### C3. Automatic Root Cause Analysis via Large Language Models for Cloud Incidents (RCACopilot)
arXiv 2305.15778, May 2023 (v4 Nov 2023). Chen, Xie, Ma, Kang, Gao, Shi,
Cao, Gao, Fan, Wen, Zeng, Ghosh, Zhang, Zhang, Lin, Rajmohan, Zhang, Xu.
EuroSys 2024.

Production Microsoft on-call system: routes incidents to handlers by alert
type, aggregates diagnostics, and predicts a root-cause category with an
LLM, evaluated on a full year of real incidents.

Quote: "We evaluate RCACopilot using a real-world dataset consisting of a
year's worth of incidents from Microsoft. Our evaluation demonstrates that
RCACopilot achieves RCA accuracy up to 0.766... the diagnostic information
collection component of RCACopilot has been successfully in use at
Microsoft for over four years."

For hippo on k8s: the strongest production evidence in this set — four
years of real deployment, 0.766 RCA accuracy on a year of real incidents.
Note: the abstract does not describe similar-incident retrieval explicitly
(described elsewhere as RAG over past incidents); treat that mechanism as
plausible but not itself quoted from this page.

### C4. Flow-of-Action: SOP Enhanced LLM-Based Multi-Agent System for Root Cause Analysis
arXiv 2502.08224, Feb 2025. Pei, Wang, Liu, Li, Liu, He, Kang, Zhang, Chen,
Li, Xie, Pei.

Constrains a ReAct-style RCA agent with Standard Operating Procedures
(SOPs) sourced from SRE expertise, cutting hallucinated actions.

Quote: "SOP flow contains a series of tools... This significantly
alleviates the hallucination issues of ReAct in RCA tasks." Result: 64.01%
accuracy vs. ReAct's 35.50%.

For hippo on k8s: nearly doubling RCA accuracy (35.50% to 64.01%) by
grounding the agent in retrieved procedural knowledge (SOPs) rather than
free-form reasoning is direct evidence that persistent, structured memory
(procedures, not just facts) improves root-cause accuracy — the strongest
finding here for "does past-incident/procedure memory help."

### C5. ARGUS: MCP-Grounded Root Cause Analysis for Kubernetes Incidents
arXiv 2608.23084, Aug 2026. Senja, Razavi Zadegan, Leitner.

Connects an LLM to live Kubernetes observability data (state, Prometheus,
Loki, NATS) via MCP servers and posts diagnostic summaries into the
on-call Slack channel; evaluated with fault injection plus practitioner
interviews.

Quote: "ARGUS named the correct root cause in all ten scenarios with an
aggregate MCP success ratio of 0.91." But: "a diagnostic/prescriptive
asymmetry: ARGUS reliably identifies what went wrong, but is perceived as
less reliable or trustworthy at specifying what to do next."

For hippo on k8s: this system grounds on live telemetry via MCP, not
historical incident memory — the named gap (good diagnosis, distrusted
prescriptions) is exactly where a hippo memory of past fixes and their
outcomes could plausibly help, since "what to do next" is precisely what
outcome-tagged memory (hippo's `outcome --good`/`--error`) is built to
retrieve.

### C6. Graph Traversal Agent: Auditable Graph-Guided Root Cause Analysis for Kubernetes Incidents
arXiv 2606.08590, Jun 2026. Kuvshinova, Jin.

Root-cause agent that reasons over a typed evidence graph with deterministic
tool operations for evidence collection and verdict validation, tested on
ITBench; separates prompt-tuned gains from gains that survive stripped
prompts.

Quote: "The model reasons over a typed evidence graph, while deterministic
graph and tool operations collect evidence, bound the search, and check
proposed verdicts." F1 rose "from 0.6087 to 0.9130" on a 23-scenario
subset, but a stripped-prompt ablation "retains 0.6958 F1" — "we report it
as benchmark-coupled rather than broad cross-cluster RCA evidence."

For hippo on k8s: a useful methodological caution alongside C4/C5 — self-
reported RCA gains can be partly prompt-specific rather than memory- or
retrieval-driven; any hippo-vs-no-memory comparison for a k8s SRE agent
should run the same stripped-prompt ablation before crediting memory.

---

## D. Security of shared agent memory in multi-tenant deployments

### D1. A Practical Memory Injection Attack against LLM Agents (MINJA)
arXiv 2503.03704, Mar 2025 (v5 Feb 2026). Dong, Xu, He, Li, Tang, Liu, Liu,
Xiang.

Shows an attacker can poison an agent's memory bank purely by sending
queries and observing outputs — no direct write access to the memory store
required — using "bridging steps" to make poisoned records retrievable
later for a different victim query.

Quote: "The attacker injects malicious records into the memory bank by only
interacting with the agent via queries and output observations... we
introduce a sequence of bridging steps to link victim queries to the
malicious reasoning steps."

For hippo on k8s: the threat model that matters most for a shared hippo
service — any agent pod with ordinary query access, not just one with
write/admin access, can poison memory that other pods later retrieve. Rules
out "only validate writers" as a sufficient defense for multi-tenant hippo.

### D2. AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases
arXiv 2407.12784, Jul 2024. Chen, Xiang, Xiao, Song, Li.

Backdoor attack that optimizes a trigger so poisoned demonstrations are
retrieved whenever the trigger appears, while leaving normal queries
unaffected and requiring no model retraining, tested on RAG-based
autonomous driving, QA, and healthcare agents.

Quote: "On each agent, AgentPoison achieves an average attack success rate
higher than 80% with minimal impact on benign performance (less than 1%)
with a poison rate less than 0.1%."

For hippo on k8s: under 0.1% poisoned records is enough for >80% attack
success while benign accuracy barely moves — a multi-tenant hippo service
can't rely on aggregate accuracy monitoring to detect poisoning; needs
per-tenant provenance/anomaly checks at write time (ties to A6/A7's
storage-time governance argument).

### D3. PoisonedRAG: Knowledge Corruption Attacks to Retrieval-Augmented Generation of Large Language Models
arXiv 2402.07867, Feb 2024. Zou, Geng, Wang, Jia.

Formalizes RAG knowledge-base poisoning as an optimization problem, with
both black-box and white-box variants; a handful of injected texts move a
specific target answer even in a knowledge base of millions of texts.

Quote: "PoisonedRAG could achieve a 90% attack success rate when injecting
five malicious texts for each target question into a knowledge database
with millions of texts."

For hippo on k8s: five malicious documents move a targeted answer in a
million-document store — the scale argument. A shared hippo memory backing
many agent pods is exactly this kind of large shared knowledge base, so
per-write validation has to work at the level of individual writes, not
"the pool is big enough to dilute bad data."

---

## UNVERIFIED leads (found via search, not fetched this session)

Do not cite these as findings; they are pointers for a later pass.

- MetaKube: An Experience-Aware LLM Framework for Kubernetes Failure
  Diagnosis (ACM Web Conference 2026 proceedings; no arXiv link found in
  search, only the ACM DOI page — not fetched).
- KubeIntellect, KubeLLM, KubeGuard — Kubernetes-specific LLM agent papers
  surfaced in search snippets only.
- Cloud-OpsBench (arXiv 2603.00468) — reproducible agentic RCA benchmark,
  surfaced but not fetched.
- CorruptRAG, RAGForensics, ToxicRAG — RAG poisoning/defense/traceback
  follow-ons to PoisonedRAG, surfaced but not fetched.
- SMetric, TOPAS, HexAGenT, ForkKV, KVServe, TraCT, CXL-SpecKV — agent
  serving/scheduling and disaggregated-cache systems papers surfaced in the
  same search sweep as B3/B5 but not individually fetched; likely relevant
  to a deeper capacity-planning pass on a shared hippo service.

---

## Design implications

1. **Default to a shared hippo service with centralized governance, not
   per-pod sidecars with independent policy.** A9 (kernel-managed shared
   memory) measured centralized governance beating an unmanaged shared
   backend on personalization (2.4-4.0 points, p < 10^-18) and beating full
   context concatenation on latency (15-61% lower) with matched accuracy.
   Independent sidecars replicate the "individual agents govern their own
   memory" arm that A9 shows loses.

2. **Build hippo's tenant scoping around the four named fleet-memory
   failure modes, not just row-level access control.** A6 names
   unauthorized leakage, stale propagation, contradiction persistence, and
   provenance collapse as the failure taxonomy for shared multi-agent
   memory. Hippo's existing scope isolation covers leakage; staleness,
   contradiction, and provenance need explicit handling (timestamps that
   supersede, conflict detection, an immutable write log) before hippo is
   exposed to many concurrent agent pods.

3. **Gate hippo's "sleep"/consolidation step behind a consistency check
   before it writes to long-term storage, and run it as a scheduled,
   auditable job, not an unchecked background loop.** A8 (SSGM) ties
   semantic drift and topology-induced leakage specifically to
   consolidation that runs without a pre-write consistency check. On k8s
   this argues for consolidation as a CronJob or controlled Job with its
   own audit trail, matching A7's storage-time-provenance argument.

4. **Treat write-time validation, not aggregate accuracy monitoring, as the
   primary defense against a poisoned shared memory.** D1 (MINJA) shows an
   attacker needs only ordinary query access, not write access, to poison
   memory over time. D2 (AgentPoison) and D3 (PoisonedRAG) show attack
   success above 80-90% from a small fraction of poisoned records with
   negligible aggregate accuracy impact — aggregate monitoring will not
   catch this. Hippo needs per-write provenance and anomaly checks at
   ingest, scoped per tenant, not a global "does average quality look OK"
   gate.

5. **Size and schedule the shared service off hippo-specific
   profiling, not off conversation length or request count.** B2 found
   serving cost is not predictable from conversation length/message size
   (18-69% miss rate across other memory systems) and B1 gives a concrete
   four-axis taxonomy plus a phase-aware cost harness for exactly this
   profiling. Before setting Kubernetes resource requests/HPA thresholds
   for hippo, run B1's harness against hippo's own construction/retrieval/
   consolidation phases.

6. **If hippo backs a k8s SRE/RCA agent, prioritize memory of procedures
   and past-fix outcomes over raw incident-text retrieval.** C4
   (Flow-of-Action) nearly doubled RCA accuracy (35.50% to 64.01%) by
   grounding the agent in structured SOPs rather than free-form reasoning.
   C5 (ARGUS) found current live-telemetry-only agents are good at
   diagnosis but distrusted on "what to do next" — the gap hippo's outcome-
   tagged memory (`outcome --good`/`--error`) is positioned to fill. C3
   (RCACopilot) is the strongest production precedent (4 years live at
   Microsoft, 0.766 accuracy on a year of real incidents) for a persistent
   diagnostic-memory system paying off in practice.

7. **Validate any "memory improves RCA" claim with a stripped-prompt
   ablation before shipping it as a hippo differentiator.** C6 found a
   self-reported F1 gain (0.6087 to 0.9130) partly collapsed to 0.6958
   once scenario-specific prompt hints were removed, and the authors
   explicitly scoped their remaining gain as benchmark-coupled. Any
   internal hippo-for-SRE-agents benchmark should run the same check
   (hippo memory on vs. off, prompt held constant, scenario hints
   stripped) before claiming a specific accuracy delta.

8. **Use AIOpsLab (C1) and ITBench (C2) as the evaluation harness, not a
   bespoke benchmark, when validating a hippo-backed SRE agent.** Both are
   Kubernetes-based, multi-institution, already show low baseline
   resolution rates for memory-less agents (ITBench: 13.8% SRE, 0%
   FinOps), and are the standard this category is being measured against;
   building a one-off eval risks producing a number nobody outside hippo
   can compare against.

9. **Treat a disaggregated, tiered memory store (SQLite still fine as the
   record format, but not necessarily co-located per pod) as the scaling
   path once hippo backs more than a handful of agent pods.** B5
   (Mooncake) is the production precedent for disaggregating stateful
   cache from compute across CPU/DRAM/SSD tiers with SLO-aware scheduling
   (525% throughput gain in simulation, 75% more requests handled under
   real load) — the same shape of problem as many k8s pods sharing hippo's
   store without each pod owning a local file.
