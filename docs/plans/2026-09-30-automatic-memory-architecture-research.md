# Automatic memory architecture: evidence and engineering recommendations

**Date:** 2026-09-30

**Status:** RESEARCH REVIEW / NO NEW EVALUATION RESULTS

**Roadmap:** [Track Z/S/AZ](../../ROADMAP.md), especially Z10, Z1d, Z2b, Z3b and S0-S9.

## Scope

Reviewed the current hooks, context selection/rendering, capture, search, store, consolidation and recall-trace paths, their published evaluations, and the primary sources below. This is a targeted code/evidence review, not a completed full-repository database architecture audit, new benchmark run or live-store migration.

Code observations refer to hippo-memory 1.53.0 at commit `ba9f95e14bcc17e3506673cb8ea21897e3ca288a`. Proposed mechanisms remain experiments. No per-prompt or per-session accuracy figure is inferred from CLI retrieval.

## What the shipping system establishes

| Question | Current evidence |
|---|---|
| Does memory run only at session start? | Claude Code and Codex can invoke the installed hook on prompt submission. The static block can be skipped when unchanged, refreshed later, and reset after compaction. Other runtimes have different surfaces. |
| Is each prompt searched for relevant lessons automatically? | The default hook selects applicable pins and the five newest eligible memories within its budget. Prompt-based recall is experimental and off by default. CLI/API/MCP recall is a separate path. |
| Is every prompt durably remembered? | No. Capture is selective. SessionEnd extracts from the last 20 user and 10 assistant messages; compaction lesson items and supported failed-tool captures add other inputs. |
| Is a captured error a learned remedy? | No. Failed-tool rows remain observations; a failure alone does not establish the successful action or its applicability. |
| Does installed MCP establish delivery? | No. Tool availability, invocation, returned IDs, emitted context and confirmed model context are different stages. |
| Does maintenance prove learning? | No. Changing memory data or retrieval weights does not establish lower repeat-mistake rates, correct supersession or model-weight learning. |

Snapshot sources:

- [Hook installation](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/hooks.ts)
- [Context assembly](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/api.ts)
- [Injection and lifecycle CLI](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/cli.ts)
- [Session capture](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/capture.ts)
- [Failure capture](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/capture-error.ts)

## Measured limits

The [published CLI LongMemEval result](../evals/2026-09-28-recall-cli-longmemeval-result.md) reports any-evidence R@5 of 85.6% (95% interval 82.4-88.6) for the default 4,000-token run and 87.6% (84.6-90.4) with optional MiniLM. It reports all-evidence R@5 of 29.8% and 30.2%. The optional embedder's paired advantage is 2.0 points with an interval crossing zero; it is not a demonstrated universal upgrade.

With the budget lifted, any-evidence R@5 rises to 96.8% and 97.4%, but the returned context is a median of 47 sessions and 123,491 tokens. That diagnoses ranking/budget interaction, not a usable automatic memory block. This run stores whole sessions, ingests them under compressed time, does not generate answers, and does not measure hooks, context or MCP.

Ordinary automatic writes can already be short notes. Profile their real size, evidence quality and miss causes before interpreting a whole-session benchmark as proof that the live representation needs replacing.

The [correction detector result](../evals/2026-09-26-z3-correction-detect-result.md) failed: precision 0.820 against a 0.90 gate, recall 0.314, and no populated corrected-claim targets on held-out hits. Detection, target identification and justified replacement need separate labels.

The [mechanism audit](../evals/2026-09-23-mechanism-audit-round2-result.md) does not establish task gains from decay, sleep or physics. Physics lost largely through missing BM25. Correct outcome marks helped on a synthetic workload with perfect marks. Neither that result nor repeated retrieval establishes trustworthy automatic feedback in real sessions.

## Primary research and limits of transfer

