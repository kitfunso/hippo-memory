# Research Directions

Hippo is an external memory system today. The mechanisms it implements have deeper implications for how LLMs learn, retain, and forget. This document maps the connections between hippo's design and open problems in machine learning research.

For execution plans, status tracking, and implementation details, see `ROADMAP-RESEARCH.md`. For grant-funded deliverables, see `ROADMAP.md`.

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

## Long-term vision

The end state is not an external tool. It's LLMs that have hippocampal circuits built into their architecture:
- A fast-learning module that captures deployment interactions
- A consolidation process that runs during idle compute
- Decay that naturally removes outdated knowledge
- Emotional tagging that prioritizes error-corrective learning
- Retrieval that strengthens useful knowledge and weakens noise

Hippo is the prototype. The data it generates is the evidence base. The research above is the bridge.

## Related work

### HippoRAG

[HippoRAG](https://arxiv.org/abs/2405.14831) (Gutierrez et al., 2024, OSU NLP Group) applies hippocampal indexing theory to retrieval-augmented generation, using knowledge graphs as an analog to the entorhinal cortex's pattern separation. The approach is complementary but distinct from Hippo's: HippoRAG focuses on retrieval quality via graph-based indexing, while Hippo focuses on memory lifecycle (decay, consolidation, invalidation). The name overlap reflects shared neuroscience inspiration, not shared techniques.

HippoRAG's empirical result -- Personalized PageRank over an LLM-extracted knowledge graph beats baseline RAG by up to 20% on multi-hop QA, runs 10-30x cheaper than iterative retrieval -- is the single strongest validation that graph-structured recall outperforms vector/keyword for bridging questions agents actually face. HippoRAG 2.0 is a successor with operational improvements; pip-installable but pins older OpenAI SDK versions.

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

### LongMemEval

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

### MemoryAgentBench

[MemoryAgentBench](https://arxiv.org/abs/2507.05257) (Hu et al., ICLR 2026) benchmarks memory in LLM agents via incremental multi-turn interactions. Worth running hippo against this for empirical validation alongside LongMemEval. Where LongMemEval tests retrieval from static chat histories, MemoryAgentBench tests memory under agent-style incremental updates.

### Early work on agent memory simulation

The HN commenter [davman](https://news.ycombinator.com/item?id=47667672) shared three IEEE papers from 2010-2011 that predate the current wave of LLM memory systems. These papers explored biologically-inspired memory for virtual agents and serious games:

- **"Storing objects in a short-term biologically inspired memory system for artificial agents"** ([IEEE 5952114](https://ieeexplore.ieee.org/document/5952114), 2011). Proposes a method for short-term storage that emulates biological memory systems in artificial agents, examining how capacity limits and decay affect agent behavior.

- **"Storage, degradation and recall of agent memory in Serious Games and Simulations"** ([IEEE 5548405](https://ieeexplore.ieee.org/document/5548405), 2010). Describes a biologically-inspired method for storing, degrading, and recalling agent memories. Considers biological limits on both storage and recall capacity, modeling realistic memory degradation over time.

- [IEEE 5953964](https://ieeexplore.ieee.org/document/5953964) (2011). Related work by the same author on agent memory and behavior simulation.

The key insight from this line of research: human-like memory storage produces human-like behavior as an emergent property. The example of walking between rooms and forgetting why you went there is a behavior that would otherwise need direct simulation, but falls out naturally from a memory system with capacity limits and context-dependent recall. This aligns directly with hippo's design: we don't program specific forgetting behaviors. We implement decay, and irrelevant context disappears on its own.

These papers were ahead of their time. The mechanisms they described (capacity limits, degradation curves, context-dependent recall) are now being rediscovered in the LLM agent memory space, fifteen years later.

### Other prior art

- **Mem0** -- closest commercial competitor; SaaS, single-tenant, fact-extraction-focused. Differentiator framing for hippo: open protocol, decay-by-default, multi-tool import.
- **LangChain + MongoDB partnership** (Nov 2025) -- declares MongoDB Atlas as the canonical agent backend with checkpointing, vector search, persistent memory; relevant if hippo ever gets a hosted/distributed offering.
- **LoCoMo** -- long-horizon conversational memory benchmark used in event-centric memory papers. Used alongside LongMemEval for comprehensive evaluation.

## Prefrontal Cortex: Cognitive Control for Memory

Hippo implements seven hippocampal mechanisms. The hippocampus stores and retrieves. It does not decide *which* goal is active, *which* conflict matters, or *which* outcome to weight. That is the prefrontal cortex. Adding PFC-style cognitive control on top of hippo's hippocampal substrate is the next major direction. This section documents the neuroscience theory and conceptual mappings. For implementation status and execution plans, see `ROADMAP-RESEARCH.md` Track B.

### PFC subregions and their functions

**Dorsolateral PFC (dlPFC).** Maintains and manipulates hierarchical goal representations during task performance. Miller & Cohen (2001) proposed that PFC operates through sustained activity patterns that encode current goals and the rules to achieve them, providing bias signals to downstream regions. Koechlin et al. (2003) showed dlPFC is organized hierarchically: caudal dlPFC encodes immediate stimulus-response mappings while rostral dlPFC represents abstract task structure. Damage impairs the ability to maintain task context across delays and to suppress prepotent responses in favor of goal-aligned action.

**Ventrolateral PFC (vlPFC).** Implements selective attention and inhibition. Right vlPFC (lateral BA 45/47) executes motor and semantic inhibition; left vlPFC (mid-lateral 45) performs semantic selection and controlled retrieval. These regions activate during Stroop interference, working memory filtering, and episodic retrieval under competition. Damage produces perseveration and increased susceptibility to interference. vlPFC is hierarchically subordinate to dlPFC: it executes the inhibition signals that dlPFC task representations generate.

**Anterior Cingulate Cortex (ACC).** Computes the expected value of deploying cognitive control. Shenhav et al. (2013) formalized this as the Expected Value of Control (EVC): dACC integrates the expected payoff if control is applied, the cognitive effort required, and the probability of success, then allocates control resources proportionally. ACC neurons respond distinctly to conflict (Botvinick et al., 2001), to prediction errors, and to effort cost. The EVC framework unifies these: conflict is a signal that control allocation should be reconsidered.

**Ventromedial PFC (vmPFC).** Encodes subjective value of outcomes and options, integrating emotional and reward-related signals to guide value-based decisions. vmPFC maintains associations between contextual cues and outcome values learned through experience. It works bidirectionally with amygdala (emotional significance) and ventral striatum (reward prediction). Unlike dlPFC's abstract task rules, vmPFC stores implicit emotional evaluations. Damage produces impaired decision-making in real-world situations where emotional consequences matter, while leaving abstract reasoning intact.

**Orbitofrontal Cortex (OFC).** Computes economic value of specific choices, encoding a common currency across dissimilar outcomes (Rangel et al., 2008). OFC neurons show firing rates proportional to the subjective utility of available options, adjusting valuations based on context, satiation state, and learned associations. OFC is particularly engaged during decision-making in volatile environments or when multiple incommensurable goods must be compared.

**Medial PFC (mPFC).** Integrates self-relevant information and autobiographical context. Activated during self-referential processing, mental time travel, and mentalizing about others' beliefs. mPFC maintains a meta-representation of the agent's own knowledge, goals, and competencies. It answers "what do I believe?" and "what goal am I pursuing?" mPFC shows elevated activity during sleep-stage consolidation, suggesting it guides which episodic memories are elevated to semantic schemas.

### Agent-memory analogues

The six PFC subregions map to concrete agent-memory mechanisms. Reference schemas and CLI designs are documented below; see `ROADMAP-RESEARCH.md` Track B (B1-B7) for current implementation status (MVPs shipped for B1-B5, B6 planned).

#### dlPFC: Goal stack & retrieval policy

Active maintenance of hierarchical task goals, each tagged with a retrieval policy that shapes which memories are prioritized.

```sql
CREATE TABLE goal_stack (
  id TEXT PRIMARY KEY,
  session_id TEXT, timestamp TEXT,
  goal_name TEXT NOT NULL,
  level INT,                              -- 0=root, 1=subgoal, 2=microgoal
  parent_goal_id TEXT,
  status TEXT,                            -- active|suspended|completed
  success_condition TEXT,
  memory_retrieval_context_json TEXT,
  relevant_tag_filters_json TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE retrieval_policy (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goal_stack,
  policy_type TEXT,                       -- schema-fit-biased|error-prioritized|recency-first|hybrid
  weight_schema_fit REAL,
  weight_error_tagged REAL,
  weight_recency REAL,
  weight_strength REAL,
  apply_interference_filter BOOLEAN,
  updated_at TEXT
);
```

ML parallel: goal-conditioned RL (Chane-Sane et al., 2021) and hierarchical task-set representations in rostral dlPFC (Koechlin et al., 2003). Most existing agent memory systems retrieve on semantic similarity alone; goal conditioning injects task context into the retrieval ranking.

#### vlPFC: Interference filter & semantic gate

Suppress task-irrelevant memories and resolve semantic conflicts at retrieval time.

```sql
CREATE TABLE interference_suppression (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  memory_id TEXT REFERENCES memories,
  suppression_reason TEXT,                -- conflict-with-goal|outdated-schema|error-tagged|context-switch
  suppression_strength REAL,              -- 0-1, fraction to downweight
  triggered_by_query TEXT,
  expires_at TEXT,                        -- suppression fades over time
  created_at TEXT
);
```

ML parallel: Reflexion (Shinn et al., 2023) asks the model which past attempts are relevant to the current goal; vlPFC-style gating automates this by maintaining semantic conflict flags and relevance scores as persistent structure.

#### ACC: Conflict monitor & EVC-adaptive retrieval

Detect conflicts between retrieved memories and adaptively increase retrieval effort when uncertainty is high.

```sql
CREATE TABLE uncertainty_signal (
  id TEXT PRIMARY KEY,
  session_id TEXT, query TEXT,
  retrieved_memory_ids_json TEXT,
  semantic_entropy REAL,                  -- diversity of meanings in top-K
  strength_variance REAL,                 -- spread in memory strengths
  tag_agreement REAL,                     -- 0-1 agreement on tags
  evc REAL,                               -- expected value of control
  recommend_extra_retrieval BOOLEAN,
  created_at TEXT
);
```

EVC calculation: `evc = (expected_payoff * confidence) - cognitive_cost`. Gate extra retrieval depth on `evc > 0.4`.

ML parallel: Shenhav et al. (2013) formalized control allocation as expected payoff * probability of success - cognitive cost.

#### vmPFC: Outcome value attribution

Continuous value scores per memory (-1 to +1), propagated backward to related memories.

```sql
CREATE TABLE memory_value_association (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memories,
  outcome_label TEXT,                     -- positive|negative|neutral|uncertain
  value_score REAL,                       -- -1 (very bad) to +1 (very good)
  confidence REAL,
  context_json TEXT,                      -- situational factors
  temporal_decay_factor REAL,             -- 0.5-1.5
  learned_from_source TEXT,               -- human-feedback|task-outcome|rollback|inference
  created_at TEXT
);
```

Integrates with decay: `half_life = base_half_life * (1 + value_score * k)`. Positive-outcome memories persist longer; negative-outcome memories decay faster.

ML parallel: Constitutional AI (Bai et al., 2022) uses model-generated feedback to refine outputs; Self-Refine (Madaan et al., 2023) iteratively improves via self-scoring. vmPFC-style value attribution makes the value signal a first-class persistent structure rather than a per-iteration score.

#### OFC: Option value comparison

Rank candidate memories and subgoals by expected utility across incommensurable axes.

```sql
CREATE TABLE option_valuation (
  id TEXT PRIMARY KEY,
  query_id TEXT,
  memory_id TEXT REFERENCES memories,
  option_value REAL,                      -- -1 to +1
  component_reward REAL,                  -- expected utility if used
  component_cost REAL,                    -- tokens-to-integrate + error risk
  net_utility REAL,                       -- reward - cost
  prediction_confidence REAL,
  created_at TEXT
);
```

ML parallel: Rangel et al. (2008) showed OFC neurons encode a common currency. `option_value` is this common currency across heterogeneous retrieval attributes (factual accuracy, relevance, effort, error risk).

#### mPFC: Self-model & meta-memory

Meta-representation of the agent's own knowledge state. Drives identity-aware consolidation.

```sql
CREATE TABLE self_model (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  knowledge_domain TEXT,                  -- e.g., "project-X-architecture"
  known_confident TEXT,                   -- JSON list
  known_uncertain TEXT,                   -- JSON list
  unknown TEXT,                           -- known unknowns
  competence_score REAL,                  -- 0-1
  updated_at TEXT
);

CREATE TABLE meta_memory (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memories,
  goal_relevance_score REAL,
  consolidation_worthiness REAL,
  identity_relevance REAL,
  temporal_scope TEXT,                    -- immediate|session|long-term
  created_at TEXT
);
```

ML parallel: Reflexion agents maintain self-critique memory. mPFC systematizes this into a persistent evolving self-model that shapes which consolidations are worth doing.

### Integration with existing hippo mechanisms

| PFC module | Interacts with | Synergy | Tension |
|------------|----------------|---------|---------|
| dlPFC (goal stack) | Decay, retrieval strengthening | Goal-retrieved memories with positive outcomes decay slower | Too many active goals = tag thrashing. Cap concurrent stack depth at 3-5 |
| vlPFC (semantic gate) | Conflict detection, schema fit | Suppression extends existing `conflicts_with` with a soft downweight | Over-aggressive suppression hides valid context-dependent facts. Add `--show-suppressed` override |
| ACC (EVC) | Physics engine, ambient state | High-EVC queries trigger arousal-weighted particle updates; low-EVC relaxes to stable clustering | Physics is deterministic today; arousal needs stochastic updates. Add `arousal` scalar to physics config |
| vmPFC (value) | Reward-proportional decay | Replaces binary outcome with continuous value; context-aware value scores | Context-dependent: a memory valuable in project A may be harmful in B. Track value per goal/session |
| OFC (option value) | Token budget, subgoal selection | Budget allocates tokens proportionally to expected utility | O(n) valuation per retrieval is expensive. Cache per (query, context) tuple |
| mPFC (self-model) | Sleep consolidation | Identity-relevant episodic memories consolidate faster, tagged with goal/identity context | Risk of self-serving overweighting. Flag high-salience memories for human review before promotion |

## AI Pineal Gland: Intuition and Awareness Module

Build an intuition/awareness layer on top of hippo's existing infrastructure. Three components. For implementation status, see `ROADMAP-RESEARCH.md` Track C (C1 shipped, C2-C4 next).

**Ambient state vector.** A continuous background representation of the agent's context. The physics simulation already models this: particle positions encode semantic relationships, velocities encode recent trajectory, and system energy captures overall memory coherence. Extend this into a compact state vector that's injected alongside memory context, giving the agent a "feel" for its knowledge landscape without retrieving specific memories.

**Fast-path heuristic (System 1).** A lightweight pre-generation check that runs before the full LLM call. Given the ambient state + the incoming prompt, predict whether the agent has relevant knowledge, is entering familiar vs novel territory, or is about to repeat a known mistake. This parallels OpenClaw's ClawRouter (`classifyByRules`) which classifies prompts across 7 dimensions to route to different model tiers. The pineal gland version would classify prompts against the memory state.

**Salience gate.** Filters what deserves attention vs noise. Currently hippo's search scoring + token budget system does this at retrieval time. The salience gate would operate earlier -- at memory *creation* time -- deciding what's worth storing and at what priority. Schema fit already does a version of this (high-fit memories consolidate faster). A salience gate would make the decision explicit: "this error is novel and important" vs "this is the 5th timeout in a row, skip it."

The physics engine is the natural substrate. Ambient state = system energy + velocity distribution. Fast-path = cosine between query embedding and particle cluster centroids (sub-millisecond). Salience = rate of change in the state vector after a new memory is added.

## Open research questions

Questions not yet tracked in the roadmap. For questions already being actively worked on, see `ROADMAP-RESEARCH.md` Track H (H1-H5).

### Retrieval and graph structure

1. **Graph-structured recall over hippo's store.** Can the hippocampal-index pattern (PPR over a knowledge graph) be implemented over hippo's existing markdown+YAML store using a lightweight in-memory PPR, without breaking the zero-deps promise?

2. **Adaptive retrieval.** Should hippo recall support iterative refinement where the second pass reformulates based on the first pass's findings? Most agent memory does one-shot retrieval. Query strategy that changes based on what early results reveal is largely unexplored.

### Multi-agent memory

3. **Consistency model.** What's the right consistency model for multi-agent shared memory? Eventually-consistent gossip between agents? Strongly-consistent shared store? CRDT-based merges? Each has different failure modes when agents disagree about facts.

4. **Cross-agent memory negotiation.** When agent A holds a private memory and agent B queries, what's the protocol for selective disclosure? This is partly a permissioning problem and partly a trust problem (does agent B's identity warrant the disclosure?).

5. **Conflict resolution heuristics.** Two agents store contradictory facts about the same entity. Recency wins? Authority wins (some agents are more trusted)? Source-quality-weighted? Confidence-tier-weighted? An empirical study comparing these on a benchmark dataset would be a contribution.

### Protocol and interoperability

6. **Universal memory protocol.** Is there a small enough core API (read, write, forget, query, subscribe) that could become a de facto standard? Mem0 owns the SaaS framing; nobody owns the open protocol. Hippo's CLI commands are already nearly this shape; an HTTP/MCP transport layer would make it explicit.

7. **Capability advertisement and peer discovery.** Google's A2A and Anthropic's MCP define the wire format for agent-to-agent calls but not the yellow pages -- the registry where an agent searching for "OCR specialist" finds candidates. Capability embeddings + semantic search is the plausible substrate. Where does memory end and a capability registry begin? They may be the same data structure.

### Observability and determinism

8. **Memory state bisect.** When a prompt change tanks eval scores, memory state is part of the bisect dimensionality -- the same prompt may behave differently against different memory states. Can hippo snapshot memory state per commit so eval bisects are reproducible?

9. **Memory attribution.** When an agent succeeded, which subset of the recalled memories actually contributed? Pure recency/relevance scoring is a proxy, not ground truth. Outcome feedback is already in hippo; the deeper question is granular attribution.

### Token economics

10. **Context Compiler.** Given a task, available memory, available tools, available docs, what's the token-optimal context window assembly? Currently every framework stuffs naively. This is a query-planner problem (what to summarize, what to retrieve full, what to reference by handle). Should hippo's recall --budget evolve into a full compiler that decides per-memory whether to include verbatim, summary, or pointer?

### Adversarial robustness

11. **Memory poisoning.** An attacker who can inject memories ("the user prefers to disable 2FA") corrupts every future agent decision. Should hippo's confidence-tier model be extended with a provenance-trust dimension -- memories from --verified sources can override but never be overridden by --inferred sources, regardless of recency?

12. **Differential privacy for agent memory.** Red-team agent that adapts its prompts based on responses to discover what the target agent remembers. Memory becomes an information-leakage surface. What does differential privacy for agent memory look like?

## Experiments not yet in the roadmap

For experiments already tracked with effort estimates and success criteria, see `ROADMAP-RESEARCH.md`: D9 (decay sweep), D10 (consolidation A/B), D11 (cross-agent transfer), F4 (HippoRAG graph), F8 (50-task agent eval).

### 1. Outcome-feedback ablation

Does hippo outcome --good/--bad actually improve retrieval quality over time, or is it noise? Run paired sessions with and without feedback enabled, measure task success.

### 2. Confidence-tier impact

Do agents make better decisions when shown confidence tiers inline? Run blinded comparison: same memories, with vs without [verified]/[observed]/[inferred] annotations.

### 3. Cross-tool import fidelity

When importing from ChatGPT/Claude/Cursor, what fraction of imported memories survive 30 days of decay+sleep? Are imports systematically lower-quality than native captures? If so, should imports start with reduced half-life?

### 4. Sleep frequency

Daily 6:15am cron is a guess. Is weekly sleep enough for low-volume users? Is hourly needed for high-volume? Empirically determine sleep frequency per memory volume.

### 5. Attribution granularity

When hippo outcome --good boosts the last 3 recalled memories, is that the right granularity? Should it be weighted by recall rank? An ablation could test rank-weighted vs uniform boosting.

## Company Brain

The Company Brain product thesis, memory model, ingestion strategy, security model, and execution plan are fully specified in `ROADMAP-RESEARCH.md` Track E (phases E1-E7). This section retains only the strategic framing.

**Product thesis:** The problem is not that companies lack documents. The problem is that the useful state of the company is fragmented, stale, and constantly re-explained. Hippo solves that with three layers: raw receipts (append-only with provenance), current truths (distilled facts/decisions/processes that can be superseded cleanly), and active work state (snapshots, handoffs, blockers, next actions). The moat is continuity + correction + distillation.

**Current strengths:** Adaptive knowledge hygiene (forgets on purpose), two-speed memory (buffer/episodic/semantic), correction without deletion (supersede + as-of), fact extraction and DAG summaries, short-term continuity primitives (snapshots, trails, handoffs), portable integration surface (SQLite + Markdown + MCP + CLI).

**MVP scorecard (Track E7):** A real V1 Company Brain must: ingest raw receipts from a small set of tools, maintain active-task continuity for agents, promote decisions/facts/handoffs into durable memory with provenance, correct current truth safely via supersession, and assemble high-signal task context faster than transcript replay.

## Strategic positioning

Most competitors will build one of two things: a better filing cabinet with embeddings, or a broad company search layer over everything. Hippo's position is narrower and deeper:

- **Filing cabinet vs brain.** The framing is strong. Lean into it.
- **Open protocol vs SaaS.** Mem0 owns single-tenant SaaS; hippo can own open-protocol, git-trackable, decay-by-default. Clear differentiation.
- **Context engineering vs RAG.** The "context engineering" framing is where the field is moving in 2026. Hippo is not RAG, it's memory infrastructure.
- **Neuroscience rigor as moat.** Most competitors handwave; hippo cites primary literature. Keep doing that.
- **Multi-tool portability.** ChatGPT -> Claude -> Cursor -> Codex is uniquely hippo's pitch. No competitor offers this. Worth headlining harder in the README.
- **Agent-first continuity, explicit memory lifecycle, correction as a core primitive, provenance-rich operating objects, background distillation into executable knowledge.** That makes Hippo less like "search for company data" and more like "the memory substrate that keeps agents and teams aligned over time."

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
- Hu, Y. et al. (2025). MemoryAgentBench: Benchmarking Memory in LLM Agents. *ICLR 2026*. *arXiv:2507.05257*.
- Hesse, M. (2026). MH-FLOCKE: Embodied Cognition Architecture for Quadruped Learning. *GitHub*.
- Sigman, B. & Jovovich, M. (2026). MemPalace: Palace-structured memory for AI agents. *GitHub*.
- IEEE 5952114 (2011). Storing objects in a short-term biologically inspired memory system for artificial agents. *IEEE*.
- IEEE 5548405 (2010). Storage, degradation and recall of agent memory in Serious Games and Simulations. *IEEE*.
- IEEE 5953964 (2011). Agent memory and behavior simulation. *IEEE*.
- Miller, E.K., & Cohen, J.D. (2001). An integrative theory of prefrontal cortex function. *Annual Review of Neuroscience*, 24, 167-202.
- Koechlin, E., Ody, C., & Kouneiher, F. (2003). The architecture of cognitive control in the human prefrontal cortex. *Science*, 302(5648), 1181-1185.
- Botvinick, M.M., Braver, T.S., Barch, D.M., Carter, C.S., & Cohen, J.D. (2001). Conflict monitoring and cognitive control. *Psychological Review*, 108(3), 624-652.
- Shenhav, A., Botvinick, M.M., & Cohen, J.D. (2013). The expected value of control: An integrative theory of anterior cingulate cortex function. *Neuron*, 79(2), 217-240.
- Rangel, A., Camerer, C., & Montague, P.R. (2008). A framework for studying the neurobiology of value-based decision making. *Nature Reviews Neuroscience*, 9, 545-556.
- Bai, Y., Jones, A., Ndousse, K., et al. (2022). Constitutional AI: Harmlessness from AI feedback. *arXiv:2212.08073*.
- Shinn, N., Cassano, F., Labash, B., Gopinath, A., Narasimhan, K., & Yao, S. (2023). Reflexion: Language agents with verbal reinforcement learning. *NeurIPS 2023*.
- Madaan, A., Tandon, N., Gupta, P., et al. (2023). Self-Refine: Iterative refinement with self-feedback for LLMs. *arXiv:2303.17651*.
- Chane-Sane, A., Leonardi, C., & Kottakis, A. (2021). Goal-conditioned reinforcement learning with imagined subgoals. *ICML 2021*.
