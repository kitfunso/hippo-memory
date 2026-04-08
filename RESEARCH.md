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

## Mechanism 8: Spatial memory (Memory-as-Physics)

The hippocampus doesn't just store memories with different strengths. It organizes them spatially. The 2014 Nobel Prize in Physiology or Medicine (O'Keefe, Moser & Moser) was awarded for discovering **place cells** and **grid cells** — neurons in the hippocampus and entorhinal cortex that encode memories as positions in a cognitive map. When you recall something, your hippocampus replays a trajectory through this map. Related memories are stored near each other in neural space.

Hippo v0.11+ implements this as a physics simulation. Each memory is a particle in 384-dimensional embedding space with position, velocity, mass, charge, and temperature. Forces act on these particles: queries exert gravitational attraction, related memories attract each other, conflicting memories repel, and drag prevents runaway drift. The system is integrated using Velocity Verlet (symplectic, energy-conserving) during `hippo sleep`.

### Mapping physics to hippocampal biology

| Physics mechanism | Hippocampal biology | Neural basis |
|---|---|---|
| Position in embedding space | Location in cognitive map | **Place cells** — CA1 neurons that fire at specific locations in the cognitive map |
| Position drift via inter-memory forces | Memory reorganization during sleep | **Sharp-wave ripple replay** — hippocampus replays and reorganizes memories during slow-wave sleep |
| Query gravity (retrieval-time attraction) | Context-dependent recall | **Pattern completion** — CA3 recurrent connections activate nearby memories from partial cues |
| Cluster amplification | Co-activation of related memories | **Ensemble coding** — groups of place cells fire together, producing a group signal stronger than any individual |
| Conflict repulsion | Interference resolution | **Pattern separation** — dentate gyrus pushes similar-but-different memories apart to prevent confabulation |
| Drag / velocity damping | Stabilization of old memories | **Systems consolidation** — memories transfer from hippocampus (plastic, high learning rate) to neocortex (stable, low learning rate) |
| Temperature (new memories = hot, old = cold) | Lability of recent memories | **Synaptic tagging and capture** — fresh synapses exist in a labile state receptive to modification; consolidated synapses are stable |
| Outcome feedback nudge | Learning from reward/punishment | **Dopaminergic modulation** — VTA reward signals gate hippocampal plasticity, strengthening memories associated with positive outcomes |

### What existed before was the chemistry. What physics adds is the geometry.

The original seven mechanisms model biochemical processes: how individual synapses strengthen (retrieval boost), weaken (decay), and reorganize (consolidation). These determine **how strong** a memory is.

The physics engine models spatial organization: how the hippocampus arranges memories **relative to each other** in cognitive space. This determines which memories are neighbors, which form clusters, and which are isolated.

Both are real aspects of hippocampal function. Chemistry without geometry gives you strength-ranked retrieval (a sorted list). Geometry without chemistry gives you spatial clustering (a map with no salience). Together they produce context-sensitive recall where the answer emerges from the interaction between memory strength and spatial proximity — which is what biological memory actually does.

### The cluster amplification hypothesis

The most novel prediction of the physics model is **constructive interference**: when multiple memories about the same topic have clustered together through consolidation forces, their combined retrieval signal is stronger than any individual memory's score. This is analogous to ensemble coding in the hippocampus, where a population of co-active neurons produces a clearer signal than any single neuron.

A/B benchmark results (synthetic embeddings, 26 memories, 10 sleep cycles):

| Query type | Classic R@3 | Physics R@3 | Delta |
|---|---|---|---|
| Standard (keyword-heavy) | 0.817 | 0.850 | +0.033 |
| Cluster (broad, 3+ related memories) | 0.733 | 0.800 | +0.067 |

The +6.7% improvement on cluster queries is the physics model's primary contribution: surfacing groups of related memories that BM25 treats independently. The effect should compound over time as position drift from real usage creates tighter clusters than synthetic initialization.

### Open research questions

1. **Does position drift improve retrieval over time?** After N real usage sessions with outcome feedback, do physics-scored queries outperform classic by a widening margin? The micro-nudge mechanism (good outcomes push memories toward the query context) should create increasingly accurate spatial organization.

2. **What is the optimal simulation schedule?** Currently physics runs once per `hippo sleep`. Would more frequent simulation (every N retrievals) produce better clustering? Is there an analogue to the hippocampal theta rhythm (periodic synchronization)?

3. **Can spatial proximity replace text overlap for merge detection?** Currently, episodic-to-semantic merging uses Jaccard text overlap (threshold 0.35). Memories that have drifted close in physics space may be better merge candidates, capturing semantic relatedness that keyword overlap misses.

4. **Does conflict repulsion improve pattern separation?** When contradictory memories are pushed apart in embedding space, does retrieval produce fewer confabulations (returning one memory when the other was intended)?

5. **What happens at scale?** The O(N^2) force computation is fine for 500 memories (~100ms). At 5,000+ memories, Barnes-Hut approximation or spatial hashing would be needed. Is the clustering benefit worth the computational cost at that scale?

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
- O'Keefe, J. (1976). Place units in the hippocampus of the freely moving rat. *Experimental Neurology*.
- Moser, E.I., Kropff, E., & Moser, M.-B. (2008). Place cells, grid cells, and the brain's spatial representation system. *Annual Review of Neuroscience*.
- Nobel Prize in Physiology or Medicine (2014). Awarded to John O'Keefe, May-Britt Moser, and Edvard Moser for discoveries of cells that constitute a positioning system in the brain.