| Primary source | Relevant observation | Implication to test in Hippo |
|---|---|---|
| [LongMemEval, ICLR 2025](https://arxiv.org/html/2410.10813v2) | Separates indexing, retrieval and reading; evaluates granularity, fact-augmented keys and time-aware queries. Even correct evidence can be used incorrectly. | Test representation, query construction, budgeted evidence and application separately. Conversational QA is not repeat-mistake proof. |
| [BEIR, NeurIPS 2021](https://arxiv.org/abs/2104.08663) | BM25 is a robust baseline across heterogeneous retrieval tasks; reranking/late interaction can improve results at higher compute cost. | Preserve a lexical baseline. Its historical results do not select the best current model for coding memory. |
| [Hindsight, December 2025](https://arxiv.org/html/2512.12818v1) | Separates facts, experiences, summaries and beliefs; combines lexical, semantic, graph and temporal retrieval with RRF, reranking and token budgets. | Independent candidate channels and epistemic provenance are useful design references. Its QA results do not justify adopting the whole architecture or a required cross-encoder. |
| [ReasoningBank, September 2025](https://arxiv.org/html/2509.25140v1) | Distils transferable strategies from successful and failed trajectories. Its streaming construction uses LLM-judged proxy outcomes. | Test bounded procedural lessons, not just stored errors. Proxy judgements need calibration and unknown states; this is not external verification. |
| [MemRL, January 2026](https://arxiv.org/html/2601.03192v2) | Retrieves by intent and learned utility while leaving the backbone frozen. Feedback drives memory values; stability analysis assumes a frozen inference policy and stationary tasks. | Outcome-based selection is an experiment. Changing repositories/models and ambiguous task credit limit transfer; do not assume its convergence guarantees. |
| [CODESKILL, May 2026](https://arxiv.org/html/2605.25430v1) | Learns a skill-management policy for a frozen coding agent, with task-level/event-level skills and quality plus execution feedback. Plausible skills can remain unused or ineffective. | Test task-intent and event-triggered experiences, application and execution outcomes. Its trained manager is not a drop-in dependency or authorization to expand Track G. |
| [HippoRAG 2, February 2025](https://arxiv.org/html/2502.14802v1) | Uses a knowledge graph, passage integration, PPR and LLM-assisted filtering for factual/associative QA. | Graph traversal is plausible for measured multi-hop gaps. This is a separate project and does not prove that general coding memory needs a graph. |

These are architecture references and bounded experimental reports, not evidence of gains in Hippo. Do not compare their answer/pass-rate scores directly with Hippo's retrieval R@5, or turn their gains into expected local effects.

## Proposed stack

| Layer | Recommendation | Reason and gate |
|---|---|---|
| Canonical local store | Retain SQLite/WAL, scope, provenance and reversible versions. | The current local deployment does not establish a need for a service or replacement database. Check actual contention, transaction duration and recovery. |
| Source evidence | Preserve allowed receipts/source spans and supported ingestion progress; keep raw compaction records outside memory recall. | Ground compact lessons without injecting transcript dumps or creating another capture pipeline. |
| Retrieval units | Compare existing notes, deterministic chunks, compact claims and bounded experiences on equal evidence access and budgets. | Do not assume a new table or 40-120-token target is a measured win. Preserve conditions and exceptions. |
| Lexical retrieval | Retain FTS5/BM25 and test code/path/error/command handling. | The [current store shortlist](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/store.ts) can constrain candidates before optional vector scoring. |
| Semantic retrieval | Optional independent dense candidates over eligible rows, then union/fusion with lexical candidates. | A row excluded by lexical candidate selection cannot be rescued by subsequent cosine scoring. Start from existing embedder baselines; select upgrades on real memory misses and latency. |
| Ranking/admission | Explicit eligibility before limits, interpretable component ablations, relevance gate, whole-unit packing. | [Shipping scoring](https://github.com/kitfunso/hippo-memory/blob/ba9f95e14bcc17e3506673cb8ea21897e3ca288a/src/search.ts) includes more than recency/strength. Freeze every factor; RRF is a comparator, not a presumed winner. |
| Temporal update | Supported, scoped, atomic closure/successor writes with reversal and distinct validity/recorded-time semantics. | A contradiction or later date alone does not establish replacement. |
| Learning | Evidence-specific outcomes with observed/judged/unknown application and version-dependent utility. | Do not credit a whole shown batch for success or reinforce rows just because they were returned. Task confirmation still needs a valid comparator. |
| Runtime surface | Common store/admission/ranking/packing/trace contract with tested adapters. | Installation, real context delivery and task efficacy have separate acceptance criteria. |

[SQLite's deployment guidance](https://sqlite.org/whentouse.html) supports embedded local use and explains the single-writer constraint. [WAL](https://sqlite.org/wal.html) permits concurrent reads/writes but does not provide simultaneous writers or a network-filesystem deployment.

[sqlite-vec](https://alexgarcia.xyz/sqlite-vec/) is an optional indexing implementation candidate, subject to compatibility, filtering and latency checks. Begin with a correct independent dense baseline; add an extension/index when measurement justifies it. A service with demonstrated central-operation/concurrency needs could separately evaluate PostgreSQL plus [pgvector](https://github.com/pgvector/pgvector). Neither database choice supplies extraction, attribution or truth.

## Engineering priorities

1. Extend existing traces to reconstruct capture, candidates, budget/gate decisions, context availability, application and outcomes. Label denominators independently; telemetry cannot discover truth by itself.
2. Test durable capture during long-lived sessions, interruption, duplicate delivery and missing inputs. Extend existing compaction replay; expose pending/degraded states and bounded processing costs.
3. Build representation/packing and contextual-query prototypes on development data alongside Z0 preparation. A scored baseline result is not a prerequisite for a development prototype.
4. Test exact ranking ablations and conservative correction/experience writes against their identified failure stages, preserving regression floors.
5. Confirm task benefit on fresh registered families with the existing validity/harm gates. Other users/runtimes and long-lived stores need their own coverage before broader claims.

The zero-touch acceptance journey is install/trust once, teach in ordinary conversation, apply in a later session, correct, compact or interrupt, and resume. Routine user memory commands are absent. It verifies scoped durable capture and context availability, then separately measures use, repeat mistakes, stale-follow, task quality and full priced overhead.

## Event follow-up: supervision, trajectories and memory growth

Keith's notes from [AAIF London x Prolific, 2026-09-30](https://luma.com/rs92x0u9) motivate these proposals. The published agenda covers harness/context, rollouts, trajectory evaluation and KV-cache routing; it does not establish speaker endorsement of this Hippo design or provide a transcript of the conversations. These are planning recommendations, not measured results.

**Product test.** Does memory reduce repeated corrections and explanation across sessions, beyond built-in memory, while preserving task quality and full cost? A quiet successful session is compatible with both valuable memory and no memory effect. A controlled comparison can detect useful gains the user barely notices; satisfaction and perceived friction complement, rather than establish, attribution.

The fresh [Z12 draft](../evals/2026-09-30-z12-supervision-growth-prereg.md) separates controlled correction counts from actual active supervision time in a human pilot. It keeps failure/abandonment visible and grows unrelated source histories while preserving the relevant evidence. Bad-memory delivery, bad-memory use, irrelevant context, admission abstention and agent uncertainty have distinct denominators. Always refusing or injecting nothing cannot win by construction.

| Primary source | Relevance and limit |
|---|---|
| [MemoryArena, February 2026](https://arxiv.org/abs/2602.16313) | Evaluates interdependent multi-session tasks where experience must guide later actions. Useful application fixtures; its environments/results are not Hippo coding-task proof. |
| [LongMemEval-V2, May 2026](https://arxiv.org/abs/2605.12493) | Tests environment experience from trajectories through compact evidence and downstream QA, including workflow/gotcha knowledge. Useful diagnostic coverage, not a measure of human supervision; accuracy and latency remain separate. |
| [Scale-conditioned agent-memory evaluation, May 2026](https://arxiv.org/abs/2605.07313) | Holds task evidence fixed while adding irrelevant sessions and reports reliability under interaction budgets. Supports a growth stress test; its studied systems and scale boundaries do not transfer to Hippo. |
| [vLLM prefix-cache design](https://docs.vllm.ai/en/latest/design/prefix_caching/) | Reuses computed token-prefix blocks under cache identity/isolation rules. Cached computation is distinct from durable semantic memory; real placement, provider conditions, misses and priced cost need measurement. |

**Trajectory evidence.** Extend Z10, not a second tracing system. Correlate observable prompts/turns, tool calls/results, delivery decisions, memory versions, checks and interruptions. Snapshot permitted inputs outside the repository, with hashes, scoped access and retention/redaction rules. Gaps remain unknown; private model reasoning is not assumed available. Keep raw evidence out of automatic recall and preserve existing protected compaction boundaries.

**Scope of the other ideas.** Team/subproject memory reuses the existing A5 and scope/provenance work; a broader hierarchy needs explicit permissions, inheritance/override and conflict rules before a separate pilot. It does not imply the local store is ready for arbitrary shared enterprise serving. Model-weight learning is a different loop from external memory updates. Harness changes and context/skill changes need separate controls. S5 may prototype a bounded, versioned procedure from verified experience; a factory of generated skill files is not a success metric and does not expand Track G. Cache/RoPE/model-internal work stays a research branch requiring backend access, version/invalidation/isolation checks and actual task evidence. Numerical attention fidelity alone cannot establish semantic truth or reliable “I don't know” behaviour.

## Boundaries

No defaults, schemas, package dependencies, runtime adapters or retention policies change through this research note. No new benchmark or task run has been performed. The linked evaluation drafts remain unregistered/unrun; their freeze, thresholds, samples and resource requirements must be settled before scoring. Existing locked registrations and protected compaction-item rules remain intact.
