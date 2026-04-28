# Research Directions

Hippo is an external memory system today. The mechanisms it implements have deeper implications for how LLMs learn, retain, and forget. This document maps the connections between hippo's design and open problems in machine learning research.

## The lineage

Hippo's architecture draws directly from McClelland, McNaughton & O'Reilly's Complementary Learning Systems theory (1995). That paper wasn't about brains. It was about neural networks. McClelland showed that standard neural nets suffer catastrophic forgetting: training on new data overwrites old knowledge. His solution was two complementary systems with different learning rates, one that captures experiences quickly, one that integrates them slowly through interleaved replay.

This idea has already produced major results in ML:

| Year | Technique | Neuroscience Origin | Impact |
|------|-----------|-------------------|--------|
| 2013 | Experience Replay (DQN) | Hippocampal replay during sleep | Made deep RL work for the first time |
| 2015 | Prioritized Experience Replay | Emotional tagging (amygdala) | 2x improvement in Atari benchmark |
| 2017 | Elastic Weight Consolidation | Synaptic consolidation | Reduced catastrophic forgetting in sequential tasks |
| 2021 | LoRA | Fast/slow learning systems | Efficient fine-tuning without overwriting base knowledge |
| 2024 | Continual pre-training | Schema-accelerated consolidation | Domain adaptation with knowledge retention |

Hippo implements all seven hippocampal mechanisms as software. The question is whether these mechanisms, currently external to the model, could be moved inside the training loop.

## Seven mechanisms, mapped to ML

### 1. Two-speed learning (CLS) -> Adapter + Base model

**Current state:** LoRA, QLoRA, and similar adapter methods already separate fast-learning (adapter weights) from slow-learning (frozen base). But the adapter is static after training. There's no ongoing dialogue between the two.

**Open problem:** A continual learning pipeline where the adapter captures new interactions in deployment, and a background "consolidation" process periodically distills the adapter back into the base model weights, then resets the adapter. This would give LLMs genuine ongoing learning without catastrophic forgetting.

### 2. Decay by default -> Training signal deprecation

**Current state:** All training examples are treated equally regardless of age. A 3-year-old StackOverflow answer has the same weight as yesterday's documentation update.

**Open problem:** Time-weighted training where older examples naturally contribute less unless they've been "retrieved" (cited, referenced, or matched by users). This is the forgetting curve applied to training data curation. Hippo's strength formula (exponential decay + retrieval boost) could directly weight training examples.

### 3. Retrieval strengthening -> Reinforcement from usage

**Current state:** RLHF reinforces outputs that humans prefer. But it doesn't reinforce the *knowledge* that produced those outputs.

**Open problem:** When a model retrieves and uses a piece of knowledge successfully (positive user feedback), that knowledge should be reinforced in the weights. When knowledge is retrieved but leads to negative feedback, it should be weakened. Hippo's `outcome --good/--bad` generates exactly this signal.

**Hippo implementation (v0.11.0):** Reward-proportional decay. Cumulative outcome counts modulate effective half-life via a reward factor (range 0.5-1.5), inspired by R-STDP in spiking neural networks. See [MH-FLOCKE](https://github.com/MarcHesse/mhflocke) for the embodied AI parallel.

### 4. Emotional tagging -> Error-prioritized replay

**Current state:** Prioritized Experience Replay (Schaul et al., 2015) replays high-TD-error examples more frequently in RL. But this hasn't been systematically applied to LLM training.

**Open problem:** Continual training that over-samples from error-producing interactions. When a deployed model generates a hallucination or produces code that fails to compile, that interaction should be replayed at 2-5x the rate of successful interactions. Hippo's error-tagged memories with 2x half-life model this directly.

### 5. Sleep consolidation -> Offline distillation

**Current state:** Knowledge distillation exists (training a smaller model from a larger one). But there's no "sleep cycle" where a model consolidates its recent adapter learning into compressed, generalized knowledge.

**Open problem:** Periodic offline passes where:
1. Recent interaction logs are compressed into representative examples
2. Redundant examples are merged (like hippo's episodic-to-semantic consolidation)
3. The compressed set is used for a brief fine-tuning pass
4. The interaction buffer is cleared

This is sharp-wave ripple replay, implemented as a training pipeline.

### 6. Schema acceleration -> Curriculum-aware continual learning

**Current state:** Curriculum learning (Bengio et al., 2009) orders training examples by difficulty. But it doesn't account for what the model already knows.

**Open problem:** New training data that is consistent with the model's existing knowledge should be integrated faster (higher learning rate, fewer epochs needed). Novel or contradictory data should be learned more slowly and carefully. Hippo's schema_fit score measures exactly this: how well new information fits existing patterns.

**Measurement approach:** Compare the embedding of new training data against the model's existing knowledge (approximated by its confident outputs on related prompts). High similarity = high schema fit = faster integration.

### 7. Interference detection -> Contradiction-aware training

**Current state:** Models trained on contradictory data (e.g., "the capital of Australia is Sydney" and "the capital of Australia is Canberra") simply average the signal, often producing confidently wrong outputs.

**Open problem:** Detecting contradictions in training data before they're learned. When new data conflicts with strongly-held existing knowledge, flag it for human review rather than blindly training on it. Hippo's conflict detection mechanism (flagging memories that contradict each other) is the prototype.

## What hippo collects that nobody else has

If hippo achieves meaningful adoption, it will generate a unique dataset:

- **What memories matter over time.** Which memories get retrieved repeatedly (strong signal) vs which decay unused (noise)?
- **Outcome-labeled retrievals.** For each memory retrieval, did it help the task (positive outcome) or not (negative)? This is direct training signal for retrieval model improvement.
- **Decay curves by domain.** How quickly do different types of knowledge become irrelevant? Is a Python syntax rule more durable than an API endpoint URL? The data would tell us.
- **Consolidation patterns.** Which episodic memories naturally cluster into semantic patterns? This reveals how knowledge generalizes.
- **Error taxonomy.** What kinds of mistakes do agents make repeatedly? What memory prevents them? This is a curriculum for agent training.

This data doesn't exist anywhere else because no other tool tracks memory lifecycle. Mem0, Basic Memory, and similar tools store and retrieve. They don't track decay, retrieval frequency, outcome feedback, or consolidation.

## Near-term research opportunities

### 1. Benchmark: Memory-Augmented Agent Evaluation

Build a standardized eval: give an agent a sequence of 50 tasks in a codebase with 10 planted traps. Measure trap-hit-rate over the sequence. Compare:
- No memory (baseline)
- Static memory (CLAUDE.md/AGENTS.md)
- Hippo with full mechanics (decay, strengthening, consolidation)

Hypothesis: hippo-equipped agents improve over the sequence (learning from early mistakes), while static memory agents show no improvement.

### 2. Optimal Decay Parameters

Run sensitivity analysis on the strength formula:
- Half-life range: 1 day to 90 days
- Retrieval boost: +1 to +5 days per retrieval
- Error multiplier: 1.5x to 3x

Measure: for a given workload, which parameters maximize the signal-to-noise ratio of retrieved memories?

### 3. Consolidation Quality

Compare consolidation strategies:
- Rule-based merge (current: text overlap threshold)
- LLM-powered merge (use a model to synthesize episodic memories into a general principle)
- Embedding cluster merge (group by embedding similarity, summarize clusters)

Measure: which strategy produces semantic memories that are most useful for future retrieval?

### 4. Cross-Agent Transfer Learning

Test whether memories learned by Agent A on Project X transfer usefully to Agent B on Project Y.
- Which memory types transfer well? (language rules, tool gotchas, architectural patterns)
- Which are too project-specific to transfer? (file paths, variable names, specific API endpoints)
- Can schema_fit predict transferability?

### 5. AI Pineal Gland — Intuition and Awareness Module

Build an intuition/awareness layer on top of hippo's existing infrastructure. Three components:

**Ambient state vector.** A continuous background representation of the agent's context. The physics simulation already models this: particle positions encode semantic relationships, velocities encode recent trajectory, and system energy captures overall memory coherence. Extend this into a compact state vector that's injected alongside memory context, giving the agent a "feel" for its knowledge landscape without retrieving specific memories.

**Fast-path heuristic (System 1).** A lightweight pre-generation check that runs before the full LLM call. Given the ambient state + the incoming prompt, predict whether the agent has relevant knowledge, is entering familiar vs novel territory, or is about to repeat a known mistake. This parallels OpenClaw's ClawRouter (`classifyByRules`) which classifies prompts across 7 dimensions to route to different model tiers. The pineal gland version would classify prompts against the memory state.

**Salience gate.** Filters what deserves attention vs noise. Currently hippo's search scoring + token budget system does this at retrieval time. The salience gate would operate earlier — at memory *creation* time — deciding what's worth storing and at what priority. Schema fit already does a version of this (high-fit memories consolidate faster). A salience gate would make the decision explicit: "this error is novel and important" vs "this is the 5th timeout in a row, skip it."

The physics engine is the natural substrate. Ambient state = system energy + velocity distribution. Fast-path = cosine between query embedding and particle cluster centroids (sub-millisecond). Salience = rate of change in the state vector after a new memory is added.

## Long-term vision

The end state is not an external tool. It's LLMs that have hippocampal circuits built into their architecture:
- A fast-learning module that captures deployment interactions
- A consolidation process that runs during idle compute
- Decay that naturally removes outdated knowledge
- Emotional tagging that prioritizes error-corrective learning
- Retrieval that strengthens useful knowledge and weakens noise

Hippo is the prototype. The data it generates is the evidence base. The research above is the bridge.

## Related Work

### HippoRAG

[HippoRAG](https://arxiv.org/abs/2405.14831) (Gutierrez et al., 2024) applies hippocampal indexing theory to retrieval-augmented generation, using knowledge graphs as an analog to the entorhinal cortex's pattern separation. The approach is complementary but distinct from Hippo's: HippoRAG focuses on retrieval quality via graph-based indexing, while Hippo focuses on memory lifecycle (decay, consolidation, invalidation). The name overlap reflects shared neuroscience inspiration, not shared techniques.

### MH-FLOCKE (Embodied Cognition via Spiking Networks)

[MH-FLOCKE](https://github.com/MarcHesse/mhflocke) (Hesse, 2026) is a biologically-inspired architecture for quadruped locomotion using Izhikevich spiking neurons with reward-modulated spike-timing-dependent plasticity (R-STDP). The system uses 5,000+ spiking neurons organized into a 15-step cognitive loop running at 200 Hz, including spinal reflexes, a cerebellar forward model, episodic memory, motivational drives, and a global workspace.

The memory parallel is direct: in MH-FLOCKE, "memory" lives in synaptic weights. Synapses that contribute to reward are strengthened via R-STDP; those that don't weaken naturally. Stop the robot, restart it, and the weights reload. No explicit forgetting mechanism is needed because decay emerges from the reward signal.

**What hippo borrowed:** Reward-proportional decay (v0.11.0). Instead of fixed half-life deltas on outcome feedback, hippo now modulates effective half-life continuously based on cumulative reward ratio, directly inspired by R-STDP's continuous reward-driven plasticity.

**Key differences:**

| Property | MH-FLOCKE | Hippo |
|----------|-----------|-------|
| Abstraction level | Sub-symbolic (spike trains, synaptic weights) | Symbolic (text, tags, confidence tiers) |
| Memory inspectability | Opaque (can't ask "what does synapse #3472 know?") | Fully inspectable (`hippo inspect <id>`) |
| Decay driver | Reward absence (continuous, implicit) | Time + reward ratio (explicit half-life) |
| Domain | Continuous motor control (joint angles, gait) | Discrete knowledge tasks (code, decisions, errors) |
| Persistence | Weight file reload | SQLite + markdown mirrors |
| Consolidation | Dream mode (offline replay) | `hippo sleep` (episodic-to-semantic merge) |
| Search | N/A (weights are the knowledge) | BM25 + cosine embeddings |

MH-FLOCKE validates that biologically-inspired memory with natural decay works in embodied systems. Hippo validates it works for LLM agent knowledge management. Same neuroscience, different substrates.

### MemPalace (Spatial Memory Organization)

[MemPalace](https://github.com/milla-jovovich/mempalace) (Sigman & Jovovich, 2026) organizes AI memory using a spatial metaphor: wings (people/projects), halls (connection types), rooms (specific topics), closets (compressed summaries), and drawers (verbatim originals). It achieved a perfect 500/500 score on LongMemEval using Claude Haiku reranking and 96.6% with local-only retrieval.

The system uses AAAK, a lossless compression dialect that achieves 30x token reduction, and a four-layer memory stack (L0-L3) from identity prompts through full semantic search. Storage is ChromaDB (vectors) + SQLite (temporal knowledge graph).

**Hippo vs MemPalace: different philosophies.**

MemPalace answers: "How do you find the right memory?" It solves retrieval quality through spatial structure and achieves state-of-the-art benchmark scores doing it. Everything is kept. Organization makes it findable.

Hippo answers: "Which memories are worth keeping?" It solves memory lifecycle through decay, strengthening, and consolidation. Useless memories disappear. Useful ones get stronger. The system self-curates.

| Property | Hippo | MemPalace |
|----------|-------|-----------|
| Philosophy | Forget by default, earn persistence | Store everything, organize for retrieval |
| Forgetting | Automatic (exponential decay) | Manual invalidation only |
| Retrieval strengthening | Yes (half-life extension + reward factor) | No |
| Compression | No (full text stored) | AAAK (30x lossless compression) |
| Search | BM25 + embeddings | Spatial structure + embeddings |
| Storage | SQLite + markdown (zero deps) | ChromaDB + SQLite |
| Conflict detection | Yes | No |
| Outcome feedback | Yes (reward-proportional decay) | No |
| LongMemEval | Not benchmarked | 100% (reranked), 96.6% (raw) |
| Dependencies | Zero runtime | ChromaDB |

These systems are complementary. MemPalace's spatial organization and AAAK compression could improve how hippo stores and compresses semantic memories. Hippo's decay and outcome feedback could give MemPalace a mechanism to surface high-value memories and let stale ones fade.

### LongMemEval as a Benchmark Target

[LongMemEval](https://arxiv.org/abs/2410.10813) (Wu et al., ICLR 2025) tests five core long-term memory abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. The benchmark uses 500 questions embedded in scalable chat histories.

Current leaderboard (approximate): MemPalace 100% (reranked) / 96.6% (raw), Supermemory ASMR ~99%, Mastra ~95%, MemLayer ~94%, Mem0 ~49-85% (varies by version).

**Hippo v0.11.0 LongMemEval retrieval results (BM25 only, zero dependencies):**

| Metric | Score |
|--------|-------|
| Recall@1 | 50.4% |
| Recall@3 | 66.6% |
| Recall@5 | 74.0% |
| Recall@10 | 82.6% |

Strongest on knowledge-update (R@5=88.5%) and single-session-assistant (94.6%). Weakest on single-session-preference (26.7%), where queries reference preferences indirectly and keyword overlap is low.

For context: MemPalace scores 96.6% (raw) using ChromaDB embeddings + spatial indexing. Hippo's 74.0% uses BM25 keyword matching alone. The gap is expected: BM25 misses semantic similarity. Adding embeddings (`hippo embed`) enables hybrid search and should close it.

The benchmark tests retrieval accuracy, which is not hippo's primary thesis. Hippo's thesis is that memory lifecycle management (decay, strengthening, consolidation) produces better *agent behavior over time*, not better *retrieval precision on a fixed corpus*. The sequential learning benchmark (78% trap rate -> 14% over 50 tasks) tests this directly. Both benchmarks are needed: LongMemEval for public comparability, sequential learning for differentiation.

The five abilities map to hippo features:

| LongMemEval Ability | Hippo Feature |
|---------------------|---------------|
| Information extraction | `hippo remember` + `capture` |
| Multi-session reasoning | `hippo recall` (BM25 + embeddings across sessions) |
| Temporal reasoning | Timestamps on all memories, `--framing observe` includes dates |
| Knowledge updates | `hippo invalidate`, `hippo decide --supersedes`, conflict detection |
| Abstention | Confidence tiers (`stale`, `inferred`) signal when not to trust |

Running LongMemEval is a near-term priority. It would let hippo participate in direct comparisons and expose retrieval gaps.

### Early Work on Agent Memory Simulation

The HN commenter [davman](https://news.ycombinator.com/item?id=47667672) shared three IEEE papers from 2010-2011 that predate the current wave of LLM memory systems. These papers explored biologically-inspired memory for virtual agents and serious games:

- **"Storing objects in a short-term biologically inspired memory system for artificial agents"** ([IEEE 5952114](https://ieeexplore.ieee.org/document/5952114), 2011). Proposes a method for short-term storage that emulates biological memory systems in artificial agents, examining how capacity limits and decay affect agent behavior.

- **"Storage, degradation and recall of agent memory in Serious Games and Simulations"** ([IEEE 5548405](https://ieeexplore.ieee.org/document/5548405), 2010). Describes a biologically-inspired method for storing, degrading, and recalling agent memories. Considers biological limits on both storage and recall capacity, modeling realistic memory degradation over time.

- [IEEE 5953964](https://ieeexplore.ieee.org/document/5953964) (2011). Related work by the same author on agent memory and behavior simulation.

The key insight from this line of research: human-like memory storage produces human-like behavior as an emergent property. The example of walking between rooms and forgetting why you went there is a behavior that would otherwise need direct simulation, but falls out naturally from a memory system with capacity limits and context-dependent recall. This aligns directly with hippo's design: we don't program specific forgetting behaviors. We implement decay, and irrelevant context disappears on its own.

These papers were ahead of their time. The mechanisms they described (capacity limits, degradation curves, context-dependent recall) are now being rediscovered in the LLM agent memory space, fifteen years later.


## Hippo as a Company Brain

Yes, Hippo-Memory is a strong foundation for a true Company Brain. The reason is not just that it can store context. The reason is that it already models knowledge as a living system: decay, retrieval strengthening, sleep-based consolidation, error stickiness, reward-proportional half-lives, bi-temporal correction, extracted facts, and DAG summarisation. That is much closer to how real institutional memory works than a static vector database or a giant prompt log.

This also matches the core YC Company Brain idea well: a dynamic, executable map of company know-how that stays current instead of expanding into stale noise. Hippo's current architecture already gives agents a plausible institutional memory substrate: session buffer to episodic to semantic compression, intelligent forgetting, SQLite as source of truth, human-readable Markdown mirrors, framework hooks, MCP exposure, active snapshots, handoffs, and scoped recall.

### Current strengths for a Company Brain

- **Adaptive knowledge hygiene.** Most memory systems only accumulate. Hippo forgets on purpose. Unused processes fade, successful lessons strengthen, and errors stay sticky enough to matter.
- **Two-speed memory.** Buffer, episodic, and semantic layers already mirror the company pattern of turning raw chat and ticket history into stable playbooks.
- **Correction without deletion.** `hippo supersede` and `--as-of` are unusually important for enterprise use because companies need both current truth and historical truth.
- **Fact extraction and DAG summaries.** Sleep-time extraction plus hierarchical summaries are already the beginning of a usable company knowledge substrate, not just a personal notebook.
- **Short-term continuity primitives.** Active task snapshots, session trails, handoffs, and working memory are exactly what agents need to resume work without replaying whole transcripts.
- **Portable integration surface.** SQLite plus Markdown mirrors, hooks, MCP, and a small CLI are the right starting point for adoption. They are inspectable, debuggable, and easy to graft onto existing workflows.

### Gaps to close

Hippo is still primarily agent-centric and local-first. A full Company Brain needs extra layers that the current product only hints at:

- **Enterprise ingestion.** Slack, Jira or Linear, Notion or Docs, PRs, incident tools, email, meeting transcripts, and databases need durable ingestion paths.
- **Shared security model.** Multi-user tenancy, RBAC, audit logs, scoped access, and approval boundaries are required before this becomes real company infrastructure.
- **Relationship-first reasoning.** Extracted facts and DAG summaries help, but deeper multi-hop reasoning across decisions, policies, owners, customers, systems, and exceptions needs a graph-shaped layer.
- **First-class operating objects.** Processes, decisions, skills, incidents, run capsules, and policy exceptions should become first-class memory products rather than only free-text memories.
- **Confidence and provenance.** Enterprise memory must answer: who said this, when, under what scope, from which system, and how strongly do we trust it?
- **Scalable serving path.** SQLite is excellent for local and small-team use, but shared enterprise workloads eventually need an optional service/backend layer.

### No-code integration design

#### Phase 1: safest bridge

Goal: make Hippo the memory spine without trying to replace the systems a company already uses.

- Keep Slack, Jira, Notion, GitHub, docs, and internal databases as the systems of record.
- Feed Hippo with **append-only exports, webhooks, and cron slices**, not direct source-of-truth rewrites.
- Standardise a canonical memory envelope for imported items: `scope`, `source`, `timestamp`, `owner`, `confidence`, `artifact_ref`, `session_id`, and whether the record is raw, distilled, or superseded.
- Use current Hippo primitives as the bridge layer: `hippo snapshot save`, session trails, handoffs, `hippo decide`, `hippo supersede`, extracted facts, DAG summaries, and scoped recall.
- Distil externally. For example, turn a week of Slack incidents into a short run capsule or decision note before promotion. Do not mirror every raw message into the semantic layer.
- Keep enterprise write-backs human-approved at first. The safest bridge is read-mostly ingestion plus structured exports back out.

**Why this phase is right first:** it preserves existing tools, minimises migration risk, and lets Hippo prove value as the continuity layer before it becomes a platform.

#### Phase 2: higher-leverage Hippo-native workflow

Goal: move from "Hippo stores context" to "Hippo runs the company memory operating model."

- Promote **processes, decisions, skills, incidents, and handoffs** into first-class objects with their own recall rules and lifecycle.
- Make `hippo context --auto` assemble a layered operating view: active snapshot, recent event trail, scoped current decisions, high-confidence facts, DAG drill-down, then optional multi-hop expansion.
- Treat extracted facts plus DAG summaries as the first version of the **executable skills file**. Later, export them via `hippo export skills` or a service endpoint for agents.
- Add trigger-based recall around file path, service, repo, ticket type, customer, workflow stage, and on-call context. Cheap trigger routing should happen before expensive global recall.
- Introduce an optional graph layer only over **consolidated facts, decisions, processes, and entities**, not over every raw transcript. That keeps graph quality high and cost sane.
- Add company scopes, team scopes, and policy scopes early so multi-agent recall stays useful without leaking unrelated context.

**Why this phase matters:** this is where Hippo becomes defensible. The edge is not "we connected Slack." The edge is that the system continuously turns raw activity into current, executable operational knowledge.

#### Phase 3: what is not worth integrating at all

Some integrations sound exciting and are mostly traps.

- **Do not duplicate whole source systems inside Hippo.** Hippo should remember and distil, not become a second Jira or second Slack.
- **Do not ingest every raw transcript forever.** Long-term value comes from slices, summaries, facts, decisions, and conflicts, not endless full-text hoarding.
- **Do not build a giant always-on knowledge graph over uncurated raw text.** Graphs are most useful after consolidation, not before.
- **Do not force the zero-dependency local core to become the heavy enterprise backend.** Keep the core small and reliable; add optional service layers beside it.
- **Do not make browser automations the primary ingestion path** when APIs, exports, or event streams exist.
- **Do not auto-promote workflows or skills without provenance, evidence, and invalidation paths.** Enterprise memory that cannot be corrected becomes dangerous quickly.
- **Do not optimise for perfect recall of everything.** The product thesis is better forgetting, faster correction, and more useful continuity.

### Additional recommendations from prior work

These are the extra pieces worth adding because they keep coming up in real agent work and earlier Hippo sessions:

1. **Active-task continuity is as important as long-term memory.** Most agent failures come from losing the current thread, not missing a distant fact. Snapshots, session trails, handoffs, and working memory should stay central to the enterprise story.
2. **Append-only event logs plus slice recall beat transcript replay.** Fresh sessions should load the needed window, not the whole past. This is cheaper, faster, and much more auditable.
3. **Bi-temporal memory is a major enterprise feature.** `supersede` and `--as-of` should be treated as core product pillars because policy drift, operational changes, and postmortems all depend on historical truth.
4. **Keep canonical state separate from derived skills.** Repo briefs, process maps, run capsules, and exported skills should be distilled artifacts that point back to canonical sources, not copies of raw state.
5. **Evaluation discipline should be part of the architecture.** Canonical harnesses, file-backed evidence, fail-closed judges, and explicit verification receipts are necessary if the Company Brain is going to update itself safely.
6. **Use scopes, provenance, and RBAC early.** Most enterprise memory disasters are leakage and authority problems, not embedding problems.
7. **Keep the hot path boring.** Expensive LLM extraction, graph building, and skill synthesis should mostly happen during sleep or background jobs. Recall-time should stay cheap unless the query genuinely needs deeper traversal.
8. **Prefer contracts over duplication.** Hippo should interface with other systems through snapshots, artifacts, and explicit contracts rather than cloning whole foreign state models.

### Strategic take

The strongest version of Hippo is not a generic enterprise search product. It is a memory operating system for agents and teams: short-term continuity plus long-term consolidation, with correction, provenance, and executable outputs. Hybrid vector + graph + symbolic memory is the right direction, but only if the graph sits on top of good memory hygiene instead of replacing it.

That is the bet worth making.

## References

- McClelland, J.L., McNaughton, B.L., & O'Reilly, R.C. (1995). Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*.
- Mnih, V. et al. (2013). Playing Atari with Deep Reinforcement Learning. *arXiv:1312.5602*.
- Schaul, T. et al. (2015). Prioritized Experience Replay. *arXiv:1511.05952*.
- Kirkpatrick, J. et al. (2017). Overcoming catastrophic forgetting in neural networks. *PNAS*.
- Hu, E.J. et al. (2021). LoRA: Low-Rank Adaptation of Large Language Models. *arXiv:2106.09685*.
- Tse, D. et al. (2007). Schemas and memory consolidation. *Science*.
- Frankland, P.W. et al. (2013). Hippocampal neurogenesis and forgetting. *Trends in Neurosciences*.
- Nader, K. et al. (2000). Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval. *Nature*.
- Wu, D. et al. (2024). LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. *ICLR 2025*. *arXiv:2410.10813*.
- Gutierrez, B.J. et al. (2024). HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models. *arXiv:2405.14831*.
- Hesse, M. (2026). MH-FLOCKE: Embodied Cognition Architecture for Quadruped Learning. *GitHub*.
- Sigman, B. & Jovovich, M. (2026). MemPalace: Palace-structured memory for AI agents. *GitHub*.
- IEEE 5952114 (2011). Storing objects in a short-term biologically inspired memory system for artificial agents. *IEEE*.
- IEEE 5548405 (2010). Storage, degradation and recall of agent memory in Serious Games and Simulations. *IEEE*.
- IEEE 5953964 (2011). Agent memory and behavior simulation. *IEEE*.
