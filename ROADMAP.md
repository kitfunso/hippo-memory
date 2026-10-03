# Hippo Roadmap

> Consolidated 2026-06-09. This single file merges the two former roadmap documents with no content removed:
>
> - **Part I (Grant-Tied Deliverables)** is the former `ROADMAP.md`: work organized by funding status (committed, grant-conditional, speculative) plus the grant work packages (Frontier AI Discovery, AI Champions Phase 1).
> - **Part II (Canonical Execution Roadmap)** is the former `ROADMAP-RESEARCH.md`: the engineering execution plan (Tracks A-F, north star, benchmark priority, schema-migration order, test commitments, bets, non-goals).
>
> **Top priority since 2026-09-26: Part XV, Track Z (zero-touch memory), starting with Z0: prove hippo beats the memory Claude Code and Codex already have.** Z0 was redesigned on 2026-09-29 (`docs/evals/2026-09-29-z0-built-in-memory-prereg.md`). The next to-do is its stage 0, the runner fixes, then the smoke stage. Start there.
>
> **2026-09-30 execution addendum:** Parts XVI-XVIII reconcile delivery tracing, compact-memory experiments and runtime adapters with the current Z0 design. Instrument first; defaults remain frozen pending the separate retrieval and task gates.
>
> **2026-10-01 wording follow-up:** Part XIX, Track MSG records planned wording amendments for the core and enterprise edition. Keep the memory category; clarify the context and harness mechanisms, automation limits, evidence and feature status.
>
> **2026-10-02 content consistency requirement:** All current content on hippo-memory.com, the GitHub repository and the npm package page must agree on product claims, feature status, defaults, installation, evidence and core/enterprise boundaries. MSG6 adds a shared claim inventory and release/publication checks, including the README and metadata actually published to npm. Label differences by version/edition; planned work must not appear shipped.
>
> **2026-10-01 eval workflow follow-up:** Part XX, Track CAE records installation and explicit use of Anthropic's `/claude-api build-eval` and `/claude-api hillclimb`, with a Z1 trigger pilot, existing-runner adapters and sealed confirmation.
>
> **2026-10-02 accepted CLEF integration direction:** Part XXI, Track CLF plans a Hippo-owned decision layer across capture, retrieval, context admission, correction, consolidation and reusable lessons, for core and enterprise. Start with CLEF-flash in a free-first hosted profile plus a compatible private-serving interface; paid inference is explicit opt-in. Provider contracts and budget/fallback controls come first, then ranking, admission/corrections, write/lifecycle workflows and separately gated learning. Integration is planned, not shipped; Z0 priority, frozen defaults and locked registrations remain.
>
> **2026-10-02 product requirement: useful and as low-touch as possible, for core and enterprise.** After install/trust and any necessary project policy setup, routine capture, retrieval, correction handling and use should work through ordinary agent tasks. Count setup, repeated explanation, memory commands, review/approval work, notifications and recovery as user burden. Automate supported work within existing permissions; surface actionable exceptions instead of asking users to manage each memory. Adoption must reduce a registered user burden or improve useful task outcomes with quality, safety, cost and latency bounds; fewer injected tokens or prompts alone do not establish benefit. Carry this requirement through Z12 and the CAE8/CAE9 pilots without changing frozen defaults or registrations.
>
> **2026-10-02 accepted Computer integration direction:** Part XXII, Track CW adds an optional durable workspace/evidence adapter for externally hosted agents: scoped sources, bounded read capabilities, explicit outcome receipts and verified pull-mode handoffs first; corpus/RLM processing, procedural lessons and CLEF advice remain separately evaluated research. Carry AZ4-AZ6 capture/readiness and low-touch requirements through the adapter. Z0 priority, frozen defaults, locked registrations, the local route and the no-dispatch boundary remain. Planned integration is not shipped support or measured task benefit.
>
> `PLAN.md` remains the architecture and CLS-principles document. `RESEARCH.md` remains the research lineage and seven-mechanisms backgrounder.

## Current execution index

**Reviewed 2026-10-02.** This is the governing execution view. Dated queues and estimates below remain historical records; they do not supersede this index, Z0's stage order, the default freeze or a locked preregistration. The full agent-preservation and CLEF integration scope remains required; phasing changes the delivery order, not the coverage goal. ECC remains a research reference and Computer remains optional.

**Accountability.** Keith is the product and release owner. The maintainer owns implementation and evidence records; the selected customer's administrator owns source/identity policy and the customer defines business value. These are responsibility labels, not an assumption of additional engineers. Before an item enters active work, name its implementation owner, remaining scope, next deliverable, eligible population, success/guardrail bounds and evidence source. Re-estimate from remaining work and available capacity; the historical 16-22 week forecast is not a refreshed delivery promise.

| Window and priority | Existing items | User outcome | Next deliverable and evidence gate | Accountable role |
|---|---|---|---|---|
| Now, 1 | Z0 stage 0; Z10 development instrumentation | Establish whether Hippo adds useful value beyond built-in memory and identify capture/retrieval/delivery/application failures | Complete isolated arms, teaching, sham/control, Codex and blind-analysis prerequisites; instrument without changing selected IDs or rendered context. Then the existing smoke, calibration, freeze and scored protocol. Z10 does not amend Z0's locked endpoints. | Maintainer; Keith for resource/run decisions |
| Now, 2 | AZ6 foundation; S6 capture/recovery fixtures; AZ4/AZ5 per supported mode | Preserve useful lessons before loss and recover without routine save commands | Inventory every named runtime/mode; establish shared contracts and fixtures, then verify native hooks or supported incremental checkpoints on real hosts. Record source/trust gaps, gold capture precision/coverage, delay, restore and actual delivery separately. No CLEF or new claims schema prerequisite. | Integration maintainer |
| Next, 3 | One diagnosed S0/S9, Z1d or Z3b component; CAE5; Z12 | Reduce wrong/stale context, repeated mistakes and supervision | Select the bottleneck from Z10 evidence. Isolate representation, admission or correction on fresh development labels; freeze before independent task confirmation. Deterministic permissions/version writes and sealed cases stay outside hillclimb. | Memory/evaluation maintainer |
| Next, 4 | EI2/EI10/EV1/EI11/EV6-EV9; required source adapters; EI15/CD11-CD14 | Deliver governed, low-touch memory and customer-defined value in an enterprise pilot | Scope one partner, required sources, identity provider and deployment. Close applicable access/derivation/revocation gates; configure one objective/metric contract and join permitted outcomes through Z10/Z2b. Include developer and administrator burden. Computer is not a prerequisite. | Keith; enterprise maintainer; customer administrator |
| Next, 5; bounded development can accompany Now | CLF0/CLF1/CLF4/CLF12; CAE0-CAE4 | Improve a specific memory decision without unpredictable costs or recurring backend management | First compare one role at matched eligible candidates/input bounds against native and applicable Jev/local baselines, with quota controls and native fallback. Complete supported-surface conformance and independent task confirmation before adoption; extend all accepted CLEF roles one at a time. | Decision-layer/evaluation maintainer |
| Alongside all priorities | MSG1-MSG6; canonical product facts; CAE6/CAE7 | Give users consistent capability, setup, edition and evidence information | Correct current source copy, check roadmap IDs/references and affected tool contracts, then verify the tagged package, actual npm listing and deployed website through their release processes. A source commit is not publication evidence. | Product/release maintainer |
| Later or separately gated research | Wider CLF rollout/private serving; CAE9; optional CW; S2/S8 where justified; LC4/Track G and grant research | Retain optional capabilities only when they improve useful outcomes or total burden against simpler baselines | Keep required runtime coverage visible; register role-specific comparisons, data floors, deployment/permission checks and retain/reject decisions. No provider, learning system or agent dispatcher becomes required for ordinary memory. | Relevant track maintainer; Keith |

**Operating rule.** Prefer one complete memory loop and a small number of bounded experiments over opening every track simultaneously. Engineering fixtures and development prototypes can proceed alongside Z0 prerequisites; task-benefit/default claims retain their independent gates. Measure repeat mistakes, quality, correction/supervision burden, total cost and latency. Simulated intervention counts are proxies; active human time needs its own registered pilot. Historical benchmark scores do not establish these outcomes.

### Dependency types

- **Hard prerequisite:** functionality or a correctness contract needed for the selected implementation; specify which slice, rather than assuming a whole track must finish.
- **Conditional integration:** required only for the chosen runtime, source, identity or deployment. Other required modes remain owned backlog entries.
- **Optional producer/baseline:** can add evidence or a comparison when available; its absence cannot block the provider-neutral path.
- **Rollout/evaluation gate:** proof required before the affected enablement, release claim or default promotion; development-only prototypes do not bypass it.

Apply these meanings to active item headers and run manifests. Slash-separated legacy references are cross-references, not an instruction to build every optional adapter or baseline first. EI15, CLF4 and AZ6 below now specify their slices explicitly.

**Product facts and publication.** [Canonical product facts](docs/product-facts.md) records current source claims, implementation/publication/evidence distinctions and the dated GitHub/npm/website checks. MSG6 owns remaining inventory, publication and semantic review across all current surfaces. Run `node scripts/check-roadmap.mjs` for duplicate initiative IDs, current-index references, typed dependency headers and local roadmap anchors. Historical bare references are not treated as dependency declarations; this is document validation, not a product or task-benefit test.

---

## Part I - Grant-Tied Deliverables (formerly ROADMAP.md)

# Hippo Roadmap

This roadmap tracks planned work for the hippo-memory codebase. Items are grouped by funding status: committed, conditional on grant award, and speculative.

Development package version: `package.json`. Published versions come from the actual npm dist-tags and corresponding GitHub tags; `CHANGELOG.md` is the release history, not proof that source changes are published. See [canonical product facts](docs/product-facts.md). The Python SDK (PyPI `hippo-memory-sdk`) has its own version line.

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
- [Committed] **Memory scope isolation (stop the agent tracing the wrong memories).** The UserPromptSubmit hook injects `path:<user>` (home/global-scoped) memories into every session regardless of the active project, so a fact from project A surfaces while the agent works in project B. Two failure modes, both observed 2026-06-30: (1) **wrong-project recommendation** - in a corporate project the agent recalled a *personal* hackathon's AWS usage and recommended AWS S3 for the corporate app; a fabrication the user caught and flagged. (2) **secret bleed** - a production API key (from another project, tagged `path:<user>`) sits in the live context of unrelated project sessions. Fix direction: scope-aware retrieval keyed on the active project (cwd / git remote) that demarcates, down-weights, or excludes other-project memories unless explicitly requested; an explicit global-vs-project partition at recall time; and a hard rule that secret-tagged memories never auto-inject outside their owning project. Acceptance: an agent working in project A is not served project B's load-bearing facts or secrets without an explicit cross-project request. Pairs with the per-project + global store split noted under the quiz-me Speculative item.

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

Development and published versions are tracked separately, as in Part I and [canonical product facts](docs/product-facts.md).
Active branch: `master`

## Status as of 2026-05-24

The original 90-day plan (lines below, scoped April→July) is **functionally complete**: A3 envelope shipped v0.39 (security hardening), A5 stub auth shipped, A1 server shipped v0.36, E1.3 Slack ingestion shipped v0.37, F6 reranker hardening shipped v1.9.0, and the F-track hit its roadmap R@5 ≥ 85% target on the oracle split (v1.9.2, F13 chunk-per-turn + F9 sub-agent rerank = R@5 = 86.8). E1.4 GitHub ingestion shipped v1.3.0. The v1.10.x-v1.11.x arc added pidfile-ownership guards, conflict-subsystem tenant isolation, per-IP rate limiting on `/v1`, the opencode plugin installer fix, and the api.ts refactor that unlocked the v0.1.0 Python SDK on PyPI. v1.12.0 sub-1 shipped the A5 v2 auth/role plumbing (Actor object shape + admin-gate on `/v1/sleep`); sub-2 (L9 background pipelines tenant-scoping, 8 files) is next. 33 npm releases from v0.33 (2026-04-23) to v1.12.0 (2026-05-23).

**Next 90 days (2026-05-23 → 2026-08-23) priority queue** (revised at end-of-arc):

**Historical schedule.** Retained as the dated record; use the [current execution index](#current-execution-index) for active priority and readiness. Historical release/evaluation statements retain their original evidence and scope.
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

- **[building]** work in progress or on a feature branch; not merged or released
- **[merged]** implementation is on the default branch; publication and evidence are separate
- **[released] / [shipped]** available in an identified published version/package or deployment; name the version and edition. Never use this for an in-flight branch.
- **[next]** scoped for the current execution index, with owner, next deliverable, dependencies and gates; not a calendar promise
- **[planned]** committed direction, scoping pending
- **[research]** open question, needs investigation before scoping
- **[grant]** funded conditional on FAD or AIC-P1 award (see `ROADMAP.md`)
- **[cut]** explicit non-goal; here so it stays cut
- **[critical]** priority overlay, not a lifecycle status — highest-urgency item; always paired with a lifecycle tag, e.g. `[critical, next]`

**Evidence is a separate dimension.** Record fixture-tested, live-compatible and independently benefit-verified separately, each with runtime/model/configuration, corpus or fixture source and verdict. Unknown or unmeasured evidence stays explicit. A merged/released implementation, configured hook or retrieval score cannot imply a live automatic-save guarantee or task benefit. Legacy dated status labels are historical assertions; missing release/evidence records remain unknown until reconciled, rather than being silently promoted by this legend change.

## Benchmarks (priority order for shipping decisions)

**Historical hierarchy.** This list records the earlier benchmark strategy. Current task-benefit/default decisions follow Z0's built-in-memory comparison, validity/H4 and the applicable retrieval/correctness floors; see the [current execution index](#current-execution-index). Retain the losses and retractions below.

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

### A10. Managed cloud [planned] [commercial repo]
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

**Workflow adoption [planned].** Reuse CAE5's consolidation `build-eval` and calibrated grader for the fixed strategy comparison. A separate `hillclimb` may tune an opt-in summary prompt, with evidence/exception preservation and fresh confirmation; keep the rule-based baseline unchanged.

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

**Skill-lifecycle extension [planned].** CAE9 builds on the existing MIT `skill` object and export support: validated lesson-derived `SKILL.md` drafts, project applicability, provenance, versioning, permission checks and invalidation. Planned organisation administration and managed rollout extend it in the commercial package under EV1. Synthesis/promotion and those enterprise extensions remain unshipped.

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

> **CORRECTION 2026-06-09 (see Part III).** The `_s` numbers throughout this F-track (F14 = 42.0, F14+F9 = 50.8, F15 = 63.6, F16 = 43.6) were measured **global-pool**: each question's answer session was ranked against the union of all 19,195 `_s` sessions, with no per-question haystack filter. Standard LongMemEval-S (and gbrain's 97.6) score within each question's own ~48-session haystack. On the standard per-haystack task, hippo's zero-dependency MiniLM default scores R@5 = 98.6 and voyage-3-large scores 99.8, both above gbrain's 97.6 (see `docs/evals/2026-06-09-longmemeval-per-haystack-dual.md`). The "locally-runnable embedder is the structural ceiling / need F17 `text-embedding-3-large`" conclusion that follows is an artifact of the global-pool harness and does NOT hold for standard LongMemEval-S. Global-pool remains a legitimate, harder eval (one unified store) and is retained below as such, not as a comparison to gbrain. (Re-measured 2026-09-23: MiniLM gives 98.0 on today's build, a tie with 97.6; see `docs/evals/2026-09-23-longmemeval-reproduction.md`.)

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

**Workflow adoption [planned].** Use CAE5 to `build-eval` representative trap sequences, executable checks and grader stability before freezing a new benchmark. Tune component candidates in separate development flows; published test tasks, labels and the scoring protocol stay outside `hillclimb`.

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

**Historical sequence and capacity assumptions.** The following April-August plan is retained for provenance. Its queues and calendar estimates are superseded by the [current execution index](#current-execution-index); refresh remaining-work estimates before making a new delivery commitment.

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
| 11 | An in-process agent loop | Runtimes (Claude Code, Codex, Grok Build, Muse Code) are external processes hippo informs and never starts. Hippo stores state and hands it off; it never runs the agent loop itself | Part VII, Track W boundary, W0 |
| 12 | A shared transcript as the handoff between agents | A dumped context window blows the token budget and loses the interface-artifact model. The handoff is a structured envelope: summary, next action, constraints, evidence, outcome | Part VII, Track W boundary, W0 |
| 13 | Starting or supervising agent processes | Hippo informs runtimes and never starts, stops or supervises one, not even behind a human gate. Runtimes claim cards themselves (pull mode). A process hippo starts and feeds with stored context is a path from stored memory to actuation | Part VII, decision 2026-09-20 (`docs/decisions/2026-09-20-no-agent-spawn.md`) |
| 14 | Hosting, mirroring or searching source code as a product | Code hosts and code search (GitHub, GitLab, Sourcegraph) stay canonical. Hippo reads history and metadata to learn lessons; it stores lessons with provenance, not a copy of the codebase | Part VIII, Track EI |
| 15 | One model trained across customers' data | Per-company learning stays per tenant and deletable (right to be forgotten must reach the scorer). No pooled cross-customer model | Part VIII, Track EI |
| 16 | Publishing a token or cost saving that was not measured | A savings figure must come from the paired, cache-accounted task eval (TE5) with its harness published. Raw token counts, full-history strawmen and unmeasured multipliers stay out of the README, decks and grant reports | Part IX, Track TE |

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

> **CORRECTION 2026-09-23.** `chunk_per_turn_haystack_retrieve.mjs` was never committed; `chunk_per_turn_hybrid_retrieve.mjs --per-haystack` now replays it. The 98.6 reproduces only on the June build (`@xenova/transformers` 2.17.2, int8 weights). Today's build (`@huggingface/transformers` 4.2.0) gives 98.0, and MiniLM has been an optional install, not the default, since 1.28.0. Both figures are the best of five settings, and at 500 questions either one ties gbrain's 97.6. The voyage 99.8 was not re-run. See `docs/evals/2026-09-23-longmemeval-reproduction.md`.

> **CORRECTION 2026-09-28.** gbrain's 97.6 is an any-evidence score over all 500 questions, and gbrain has since replaced it. On the strict all-evidence measure over the 470 questions that have an answer, gbrain reports 95.53 with the Voyage rerank-2.5 reranker and 93.19 without; today's MiniLM runs score 86.8 to 88.5. hippo does not tie gbrain on strict recall, so the parity framing below no longer holds.

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

- **Parity-then-pivot** (avoids reading as goalpost-moving to grant reviewers, given the Part I / Part II benchmark WPs): lead with the per-haystack parity number (98.0 with the free local embedder, level with gbrain's 97.6) as proof of competitiveness, then pivot to the lifecycle stress eval as the differentiator. Not "benchmarks do not matter." Superseded 2026-09-28: the correction above removes the parity claim.
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

**Workflow adoption [planned].** Use CAE5 to `build-eval` label quality, independent family splits, cold-start fallback and downstream task checks. After the data floor, retain ordinary ranker training/sweeps; optional `hillclimb` covers only a separately allowed setting, never outcome labels or scope admission.

**CLEF integration comparison [planned; CLF4/CLF9/CLF12].** Keep the logistic/GBDT head, data floor and cold-start fallback as the small learned baseline. Compare any pretrained decision features/backend separately; CLEF does not replace this statistical plan or convert it into required backbone fine-tuning.

#### LC4. RL memory controller (Memory-R1 / Mem-alpha class) [research → Track G]
Verified feasible at 152-QA-pair scale, but it requires fine-tuning a 3B-14B backbone and a training loop — as a product default this conflicts with the zero-dep local core (non-goals #5/#6). File as the Track G realization (G3 knowledge-RLHF, G5 sleep-as-training-pipeline); candidate for grant-funded research (a GRPO run on a ~4B model is locally feasible on the RTX 5080 for the research track). Any product surface is an optional trained artifact under Track L Rules 2/3.

**CLEF integration and learning follow-up [CLF9/CLF12, CAE10; research gates retained].** Pretrained inference in other CLF items does not wait for this training track. For learned lifecycle decisions, first define a bounded decision and replayable state/action/outcome contract; keep permitted trace capture, independent checks, candidate training and deployment separate. Observational memory feedback or prompt hillclimbing alone does not establish an RL learner or task benefit.

### Adjacent hooks item — compaction survival (added 2026-08-01, AutoCompact follow-up)

#### CS1. PreCompact capture + compact-aware re-injection [SHIPPED 2026-08-03, PR #136]
Source: AutoCompact (Du et al., autocompact.github.io, 2026-07-30) fine-tunes Qwen3-30B-Coder to call `compact()` itself (judge-guided SFT + GRPO; post-RL it compacts proactively in 58.5% of tasks). Its supervision splits into when-to-compact 24%, **what-to-preserve 53%, how-to-continue 23%**. The when-decision needs a fine-tuned policy model — not hippo's lane (same verdict as LC4). The preserve/continue 76% is external-memory territory: make working state survive compaction independently of summary quality, with no model training.

**Historical design description.** The mechanism and estimate below record the August plan, not the current installation contract. Current source uses PreCompact for derivable working state/compaction records and PostCompact for listed-lesson extraction; see [canonical product facts](docs/product-facts.md) and the README FAQ. Live pre-loss lesson preservation remains separately gated by S6/AZ4-AZ6.

Mechanism (both hook events verified against code.claude.com/docs/en/hooks 2026-08-01):
- **PreCompact hook** (fires on manual and auto compaction): run `hippo capture` over the tail of the session transcript before the summary is written — decisions, open items, ids, next step, tagged with session id. The transcript parser already exists (`src/capture.ts`); `hippo setup` currently installs only SessionEnd + SessionStart (`src/hooks.ts`), so mid-session compaction is a blind spot today.
- **SessionStart `source: "compact"`**: re-inject the pre-compact snapshot plus task-relevant recalls, restoring what the summary dropped.
- Non-goal v1: PreCompact can block compaction — leave that knob alone; blocking an auto-compact on a full context risks wedging the session.

Feeds LC1/G8: pre-compact snapshots linked to post-compact outcomes are (state → outcome) training data for the learned lifecycle. Additive only — new hook entries + capture path, no public CLI renames.
**Effort:** 2-3d. **Success:** `hippo setup` installs the PreCompact hook for claude-code; a compaction mid-session writes a working-state snapshot memory; the following SessionStart(compact) injects it; E2E test drives a synthetic transcript through simulated PreCompact + SessionStart(compact) hook input and asserts snapshot + re-injection; SessionEnd capture is unchanged.

**Workflow adoption [planned].** Use CAE5 to `build-eval` lesson/constraint preservation and resume tasks around the existing compaction fixtures. Later `hillclimb` may tune continuation/summary wording; hook delivery, compaction-record separation and protected memory rules stay fixed.

**Cross-platform preservation follow-up [planned; AZ4/AZ5].** Keep this shipped Claude Code work as the baseline. Extend supported pre-compaction/incremental capture and resume through native per-runtime adapters, with one-time setup, truthful readiness and actual durable-memory/checkpoint evidence; the shipped status above does not establish ChatGPT, Cursor or Codex capture parity.

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

### AT3. Quarantine tier before sleep-audit hard-delete [partial: the quarantine tier shipped with CD5 (v48, admin approve/reject); sleep-junk routing into it not done]
**Verified real (wording corrected).** The sleep pipeline's audit phase flags junk (too short / empty / version-bump / non-substantive - `isContentWorthStoring`, src/audit.ts:116-124) and removes it via the hard-delete path (`errorsRemoved`, cli.ts:2859); `auditMemories` + `deleteEntry` run host-wide in sleep, not tenant-scoped (the known A5 v2 sub-2 residue). No recoverable step exists between "flagged" and "gone". `memory-project`'s archive -> cold-storage -> `revive_from_cold()` two-speed pattern and `perseus-vault`'s staged supersede/demote/archive/forget/purge both keep one.
**Effort:** 3-4d. **Success:** a junk-flagged entry moves to a quarantined state for N days before permanent deletion; a `revive` command restores it and it recalls normally; `audit_log` distinguishes quarantine events from hard-delete events.

### AT4. Approval gate on unattended destructive passes [planned]
**Scoped narrower than the atlas's "no human review" verdict.** Humans CAN adjudicate conflicts today (`hippo conflicts` / `hippo resolve`, cli.ts:8704/8708). What has no approval surface is the *unattended* destructive work: sleep's junk deletion (AT3) and consolidation merges act without a person in the loop. `provem` models admission with discrete statuses (`hypothesis`/`accepted`/`proposed`/`pending review`/`quarantined`).
**Effort:** 4-6d (review-queue table + CLI + dashboard surface, opt-in flag so single-user local mode is unaffected by default; overlaps AT3's quarantine table - build together). **Success:** with review mode on, a junk-flagged entry or auto-merge sits in `pending_review` until approve/reject, logged to `audit_log`; review mode off (default) behavior unchanged. Outside-voice pass before leaving `[planned]`, same gate Tracks K/L use.

### AT5. Negative-retrieval assertions in the eval suites [shipped 2026-09-05, micro-eval]
**Status (2026-09-05):** `benchmarks/micro/fixtures/negative_retrieval.json` pins superseded (default filter, with an `--include-superseded` positive control), forgotten and rejected rows as must-not-appear, each against a live sibling row; the rejected paired case re-remembers the same text and requires the AT1 guard to refuse it (runner `reject` action). The `conflicts_with` 0.3x down-rank under `--filter-conflicts` is not asserted (it needs a sleep-detected conflict, no deterministic CLI setup). LongMemEval harness unchanged.
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

---

## Part VII - 2026-09-12 update: work plane (cards, dispatch, cross-runtime migration)

Triggered by a community request on X (Sep 2026, attributed to @sophiamyang; the post itself could not be fetched unauthenticated, so treat the attribution as unverified) for a meta-harness plus kanban that orchestrates Claude Code, Codex, Grok Build and Muse Code, tracks progress, handles model limits, and hands off cleanly when one runtime hits a wall. The question put to hippo: it already covers the handoff half; can it grow the board and dispatch halves without becoming another agent runtime?

**Answer (source-verified):** yes for the board, conditionally for dispatch, and only as a thin control plane over the existing SQLite store. Every claim below was checked against `src/` at v1.38.10 and against the cited papers' arXiv text on 2026-09-12; corrections to the original proposal are listed at the end of this part.

**Decision 2026-09-20 (dispatch): no.** Hippo does not start or supervise agent processes, not even behind a human gate. W3 and W4 below are re-scoped to a pull model: runtimes claim cards themselves. Record: `docs/decisions/2026-09-20-no-agent-spawn.md`.

### What hippo already has (read from source, v1.38.10)

| Existing | Where | What it becomes |
|---|---|---|
| `hippo handoff create --summary --next --session --task --artifact`, `hippo session resume` | `src/cli.ts:4271`, `src/store.ts:3339`, table `session_handoffs` (`src/db.ts:2515`: session_id, repo_root, task_id, summary, next_action, artifacts_json) | the migration envelope, once it carries constraints, evidence and outcome (W1) |
| `hippo session complete --outcome success/failure/partial`, `session_events`, `task_snapshots` | `src/cli.ts:4183`, `src/db.ts:2486-2513` | card progress and audit trail (W2) |
| `hippo wm push/read/flush` working memory | README "Working memory" | per-card scratchpad, cleared on handoff |
| `hippo outcome --good/--bad`, `--error` 2x half-life | README "errors stick" | limit and failure signal per runtime (W3) |
| `hippo share` / `hippo peers`, `owner` in the envelope | `src/cli.ts:9268-9330`, `MEMORY_ENVELOPE.md` | multi-agent attribution |
| Hooks and MCP for Claude Code, Codex, Cursor, OpenClaw, OpenCode, Pi | `integrations/`, `extensions/` | the adapter layer; Grok Build and Muse Code are NOT covered today |
| `hippo dashboard` web UI (localhost:3333) | README command table, `ui/` | the board view; the proposal called the UI "planned", it is shipped |
| CS1 PreCompact capture + compact-resume hook | Part IV | first limit detector (W4) |

**Not there, and not to be faked:** cards table, atomic claim, leases, heartbeats, process supervision, worktree isolation, per-runtime capability matrix, verification gates. `grep -rn heartbeat src/` returns nothing.

### Boundary with existing non-goals (must be resolved before W2 starts)

- **Non-goal #3 (never replace Jira / Linear / GitHub as the system of record).** The board is an *agent work queue*, the same object Hermes Kanban is: rows an agent claims, not the team's tracker. Team-tracker items flow IN via the already-planned E1.5 Jira / Linear ingestion (read-only), and status flows OUT only through the human-approved write-back path of non-goal #8. If a card exists in Linear, Linear stays authoritative for the ticket; hippo owns the runtime, envelope and outcome.
- **Non-goal #8 (no autonomous actuation in V1).** A dispatcher that spawns Codex is local process supervision, not write-back to a source system, so it does not literally violate #8. It is still the first time hippo would *start* an agent rather than inform one. V1 keeps the `ready -> running` transition human-approved (a click or a CLI confirm); unattended dispatch is a separate switch, off by default. **Superseded 2026-09-20:** hippo does not spawn runtimes at all (`docs/decisions/2026-09-20-no-agent-spawn.md`), so the tension does not arise. A runtime moves its own card to `running` with `hippo card claim`.
- **Bet #2 (local-first never gets worse).** The board lives in the same SQLite file, zero new deps. Hosted mode follows A6 / A10 later.
- **Bet #6 (hot path stays cheap).** Routing reads hippo's own outcome memory; no LLM call on claim.

### Track W - Work plane

Two planes, one SQLite file: memory (exists) and work (W1-W4). A third plane, dispatch, was considered and declined on 2026-09-20 (`docs/decisions/2026-09-20-no-agent-spawn.md`). Runtimes stay plugins. The formal frame is Zhao et al. 2026 (arXiv 2609.00546): the persistent part P_t = (identity, durable memory, versioned body) is what hippo owns; the execution part E_t = (reasoner, harness, host) is Claude Code / Codex / Grok Build / Muse Code and is replaceable. Extending hippo to orchestration means owning P_t and the work queue, never starting or swallowing E_t.

#### W0. Boundary constitution [next, doc-only, 1-2d]
One page in `docs/plans/`: hippo will not become an agent loop; no in-process sub-agents; no supervisor LLM that chats with worker LLMs; the envelope (W1) is the only legal handoff; the board is a work queue, not a tracker (non-goal #3 resolution above). Publish the envelope schema. **Success:** the page exists, is linked from `AGENTS.md`, and the non-goals table gains rows 11 (in-process agent loop) and 12 (shared transcript as handoff).

#### W1. Handoff envelope promotion [next, 3-5d] - closes the one open E2 item
`handoff` is the last E2 object still session-scoped (Phase E2 table above, "3d to fully promote"). Promote `session_handoffs` to the migration envelope: add `constraints`, `evidence_json` (git ref, dirty-tree flag, test status), `outcome`, `target_runtime`, `card_id`; `hippo session-end` writes one automatically when a card is open; `session resume` and `context --auto` inject the latest envelope for the card, not the session. Per Li et al. 2026 (arXiv 2605.19140), cross-agent information is the artifact plus a compact score, never a dumped context window; the paper frames richness as a tradeoff against privacy and computation, not a monotone win, so the envelope stays bounded (budgeted like `context`).
**Success (the IC-SMDP test):** a second runtime resumes a card from the envelope plus `hippo context` alone, with no prior transcript, and completes it on a 10-card fixture at parity with same-runtime resume. Red-under-old: today's envelope has no evidence or outcome fields to resume from.

**Workflow adoption [planned].** CAE5's handoff `build-eval` starts from this envelope-only resume fixture. A later `hillclimb` can vary bounded summary/continuation wording on the Claude side after delivery mechanics pass, preserving constraints, evidence and parity; W3's no-dispatch boundary is unchanged.

#### W2. Cards table, status machine, board view [planned, 2-3w]
Tables: `cards` (id, title, status, assignee_runtime, repo, contract, budget, lease_until, heartbeat_at, tenant_id, scope), `card_deps` (parent, child), `card_runs` (card, runtime, session_id, started, ended, outcome). Status machine `backlog -> ready -> running -> blocked | review -> done | shelved`; children promote to `ready` when parents are `done` (Hermes pattern). Comments on a card are the human gate. CLI `hippo card create|claim|block|review|complete|show`, MCP tools `board_show`, `card_create`, `card_block`, `card_complete`. Board view is a new tab in the existing dashboard, not a new UI. Schema migration lands in the cross-track migration order above.
**Success:** progress tracking for a 20-card / 2-runtime dogfood week on hippo's own backlog with no state kept anywhere but the DB; a crashed session leaves a `running` card that a `hippo card reclaim` pass returns to `ready` with its last envelope intact.

#### W3. Pull-mode runtime adapter kit [planned, re-scoped 2026-09-20: no dispatcher, est. 2-3w]
One pull-side adapter contract per runtime: a claim recipe (the runtime runs `hippo card claim` itself), a launch-command template that hippo prints and never executes, a limit-signal hook, and a health note. Adapters: Claude Code and Codex (hooks exist), Pi, OpenClaw, OpenCode (extensions exist), Grok Build (xAI terminal agent, v1.0 Aug 2026, Apache 2.0) and Muse Code (Meta terminal agent, GA Sep 2026); both isolate sub-agents in git worktrees, so the adapter passes a worktree, never a shared tree. Generic MCP-agent fallback. No dispatcher (decision 2026-09-20): a human, or the human's own scheduler, starts the runtime. The runtime claims the card (atomic claim and lease shipped in W2b), reads `hippo context` plus the envelope, heartbeats, and on exit writes `handoff create` and `outcome`. `hippo card reclaim` returns a card with a dead lease to `ready`. Capability file per runtime (context window, repo tools, vision, cost, known failure modes) stored as memories, per RESEARCH "Protocol and interoperability" item 7 (the capability registry and the memory store may be one structure). Limit events are `--error` memories with slow decay, so "Codex hit compaction on this module" is a first-class fact the next runtime retrieves.
**Success:** a card started on Codex that signals a limit is released with its W1 envelope and resumed on Claude Code by a human-started session that claims it, on the 10-card fixture. Hippo starts no runtime process at any point.

**Workflow adoption [planned].** Use CAE5/W1 to `build-eval` envelope-only resume and supported pull-recipe tasks. `hillclimb` only bounded Claude-side recipe/continuation text after mechanics pass; leases, isolation and human-started runtime boundaries remain invariant.

#### W4. Limit-triggered migration [planned, pull mode since 2026-09-20, 2-3w, after W3]
Detectors: CS1 PreCompact hook (exists), repeated tool-error streak, quota / rate-limit response, test-loop stall (same failing test N times), explicit "I am stuck" self-report via `hippo card block`. Migration runs the six-step protocol from Zhao et al. 2026: quiesce tools, checkpoint (envelope + git ref + test status), validate the target runtime can see the workspace, bind credentials, rehydrate the envelope into the new session, resume only after the review column or a verifier says so. Never hand off a dirty tree: missing evidence moves the card to `blocked`. Pull mode (decision 2026-09-20): the source side writes the checkpoint, then blocks or releases the card. The target-side steps (validate the workspace, bind credentials, rehydrate, resume) run inside whichever runtime next claims the card, started by a human or the human's own scheduler. Hippo never starts the target runtime and never touches its credentials.
**Success:** each detector has a red-under-old fixture; a migration with a dirty tree is refused; zero cards resume without evidence.

#### W5. Learned routing over outcome memory [research -> Track LC / D11]
Routing policy starts explicit: prefer the runtime with the strongest similar-success memories and the lowest recent limit-rate on this repo. Learned version is LC3-class (needs LC1 trace data). Two constraints from the literature: Le et al. 2026 (arXiv 2609.04518) measure the harness moving SWE-bench solve rate by 4.3x while the training recipe moves it 1.16x, and cross-harness RL learning configuration adaptation rather than portable skill, so hippo keeps per-runtime capability and failure memory and never assumes one policy fits Codex and Muse alike. Living-Harness (arXiv 2607.26598: tools frozen, procedural repairs and a state graph accumulate from traces) is the later, bounded shape for repairing the routing graph; a proposer never gets write access to the card queue (routing is advisory since the 2026-09-20 no-dispatcher decision). Stanford Meta-Harness (arXiv 2603.28052: 7.7 points at 4x fewer context tokens on classification, beats hand-built TerminalBench-2 scaffolds) optimises harness source code with a strong coding proposer and is explicitly NOT the v1 loop here. Ties to D11 (cross-agent transfer matrix) and O3 (the unfunded multi-agent spec now has a concrete object to specify).
**Success:** routing beats round-robin on card completion rate on the dogfood board, Wilcoxon-tested on the paired A/B harness.

#### W6. Association index over cards + memories [research, extends F4 / E3]
HippoRAG (arXiv 2405.14831) shows single-step Personalized PageRank over a sparse graph matching or beating iterative retrieval at 10-30x lower cost; F4 already holds this as [research] and E3.2 multi-hop recall is shipped. Add card, runtime and error entities to the consolidated graph so "this card is stuck on auth tests" surfaces prior auth-test failures and which runtime fixed them. Stays on consolidated state per Bet #5.
**Success:** recall of the fixing runtime for a repeated failure class on the dogfood board, measured against E3.2 without card entities.

### What not to build
- A supervisor LLM that chats with four worker LLMs (the survey arXiv 2606.20683 and Hermes both treat this as the failure mode; Hermes separates `delegate_task`, a function call, from the kanban, a work queue every profile and human can see).
- One shared transcript as the handoff (violates the interface-artifact model and blows context).
- Absorbing Claude / Codex / Grok / Muse into one Node process; isolation is the product.
- Stanford Meta-Harness as the v1 loop.
- A routing policy trained on one harness applied to another.

### Honest forecast
| Goal | With Track W | With a UI over memories only |
|---|---|---|
| Progress tracking (board) | High: same SQLite, snapshots and events exist | Fake board, no leases, no reclaim |
| Clean handoffs | High: the envelope is the whole game | Medium: already have most of it |
| True cross-runtime orchestration | Medium: adapters and capability memory are the grind | Low: still copy-paste between apps |

### Sequencing
W0 and W1 first: small, close the last E2 item, no non-goal tension. W2 next. W3 and W4 waited on one product decision: does hippo spawn agent processes at all, even behind a human gate? Decided 2026-09-20: no (`docs/decisions/2026-09-20-no-agent-spawn.md`). Track W goes on past the board and the envelope in pull mode only: runtimes claim cards, hippo never starts them. The decision reopens if the W2 dogfood week measures the manual start step as the bottleneck. W5 and W6 ride the LC and E3 tracks.

### Corrections to the source proposal (verified 2026-09-12)
- **"Zhao & Zhao (2026)"** is Zhao, Zhao et al. (five authors), "Runtime-Independent Persistent Agents", arXiv 2609.00546. Formalism and six-step protocol confirmed verbatim.
- **"Yan's IC-SMDP"** is Li, Zhang, Zhou, Chen and Yan, "Learning to Hand Off", arXiv 2605.19140; Yan is last author. The "richer artifact shrinks the interface gap" claim is NOT in the paper; it describes a richness-versus-privacy/computation tradeoff.
- **Meta-Harness** "greps raw traces" is a paraphrase; the paper says the proposer has unrestricted filesystem access to prior search history. The 7.7 / 4x / TerminalBench-2 numbers are confirmed.
- **HippoRAG 2** (arXiv 2502.14802) does not restate the PPR-versus-iterative claim; that comes from HippoRAG 1 (arXiv 2405.14831).
- **Hermes Kanban** claims (SQLite board, atomic claim, OS-process workers, parent/child deps, blocked plus human gate, crash reclaim) are confirmed at hermes-agent.nousresearch.com, not openorchestrators.org. The "A2A protocol" delegation claim is NOT supported by the docs.
- **"corvicai" handoff tools**: not found; corvic.ai is an unrelated enterprise data platform. Dropped.
- **Sophia Yang**: NumFOCUS lists her on the HoloViz steering committee and grant review, not the board; "ex-Mistral" unconfirmed. The post itself was not retrievable. Cite as an unverified community request.
- **hippo "planned web UI"**: `hippo dashboard` is shipped. **Pi** is an integration the proposal omitted.
- **Muse** = Muse Code (Meta), **Grok** = Grok Build (xAI); both real terminal agents with worktree isolation, neither integrated with hippo today.

**Discipline note (same as Part V):** the proposal was LLM-authored and carried three attribution errors, one fabricated product and one overstated paper claim; every item above that cites a paper or a product was re-read at source before it landed here.

---

## Part VIII - 2026-09-23 update: enterprise integration (the corporate memory layer)

Triggered by a founder question: companies keep code in private hosts that are often not github.com, so how does hippo plug into their DevOps, and how does one memory layer tailor itself to each company? Research record: `docs/plans/2026-09-23-enterprise-integration-research.md` (market and platform landscape, literature review, source audit of v1.44.0). **Reviewed 2026-09-24** by an independent pass after merging 1.45.0: factual corrections and item merges below are marked "(review 2026-09-24)".

**Answer (source-verified where it cites hippo):** most companies still use Git, hosted on GitHub Enterprise (Cloud, `*.ghe.com` residency, or self-hosted Server), GitLab (about two thirds of GitLab revenue is self-managed), Bitbucket Data Center or Azure DevOps. Hippo's git learning already works on all of them because it reads the local clone (`src/autolearn.ts:189`). What it cannot reach is the metadata around code (reviews, tickets, incidents, CI failures, chat decisions), and an enterprise will not adopt any memory layer without four things: deployment where its code lives, SSO/SCIM and machine identity, **permission-aware recall**, and an audit trail. Hippo has the audit trail and tenant isolation; the rest is this track.

**Shape:** one core, many source adapters, one company profile, every agent over MCP. The core and the memory envelope do not change; adapters normalize each source into the envelope plus an ACL, the profile holds what differs per company, and deployment matches the company's security posture.

### What hippo already has (read from source, v1.45.0 + PR #227)

| Existing | Where | What it becomes |
|---|---|---|
| Host-agnostic git learning (`git log` on local clones), migration-commit invalidation | `src/autolearn.ts`, `src/invalidation.ts` | Git learning v2 (EI1) |
| Slack and GitHub webhook connectors: HMAC, idempotency, DLQ, backfill, deletion, tenant routing | `src/connectors/` | The pattern the connector kit (EI0) generalizes |
| Tenants, API keys, roles, audit log, non-loopback gate | `src/server.ts`, `src/auth.ts`, `src/audit.ts` | Base for identity (EI11) and permissions (EI2) |
| `<source>:private:` default-deny scopes | `src/recall-scope.ts:26` | Starting point for real ACLs (EI2) |
| Dormant memories on by default, restore labels (`dormant_restore`) | `src/dormant.ts`, PR #227 | Per-tenant learned lifecycle input (EI9) |
| MCP server (13 tools); a real JSON hook for Claude Code, plugins for OpenCode and OpenClaw, a wrapper for Codex, instruction-file patches for Cursor and Pi | `src/mcp/server.ts`, `src/hooks.ts:1074` | Unchanged delivery surface; registry listing (EI11, CD10) |

### Track EI - Enterprise integration

#### EI0. Connector kit [next, 2w]
One `Connector` interface plus shared tables for event log, dead-letter queue, cursors and tenant routing, with one CLI (`hippo connector add|list|dlq|backfill`). Port Slack and GitHub onto it with no behaviour change. Host-qualified `artifact_ref` (`github://ghe.corp.example/org/repo/pull/42`). **Success:** Slack and GitHub suites pass unchanged on the kit; a new source is an adapter of a few hundred lines, down from 1,000-1,400.

#### EI1. Git learning v2 [next, 2-3w]
Read subject, body, trailers (`Fixes`, `Co-authored-by`), ticket keys (`ABC-123`), changed paths and author; skip bot and merge noise; classify with the diff, not the subject alone; link fixes and reverts to the change that introduced the bug (SZZ-lite, `git blame` on the fixed lines); store the commit as `artifact_ref`. (The CLI ignoring `config.gitLearnPatterns` was fixed in PR #227.) Still local-clone based, so it works on every Git host and air-gapped. **Success:** pre-registered eval on the lesson-precision fixture: v2 lessons judged useful at a higher rate than v1 keyword lessons, and every lesson traceable to a commit.

**Workflow adoption [planned].** Share CAE5's source-to-memory eval with SI4/S6: `build-eval` reviews diff/body-to-lesson gold pairs, noise and evidence completeness. An optional extraction-prompt `hillclimb` uses isolated development clones; commit traceability and the rule-based baseline remain fixed.

#### EI2. Permission-aware recall [critical, next, 3-4w]
Every memory carries the ACL of its source (repo visibility and teams, channel membership, Jira project). Callers carry an identity; recall filters by ACL as a hard predicate before ranking; memories derived from several sources inherit the most restrictive ACL; ACLs re-sync on webhook events and on a schedule. **Fixed:** 1.45.0 stopped member keys minting keys or revoking other keys; PR #227 stopped a member key unlocking a private or quarantined scope by naming it, and stopped MCP over HTTP running every caller as admin; the per-scope grants that let a member read a private scope it is entitled to are the remaining EI2 work. **Slice 1 (feat/ei2-permission-recall):** scope grants for member keys (`hippo auth grant|ungrant`, schema v47); consolidation merges, DAG summaries and profiles, extracted facts, auto-promoted traces and supersede successors keep their source's restricted scope and never mix scopes; brief refresh skips restricted receipts; the JS recall filter now hides `:private:` in any case, as the SQL one did; negative tests over HTTP recall, assemble, MCP recall and the graph. **Still open:** default recall that widens to every granted scope without naming one (touches the store loader); derived memories that span several restricted scopes (needs a multi-scope ACL column); back-filling scope on derived rows written before slice 1 (a live-data change; merges keep no source link); HTTP routes for grants; team and IdP-group grants (EI11); ACL capture in connectors and re-sync on webhooks and a schedule; scope on E2 objects (decisions, policies, briefs, notes); member writes by id on restricted rows (forget, archive, promote, share); `GET /v1/audit?tenant=` honoured for member keys (pre-existing, now carries grant rows); `auth list` shows grant scopes to member keys; drill-down refuses a granted member's private summary; a self-heal for `api_key_scope_grants`; case-insensitive Bearer redaction in support bundles (pre-existing). **Success:** negative tests that a user without source access recalls nothing from that source, including through summaries and the graph.

**Workflow adoption [planned].** Use CAE5 to `build-eval` realistic source-permission and derived-memory negative fixtures alongside deterministic API/MCP tests. This is an eval-design use: ACL predicates, grant semantics and source-scope inheritance are outside `hillclimb`.

**Derived-skill follow-up [planned].** CAE9 requires the remaining E2/derived-object scope and source-ACL work before shared use. Source restrictions must survive synthesis, artifact export and later mutations; corrections and revoked source access propagate to dependent managed versions. Do not treat a generated instruction file as a way around recall permissions.

#### EI3. GitHub, enterprise grade [next, 2w]
GitHub App auth (installation tokens) instead of a PAT; configurable API base for GHES and `*.ghe.com` (backfill hardcodes `api.github.com` today, `src/connectors/github/backfill.ts:40`); pull request reviews, reverts and CODEOWNERS as lesson sources; review threads that ended in a code change become convention memories.

#### EI4. GitLab (SaaS, Dedicated, self-managed) [planned, 2w after EI0]
Group service accounts or OAuth, group webhooks, system hooks on self-managed; merge requests, discussions, pipelines.

#### EI5. Jira and Confluence [planned, 2-3w after EI0; supersedes the Jira half of E1.5]
Forge or OAuth 3LO for Cloud (Connect apps froze for updates on 31 Mar 2026 and reach end of support on 31 Jan 2027; review 2026-09-24), PATs for Data Center through 2029. Consuming the Rovo MCP server is the default; build a crawler only where it falls short. Ticket keys join tickets to commits (EI1). Optionally consume the Atlassian Rovo MCP server instead of building a crawler.

#### EI6. Azure DevOps [planned, 2w after EI0]
Repos, Boards and Pipelines through service hooks; Entra ID service principals or managed identity preferred. Global PATs stop working Dec 1, 2026; organisation-scoped PATs still work (review 2026-09-24).

#### EI7. Bitbucket, Teams, incidents [on demand: build when a design partner needs it]
Bitbucket Cloud and Data Center (DC is exempt from Atlassian's 2029 end of life); Microsoft Teams through Graph; PagerDuty and Jira Service Management postmortems as incident memories. Slack: since May 2025 (new apps) and Sept 2025 (existing installs), non-Marketplace distributed apps get 1 history request a minute; customer-internal custom apps are exempt, so each customer installs hippo's Slack app as their own internal app (review 2026-09-24).

#### EI8. Company profile [planned]; onboarding hindcast [research]
A per-company profile: sources and repos, ticket-key pattern, commit conventions, ownership from CODEOWNERS or a Backstage catalog, retention and legal hold, sensitivity rules, `.hippoignore`, model endpoint. Onboarding replays a sample of the company's own past issues, compares an agent's attempt with the merged change, and stores the differences as evidence-backed convention memories (Learning to Commit, arXiv:2603.26664). Generated-but-unverified context hurts (arXiv:2602.11988: generated context files about -3% success and +20% cost, developer-written about +4%), so hindcast memories stay probationary until outcomes confirm them. The hindcast is research, not planned (review 2026-09-24): it runs paid agent sessions per customer and reuses TE5's `make-tasks.mjs` and `ab-run.mjs`.

**Workflow adoption [planned].** Use CAE5 to `build-eval` permitted company development tasks and evidence-backed convention labels. A later scoped extraction/admission `hillclimb` uses isolated history; retain probationary status, source permissions and the hindcast's research/resource gates.

#### EI9. Per-tenant learned lifecycle [research, gated on LC3]
LC2/LC3 value scorers trained per tenant on that company's outcomes and `dormant_restore` labels, deletable with the tenant's data (non-goal 15).

**CLEF learning follow-up [research; CLF9/CLF11].** Tenant-specific datasets, learned policies and derived model artifacts require explicit opt-in and the same deletion/retention/source-revocation boundary. Pretrained inference needs no customer training; pooled cross-tenant learning requires separate authorisation.

#### EI10. Deployment tiers [planned, 6-10w; absorbs A6 packaging, A4 encryption and CD8 reliability]
Single-tenant or customer-VPC (Helm, Terraform, Postgres per A6), fully air-gapped (local embeddings, customer model endpoint, no telemetry), and an outbound-only relay so self-hosted Git servers need no inbound port. TLS, per-key quotas, encryption at rest (A4), plus the central server's backup, restore, high availability and upgrade runbooks (was CD8).

**CLEF deployment follow-up [planned; CLF2/CLF11].** Support the shared typed decision contract on approved customer-controlled local/VPC/air-gapped endpoints, with pinned serving artifacts and working native fallback. Include decision-head compatibility, offline installation, model footprint, health/capacity, upgrade, backup and recovery in the deployment validation.

#### EI11. Enterprise identity and governance [planned]
SAML/OIDC SSO and SCIM [commercial repo] (the A5 stubs were deleted in 1.45.0, so this is new work), remote MCP over HTTP with OAuth 2.1 and an MCP-registry entry (was CD2), roles from IdP groups, OIDC workload identity for machines, SIEM export of the audit log [commercial repo], listing in internal MCP registries (Copilot "registry only" policies block unlisted servers).

#### EI12. Tenant evaluation [merged into TE5: the same runner on a design partner's own history]
Replay a tenant's own history in time order with memory on and off at matched token budgets and several seeds; report resolve rate, tokens per resolved task, review-acceptance and revert rate, and stale-retrieval rate, with verbatim storage as a baseline. This is the number a buyer and an investor both ask for, and it keeps every later claim honest (arXiv:2606.15017 shows memory gains often vanish at matched budgets; note it studies web agents on WebArena, not coding agents). Shares its harness and cost accounting with TE5 (Part IX).

**Workflow adoption [planned].** CAE5 uses `build-eval` to adapt independently reviewed tenant development cases and cost/telemetry checks around this runner. Company-specific extraction/admission `hillclimb` uses isolated development history; CD11's live control and CD12's buyer reporting remain independent of candidate selection.

#### EI13. Organisational-memory benchmark [research]
A public benchmark whose tasks need knowledge that exists only outside the code (review threads, incidents, ticket decisions). No 2025-2026 memory benchmark for coding agents does this (SWE-Bench-CL, SWE Context Bench, DreamBench-SWE all use code or prior trajectories). Publishable; the natural home for the Part III "memory-system eval methodology" item.

**Workflow adoption [planned].** Use CAE5 to `build-eval` fresh organisational-knowledge tasks and independently reviewed ground truth from permitted sources. Keep benchmark authoring separate from candidate `hillclimb`; publish frozen scoring and fresh confirmation whatever the result.

#### EI14. Compliance [moved to the Company section in Part X; funding-gated]
SOC 2 Type II first, then ISO 27001 and ISO 42001; DPA, subprocessor list, SIG/CAIQ answers; FedRAMP only through the self-hosted SKU or a partner.

#### EI15. Business-objective and task-outcome links [planned; hard: EI0/EI2/EI8/EV1/Z10/Z2b; conditional: selected source adapters and EV7; optional producer: CW3; added 2026-10-02]
Connect permitted task evidence to the business objective the customer wants the work to serve. Extend the existing enterprise connectors and company profile; source systems remain authoritative for objectives, tickets and acceptance.

**Dependency slices.** Use the provider-neutral Z10 delivery/task evidence and Z2b outcome contract with EI2 source permissions, EI8 objective configuration and EV1 edition ownership. Only the customer's required source adapter(s) from EI3-EI7 and applicable EV7 mapping are required; both Jira and Azure DevOps are not mandatory. CW3 contributes Computer-specific receipts when that optional adapter is installed. Ordinary enterprise objective joins and CD14/EV9 acceptance do not require Computer, CW0-CW2, a CLEF backend or an RL learner.

- Configure project objectives and a success-metric contract once: owner, metric definition/unit, eligible work, acceptance evidence, observation window and source. Reuse existing ticket/project metadata and EV7 mappings wherever available. The customer defines value; token usage, activity counts and a model's opinion cannot supply the objective.
- Join objective → source ticket/task → runtime/session/turn → accepted artifact or independent check → observed outcome, with applicable delivered memory IDs/versions from Z10; include CW3's provider-specific receipts only for Computer work. Keep work acceptance, business results and evidence of memory application separate. A merged PR or task pass cannot credit every delivered memory; ambiguous, missing or delayed evidence stays unknown under Z2b.
- Version objective/metric mappings and source evidence. Preserve task timing, project/tenant scope and evidence references across retries, compaction and runtime handoffs. A source correction, reopened task, reverted artifact or changed objective updates the derived status with its history intact; unavailable business results do not prevent ordinary scoped memory use.
- Apply EI2 source permissions to joins and derived reports, including multi-source restrictions, revocation and retention. Reuse the MIT core's task/source/provenance foundations; enterprise objective configuration and cross-source business-outcome joins follow EV1 packaging.

**Exit.** Permitted fixtures reconstruct the objective-to-outcome chain and distinguish accepted work from demonstrated memory benefit. Cover conflicting project mappings, unrelated outcomes, concurrent tasks, missing results, reversals and denied source access. No business-value or employee-performance claim from trace coverage alone.

### Deferred in this track
Gerrit and Perforce (automotive, games) through Git bridges or partners; observability alerts as memories; a "who knows what" directory built from review and outcome evidence rather than `git blame` (arXiv:2606.20882).

### What not to build
A code host, a code mirror or a code search engine (non-goal 14); a crawler where the vendor ships an MCP server or events API; long-lived personal tokens as the default auth; one model pooled across customers (non-goal 15); write-back into source systems (non-goal 8).

### Honest forecast

| Goal | Confidence | Why |
|---|---|---|
| Git history on any host | High | Already host-agnostic; v2 is reading more of the same data |
| GitHub, GitLab, Jira, Azure DevOps coverage | High | Well-documented APIs; the kit removes duplication |
| Permission-aware recall that survives an enterprise security review | Medium | Derived memories (summaries, graph) are the hard part; research literature has no complete answer |
| Air-gapped and VPC deployment | Medium | Local-first core helps; Postgres and packaging are new work |
| Measured value per company | Medium | Depends on EI12 and real design partners |

### Sequencing
Superseded by the single queue at the end of Part X (review 2026-09-24): each Part's own "0-3 months" added up to more than a quarter. Order within this track: EI2 first; EI0 and EI1 when a third source or a design partner needs them; EI3-EI6 per design partner; EI10 and EI11 with the first paid pilot; EI7 on demand; EI9 and EI13 as research.

**Discipline note:** market figures in the research record came through search summaries (the sandbox blocked most direct fetches) and 2026 arXiv items are preprints; re-check any figure at its source before it goes on a slide or into a claim.

---

## Part IX - 2026-09-23 update: token efficiency and the evals that prove it

Triggered by a founder question: can hippo save organisations tokens and make answers smarter, and how would we prove it? Research record: `docs/plans/2026-09-23-token-savings-eval-research.md` (source audit of v1.44.0 plus PR #227, literature and benchmark review).

**Answer (source-verified where it cites hippo):** not provable today, because hippo records nothing about the tokens it spends. It estimated tokens as `chars / 4` (now defined once in `src/token-ledger.ts`, re-exported from `src/search.ts`), printed the count and stored none of it. It also adds tokens of its own: the Claude Code `UserPromptSubmit` hook re-injects the pinned block (cap 1,500 tokens) on every prompt, whether or not it changed, and the rendered lines carry a live strength percentage and dates, so repeated copies are rarely byte-identical for a prompt cache. The literature supports the claim in a narrower form: memory systems report 85-99% fewer context tokens than full-history baselines at similar accuracy (Mem0, Zep, LightMem), focused context beats long context (Lost in the Middle, Context Rot, NoLiMa), and experience reuse cuts steps on later coding tasks (ReasoningBank, SWE-ContextBench). For coding agents most spend is input and most input is file reads, so the saving that matters is work the agent no longer does, measured per task in dollars with cache accounting.

**Rules for this track:**
1. The headline metric is **dollars per resolved task**, priced over four buckets (uncached input, cache write, cache read, output), paired against a no-memory arm with bootstrap CIs. Raw token counts are supporting data, never the claim.
2. Hippo's own overhead is measured and reported next to any saving (token ROI is net).
3. No token or cost figure goes into the README, a deck or a grant report until TE5 measures it (non-goal 16). This covers the existing A9 "5x compute cost reduction" and Track L "5x-cost lever" lines, which are unmeasured.

### What hippo already has (read from source)

| Existing | Where | Status |
|---|---|---|
| Token budgets on every surface (recall 4000, context 1500, MCP recall 4000, MCP context 3000, pinned inject 1500) | `src/cli.ts`, `src/api.ts`, `src/config.ts` | Works; the MCP descriptions advertised 1500 for both until PR #227 |
| Greedy score-ordered packing, dedup, MMR, `minResults` | `src/search.ts:694-785` | Fills the budget; never stops early on weak results |
| Lifecycle stress eval with a per-condition `tokens` field | `scripts/lifecycle-stress/run.mjs` | The only token-reporting harness; headline NULL (Part III) |
| Structured handoff and snapshot caps instead of transcripts | `src/handoff.ts`, `src/capture.ts:1026` | Bounded by design (non-goal 12) |

### Track TE - Token efficiency

#### TE0. Token ledger [shipped first slice, PR #227]
**Status:** `token_ledger` (schema v45) records the hook, CLI context and recall, MCP recall and context, and HTTP recall, context and assemble; `hippo tokens` reports per surface; one `estimateTokens`; MCP descriptions fixed. Remaining: optional exact tokenizer or per-model calibration, continuity blocks inside the `hippo context` budget, an HTTP report endpoint and the A7 rollup, and confirming how each host keeps `additionalContext`.
Record every injection: surface (hook, CLI, MCP, HTTP), items, estimated tokens, a hash of the rendered block, session id. One `estimateTokens` everywhere (done), optional exact tokenizer or per-model calibration, continuity blocks counted inside the budget, MCP descriptions fixed to the real defaults. `hippo stats tokens` and an HTTP rollup feed A7 (per-tenant usage). Also confirms how each host keeps `additionalContext` in its transcript. **Success:** a week of dogfood sessions produces a per-session injection report.

#### TE1. Cache-stable rendering [shipped for the hook, PR #227]
**Status:** the hook block drops the live strength percentage and is byte-identical while its memories do not change. Remaining: moving pinned memories into the session-start prefix, and the same treatment for MCP and HTTP text.
Injected blocks render byte-identically for the same memories: no per-call strength percentage (bucket or drop it), stable date text, deterministic tie order. Pinned memories inject at session start where they can sit in the cached prefix. **Success:** TE4 shows identical hashes for unchanged memory across turns.

#### TE2. Inject only on change [shipped, PR #227; delta-only injection remaining]
**Status:** an unchanged hook block is skipped when the payload carries a session id, resent every 10 skips (`pinnedInject.refreshTurns`) and after compaction, and logged as tokens saved. Sending only the changed items is not built yet; a changed block is resent whole.
The per-prompt hook compares the block hash with the last one it sent in this session and sends nothing (or a one-line marker) when unchanged, and only the new or changed items otherwise. **Success:** TE4 shows most per-session hook tokens removed, with no change in which memories the agent has seen.

#### TE3. Token-at-accuracy curve [harness shipped, PR #227; real-data run pending]
**Status:** `scripts/token-eval/budget-curve.mjs` sweeps budgets per question against recency, full context and no memory, and reports minimum tokens to reach the evidence. Verified on the bundled smoke file only (haystacks too small to discriminate); the LongMemEval_s run needs the dataset, which this container cannot download. LLMLingua-2 arm deferred.
LongMemEval and LoCoMo at budgets 250 to 8000, reporting answer recall against injected tokens and minimum tokens to answer, against full context, naive top-k at the same budget, LLMLingua-2 compression and no memory. Deterministic, gates CI. Replaces "R@5 at a fixed 4000" as the retrieval chart, since per-haystack R@5 is saturated.

**Workflow adoption [planned].** Use CAE5's rendering flow to `build-eval` evidence completeness and downstream application around the existing budget curve. Keep the deterministic scorer and benchmark protocol; `hillclimb` only a separate development rendering surface, confirmed on fresh task families.

#### TE4. Session replay harness [shipped, PR #227]
**Status:** `scripts/token-eval/replay.mjs` replays traces through the real hook in every-turn and skip-unchanged arms, cache-priced; a short trace runs in CI. On three synthetic traces skip-unchanged cut hippo's own cache-priced hook text by 84-89% and unchanged blocks were byte-identical every time (`benchmarks/token-eval/README.md`). This is hippo's overhead, not a saving on the agent's work. `scripts/token-eval/claude-usage.mjs` reads Claude Code's own per-message usage records on a desktop and joins them to the ledger by session id; running it on the founder's machine is the next input.
Replays recorded (anonymised) agent sessions through the hooks with no LLM calls and prices the injected text with a cache model (Anthropic 0.1x read, 1.25x write). Reports tokens injected per session, share re-injected unchanged, and byte-stability. **Success:** runs in CI and fails on a regression, such as a hook that doubles its output.

#### TE5. Paired agent A/B on task sequences [critical; runner, analyzer and protocol shipped in PR #227; scored runs pending; budget about $1-4k]
**Re-registered 2026-09-29 as Z0 (Part XV):** the comparison is now built-in memory, not no memory, on lesson families with scripted corrections; see `docs/evals/2026-09-29-z0-built-in-memory-prereg.md`. The text below is the first registration.
**Status:** protocol registered in `docs/evals/2026-09-23-te5-token-ab-preregistration.md`. `scripts/token-eval/make-tasks.mjs` drafts and verifies tasks from git history, `ab-run.mjs` runs real Claude Code sessions per arm (no-memory, hippo, random-text, stale-memory; stale-memory is another repository's memory, so it tests irrelevant rather than outdated memory, and should be renamed irrelevant-memory before the first scored run) with history truncated at the task base and the user's own settings excluded, and `ab-analyze.mjs` reports cost per resolved task with CIs. Plumbing verified with a stand-in in CI and once with real Claude Code on a toy repository. No scored run exists; the next step is a reviewed task set on two or more real repositories, run on the founder's machine.
Sequences of related coding tasks where early tasks produce lessons later ones can use: SWE-ContextBench plus fresh issues from hippo's own history and post-cutoff public repositories. Six arms on the same model and harness: no memory, hippo as shipped, all memories dumped, naive top-k at equal budget, random repository text at equal budget, stale or irrelevant memories. 3-5 seeds, standard errors clustered by repository, four-bucket costs from provider usage fields, execution-based grading. Reports dollars per resolved task, resolve-rate delta (pass@1, pass^k), turns, file reads and repeated-error rate, and net token ROI. Pre-registered in `docs/evals`; harness and every arm's configuration published (the Mem0/Zep dispute shows vendor-run baselines are not trusted). This is the eval EI12 runs on a tenant's own history. **Success:** a published result with CIs, whatever it says.
**Official workflow adoption (planned 2026-10-01):** Part XX, CAE0-CAE4 adds installation, explicit command invocation and an adapter around this runner; it preserves the current Z0 registration and timeout/retry policy.
**Grading and plumbing checks (added 2026-09-28).** Anthropic's eval guide (Lance Martin, "Automating eval design and hillclimbing with Claude", 2026-09-28) asks for three checks the runner lacks: grade the same output twice, count plumbing failures on their own, and keep state left over from one attempt away from the next. Close them before any scored run:
- **Re-grade.** The hidden tests run once on the agent's final state (`ab-run.mjs:485-486`), and the next checkout wipes that state, so no grade can be checked again. Save each session's diff, run the hidden tests on it a second time, and report a grade that flips as flaky. Before scoring, read a sample of graded diffs with the arm hidden, to confirm a pass is a real fix.
- **A timeout is a result.** A session killed at the 60-minute limit leaves no JSON result, is marked `no-result` (`ab-run.mjs:466`, `:515`) and drops out of the resolve rate as well as cost (`ab-analyze.mjs:100`). The guide counts timeouts as plumbing, but in an A/B an arm can cause them, and an arm that makes sessions hang would hide its own failures. Score a timeout as unresolved and price it from its transcript, which needs the session id fixed before the run. A crash with no result stays invalid. Report invalid sessions by arm and reason; today they are counted by reason only (`ab-analyze.mjs:101-103`).
- **A retry starts clean.** After a plan-limit cut-off the checkout is reset but the store is kept (`git clean -e .hippo`, `ab-run.mjs:246`, called again at `:476`), so a retried hippo session can start with whatever the cut-off attempt's hooks captured, after a leak check that ran before that attempt (`:434`). Snapshot `.hippo` and the run's `HIPPO_HOME` before each attempt and restore both before a retry.

#### TE6. Adaptive budget [planned, after TE3]
Stop packing when relevance falls off (score gap or threshold) and inject nothing when nothing is relevant; the budget becomes a ceiling, not a target. **Success:** fewer tokens on TE3 at equal recall, and no resolve-rate loss on TE5.

**Cheap first test (added 2026-09-26):** a pass-by-default gate, where a failed or unsure check injects nothing (the pattern supermemory's open-source company-brain uses before its bot speaks unprompted: answer, acknowledge, investigate or pass). Replay the 133 transcripts from the SI0 kill test, where injected memories had a median overlap of 0.057 with the work, and count how many injections the gate drops and how many of the few relevant ones it keeps. No paid call; it decides whether TE6 needs more than a threshold. If a threshold is not enough, the next arm is a Jev yes/no judgment ("does this memory bear on this prompt?"), opt-in and falling back to the threshold, the same shape as `--reranker jev`. The corpus is frozen at `hippo-archive/transcripts-since-2026-09-01/` (135 files, outside the repo; private text).

**Workflow adoption [planned].** CAE5 maps this admission experiment to `build-eval` case/rubric review and a bounded `hillclimb` of query construction or the optional relevance gate. Keep the replay-first route, Z10 readiness and a fresh confirmation set; tune against useful coverage and no-match harm, not injection count.

#### TE7. Terse agent format [planned, after TE3]
A compact rendering for agent-facing output without markdown decoration and repeated labels. **Success:** fewer tokens per fact at equal accuracy on TE3.

**Workflow adoption [planned].** Use CAE5's S9/TE7 format flow: review equal-budget evidence/application cases with `build-eval`, then `hillclimb` only the rendering text. Preserve qualifications, provenance, actual cache accounting and downstream task quality.

#### TE8. Lessons that prevent exploration [research, gated on TE5; merged with the "codebase map" item in Deferred, row 6]
Capture file maps, "where X lives", commands that worked and known dead ends from sessions that read many files, since reads are most of a coding agent's input. Wrong pointers cost more than none (SWE-ContextBench), so this ships only with a TE5 delta.

#### TE9. Consolidation that compresses [research, gated on TE3 and TE5]
Part III found merge summaries are concatenations and DAG slice 1 cost 6.3pp. Any new attempt starts from a new hypothesis and must win on both evals.

**Workflow adoption [planned].** Use CAE5's consolidation `build-eval` for evidence-preserving compression and task effects. A permitted optional merge/summary prompt can `hillclimb` on independently rebuilt development stores; retain both TE3 and TE5 confirmation gates.

#### TE10. VibeMemBench [next when released; plan fixed 2026-09-24]
VibeMemBench (arXiv 2609.23570, Alibaba DAMO, September 2026) is the first public benchmark that toggles memory on real repository coding tasks with executable tests: 111 SWE-rebench V2 targets, 3,634 history trajectories, five solvers, 4 seeds. Mem0, SimpleMem, MemoryOS and A-MEM landed at or below memory-off in 11 of 12 pairings. Its code and data are not released yet (the DAMO-ConvAI folder says "Coming"). The protocol for hippo is fixed in `docs/evals/2026-09-24-vibemembench-plan.md` before seeing the data: a like-for-like top-1 arm, a separate hippo-native context arm, an outcome-feedback-off control, and publication whatever the result. Before release: trajectory ingestion (a trajectory becomes hippo memories with its outcome, never the gold patch) and a TE5 run on a few SWE-rebench V2 repositories as an early read.

#### TE11. DolphinBench [next; released September 2026; protocol registered before any paid call]
DolphinBench (arXiv 2609.24971, Mem0, September 2026; site dolphinbench.ai; harness `mem0ai/dolphinbench`, Apache-2.0) grades the action an agent takes after a long history, not a quiz answer. Three knowledge-work personas each carry about 500k tokens of user messages dated January 2023 to December 2027, and its 600 tasks (200 per persona) turn on rules stated once and buried among thousands of unrelated messages. A task passes only when the tool called, its target and its content are all right, against mock email, Slack, Discord, calendar and CRM apps served over MCP; each task was checked to pass with the history and fail without it. Every run reports total cost (ingestion plus tests) and latency beside accuracy, which is this track's rule 1. It is the first public benchmark that tests hippo's automatic capture as well as its recall: ingestion sends every history message through the agent and its normal memory hooks, one fresh conversation each, so a rule the hooks fail to store (the open "we use pnpm, never npm" miss in Part X's capture findings) cannot be recalled later.
- **Arms:** the paper ran Claude Code with Sonnet on Built-In, Mem0 and Honcho. hippo runs on that harness and model through its Claude Code hooks, beside a Built-In arm we run ourselves, a BM25-only arm over the same captured memories, and a decay-off arm as a sensitivity check.
- **Verify before reading hippo:** our Built-In arm must reproduce the paper's Built-In row within its noise. Until it does, a hippo delta may only be a setup difference.
- **Read-only tests:** tests run with memory writes and deletion blocked, capture included, and the harness's `verify_checkpoint` rejects a store that changed after `freeze`. hippo's recall writes retrieval counts back (`markRetrieved`, `src/search.ts:1257`), so the test arm needs a recall path that writes nothing, with the capture hooks off.
- **Dated clock:** decay runs from `last_retrieved` against `evalNow()` (`src/memory.ts:340-376`). Ingestion takes hours, so unless `HIPPO_FAKE_NOW` follows each message's date, five years of history look a day old and decay never acts. With it, a plain memory stated three years before a test and never recalled keeps about one eighth of its strength at the 365-day default. Whether that buries the rule is FE3's question on a public benchmark; the decay-off arm answers it.
- **Cost gate:** ingestion is one paid agent session per history message (up to 5,128 per persona), run on the founder's machine. One persona, Built-In and hippo, prices the full run first.
- **Scope of any claim:** tests block writes and send no feedback, so outcome marks, hippo's clearest measured win, never act. A result speaks to capture and recall for action, at the cost and latency measured.
- **Published whatever the result:** the runner's `package` output (`ingestion.json`, `tests.json`) goes to the leaderboard, where it shows as self-submitted and unverified. The site does not say how a run becomes verified; ask Mem0 once the Built-In row reproduces.

**Success:** hippo's accuracy, dollars and latency published against Built-In, Mem0 and Honcho on the same harness and model, paired by task with bootstrap 95% intervals, whatever they say.

### What not to build
LLM-in-the-loop compression at injection time (adds a model call to every prompt to save tokens on the same prompt); a token saving figure from raw token counts without cache accounting; a claim that hippo beats simpler retrieval without the naive top-k arm (the first registration measures savings against no memory only, and defers naive top-k and dump-all; a claim against them needs a second registration that runs them).

### Honest forecast

| Goal | Confidence | Why |
|---|---|---|
| Measure hippo's own overhead, and cut it | High | TE0-TE2 are plumbing; the waste is visible in source |
| A retrieval-level tokens-at-accuracy chart | High | Existing LongMemEval and LoCoMo harnesses, new sweep |
| A net dollar saving per resolved task on coding sequences | Medium | Literature says yes when retrieval is right and no when it is wrong; hippo's own lifecycle evals so far are NULL or negative |
| "Smarter" (higher resolve rate) with CIs excluding zero | Low-Medium | Mem0's own table has full context ahead on accuracy; needs TE5 and likely TE8 |

### Sequencing
TE0, TE1, TE2, TE4 first (measure and remove hippo's own cost, about 0-1 month); TE3 and TE5 next (the proof, 1-3 months, shared with EI12); TE6 and TE7 after TE3; TE8 and TE9 as research gated on TE5.

**Discipline note:** paper figures in the research record were checked through abstracts and secondary write-ups (the sandbox blocked most direct fetches) and 2026 items are preprints; the 40-turn hook cost is an upper bound at the cap, not a measurement. TE0 replaces it with real numbers.

---

## Part X - 2026-09-24 update: selling into companies that roll out GitHub Copilot

Triggered by a founder question: many companies hand AI coding to developers through GitHub Copilot Business or Enterprise in VS Code, so how does hippo reach them, and should it be invisible infrastructure or a tool every developer sees?

**Answer:** mostly invisible infrastructure with a small visible trust layer. The platform or AI-enablement team approves hippo once and switches it on for everyone; developers change nothing. The buyer is that team, not individual developers. Package hippo the way Copilot admins already approve add-ons (an agent plugin plus an approved MCP server), not as a classic VS Code extension first.

### What changed in the market (research 2026-09-24; checked through search excerpts of GitHub, VS Code and vendor pages because the sandbox blocked direct fetches, so re-check before quoting)

- **MCP servers and agent plugins are the main third-party routes into Copilot.** GitHub sunset App-based Copilot Extensions on 2025-11-10 and named MCP servers as the replacement; VS Code extensions were not affected (review 2026-09-24 corrected "MCP is the only route").
- **Admins opt in.** For Business and Enterprise seats the "MCP servers in Copilot" policy is off by default. Admins can restrict developers to a private MCP registry ("registry only", still in preview), served by GitHub's registry format (MCP Registry v0.1) or Azure API Center.
- **Agent plugins went GA on 2026-08-12** in VS Code, Copilot CLI and the Copilot app. A plugin bundles MCP servers, hooks, skills and commands; org-wide enabling through managed settings (`enabledPlugins`) is in public preview since 2026-06-05.
- **VS Code hooks (preview) use the same format as Claude Code**, so hippo's existing hooks may carry over with little change. Unverified: whether VS Code's `UserPromptSubmit` accepts `additionalContext`, which hippo's per-prompt hook relies on; CD1 checks it first.
- **Built-in memory is now everywhere and free.** Copilot Memory (public preview since 2026-01-15) stores repository-scoped facts with citations, checks them against the current code, re-stores memories that are validated and used, and deletes unused ones after 28 days; it is off by default for Business and Enterprise. Claude Code, Codex and Windsurf ship their own memory. None of them is cross-tool, company-wide, long-lived, self-hosted and audited together, which is where hippo competes.

**Positioning:** "Copilot Memory remembers one repository, inside Copilot. Hippo is your company's memory, for every AI tool, on your own infrastructure." (The earlier "for a month" wording was inaccurate: used memories are kept.) Complement Copilot Memory; do not compete with single-repository recall.

### Track CD - Corporate distribution

#### CD1. Hippo agent plugin [next, 1-2w; the Claude Code marketplace entry shipped in PR #227]
A Hippo agent plugin bundling the MCP server, the hooks and a short skill. That's the unit an admin can approve and turn on for everyone. Ship it in the agent-plugin format for VS Code and Copilot CLI (same bundle for Claude Code where the format matches), port the existing Claude Code hooks to VS Code's hook events, and publish a listing for the default plugin marketplaces and for private company marketplaces. **Success:** an admin enables it through managed settings and every developer's Copilot agent uses hippo with no per-developer step.

**Workflow adoption [planned].** Use CAE5's tool-guidance flow to `build-eval` supported invocation and sandbox setup cases, then `hillclimb` only plugin skill/tool wording. Keep hooks, schemas and managed installation fixed; verify each client's support separately.

**Contract and upgrade follow-up [planned].** CAE6 audits the bundled MCP tool contracts and truthful annotations before instruction optimisation; CAE7 records supported model/runtime/plugin versions and reruns the relevant fixtures after upgrades. Preserve managed installation and each client's actual lifecycle support.

**Native improvement follow-up [planned].** CAE8 tests Hippo's own supported capture/context/plugin path, including hook ownership and safe update/uninstall. Existing third-party user configuration is preserved by generic installer fixtures; an ECC integration or coexistence recipe is not a product deliverable. Setup/recovery burden is part of acceptance.

**Automatic preservation and readiness [planned; AZ4/AZ5].** Bundle the validated capture/checkpoint adapter and health checks for each supported mode; managed installation must prove scripts, store access, required trust and actual saves. A marketplace listing or MCP connection alone is not cross-platform automatic capture.

#### CD2. Company-hosted Hippo server with company sign-in [next, 3-4w; delivered by the EI11 OAuth and registry work and the EI10 server tier]
A company-hosted Hippo server with sign-in that the company's identity system can use (OAuth), listed in the company's approved MCP list. Remote MCP over HTTP with OAuth 2.1 (today the HTTP server has API keys only), an entry in the MCP Registry v0.1 format so it can sit in a company's GitHub or Azure API Center registry, and the CD1 plugin pointing at it. **Success:** works under a "registry only" Copilot policy, and every recall is tied to the signed-in developer for permissions (EI2) and audit.

#### CD3. Small VS Code extension [optional, later; build only on request]
Optionally, later, a small VS Code extension. It could start Hippo automatically and show what memory was used. Only build it once someone asks. It would register hippo through VS Code's MCP server definition provider API and show a panel of the memories an answer used. Not started until a paying or piloting customer asks for it.

#### CD4. Memory curation workflow [planned; built as AT4's review queue, one surface]
Lessons move from repository to team to company only with approval. A review queue lets tech leads approve, reject (reusing `hippo reject`), merge or edit lessons; agents cite which memory they used and where it came from. Without this, one team's bad lesson reaches every agent in the company.

#### CD5. Memory poisoning defence [shipped first slice (connector ingest), schema v48; rest open]
Anyone who can write a PR comment, an issue or a chat message can try to plant instructions that become a "lesson" for every agent. Treat ingested text as untrusted: provenance-weighted admission, instruction-like content detection, quarantine for lessons from outside contributors, and approval (CD4) before org-wide reach. Enterprise security reviews will ask about this first.
**Shipped (first slice):** GitHub and Slack connector text is marked untrusted and screened by `src/instruction-detect.ts`; a flagged row is stored under the restricted scope `quarantine:private:<original>` (so every existing default-deny site hides it) with a pending row in `memory_quarantine` (v48) and a `quarantine` audit event. An admin releases it with `hippo quarantine approve <id>` or `POST /v1/quarantine/:id/approve` (scope restored), or keeps it hidden with `reject`. Quarantined rows cannot be shared and take no part in conflict detection. Local single-user writes are untouched. **Open:** HTTP/MCP member `remember` is not screened; no provenance-weighted admission (author association); derived rows built from a quarantined row keep its scope and are never released; no re-screen of rows stored before v48; rejected content is not tombstoned (AT1); no CD4 approval UI; the detector is regex-only, so a polite paraphrase gets through. Plan: `docs/plans/2026-09-26-cd5-poisoning-defence.md`.

**Workflow adoption [planned].** CAE5 uses `build-eval` to review independently labelled poisoning/legitimate-content cases and hard-policy regression fixtures. An optional detector/instruction `hillclimb` is a separate surface; it cannot edit ACLs, quarantine access, labels or release rules to improve an aggregate score.

#### CD6. Admin dashboard [planned; part of A7 observability] [commercial repo]
One place for the buyer: what is stored per team and repository, who used what, audit log search, dormant and banned memories, and token cost from the TE0 ledger.

**Native skill follow-up [planned].** CAE9 reuses this commercial admin surface for evidence-backed promotion exceptions, version/status, managed rollout and rollback. Keep routine developer use automatic after the admin's policy setup and include administrator effort in the pilot result.

#### CD7. Value report for buyers [planned, needs TE5; part of A7]
A monthly report per company: memories used, repeated errors avoided, tokens hippo spent, and, once a CD11 holdout or EI12 has measured it for that company, cost per session and per merged PR with and without hippo (CD12). No saving figure before it is measured (non-goal 16).

**Business-outcome follow-up [planned].** EI15/CD14 extend this report with agreed customer outcomes; EV9 verifies automatic population after initial configuration. Existing cost and guardrail reporting remains independently defined.

#### CD11. Shadow holdout [commercial repo] [planned, next after TE5's pilot run; design in `docs/plans/2026-09-24-buyer-kpis.md`]
A setting, `holdout.rate`, makes a deterministic share of sessions (or of developers) skip memory injection while capture continues. Each holdout is logged, so a pilot measures hippo against a live control group on the same days, models and people.

**Workflow adoption [planned].** Use CAE5 to `build-eval` development fixtures for control assignment, capture/injection separation and leakage checks. This is eval design and correctness work; live controls, randomisation and shadow-holdout outcomes remain outside `hillclimb`.

#### CD12. Agent telemetry join and pilot report [planned, with CD11] [commercial repo]
`hippo report --pilot` joins hippo's ledger with the agent's own cost data by session id, computed inside the customer's network:
- **Claude Code:** its OpenTelemetry export or its organisation usage API.
- **Copilot and Cursor:** per-developer usage.

It reports, per arm with intervals:
- cost per session and per merged PR;
- read-token share;
- repeat-error rate;
- guardrails;
- hippo's own cost.

**Workflow adoption [planned].** Use CAE5 to `build-eval` trace/usage joins, missing telemetry, arm-specific failures and report recomputation from raw records. Keep the buyer report and metric definitions independent of candidate selection; no `hillclimb` of reported savings or denominators.

#### CD13. Failure-signature log [shipped, schema v46]
Every failure signature seen is logged with its session, including skipped and duplicate ones, so repeat-error rate can be computed per arm.

**Status:** the `failure_log` table records every failure the capture-error hook sees: outcome, session, tool, the routine rule that skipped it, and two hashes of the error, never its text. `failuresBySession` (`src/failure-log.ts`) is CD12's per-arm input. `hippo failures` prints counts, not a rate, until CD11 gives it a holdout arm. Only Claude Code feeds it. The definition, and its known biases, are in `docs/plans/2026-09-24-buyer-kpis.md`.

#### CD14. Customer-specific business-outcome reporting [planned; EI15, CD7/CD11/CD12, EI12, Z0/Z12; added 2026-10-02] [commercial repo]
Extend the existing buyer report with the customer's agreed outcomes, alongside total cost and quality. Report at task/project/team level so successful approaches and reusable lessons can be assessed in their working context.

- Select applicable metrics from EI15's contract, such as resolution time, accepted deliverables, escaped defects, review/rework and independently measured human supervision. Define eligibility, denominators, task mix, observation windows and source coverage before scoring. Include unresolved/abandoned work, reopened or reverted results, delayed outcomes and explicit unknowns. A passing check, accepted artifact and business result remain distinct measurements.
- Count Hippo's extraction, inference, maintenance, retry and administration costs as well as agent spend and latency. Preserve quality and no-lesson guardrails; lower tokens alone cannot establish value. Measure active human time in a registered human pilot, never infer it from synthetic turns or convert token savings into assumed revenue.
- Register a fresh tenant study using EI12/CD11 and Z12's shared-memory contamination controls. Choose an appropriate task/project/team assignment unit and independent outcome checks; do not treat overlapping memory across arms as an independent control. Existing locked registrations remain unchanged. CAE5 may help design development fixtures, but reported metrics, live controls and confirmation data remain outside hillclimb.
- Make each report recomputable from permitted evidence with metric versions, coverage, arm sizes and intervals. Separate observed outcomes from causal estimates; publish null results and harm as well as improvement. Surface evidence-backed approaches and contributions without an automatic employee ranking. MSG1-MSG6 keep public wording within the measured scope.

**Exit.** A design-partner report reproduces the agreed business metrics and total costs from source evidence, with a valid comparison or an explicit descriptive-only verdict. Missing evidence cannot become a zero, a success or a savings claim. Benefit/default claims still require the applicable Z0/H4 gates.

#### CD8. Reliability of the central server [merged into EI10]
Backup and restore, high availability, disaster recovery, upgrade and schema-migration runbooks, and monitoring for the company-hosted server.

#### CD9. Company and commercial basics [next, founder task; see the Company section below, which also takes EI14]
IP assigned to the company; a contributor licence agreement for outside contributions; an open-core licence decision (local single-developer hippo stays free and MIT); pricing (per seat or per organisation for the company server); a support promise; a security pack (penetration test, software bill of materials, data flow and subprocessor list).

#### CD10. Agent-friendly install [first slice shipped in PR #227]
The platform lead's first move is to ask an agent to install hippo, so install and verification must work without a human reading docs.
- **Shipped:** `hippo doctor [--json]` (read-only health check; every warn or fail names its fix; exit 1 on failure); `npx -y hippo-memory mcp` creates the global store on first use instead of failing; `llms-install.md` (install, wire in, verify, written for agents; linked from README and `llms.txt`); `.claude-plugin/marketplace.json` (validated with `claude plugin validate`, installed from a scratch home); `server.json` and `mcpName` for the official MCP registry; the README's MCP tool list matched to the server by a test.
- **Remaining:** publish to the MCP registry after the next npm release; VS Code and Copilot detection in `hippo init`, writing the user's MCP config (check VS Code's current config format first); a first-run "here is what I learned from your repositories, approve?" report, built as the first surface of AT4/CD4 and respecting the DF4 admission filters.
- **Downgraded:** `hippo rollout` (an org bundle generator) waits for EI10 and EI11; it has nothing to package before them.

**Workflow adoption [planned].** Use CAE5 to `build-eval` clean-checkout install/doctor tasks with executable success checks. A later `hillclimb` may tune installation guidance only; preserve installer behaviour, trust settings and the supported-runtime checks.

### Sequencing
Superseded by the 90-day queue below.

### What not to build
A second Copilot, chat UI or code assistant; anything that needs developers to change how they work; per-developer setup steps a platform team cannot automate.

### Company (founder track, not engineering; review 2026-09-24)

What a VC or an enterprise buyer checks that code does not answer:
- **Design partners:** a target of three, with letters of intent, and a pilot success metric agreed up front: a TE5-style result on the partner's own history (was EI12).
- **Activation without telemetry:** hippo promises no telemetry, so measure activation through design partners and voluntary `hippo doctor --json` reports, never a default-on beacon.
- **Competitive map:** Mem0 (including its AWS Strands memory-provider deal), Zep, Letta, Copilot Memory, Augment's context engine and Tabnine, with what each does that hippo does not and the reverse.
- **Security and support:** a `SECURITY.md` vulnerability-disclosure policy, a support and incident promise, and documented data export (`hippo export`) and uninstall paths. A solo founder is itself a buyer risk, so write down the continuity plan.
- **Legal and commercial (was CD9):** IP assigned to the company, contributions under DCO sign-off with no contributor licence agreement (MIT in, MIT out), the open-core line (README "Open source and commercial") (the local single-developer core stays MIT), pricing experiments, and the hosted-SaaS (A10) decision with data residency.
- **Compliance (was EI14):** SOC 2 Type II needs an observation period and outside audit fees (tens of thousands of dollars; an estimate, not a quote), then ISO 27001 and 42001. Funding-gated.

### Evidence check: does the lifecycle moat hold? (review 2026-09-24)

The 1.45.0 mechanism audit (`docs/evals/2026-09-23-mechanism-audit-result.md`, E1 matrix at 20 seeds plus LongMemEval lanes, pre-registered) is the best evidence to date on the thesis these Parts lean on:
- **The default 7-day decay loses badly on E1:** current-fact recall 29.2% against plain BM25's 77.6% (-48.4 pp).
- **A 365-day half-life nearly matches BM25** (-2.9 pp).
- **The lifecycle's clear win is suppressing known-bad memories:** trap persistence 25.7% against BM25's 73.9%.
- **Outcome feedback and retrieval strengthening each help.**
- **Physics hurts:** -22.2 pp hit@5 on LongMemEval.
- **Sleep's merge and dedup fall below the 3 pp floor.**
- **Update 2026-09-28, release confirmation on 1.52.3** (`docs/evals/2026-09-28-e1-release-confirmation-result.md`, fresh seeds 121-160): marked-wrong memories now sit in the top five 0.0% of the time against BM25's 71.9%, but BM25 plus the same outcome nudge (one score multiplier) also reads 0.0% and retrieves current facts 6.5 pp better than the full lifecycle. Against plain BM25, current-fact recall shows no measurable difference. The known-bad win belongs to outcome feedback, which plain BM25 gets from the same nudge.

What follows for this roadmap:
- **Pitch the moat as "memory that learns what is wrong and stops repeating it"**: outcome-driven suppression, learned lifecycle (Track LC). Not a fast forgetting curve.
- **Two defaults are decisions for Keith, backed by the audit:** the default half-life (7 days vs 365 or adaptive), and physics. PR #227 turns physics off by default; that change should be accepted or reverted explicitly at merge.
- **Dormant memories (PR #227) soften the cost of fast decay,** because faded memories stay restorable. They do not fix ranking, which is the half-life decision.
- **The audit ran on pre-release code;** re-running it on 1.45.0 is listed in its own NOT-DONE and belongs in the queue.
- **The paper (E1, hippo-paper) now has its registered result.** See the queue.

### 90-day queue (all of Parts VII-X; review 2026-09-24)

**Historical schedule, superseded for execution.** Preserve the item record and completed decisions; the [current execution index](#current-execution-index) and redesigned Z0 stage order govern new work. The week ranges below are not current delivery commitments.

Each Part's own "0-3 months" added up to about 16-20 weeks of work against 13 calendar weeks. One queue for a solo founder, in order:

1. **Weeks 0-4:**
   - Review and merge PR #227.
   - Decide the half-life and physics defaults on the audit evidence. **Done 2026-09-24:** 365 days, pre-registered and confirmed on fresh seeds (`docs/evals/2026-09-24-decay-default-result.md`); physics off.
   - Re-run the mechanism audit on release code.
   - CD1 agent plugin: first check that VS Code's hook accepts `additionalContext`.
   - CD10 remaining: registry publish with the next release.
   - Rename the TE5 stale-memory arm.
   - Run a 10-task TE5 pilot on the founder's machine to price the full run.
   - Company basics: IP assignment, `SECURITY.md`, licence decision.
   - Trajectory ingestion for TE10 (VibeMemBench), so hippo can run as soon as the benchmark is released.
   - Verify automatic capture on the founder's machine (`docs/dogfood/2026-09-24-verify-auto-capture.md`): hooks, a real `/compact`, a real tool failure.
   - Fix the write path's per-write cost, which grows with store size (measured below).
2. **Weeks 4-8:**
   - EI2 permission-aware recall, with derived-memory negative tests.
   - CD5 poisoning defence with AT3 quarantine.
   - The TE5 scored run, if the pilot's cost per task fits the budget.
   - TE11 DolphinBench: register the protocol, build the harness adapter (read-only recall, dated clock), then run one persona, Built-In and hippo, to check the Built-In row and price the full run.
   - The E1 paper write-up with the audit's results.
3. **Weeks 8-13:**
   - The first design partner:
     - EI10's VPC tier and EI11's OAuth and registry entry (CD2), scoped to what that partner needs;
     - the AT4/CD4 review queue's first surface (the first-run approve report);
     - the TE3 LongMemEval run.
   - The TE11 scored run, if the pilot's cost fits the budget.

**Not in these 90 days:**
- EI3-EI7, except what a design partner needs;
- CD3, CD6 and CD7 beyond the token ledger;
- TE6-TE9, EI9, EI13;
- `hippo rollout`;
- compliance certification.

### Capture and scale findings (2026-09-24, measured)

**Automatic capture.** A real Claude Code `/compact` against hippo's hooks in a sandbox showed four things:
- `hippo pre-compact` fires on compaction and saves the task snapshot.
- Its rule-based mining stored Claude Code's own `/compact` boilerplate as a memory. Fixed: compact summaries, meta lines and slash-command lines are skipped.
- It missed a decision phrased "we use pnpm, never npm, because…": clause bounding cuts the sentence and both halves fall under the quality floor. Still open; better bounding or opt-in LLM extraction is the fix, measured with TE5.
- `hippo init` never added hooks a newer hippo introduced when `CLAUDE.md` already held the hippo block. Fixed.

Failed-tool capture now ships through both install routes as `hippo capture-error`. It skips routine failures, stores repeats once, and marks what it stores `observed`.

**Scale.** One store, 10,000 memories of about 180 characters, measured on the sandbox:

| What | Result |
|---|---|
| Database size | about 1.2 KB per memory; about 2.2 KB including markdown mirrors |
| Recall | 0.58 s |
| Per-prompt hook | 0.28 s |
| `hippo sleep --dry-run` | 76 s |
| One write | about 50 ms at 10,000 memories, 18 ms at 2,000; 14 ms and 9 ms after `perf/write-path-cost` |

- **Size is not the constraint:** a million memories is about 1.2 GB, well within SQLite.
- **The cost of one write grew with the store:** every write rebuilt `index.json` from the whole database, and a full-text delete scanned every row. Both are gone in `perf/write-path-cost`; what growth remains is the store open every command pays (`docs/evals/2026-09-25-write-path-cost.md`, "After the fix").
- **Many paths load every memory:** consolidation, and duplicate checks in capture and remember.
- **SQLite allows one writer at a time:** fine per developer; for a company-wide server it is why A6 (Postgres) and EI10 exist.
- **Fixes, before a design partner's store reaches that size:**
  - make the index mirror incremental or optional;
  - move duplicate checks to indexed queries;
  - bound sleep's candidate set.

  This is where A9 (scale to 1M+) starts.

---

## Part XI - 2026-09-24 update: memory for self-improving agents (Track SI)

**Question.** Agents that improve themselves come in three kinds:
- they learn lessons at run time (Reflexion, ExpeL, Dynamic Cheatsheet, Agentic Context Engineering);
- they rewrite their own harness (RRSI, arXiv 2609.24972; Darwin Gödel Machine);
- they update their weights.

The first two need a store of attempts and lessons that remembers what worked, forgets what did not, and does not believe its own mistakes. That is hippo's design. The third is out of scope. The paper citations above are from memory, except RRSI's (read through its README and write-ups); re-check them before quoting.

**What hippo already has for this.**
- **Error capture:** `hippo capture-error` and compaction capture.
- **Outcome feedback:** a memory marked bad stays in the top five 25.7% of the time, against 73.9% for BM25. This is on E1 only, and it is E1's best case.
- **Trust levels and supersession.**
- **Rejection tombstones:** `hippo reject`, so a wrong lesson stays out.
- **Recoverable history:** the dormant store and the audit log.
- **Budgeted recall and the token ledger.**
- **Strategy traces:** `hippo trace record --outcome` and `hippo recall --outcome success`, a small skill library.

**Earlier items this track builds on.** Part IV's LC track learns from outcomes:
- LC1, retrieval traces: shipped;
- LC2, a learned keep/forget scorer: shipped, opt-in;
- LC3, an outcome-trained reranker: planned, gated on about 90 days of data;
- LC4, an RL memory controller: research.

Also related: F3, reward-proportional decay (shipped), and TE8, lessons that prevent exploration. All of them make *hippo* better from outcomes, and all of them need outcome data. SI0 is what would supply that data at volume.

**The gap.** Every outcome is still marked by hand, or by the agent calling `hippo outcome`. A self-improving loop needs outcomes to arrive by themselves, and needs a lesson to prove itself before it is trusted.

#### SI0. Automatic outcome signals [planned, next; behind a flag until TE5 measures it]
Attribute real results to the memories that were in context when the work was done: the session's recalled ids, from the token ledger and `last_retrieval_ids`. Signals:
- tests that failed and then passed in the session;
- a CI run on the commit;
- a PR merged, or its review rejected;
- a commit reverted later.

Each signal is an `observed` outcome, logged with its evidence, and reversible. It runs only when the attribution is unambiguous (few memories in context, one task). It stays off by default, so the TE5 hippo arm stays as registered, until a second TE5 registration measures it.

**Workflow adoption [planned].** Use CAE5/Z2b to `build-eval` supported, unrelated and ambiguous outcome signals against delivered evidence. Any later extractor/classifier `hillclimb` preserves unknowns and attribution rules; automatic writes remain gated by SI0 validity and a separate task registration.

#### SI1. Attempt archive for harness tuning [research; after TE5]
The RRSI experiment. Replace RRSI's edit history with hippo:
- each proposed change is a memory holding its hypothesis, score change and verdict;
- failed changes are marked bad;
- the proposer recalls similar past attempts before proposing.

At an equal budget, measure how often failed ideas are retried and the held-out score, against RRSI's plain log. This needs RRSI's code to be public. A plain log may be enough when the history is small; hippo has to beat it, just as it has to beat BM25.

**Workflow adoption [planned].** Use CAE5's retained attempt histories to `build-eval` repeated failed ideas and proposal quality against a plain log at equal budget. Freeze any memory-assisted proposer before fresh confirmation; the separate RRSI comparison still needs public code.

#### SI2. Lessons earn trust on held-out work [research; after SI0 and EI12]
RRSI's rule, applied to lessons:
- an auto-captured lesson is `observed` until it has helped on tasks other than the one it came from: positive outcomes from at least two tasks, or a replay delta from TE4 or EI12;
- a lesson that stops helping fades to dormant;
- this also carries the minimum-effect floor for the next TE5 registration.

This is the evidence AGENTS.md requires before a lesson graduates.

**Procedural follow-up [planned].** CAE9 applies this trust gate to workflow/skill promotion: repetition, confidence scores and absence of correction are not independent evidence of usefulness. A lesson-derived executable artifact has its own validation, scope and invalidation record.

#### SI4. Write contract for agent-written memories [planned, eval first; added 2026-09-26]
Clean a memory when it is written instead of ranking junk out later. Each agent-written memory must be:
- one self-contained subject, readable without its thread;
- free of raw ids, transcript tags and bare name stubs;
- tagged with an existing tag when one covers the subject, so near-synonym tags stop multiplying.

The source is the `MemoryDoc` schema in supermemory's company-brain (`src/brain/memory/writeback.ts`). `hippo capture` already stores trailing transcript tags as facts, so it is the first place to apply this. **Eval first:** run the contract over a copy of the founder's store and report the share of memories it would reject or rewrite, then check recall on E1 and TE3 does not drop. Ships only if both hold. The rule-based check goes first; a Jev judgment is the opt-in second arm for the "self-contained subject" test that rules cannot read.

**Workflow adoption [planned].** CAE5 joins this with S0/S6/EI1 and Z9's write guidance. Use `build-eval` to review source-to-memory labels and graders; `hillclimb` one permitted extraction prompt or capture/`hippo_remember` instruction at a time, retaining conditions, scope, provenance and the recall floor.

**Procedural follow-up [planned].** CAE9 extends the write contract to evidence-backed lesson-to-skill drafts. Validate conditions, exceptions, applicability and source links before export; routine lesson capture remains automatic where the supported runtime and existing opt-ins allow it.

**CLEF integration [planned; CLF6/CLF12, CAE10].** Add schema-bound subject-quality and source-support screening through the shared decision interface. Compare native rules, the registered Jev arm and CLEF on fresh cases; keep source support, scope, observation status and the recall floor fixed. Optional inference does not replace the source/drafting contract.

#### SI5. Distil before the host deletes [planned, after SI4]
Claude Code deletes session transcripts after 30 days by default (`cleanupPeriodDays`). Hippo distils a session only when its SessionEnd or PreCompact hook fires, so a crashed session, a session from before install, or one on a box without the hooks is lost for good. `hippo capture --backfill` sweeps transcripts older than 20 days whose session id has no capture yet and distils them. It never archives the raw transcript (Phase E6 cut: "Ingesting every raw transcript forever"). `hippo doctor` reports the host's retention and how many sessions are within 7 days of deletion with no capture. Gated on SI4, because backfilling today's capture quality would add junk faster. **Pitch, once SI4 and SI5 ship:** "Claude Code forgets your sessions after 30 days; hippo keeps what they taught."

#### SI3. Poisoning limits for self-writing agents [planned, with SI0]
An agent that writes its own memories can amplify its own mistakes. Limits:
- a per-session cap on auto-captured memories;
- auto-captured memories rank below verified ones;
- a rejected value can never come back (existing tombstones);
- `hippo doctor` reports the share of the store that is auto-captured and unconfirmed.

**What not to build yet.** Export of outcome-labelled trajectories for fine-tuning (weight updates). It carries privacy weight, and nothing shows a buyer needs it.

**Evidence gate.** No claim that hippo makes agents improve themselves until TE5 passes H1 and H3 and SI0 is measured in a second registration. VibeMemBench found most memory systems at or below memory off (TE10), so the claim has to be earned.

**Workflow adoption [planned].** Use CAE5's trust `build-eval` for poisoning, unsupported self-written lessons and rejected-value recurrence. Optional detector/extractor wording may `hillclimb`; hard caps, tombstones, provenance tiers and evidence-based promotion remain fixed.

---

## Part XII - 2026-09-24 update: Enterprise v1, the first sellable release

**Why this Part exists.** Parts VIII to XI list the enterprise work item by item, but nothing defines the release a company can buy. A gap check against the commercial playbook (kept privately by the founder) found:
- five engineering items missing from the roadmap;
- the pilot measurement (CD11 to CD13) missing from the 90-day queue.

This Part defines Enterprise v1 and lists what is missing.

**Enterprise v1, defined.** A self-hosted edition a company runs inside its own network. Kitfunso never holds customer data, so v1 needs no hosted service and no SOC 2. It is sold through a paid pilot whose result comes from the customer's own telemetry.

### Scope, in build order
Existing items are named by their IDs; new ones are EV1 to EV5 below.

1. **Evidence first:**
   - the decay default (`docs/evals/2026-09-24-decay-default-prereg.md`);
   - the TE5 pilot and scored run.

   Nothing below is sold on a claim these have not measured (non-goal 16).
2. **Trust core:**
   - EI2 permission-aware recall;
   - CD5 poisoning defence;
   - the AT4/CD4 review queue's first surface.
3. **Deployment:**
   - EI10's customer-VPC tier: Postgres, Helm, TLS, backup and upgrade runbooks;
   - the per-write cost fix already in the 90-day queue.
4. **Identity:**
   - EI11's OIDC and SAML sign-in (an identity broker is acceptable) [commercial repo];
   - OAuth 2.1 remote MCP and the registry entry (CD2);
   - SIEM export of the audit log [commercial repo];
   - SCIM can follow v1 [commercial repo].
5. **Rollout:**
   - CD1, the agent plugin an admin turns on for everyone;
   - CD10, the remaining install work.
6. **Proof in production:**
   - CD11 shadow holdout [commercial repo];
   - CD12 telemetry join and pilot report [commercial repo];
   - CD13 failure-signature log;
   - CD6's first admin view [commercial repo].
7. **Product packaging:** EV2 to EV5.

**EV1's repository comes before step 2 (review 2026-09-26).** Code published in the MIT repository stays MIT for good, so the private repository must exist before the first commercial-only line is written. EI2's per-key scope grants shipped in the MIT repository in 1.49.0 (2026-09-26), before the private repository existed, so they stay MIT. The private repository now exists (2026-09-27), and the first commercial-only item is EI11's SSO. EV1's packaging and CI can still wait until step 7. What has already shipped in the public repository (tenants, API keys, roles, scope grants, the audit log, the dashboard) stays MIT. `scripts/check-open-core.mjs` fails a PR here that adds commercial-only code by mistake.

### New items

#### EV1. Enterprise edition packaging [planned, 1w; private repository created 2026-09-27]
- **Where the code lives:** the features that stay out of the MIT core go in a separate private repository and package under a commercial licence from KITFUNSO LTD. That means SSO (OIDC and SAML sign-in), SCIM, teams, project mapping and layered roles (EV6 to EV8), the CD6 admin view, the CD11 and CD12 pilot report and telemetry join, SIEM export of the audit log, the EV2 licence check, hosted SaaS (A10), and support with an SLA. EI2's scope grants are not on this list: they shipped under MIT in 1.49.0.
- **The line:** documented in the README ("Open source and commercial"). The line is drawn by buyer: everything an individual developer or a self-hosted team needs stays MIT, including the CLI, MCP server, hooks, connectors, tenants, API keys, roles, scope grants, the audit log and the dashboard.
- **CI:** builds and tests both packages against each release of the core.

**Native improvement ownership [planned].** CAE8/CAE9 retain the shared memory engine, lesson validation/artifact lifecycle, ordinary adapters, grants and audit in MIT. Organisation administration, IdP/team/role policy, managed distribution/rollback and buyer/SIEM reporting extend the public API in this commercial package; no ECC product dependency or copied runtime is scheduled.

**CLEF ownership [planned; CLF0-CLF13].** Keep the shared decision interface, hosted/private adapters, ordinary setup, basic usage controls, lifecycle validation and core grants/audit MIT. Org identity, administrator model/egress policy, managed rollout/rollback and pilot/SIEM reporting extend the public API in the commercial package. The enterprise scaffold is not an implemented CLEF offering.

#### EV2. Offline licence keys [planned, 1w] [commercial repo]
- **The key:** a licence file signed with Ed25519 (company, seats, expiry, edition), checked offline against a public key in the enterprise package.
- **No beacon.** This keeps the no-telemetry promise.
- **Seats:** counted on trust, with an annual true-up.
- **On expiry:** a warning period, then the enterprise features turn off. Memories are never deleted or locked, so the MIT core keeps working on the same store.

#### EV3. Release artefacts a security team checks [partly shipped, 1.47.0-1.48.0]
- A software bill of materials (`npm sbom`, CycloneDX) attached to every release.
- npm provenance: done in PR #227, needs the npm setting turned on.
- A signed container image for the server tier.
- A written support window: each `stable` minor version is supported for 12 months.

**Status:** three of the four are done. npm provenance ships from 1.47.0; 1.46.0 has none. From 1.48.0, `.github/workflows/sbom.yml` attaches `hippo-memory-<version>.cdx.json` to each GitHub release: a CycloneDX SBOM of the runtime packages in the tarball, the dashboard's bundled ones included. v1.47.0's was backfilled by hand and still lists `@types/three`, which that tag had under the dashboard's dependencies. The support window is written in `docs/release-policy.md` and `SECURITY.md`: 12 months per `stable` minor from its promotion, at most one promotion a calendar quarter, and security and data-loss fixes backported as patch releases under `maint-<x.y>`. Still planned: the signed container image; there is no server-tier image to sign yet.

#### EV4. Support bundle [shipped, 1.48.0]
- **The command:** `hippo support-bundle` writes a redacted archive for a support ticket: versions, `hippo doctor --json`, config with secrets removed, recent logs, schema version and store counts.
- **Never included:** memory content, unless the customer adds it explicitly.

**Status:** `hippo support-bundle` writes one JSON file rather than an archive, so the customer can read it before sending it. It holds versions, `hippo doctor`'s report, each store's schema version, file sizes and table counts, the effective config with secret fields redacted, the names (never the values) of the environment variables hippo reads, and the log files' names and sizes. It opens each store read-only and reads no memory text. Log lines are the explicit opt-in: `--include-logs` adds the last 200 lines of each log with known secret shapes removed, and those lines can quote memory text. `hippo doctor` became read-only in the same release, since the bundle embeds its report.

#### EV5. Admin documentation and security overview [planned, 1-2w]
- An install, upgrade and rollback guide for the server tier.
- A one-page data-flow diagram: what is stored, where, what leaves the network (nothing by default), and which model sees what.
- A security overview that answers a standard questionnaire: CAIQ Lite or SIG Lite.

#### EV6. Teams and departments [planned, added 2026-09-29, after SSO and SCIM] [commercial repo]
- Users and groups arrive from SSO or SCIM (Okta, Entra) as first-class objects. Today EI2's grants attach to one API key, so a 40-person department is 40 grants and a new joiner inherits none.
- A scope grant attaches to a group; a member gets it through the group and loses it on leaving.

#### EV7. Project-to-team mapping [planned, added 2026-09-29, needs EV6 and Z9 item 7] [commercial repo]
- An admin maps a repository or project to a team, and memories written there land in that team's scope with no per-write choice.
- Needs every memory tagged with its project in the core first, Claude Code imports included (Z9 item 7, MIT).

**Native skill follow-up [planned].** CAE9 applies the admin's project-to-team mapping to governed artifact distribution with no per-write/per-developer scope picker. Membership and source permission are checked at delivery; this extension waits for the project's identity/scope tagging and group support.

#### EV8. Layered roles [planned, added 2026-09-29, with EV6] [commercial repo]
- Org, team, project and scope, with roles past admin and member: editor, viewer, team admin. The A5 plan named this hierarchy (`docs/plans/2026-04-29-a5-stub-auth.md`); it was never built.
- The admin and member pair stays in the MIT core.

**Workflow adoption [planned].** Use CAE5 to `build-eval` role/action and cross-team/project negative fixtures for the enterprise implementation. Keep layered-role enforcement as deterministic correctness; no `hillclimb` of permissions or authority boundaries.

**Native skill follow-up [planned].** CAE9 adds publisher/approver/distributor actions to the planned org/team/project role matrix, with wrong-tenant, revoked-member and private-source negative fixtures. Promotion policy is admin-configured and permissions remain outside optimisation.

#### EV9. Low-touch enterprise outcome acceptance [planned; EI15/CD14, CD10, EV6-EV8, S6/AZ4-AZ6, Z10/Z12; added 2026-10-02] [commercial repo]
Extend the shared zero-touch acceptance contract to the enterprise objective, evidence and reporting flow.

- After initial install/trust and admin configuration of sources, project/team mappings and success metrics, ordinary work automatically captures lessons, correlates permitted task/outcome evidence, retrieves applicable context and populates the report. Reuse existing project metadata and provisioning; no routine user memory scoring, outcome report, per-write scope picker or remember/outcome/supersede command is required.
- Missing objectives, unavailable telemetry, ambiguous attribution and unsupported runtime events leave visible coverage gaps while ordinary memory use continues where supported. Provide actionable admin diagnostics and exception handling; do not ask every user to label each task or curate each lesson. Automatic capture, outcome writes and lesson promotion retain their existing evidence and rollout gates.
- Verify the flow across sessions and every runtime claimed for the pilot: task → permitted capture → confirmed delivery/application evidence → independently accepted result → objective/report join → useful lesson on later work. Exercise pre-compaction saves and restore, interruption/retry, duplicate events, source outage, changed objectives, reverts and revoked access. Use AZ6's runtime inventory; installation, hook registration or a saved transcript alone cannot pass.
- Register bounds for automatic coverage, write/attribution precision, recovery delay and setup/ongoing burden before the pilot. Count developer and administrator configuration, maintenance, exception review and recovery alongside Z12's task supervision; preserve task quality and report evidence gaps. Acceptance must pass without routine user scoring.

**Exit.** A design partner completes the ordinary-work acceptance path after initial configuration and receives an evidence-backed CD14 report without routine memory/outcome commands. Publish supported-runtime coverage and measured residual effort; no universal zero-touch or business-benefit claim from fixtures alone.

### Exit criteria for v1
- A design partner installs it in their network from the admin guide, with no help beyond the support channel.
- One real security questionnaire is answered with no "no" on identity, permissions or deployment.
- An outside penetration test of the server tier is done, with its findings fixed.
- A pilot report is produced from a partner's own telemetry, with a holdout group, whatever its result.

### Estimate
- **Forecast status (2026-10-02): historical, not re-estimated.** Re-scope the selected partner/source/identity/deployment, remaining work and available capacity under the [current execution index](#current-execution-index) before promising a date. Optional CLEF, skills and Computer work are not general Enterprise v1 prerequisites.
- **Engineering:** about 16 to 22 weeks for one developer working with an AI assistant, based on the item estimates above. That is longer than the 90-day queue, so v1 lands after it.
- **Cutting it to a design partner's needs** (one git host, one identity provider, one deployment shape) is the main lever.
- **Founder-track work** (IP assignment, contracts, insurance, Cyber Essentials) runs in parallel and is not engineering time.

### What the 90-day queue gains
**Historical additions to the 2026-09-24 schedule.** Retained for provenance; current priorities and dependency slices come from the [current execution index](#current-execution-index).
- **Weeks 4-8:** CD13's failure-signature log, since it is small and starts collecting the baseline early. Shipped (schema v46).
- **Weeks 8-13:**
  - CD11 and CD12, scoped to the first design partner's agent;
  - EV1 and EV2, so the pilot runs the edition that will be sold.

---

## Part XIII - 2026-09-24 update: forgetting by evidence, not by the clock (Track FE)

**Why.** The decay decision (`docs/evals/2026-09-24-decay-default-result.md`) moved the default half-life from 7 days to 365, and 365 tied with decay switched off. So the shipped default effectively removes time-based decay from ranking. 365 was not tuned, and the release notes and site should say that plainly.

Three facts drove the decision:
- **Public benchmarks cannot reward time decay.** LongMemEval and LoCoMo ingest once and ask once, so any decay can only hurt there.
- **E1 was built to reward decay, and 7 days still lost** (29% against 75%). Its one win was on facts with a newer version (cleanStaleR5 +12.6 for 7 days), but only 7.1% of the dogfood store is superseded.
- **The clock did not measure helpful.** Outcome feedback (marked-wrong suppression) did. Supersession and strengthening have not been measured on their own.

What stays open:
- No half-life between 7 and 365 was tested.
- E1's dating caveat, the lookalikes dated inside each fact's window, is untested.
- Real memories go stale when code changes, which no test models.
- At 365 days sleep practically stops deleting, which a shared server cannot run without a cap.

#### FE1. Split ranking from retention [planned]
- **Ranking:** uses outcomes, supersession and strengthening. Time applies only as a tie-break among competing versions of the same fact, not as a penalty on every memory.
- **Retention:** deletion and dormancy are decided by value (never recalled, never confirmed, low outcomes), not by age alone.

#### FE2. Staleness from code churn [built, opt-in: `churnStaleness.enabled`, default off]
A lesson that names a file, symbol or command is marked stale when that file changes or is deleted after the lesson was stored. It builds on `src/invalidation.ts`. Staleness lowers the lesson's rank and flags it for confirmation; it never deletes it.
Measured on a copy of the founder's store: 73 of 1,106 lessons flagged, 44 of them still true (60% false stale, 75% counting misattributions). File-level churn is too blunt to default on; FE3 must beat this. See `docs/evals/2026-09-26-fe2-churn-false-stale.md`.

#### FE3. Registered test of the new forgetting [planned, before FE1 or FE2 ship as defaults]
**E1 on fresh seeds (61 to 80),** with these arms:
- full@365, the current default;
- full@30 and full@90, the untested middle;
- version-aware recency (FE1);
- event-date recency (FE5);
- decay off.

It runs with the in-window dating lane as well. It also includes a **replay of real recall queries** from the founder's store: LC1 retrieval traces with their later outcomes, scored for each arm. This is the only test that reflects actual use, and it runs on the founder's machine.

**Workflow adoption [planned].** Use CAE5 to review development recency/staleness labels and replay checks with `build-eval`. Keep this registered arm comparison fixed; explore a new bounded setting separately before fresh confirmation, without tuning on its held-out seeds or changing retention policy.

#### FE4. Messaging [done 2026-09-25]
Pitch "learns what is wrong and stops repeating it", not "decay by default". "Good memory is knowing what to forget" stays only where forgetting means wrong, superseded or unused, never age.

Done in the README and the website (`website/`): the pitch leads with outcome marks and supersession, the claims that decay or sleep improve recall are gone, the 365-day half-life is labelled as not tuned, and the hippocampus framing is labelled as design inspiration.

**Precision follow-up [planned 2026-10-01]:** Part XIX, Track MSG covers the next wording amendments for both editions. FE4's completed copy pass is historical; the new amendments are not implemented yet.

#### FE5. Recency by event date, not save date [planned, eval first; added 2026-09-26]
The mechanism audit found recency hurts current-fact recall but guards against stale facts. Part of the cost may be that recency counts from when a memory was saved, not from when its fact became true. `valid_from` already exists, but it defaults to `created` and only filters `--as-of` queries; it never ranks. The arm: fill `valid_from` from the date a memory states (a decision, deadline or incident), then apply recency to that date. It runs as an FE3 arm on E1. Ships only if it keeps the stale-fact guard without the current-fact loss. Idea from supermemory's company-brain, whose writer records an `eventDate` for dated memories.

---

## Part XIV - 2026-09-25 update: hippo on Kubernetes (Track K8)

**Identifier migration (2026-10-02).** Kubernetes items now use K8.1-K8.8; PKM keeps K1-K6. Legacy bare K1-K8 references mean the old Kubernetes item only when qualified by this track. Old Kubernetes heading anchors remain as aliases; use the new IDs in current work. Historical research and evaluation records are unchanged.

| Legacy Kubernetes reference | Current initiative ID |
|---|---|
| Kubernetes/K1 | K8.1 |
| Kubernetes/K2 | K8.2 |
| Kubernetes/K3 | K8.3 |
| Kubernetes/K4 | K8.4 |
| Kubernetes/K5 | K8.5 |
| Kubernetes/K6 | K8.6 |
| Kubernetes/K7 | K8.7 |
| Kubernetes/K8 | K8.8 |

**Why.** EI10 lists Helm as one line of the VPC tier (line 1331) and nothing is built. The research round (`docs/plans/research-k8s-web-2026-09-25.md`, `research-k8s-papers-2026-09-25.md`, `research-k8s-code-audit-2026-09-25.md`) found three things:
- **No direct memory competitor ships a Helm chart.** Mem0, Zep/Graphiti and Letta stop at Docker Compose, and Mem0 has an open issue asking for one. Cognee and the community Chroma chart ship single-replica and say so plainly. That is the posture to copy.
- **There is named demand.** kagent (CNCF Sandbox) has an open issue asking for a memory service (#1256). HolmesGPT and k8sgpt show no memory across incidents.
- **The papers favour one governed service over many independent sidecars.** Kernel-Managed Shared Memory (arXiv 2609.10144) beat unmanaged sharing on both quality and latency. Governed Shared Memory (2606.24535) names four fleet failure modes: leakage, staleness, contradiction and provenance collapse.

**The constraint that shapes everything.** SQLite has one writer, and SQLite's own docs say WAL does not work on a network filesystem. Until A6 (Postgres) ships, the only sound shape is one `hippo serve` process per store:
- a StatefulSet with replicas fixed at 1;
- a `ReadWriteOncePod` volume on block storage, because plain `ReadWriteOnce` is per node and lets two pods overlap during a rollout;
- no NFS, EFS or Azure Files.

**Non-goals until A6.** No multi-writer SQLite (LiteFS, Marmot and cr-sqlite have had no release for 17 to 24 months). No operator or CRD of our own. No hippo-run cluster, since hosting costs money.

<a id="k1-make-the-container-honest-planned-first"></a>

#### K8.1. Make the container honest [planned, first]
The code audit found gaps that break any pod today, some of which break `deploy/aml` already:
- **The image has no local embeddings.** `@huggingface/transformers` is only in `peerDependenciesMeta` (`package.json:86-93`), so `npm ci` in `deploy/aml/Dockerfile` never installs it, despite the header comment. Install it pinned in the image and bake the model in with `scripts/fetch_embedding_model.mjs` at the `HIPPO_MODEL_CACHE` path.
- **A missing model fails silently.** `src/embeddings.ts:219-227` returns null on a load failure, so a pod runs with embeddings quietly off. Log it and fail `/ready` instead.
- **No readiness check.** `/health` never touches the database (`src/server.ts:754-770`). Add `GET /ready` with a cheap DB round-trip; `/health` stays the liveness check.
- **The image runs as root** and drops privileges with `setpriv` (`deploy/aml/entrypoint.sh:18-21`), which the `restricted` Pod Security profile rejects. Add a `USER` directive and use `fsGroup` on the volume.
- **Shutdown kills in-flight writes.** `closeAllConnections()` runs before `server.close()` settles (`src/server.ts:3466-3499`). Stop accepting new requests, let in-flight writes finish, then force-close SSE streams only.
- **No request log.** Add one JSON line per request to stdout: method, path, status, tenant, latency.
- **No way to create the first key at install.** Add a post-install Job that runs `hippo auth create --role member --json` and writes the key into a Kubernetes Secret, never to a log.

**Success:** the image boots under `restricted`, embeds with no network, and `/ready` goes false when the volume is missing.

<a id="k2-single-replica-helm-chart-planned-after-k1"></a>

#### K8.2. Single-replica Helm chart [planned, after K8.1]
- **Chart shape:** a StatefulSet on a `ReadWriteOncePod` volume, `HIPPO_HOME` and the model cache on that volume, and `HIPPO_REQUIRE_AUTH=1` always paired with `--host 0.0.0.0` (the server refuses the bind otherwise, `src/server.ts:3354-3360`).
- **Values and secrets:** `values.schema.json`, `existingSecret` for keys, optional NetworkPolicy.
- **Security:** a `restricted` securityContext (non-root, `RuntimeDefault` seccomp, no privilege escalation, read-only root filesystem).
- **Docs:** state the single-replica limit and the block-storage requirement at the top of the chart README.
- **Publishing, all free:** an OCI chart on GHCR, the image signed keyless with cosign, a BuildKit SBOM.

**Success:** `ct install` passes on a local kind cluster (kind runs Kubernetes inside Docker, free). The same check runs in CI once GitHub Actions billing is back.

<a id="k3-consolidation-that-cannot-collide-planned-with-k2"></a>

#### K8.3. Consolidation that cannot collide [planned, with K8.2]
`/v1/sleep` is loopback-only (`src/server.ts:1247-1263`), and the `hippo sleep` CLI does not check for a live server on the same store (`src/cli.ts:3144-3177`). A separate CronJob pod would therefore open the same database as a second writer.
- **Chart side:** run the schedule as an in-pod cron that calls `127.0.0.1/v1/sleep`, never as a separate CronJob pod.
- **Code side:** give `hippo sleep` the same `detectServer` guard that `serve` has, and refuse to run while a server holds the store.
- SSGM (arXiv 2603.11768) ties drift and leakage to consolidation that has no check before it writes. The sleep run keeps its audit-log row and goes through the conflict checks that already exist.

<a id="k4-backup-and-restore-with-litestream-planned-after-k2"></a>

#### K8.4. Backup and restore with Litestream [planned, after K8.2]
Litestream (v0.5.17, Aug 2026) is the only maintained tool built for this shape. It runs as a native sidecar (GA since Kubernetes v1.33) that streams the WAL to any S3-compatible store, and an initContainer restores the database on first boot. It is an optional value, off by default. This is also EI10's missing backup and restore runbook.

**Success:** delete the volume, reinstall, and the store comes back with the same memory count.

<a id="k5-sidecar-recipe-for-one-agent-planned-docs-only"></a>

#### K8.5. Sidecar recipe for one agent [planned, docs only]
A pod example with hippo as a native sidecar next to an agent, on its own volume, reached over localhost. It is for a single agent or a dev loop. Two limits go in the doc:
- the sidecar still needs a key, because the loopback admin fallback (`src/server.ts:645-658`) would give every container in the pod admin rights;
- fleets use K8.2's shared service, which is the governed shape the papers favour.

<a id="k6-mcp-ecosystem-listings-planned-near-zero-code"></a>

#### K8.6. MCP ecosystem listings [planned, near-zero code]
- `deploy/toolhive/mcpserver.yaml` using ToolHive's `MCPServer` resource (`toolhive.stacklok.dev/v1beta1`, streamable-http transport).
- A listing on the MCP registry (registry.modelcontextprotocol.io), which points at the npm package.

Both are discovery, not new plumbing. The registry submission is outward-facing, so Keith approves it before it goes.

<a id="k7-incident-memory-for-kubernetes-sre-agents-planned-after-k2"></a>

#### K8.7. Incident memory for Kubernetes SRE agents [planned, after K8.2]
A thin integration, not new plumbing:
- the agent calls `hippo remember` when an incident is resolved (root cause, fix, affected resources, outcome);
- it calls `hippo context` before a new investigation;
- the tenant is scoped per cluster or namespace.

The first target is kagent (#1256), then HolmesGPT. The papers say to store procedures and fix outcomes, not raw incident text: Flow-of-Action (arXiv 2502.08224) raised root-cause accuracy from 35.5% to 64.0% with standard operating procedures.

Write-time checks are required before any shared fleet. MINJA (2503.03704) poisons memory with only ordinary query access, and AgentPoison (2407.12784) succeeds over 80% of the time at a poison rate under 0.1%, which aggregate monitoring does not catch.

**Success:** a result on AIOpsLab (2501.06706) or ITBench (2502.05352), whose baseline agents resolve 13.8% of SRE scenarios. It uses hippo on against hippo off, the same prompt, and scenario hints stripped. That last part is the Graph Traversal Agent lesson (2606.08590), where a reported gain mostly vanished once the hints were removed. No accuracy claim ships before that ablation.

<a id="k8-size-from-measurement-then-scale-via-a6-planned-last"></a>

#### K8.8. Size from measurement, then scale via A6 [planned, last]
Resource requests come from profiling hippo's own write, recall and sleep phases (the harness shape in arXiv 2606.06448), not from guesses. Total Recall at What Cost (2608.11879) found serving cost could not be predicted from conversation length. Two limits apply:
- the rate limiter is an in-memory map per process (`src/rate-limit.ts:40-42`), so N replicas would allow N times the configured rate;
- more than one replica waits for A6 and EI10, with Postgres and shared rate-limit state.

**Order:** K8.1, then K8.2 and K8.3 together, then K8.4, K8.5 and K8.6, then K8.7 and K8.8. K8.1 is worth doing even if no chart ever ships, because `deploy/aml` has the same gaps.


---

## Part XV - 2026-09-26 update: zero-touch memory (Track Z) [top priority]

> **Default freeze (2026-09-30).** Track S and Track AZ behaviour changes ship behind explicit flags. Defaults change only after the retrieval floor in Part XVI holds and a valid, preregistered Z0 task-family result shows benefit, with G1-G5 and H4 explicitly passing. Instrumentation and connector plumbing may ship on their correctness and overhead checks; neither establishes task benefit. This policy preserves the existing Z0-Z9 record and does not amend a locked preregistration.


**Why.** Users prompt; they do not call hippo. Any mechanism that needs a command is, in practice, off. Two facts from source and data:
- **The per-prompt hook never reads the prompt.** `UserPromptSubmit` runs `hippo context --pinned-only --include-recent 5` (`src/hooks.ts:138`): pinned rules plus the five newest memories, whatever was asked. The SI0 kill test measured the result: injected memories had a median overlap of 0.057 with the work.
- **The best measured mechanism is manual.** Outcome feedback (a memory marked wrong stops coming back) is the one lifecycle mechanism that clearly helped in the audit, and it runs only when someone calls `hippo outcome`.

**Goal.** Remember the right thing, surface it when it bears on the prompt, and stop the same mistake from happening twice, with no command from the user. Personal and company stores run the same loop.

**Order is load-bearing.** Z0 comes first and is the scoreboard for every later item. Z2 cannot credit memories until Z1 makes injections relevant; Z4 needs Z2 and Z3 to know which lessons were ignored.

**Cross-agent reliable recall [priority; added 2026-09-29].** Z0 and Z1 must prove the memory reaches the agent doing the work, not only that a search command can return a plausible hit. This is one retrieval and admission contract with small runtime adapters, not a separate ranking policy for each agent. Cover Claude Code, local Codex CLI and desktop chats, Cursor, OpenClaw, OpenCode, Pi, and generic MCP clients; record cloud sessions separately under Z8. An agent without a usable hook must have an explicit, tested MCP or instruction-file route. An installed wrapper or an `AGENTS.md`/`CLAUDE.md` reminder alone is not proof that recall occurred.

- **Discover the right store.** A repository session finds its project store and eligible global memories; a projectless session can reach the global store. A missing project store reports a clear fallback or failure, never silently looks empty. Test from the working directory each runtime actually uses, including nested directories and worktrees. A projectless Codex desktop chat on 2026-09-29 could read the home store only after changing the CLI working directory; its normal `hippo recall` failed with "No hippo store".
- **Admit the right memories.** Project identity and source scope filter candidates before ranking; another project's facts, private entries and secrets do not enter the automatic context without an explicit authorized cross-project request. Legacy entries with no project identity need a stated admission rule. Superseded, rejected and invalidated facts cannot silently appear as current instructions. Keep this linked to the committed scope-isolation item in Part I and the existing scope tests in `TODOS.md`, not a second scope implementation.
- **Retrieve for the task.** Supply the prompt, task state or failing tool output through the runtime adapter to the shared recall path, then apply a measured relevance gate and token budget. Retain an agent-initiated `hippo_recall` path where push is unsupported or unhelpful. Z1's prompt and tool-output arms failed their gates; do not turn them on by default to claim coverage. Test a task-specific expected memory, a plausible wrong memory, and a no-match case for every runtime.
- **Prove delivery and benefit.** For each runtime, run an end-to-end session fixture that records which store was searched, which memory IDs were admitted, what the agent actually saw, and whether the agent used or ignored them. Include install/trust/update and opt-out states, projectless and project sessions, and sub-agents where supported. Publish a pass/fail matrix by runtime and compare against the memory agents already have on Z0's task set, including wrong-project exposure, useful recall, repeated mistakes, latency and tokens. Do not claim "works across agents" until every named runtime passes its supported local path; list unsupported cloud paths under Z8.

**Implementation progress.** This episode fixes projectless CLI store discovery and adds a Codex projectless installed-hook fixture. Context and CLI fallback continuity separate global memory/config availability from project task state; real-command fixtures exclude a foreign global snapshot, handoff and events. Global source labels and hook opt-out are tested. Explicit-root API/MCP scoped opt-in continuity is preserved; the boundary is recorded in `docs/decisions/2026-09-30-global-fallback-continuity.md`. Correctly scoped task recall from the global store and the remaining runtime/delivery coverage above are pending; this is not yet a cross-agent success result.

#### Z0. Prove hippo beats the memory agents already have [top priority; started 2026-09-26; redesigned 2026-09-29]
**Design:** `docs/evals/2026-09-29-z0-built-in-memory-prereg.md`. It is TE5's scored run, re-registered.

**Why the redesign.** Claude Code turns its own auto memory on by default, and Codex ships opt-in memories, so "beats no memory" answers a question no buyer asks. The first design's runner could not have answered it anyway:
- it never turned auto memory off, so the no-memory arm could keep notes;
- the hippo arm never had its `CLAUDE.md` block: init writes it only into an existing `CLAUDE.md` (`src/cli.ts:778`), and where one existed, `checkoutBase` restored the committed file before every task (`scripts/token-eval/ab-run.mjs:241-247`, `:416`, `:433`);
- tasks mined from commits, with nobody correcting the agent, gave either memory little to do;
- no arm showed whether memory could help on the task set at all.

The pilot under the first design is a runner shakedown, not evidence.

**The new test.** Lesson families built from real maintainer rules. Each is taught once, by a scripted user message (a correction, or a confirmation if the agent already complied), then needed again in later fresh sessions.

Claude Code arms:
- no memory;
- Claude Code's built-in memory;
- built-in plus hippo (the primary arm);
- a perfect-memory positive control;
- a sham hippo, with the same block and hooks but capture removed.

A Codex set teaches in Claude Code and applies in Codex. There, hippo is compared with the free route: `CLAUDE.md` importing `AGENTS.md`.

Hypotheses, Holm-adjusted. Each ends in loss, win, tie or inconclusive:
- H1: fewer repeated mistakes than built-in memory;
- H2: the lesson reaches Codex better than the shared-file setup;
- H3: fewer tokens per task.

H4 is a harm gate: hippo must cost little when nothing it holds is relevant.

**Checks before any result counts:**
- Five validity gates must pass first.
- The perfect-memory arm must beat no memory by 30 points, or the run says nothing about hippo either way.
- The analysis is blind until the gates pass.
- Sample size comes from calibration by a written rule, and an underpowered run does not start.

**Stages, next first:**
0. Runner and hippo prerequisites, as code PRs:
   - per-arm auto memory, and a Claude Code config directory per run;
   - a stub `CLAUDE.md`, and carry lists instead of the wipe;
   - teach and correction resumes, and lockstep arm rotation;
   - wider file reads, snapshot restore on retry, and the three TE5 grading checks;
   - a Codex runner;
   - hippo's Codex wrapper honouring `CODEX_HOME` (`src/hooks.ts:254`);
   - the sham-hippo shim, a memory-surface ledger, a two-level bootstrap and blind analysis.
1. Smoke, about 30 sessions. It settles two questions: does auto memory save under `claude -p` (if not, the Claude Code arms run through an interactive driver), and do Codex memories and hooks work under `codex exec`?
2. Development task set and calibration on the pilot's repositories. Then the hippo freeze tag.
3. Scored task set: authored after the freeze, blind to hippo, screened on the control arms only. Only its hash is committed until the result is published.
4. The scored run.
5. Write-up, whatever it says.

Stages 1 onward spend plan usage and wait on the founder's go. A rough guess before calibration is about 3,000 sessions at a 15-point minimum effect. The session ceiling and the minimum effect are set at that go.

**Expectation, written down first:** H1 may tie or lose. With about ten lessons per repository, Claude Code's index loads whole, while hippo's hook injects pinned and recent memories, not the relevant ones. H2 is not a gimme either: the shared-file setup is free.

**First design (superseded 2026-09-29; kept as the record).** Hippo has never been shown to beat an agent with no memory. TE5 is the test and has had no scored run. It runs real Claude Code sessions on the founder's signed-in plan, so it bills nothing; the limit is plan usage, and the full registration is about 1,200 sessions. Staged:
1. **Task set.** Draft sequences with `make-tasks.mjs --verify` from 3 repositories with commits after 2026-07-01, rewrite every prompt as a symptom, grep memories against gold patches. **Done 2026-09-26:** 28 tasks (22 scored) from hippo, project-f and project-a, in `hippo-archive/te5-pilot/` (outside the repo; its README lists every drop and each original commit beside its rewritten prompt). Harness faults found in the pilot, **fixed in #257** (2026-09-26): a failed `--setup` or a test timeout now drops the candidate in `make-tasks.mjs --verify`, and a failed setup in `ab-run.mjs` spends no session (`invalid: 'setup'`); fixtures, snapshots and `conftest.py` are written but not run, and `e2e/` specs are neither tests nor code; a scope gate skips commits with more than 4 runnable test files or 400 changed code lines, which catches 25 of the 48 tasks review dropped and none of the 28 kept (the other 23 were judged on pinned names or strings in the tests, a human review call); `ab-run.mjs` loads `dist` only for a real run, so `--dry-run` needs no build; the stale-memory arm borrows a hippo store from an earlier run of another cluster with `--donor-runs DIR`. Still open: project-f's tests run the live `.venv`, so it needs an isolated environment first.
2. **Pilot, descriptive only.** Arms `no-memory` and `hippo` (as shipped), about 20 scored tasks, 2 seeds, one model. Proposed first run: hippo and project-a only (15 scored tasks, 76 sessions), project-f after its environment is isolated. Waits on the founder's go, since it spends several days of plan usage. Outputs: resolve rate, cost per resolved task, repeated errors, seed-to-seed spread, sessions per plan window. It sizes the full run and catches harness faults. Pilot repositories never enter the scored run, so Z1 may be tuned on them. Harness faults the pilot found, **fixed in #270** (2026-09-28): `hippo init` and the hook shim ran with the operator's real HOME, so init could write the operator's `~/.claude/settings.json`, register a machine-wide scheduled task and import the operator's Claude Code memory files into the arm's store (leaking answers); hippo now runs with HOME set to the run's output dir and init gets `--no-schedule`. On Windows `ab-run.mjs` added a second `PATH` beside the existing `Path`, so a child `npm ci` lost the system path; it now prepends to the existing key. A usage-limit or overload result from `claude -p` now waits 15 minutes, resets the checkout and reruns the session for up to 24 hours, instead of recording the task as not resolved. Open: `fileReads` counts only the Read tool, so a session that reads files through shell `sed`, `cat` or `grep` records 0; widening it is a metric change for the preregistration, not a harness fix.
3. **Scored run** as registered (H1 to H4), on fresh repositories.
4. **Every Z item re-runs the same tasks** with its own `hippo` arm; an item that does not move cost per resolved task or repeated errors does not ship as a default.

**Harm from wrong memory (added 2026-09-28).** H4's harm check uses another repository's memories, so it tests irrelevant memory, which an agent can ignore. The dangerous case is an on-topic memory that is confidently wrong, and Z3 and Z6 will create some. XYEval (Google DeepMind, September 2026) added one confident, misleading hint to agent tasks with the right fix unchanged and cut scores by up to 46.7% relative; agents often doubted the hint in their reasoning, then followed it without saying so. The next registration adds a `misleading-memory` arm built the same way: one plausible memory per task that points to a wrong fix. It reports the drop against `hippo` and how often the agent follows the memory silently. Plan usage only, no paid call. **Update 2026-09-29:** the redesigned Z0 covers an on-topic lesson going out of date through its reversal families. The planted misleading memory is the registration after Z0, because built-in memory needs a planted note of its own for the arm to be fair.

**Pre-compact audit (2026-09-26, 1.46.0 on the founder's box).** The snapshot is saved and re-injected after every compaction, and 1.46's global-store fallback ended the "store not initialized" losses. Three defects remain, all before Z0's pilot so the hippo arm is not measured with them:
- **Task field is a background-agent notice** in 66 of 71 snapshots: `isNonHumanUserLine` (`src/capture.ts:648`) does not skip user lines Claude Code tags `promptSource: "system"`. Fix there; it cleans Task, Summary and extraction together.
- **Pre-compact memories are mostly junk** (2 useful of the last 45): rule matches start at the keyword and drop the subject. Stop extracting in pre-compact, since SessionEnd capture covers it and the snapshot is the product.
- **A stale snapshot can be restored** when pre-compact skips and the cwd has moved (one restore was about 25 hours old). Ignore snapshots older than about 15 minutes in `compact-resume`.
- **Fixed in #258.** Open trade: SessionEnd capture mines only the last 20 user and 10 assistant turns, so a decision stated only before a compaction and outside that tail is no longer captured. Fix the extractor before widening that window.
  - **Extractor attempt 1 (2026-09-27): no verdict, nothing shipped.** A whole-sentence rule extractor (frozen at `26444bf`) raised the held-out useful rate from 0.06 (4 of 70) to 0.48 (11 of 23) on 73 sessions, but missed the 0.60 bar, and the two blind labellers agreed on only 70% (floor 80%). The tail window stays; the whole-session arm scored 0.34. Next: tighten the rubric with worked examples and check agreement before the freeze, gate subjectless leads ("the fix is...") and subjectless agent status, then re-score on sessions after 2026-09-27. Result: `docs/evals/2026-09-27-z0-session-capture-result.md`.
  - **Extractor attempt 2 (prereg locked 2026-09-27, not yet scored).** The same extractor plus gates for subjectless leads, agent status lines, a bare "this" and glued sentences, and content-array user text. It is frozen at tag `z0-extractor-v2-freeze` and kept off master. Rubric v2 (worked examples, a decision order) got 81% to 84% judge agreement on the tune split across three rounds, up from 70%. Tune A1 scored 0.40 and 0.60 in-sample on two labellings of the same ten memories, so it sits at the 0.60 bar within labeller noise. Scored once on sessions from 2026-09-28 when 110 are eligible, around 2026-10-22 and before 2026-10-27: `node scripts/z0-capture-eval.mjs --out <scratch> --frozen-corpus <SI0 copy>`. See `docs/evals/2026-09-28-z0-session-capture-v2-prereg.md`.
- **Reversed 2026-09-29: every compaction saves memories.** "SessionEnd capture covers it" was wrong. SessionEnd fires only when a session ends, and the founder mostly leaves sessions open, so after #258 a long session could compact many times and save nothing but its snapshot. #258 and #297 (which dropped the agent's `hippo remember` line) cut back what the founder asked for without his go. The new design, built as one dev-framework-rl episode after the z6keep and session-digest branches merge:
  - pre-compact prints an instruction to the summarising model to list the session's lessons, decisions and corrections in its summary;
  - after compaction, hippo reads that summary from the PostCompact payload (from the transcript when the hook missed it) and stores each item as a memory; the summary itself goes into a compaction record, a row in its own table and not a memory row, so every compaction leaves something in the store;
  - the auto memory sync moved out of this change to PR 2, branch `feat/import-agent-memories`, which imports every agent's memories (Claude Code, Codex, Gemini CLI) on init and sleep, likely with no new table;
  - these rows are kept for good: sleep, dedupe and merge never retire or delete them. **Reversed 2026-10-03 (1.53.1):** they now fade like any other memory, and an item that restates a held memory is skipped (another session's restatement strengthens it), so a long session no longer piles up undeletable copies. Memories that back an object are what no automatic pass deletes.
  - First check, before any code: a real compaction proves the summariser follows the instruction.
  - **PR 1 built, pending merge (2026-09-29, branch `feat/compaction-saves-memories`):** the instruction, the compaction record, the item memories, the keep rule and the own-session filter. Still unmeasured: a real compaction at 250k context, where a `no memories section` log line counts the misses.
  - **Current implementation status (2026-10-02): merged on master.** The preceding branch note is the dated record. `src/capture.ts` now has `cmdPostCompact` and the real-database pre/post/replay/own-session compaction suites cover record, item and recovery behaviour. These distinguish a pre-compaction snapshot/record from post-compaction lesson extraction. This source check establishes neither universal host coverage nor the large-context live check/task benefit; those remain separate AZ4/AZ6/Z0 evidence requirements. Published-version provenance is recorded separately in [canonical product facts](docs/product-facts.md).

**Workflow adoption [planned].** Use CAE5's `build-eval` workflow to review fresh development families, controls and executable grades around the existing runner. Preserve this locked registration and stage order. Component `hillclimb` runs on separate development data before independently registered task confirmation.

#### Z1. Recall against the prompt, gated [prompt and tool-output arms failed 2026-09-26; prompt arm shipped off by default]
The `UserPromptSubmit` hook reads the prompt from its payload and recalls against it, then applies TE6's gate: inject nothing when nothing clears it. Pinned rules stay. **Test first, no paid call:** replay the frozen SI0 corpus (`hippo-archive/transcripts-since-2026-09-01/`) and report overlap with the work and tokens injected, today's hook against Z1. **Ships if** overlap rises well above 0.057 and median injected tokens do not grow. Latency budget: the hook stays under the current 0.28 s at 10,000 memories.
**Result (2026-09-26):** the lexical-overlap gate failed. Overlap stayed flat (0.0545 in both arms on the held-out split), hook p95 rose to about 0.30 s, and median tokens fell from 847 to 533. It ships behind `pinnedInject.promptRecall`, off. Next arm: a relevance judge, or recall against recent tool output, not the prompt. See `docs/evals/2026-09-26-z1-prompt-recall-result.md`.
**Second arm (2026-09-26), recall against the failing command and its error:** failed at the pick rule. No config kept median tokens at A1's, since any added block lifts a median that sits on a jump, and tune overlap peaked at 0.075 against the 0.114 bar. An exploratory blind judge on held-out found the recalled memories helped on 14 of 33 failures, against 0 of 33 for what the hook already injects. Latency fix shipped: prompt-recall p95 now about 0.21 to 0.23 s. Next: a Z1c prereg with the judge as the primary gate and a mean-token bound, on a fresh transcript window. See `docs/evals/2026-09-26-z1b-tool-recall-result.md`.
**Third arm, Z1c (prereg locked 2026-09-27, not yet scored):** the Z1b block with its config frozen from the tune split, judged on sessions from 2026-09-27 onward. Two blind judges (Sonnet and Opus, consensus) with a control and a placebo arm. Passes only if at least 30 eligible events, T helps on at least 0.30, T beats today's hook by at least 0.15 with sign-test p below 0.05, and mean tokens stay at or under 1.20 times A1's. Latency is measured only after those pass. `node scripts/z1c-eval.mjs --out <scratch>` scores it once when the window has 30 events; at the frozen corpus rate that is around 2026-10-08. See `docs/evals/2026-09-27-z1c-judge-gate-prereg.md`.
**Pull arm (added 2026-09-28, untested).** Every Z1 arm so far pushes memories into the prompt. Anthropic's "Building effective agents" (December 2024) starts from the opposite design: the model writes its own search queries and decides what to keep, through tools it calls. Hippo ships that tool (`hippo_recall` and 12 others in `src/mcp/server.ts`), yet the founder's box never used it: 0 hippo MCP calls in the 135-session frozen corpus. The CLI route the instruction block asks for at every task is mostly skipped too: the agent ran `hippo context` in at most 24 sessions and `hippo outcome` in at most 32 (a count of the agent's own shell calls; Z2 replaces the self-graded outcome with signals from the environment). Test as a TE5 arm after the pilot: pinned rules only from the hook, plus `hippo_recall` alone, its description written and tested the way the article's tool appendix says (example calls, edge cases, when not to call it). Mistake-proof the CLI first, since agents probe flags: `hippo init --help` runs init and `hippo dashboard --help` starts a server (`src/cli.ts:10020`, `10703`). Every verb should print usage on `--help` and do nothing else.
**Trigger eval before the pull arm (added 2026-09-28).** A TE5 arm built on a tool the agent does not call measures nothing, and a call rate is cheap to measure and easy to attribute. The eval guide cited under TE5 uses the same surface as its worked example: it tunes a skill's description against how often the model invokes it. Before the TE5 arm, build a prompt set in two halves, labelled before the first round: prompts where the store holds a memory that bears on the task, and prompts where it holds none. Each prompt runs through `claude -p` with `hippo_recall` as the only hippo tool, recording whether the agent calls it. Run the starting description twice first; if the two call rates differ by more than the smallest change worth keeping, add prompts before tuning. Then tune the description on a tune split, one change per round, keeping a change only if calls rise on the first half without rising on the second; after two or three flat rounds, sort the misses by cause before the next change. Score the frozen description once on the held-out split, with a CI. The TE5 arm runs only if the held-out call rate clears a bar written down before the first round. Plan usage only.

**Official command pilot (planned 2026-10-01):** Part XX, CAE2-CAE4 implements this trigger-eval plan through `/claude-api build-eval` and `/claude-api hillclimb`. Use train/validation/sealed-final splits and the registered stopping rule; a trigger win remains a prerequisite to the separate task experiment, not a default-promotion result.

#### Z2. Automatic outcomes [after Z1; this is SI0 re-opened]
Credit or blame the memories Z1 injected, from signals in the session: a failed command that passes after a memory was shown (helped), the same error recurring after its lesson was shown (did not help), a user correction that contradicts a shown memory (wrong). Each is an `observed` outcome, logged with its evidence and reversible. Re-run SI0's two kill checks on Z1's injections before the write path is built.

#### Z3. Capture corrections [with Z2]
A user message that corrects the agent ("no, don't...", "stop...", "use X not Y") is the strongest signal we have. Detect it in the hook, distil it through SI4's write contract, and store it as a lesson tied to what it corrected. A repeat of the same correction strengthens the existing lesson instead of adding a new one. **Detector eval, 2026-09-26: FAIL** (`docs/evals/2026-09-26-z3-correction-detect-result.md`): a rule table scored 0.82 precision on held-out sessions against a 0.90 bar; tone words caused most false hits. Next: re-register the explicit-phrasing rules on fresh sessions, plus a Jev arm.
A correction is a claim, and users are often confidently wrong (XYEval, under Z0). A technical correction ("the bug is in X", "use flag Y") is stored `observed` (SI2) and recalled with its source and date, as what the user said rather than as a rule; Z2 retires one whose fix then fails. A preference ("don't open a PR", "use British spelling") is the user's call and is stored as-is. Repeating a correction strengthens it but never proves it, so Z4 promotes on outcome evidence only.

**Workflow adoption [planned].** Use CAE5/Z3b to `build-eval` fresh correction-detection cases, with preference versus technical-claim labels. A bounded `hillclimb` may tune the optional detector prompt or threshold; keep gold labels, epistemic status and false-write bounds fixed.

#### Z6. Automatic supersession of changed facts [with Z3; test first; added 2026-09-28]
The market's most reported memory failure (r/AI_Agents, September 2026): a user moves from Delhi to Mumbai, or switches from dark mode to light, and the memory returns both facts and leaves the model to choose. Hippo has the machinery (`supersede`, `invalidate`, `conflicts`, `resolve`, `explain`, `--as-of`) but every step is a command. Its automatic conflict check runs only at sleep and needs an opposite pair (enabled/disabled, true/false, always/never) or a negation, two shared rare words and half the words shared (`src/consolidate.ts:59-65`, `1154-1189`), so "lives in Delhi" against "moved to Mumbai" is never flagged: neither has a pair or a negation. End-to-end behaviour is not yet tested.
- **Test first:** a small update set (moves, preference flips, corrections, reversals) written in over normal prompts with no hippo commands, then asked across sessions. Pass means the current fact wins and the old one is retired with a reason, not merely ranked lower. Run it on hippo as shipped before building.
- **Build:** on write, find memories about the same subject and attribute (same person or setting, different value) and supersede the older one, logged and reversible. A cheap classifier call is the opt-in arm when rules miss.
- **Show it:** `hippo explain` on the current fact names the retired one, its date, its source and the rule that retired it. This is the demo, and the pitch: hippo knows what changed.

**Workflow adoption [planned].** Use CAE5/Z3b to `build-eval` supported replacements, ambiguous conflicts and reversals. `hillclimb` only optional semantic matching in isolated stores; preserve atomic successor writes, scope, historical recall and reversible evidence.

#### Z7. Sub-agent work is remembered [test first; added 2026-09-28]
A sub-agent is compaction by another name: it reads forty files, hits the dead ends and hands the parent a few hundred tokens (Cyrus, Decagon, "Multi-agent systems: from coordination to negotiation", 2026-09-27). Its gotchas and errors never reach hippo. Capture skips every sidechain turn on purpose (`src/capture.ts:580`), and Claude Code keeps sub-agent transcripts in a separate `subagents/` folder per session that capture never opens; only the TE5 token counter reads it, for token counts (`scripts/token-eval/claude-usage.mjs:103`). This box wrote 1,489 sub-agent transcripts in the 30 days to 2026-09-28. As agents delegate more, this share of the work grows.
- **Test first:** replay a sample from the SI0-style archive. Count the errors, corrections and file-level facts found inside sub-agents that are missing from the parent's capture and the parent's reply. If few survive the SI4 write contract, drop Z7.
- **Result 2026-10-03: INCONCLUSIVE** (`docs/evals/2026-10-03-z7-sidechain-gap-result.md`). Two judges found a lost lesson in 31 of 90 sampled sub-agents (0.344, interval 0.221 to 0.475), which clears the BUILD bar. But the precision audit confirmed only 6 of 10, below 0.75. The judges overcounted lessons that the file concerned, the tool's own error or general knowledge already gives back. Today's extractor produced no usable lesson (0 of 57), so a build needs a distil step. Reading reports alone would reach 21 of the 31 lesson-bearing sub-agents. Next: a new prereg whose judge prompt excludes those classes, calibrated to precision 0.75 or better on a fresh dev split.
- **Z7b 2026-10-03: INVALID before the lock; no build** (`docs/evals/2026-10-03-z7b-sidechain-strict-result.md`). Calibration on Z7's 114 sub-agents could not reach 10 lesson-bearing items at precision 0.75. Hand marking confirmed 5 of 114 (0.044, interval 0.019 to 0.099) under the stricter definition, against a build line of one in ten. Most judged lessons were self-announcing errors, file facts, general knowledge or task results. Z7 stays unmeasured by the pre-registered standard, with no third run without a new data source.
- **Build:** session-end capture also reads the session's `subagents/` files through the same write contract, tagged with the parent session. Where the host has a sub-agent start hook, Z1's gated recall goes into the sub-agent too, so a delegated search does not repeat a known mistake.

**Workflow adoption [planned].** Use CAE5 to `build-eval` independently labelled useful sidechain lessons versus parent-only capture. Only permitted semantic extraction/continuation wording may `hillclimb`; preserve parent/source identity, supported transcript coverage and SI4's write-quality gate.

#### Z4. Repeated mistakes become guards [after Z2 and Z3]
A lesson that was shown and still violated, or corrected twice, is promoted from recalled memory to an enforced check: a `PreToolUse` guard that blocks the matching action with the lesson as the reason. Guards are opt-in per store at first, listed by `hippo doctor`, and each can be dropped with one command. Promotion needs the evidence SI2 requires; a guard that blocks nothing in 30 days demotes back to a memory.
**Latency (added 2026-09-28).** A guard runs before every tool call, not once per prompt. The frozen corpus has 74,172 tool calls against 1,871 human prompts (about 40 per prompt pooled, 13 in the median session), and the median call takes 1.1 s, the fastest quarter under 0.26 s (`hippo-archive/tool-timing.mjs`). Tool execution is the largest share of active session time: in 3.5 months of FreeInference agent traffic, doubling tool speed sped agents up by 38%, against 10% and 16% for doubling prefill and decode (Juncheng Yang, "Measuring agentic systems at scale: Part I", 2026-09-27). Starting the hippo CLI takes about 130 ms on the founder's box, so a guard built like today's hooks would add over a tenth to the median call and half or more to the fastest quarter. Build it as a small script that reads a guard list hippo writes when guards change, registered through the hook `matcher` only for tools that have a guard (Bash is 44% of calls). Budget: p95 under 50 ms per call (a bare node start is 31 ms here), measured in Z4's TE5 arm. Fail open: only a matched guard blocks, and an error or a timeout (set the hook's to 1 s; today's hooks use 5 to 30) lets the call through.

#### Z5. Company stores [after Z4 on personal stores]
The same loop per person. A lesson moves from a personal store to the team store only when it has helped on work other than the task it came from, for two or more people (SI2). Guards promote the same way.

#### Z8. Memory in cloud sessions [after Z0; test first; added 2026-09-28]
A Claude Code cloud session (claude.ai/code, the mobile app, `claude --cloud`, routines) runs on its own VM from a fresh clone of the repo. It reads the repo's `CLAUDE.md` and, in a session with one repository, the hooks in the repo's `.claude/settings.json`; it never reads `~/.claude/settings.json` or the plugins enabled there (Claude Code docs, "What carries over from your setup"). `hippo init` writes its instruction block to the repo's `CLAUDE.md`, which tells the agent to run `hippo context --auto` when no hook is installed, but writes its hooks only to `~/.claude/settings.json` (`src/cli.ts:7775-7786`, `src/hooks.ts:641`). So a cloud session is told to run a command that is not installed, and no Z hook fires. Two more gaps sit behind that. A store written inside the VM is lost when the VM is reclaimed, and the CLI reaches a server only through a local pidfile (`src/cli.ts:403`), and only for remember, forget, archive and promote. Zhu Liang runs every agent in cloud sessions and solved the same problem for a personal knowledge base: a SQLite service on a server, a CLI that a `SessionStart` hook installs in every session, and a database rather than files because many sessions write at once ("Self-Coordinating Agents on Claude Code Cloud", 2026-09-28).
- **Test first, by hand:** two cloud sessions on this repo, with hippo's hooks committed to `.claude/settings.json` and a `SessionStart` hook that installs hippo when `CLAUDE_CODE_REMOTE` is `true`. Record which hooks fire, and whether the second session recalls a lesson the first one wrote. Expected today: it does not.
- **Build:** `hippo init` gains an option to write its hooks to the repo's `.claude/settings.json`, installing hippo only in cloud sessions. The CLI takes a server URL and key from environment variables set once on the cloud environment, and sends context, recall, capture, outcome and sleep there; the server already has `/v1/context`, `/v1/memories`, `/v1/outcome` and `/v1/sleep` routes (`src/server.ts`). The default **Trusted** network level reaches only allowlisted domains, so the server's domain goes on a **Custom** list. Sessions with several repositories, project threads included, load no repo hooks at all; they come later. Committing the store to the repo does not work: parallel sessions would conflict on one binary database file.

#### Z9. Write-time shape, borrowed from Claude Code's auto memory [added 2026-09-28; each part tested on its own]
Claude Code spends its effort when a memory is written: the model decides what is worth keeping, writes one fact per file with a type (user, feedback, project, reference), attaches **Why** and **How to apply** lines, and updates the existing file instead of adding a new one. At startup it loads only an index, the first 200 lines or 25 KB of `MEMORY.md` with one line per memory, and reads a full file on demand (Claude Code docs, "Memory", fetched 2026-09-28). Hippo spends its effort afterwards: regex capture and git subjects in, then decay, dedupe, merge and conflict checks at sleep. Its machinery is stronger; the single memory is worse. Tonight's sleep log shows the cost: merges stored as "[Consolidated from 2 related memories]" concatenations and 35 rows flagged low-quality. Take the shape, not the small hand-curated store. Every part below is filled in by hooks, capture or sleep, never by a new verb. Comparison: `docs/2026-09-28-claude-code-memory-vs-hippo.html` on the founder's box.
1. **The reason travels with the rule.** Two nullable fields, `why` and `apply`. Capture's rule and decision categories fill `why` from the user sentence around the match; Z3 corrections fill it from what was corrected. Injection renders `rule. Why: ...`. A schema migration on live stores, so it needs its own plan and sign-off. **Test first:** blind-judge 40 captured rules with and without their `why` on the SI0 corpus for "would an agent apply this correctly at an edge case"; build only if `why` wins clearly.
2. **Update or create, decided on write.** Before inserting, capture and `remember` recall the nearest memory. Above a threshold, supersede it with merged text (LLM-written when a key is set, else the newer text wins) instead of adding a row, logged and reversible. Sleep's concatenation merge stays as a backstop only. This is the write path Z3's "a repeat strengthens the existing lesson" and Z6's supersession both need, so build it once for all three. **Ships if** the store's growth per session falls and Z6's update set still passes.
3. **Inject an index, not only pinned and recent.** Each memory gets a `description` (first sentence, or LLM-written at sleep); the hook adds one line per top memory by strength and scope, id plus about 12 words, inside today's 1,500-token budget, and the agent expands one with the existing `hippo_recall` or `hippo context`. This sits between Z1's push arms and its pull arm: the agent learns what hippo knows without hippo guessing relevance. **Test:** a Z1 replay arm on the frozen SI0 corpus (overlap, tokens), then the pull-arm trigger eval with the index present.
4. **Say what not to save, and stop saving what git already has.** Claude Code tells the model to skip anything derivable from the code, git history or CLAUDE.md, and anything that matters only to this conversation. Put that list in the hook block and the `hippo_remember` description. `learn --git` inside sleep (`autoLearnOnSleep`, on by default) stores bare commit subjects, which `git log` already answers; keep a commit only when its body states a cause. **Test:** share of `git-learned` rows among the audit's low-quality flags, before and after.
5. **Verify at recall.** One line in the injected block: memories are point-in-time; if one names a file, function or flag, check it exists before acting on it. The labels ("Previously observed") say a memory is old but not what to do. Text only, no schema. **Test:** the `misleading-memory` arm under Z0 is the scoreboard; this line should cut silent-follow.
6. **Read edited mirrors back.** Mirrors are written but edits are never read back (`src/store.ts:2475-2485`), so a user who fixes a file changes nothing. At sleep, a mirror whose hash differs from what hippo wrote is a user edit and supersedes its row, logged and reversible. Users trust files they can open.
7. **Keep Claude Code's shape on import** (still open, now easier). Every agent's memories come in through one import (`src/agent-memories/`), which already puts a project's notes in that project's store, or in the global store stamped with the project's origin; that was the part EV7's project mapping needed. The Claude Code adapter still keeps the body only, cut at 1,500 characters, and stores it as anonymous `observed` text. Map `type` to a tag, `description` to item 3's hook, and the Why and How lines to item 1's fields; the adapter already parses the frontmatter, so this is a change in one place. These are the best-shaped memories hippo receives.

**Order.** 5 and 4 first (text and a default, no schema). 2 with Z3 and Z6. 3 as a Z1 arm. 1 and 7 together once the migration is signed off. 6 last.

**What not to build.** New commands for users to learn. Every Z item is reached through hooks `hippo init` already installs; a new CLI verb is for debugging only.

**Evidence gate.** Z0 (TE5's scored run, re-registered 2026-09-29) is the proof that any of this beats the memory agents already have. Z1's replay is the cheap check; Z0 is the claim.

**Workflow adoption [planned].** Apply CAE5's write, correction and rendering flows to the relevant numbered parts: `build-eval` Why/How completeness, create/update decisions, index expansion and verification behaviour. `hillclimb` each text surface separately; retain independent schema/import/mirror fixtures and task confirmation.

---

## Part XVI - 2026-09-30 update: Track Z evaluation and delivery addendum

**Purpose.** Diagnose why a lesson did not help, then test the component responsible. Z0 remains first. Z0-Z9 above retain their identifiers and history; the ledger is Z10. Z1d extends Z1, Z2b extends Z2, and Z3b shares the Z3/Z6/Z9 write path. Track S7 refers to Z10 rather than creating another ledger.

**Evidence and engineering scope.** [Automatic memory architecture research](docs/plans/2026-09-30-automatic-memory-architecture-research.md) records the code snapshot, primary sources, measured limits and proposed stack. SQLite/FTS5 remain the local foundation; retrieval granularity, semantic coverage and feedback are experiments. A vector database replacement or a neuroscience analogy is not evidence of better task outcomes.

**Boundaries.** Hippo does not run agents. SQLite stays the local store; no Neo4j, Pinecone or LanceDB replacement, no second live ranking policy per runtime, no silent dual-write into cloud memory, no raw transcript as the automatic retrieval unit, and no new required user verb. Optional embedders and explicit existing rerankers remain optional. Track G is outside this queue.

### Two evidence gates

1. **Store/ranker release floor.** A distributed S-track store, ranking or hygiene flag must preserve the existing LongMemEval and actual `hippo recall` paths: paired R@5 difference at least -1 percentage point against the frozen shipping baseline. Fix the commit, corpus hashes, scorer, candidate limits, embedder setting and token budget before comparison. Report the paired interval and counts; an observed difference inside this band is a regression check on that corpus, not proof of population equivalence. Keep both the current CLI-budget run and the script-ranking run; neither substitutes for the other.
2. **Task benefit and default promotion.** LongMemEval cannot pass Z0, an AZ task-benefit claim or a change to `hippo init` defaults. The governing design is [the 2026-09-29 Z0 preregistration](docs/evals/2026-09-29-z0-built-in-memory-prereg.md): H1 repeat mistakes, H2 portability and H3 priced tokens per task, with its declared multiplicity, effect sizes and verdict rules. Cost per resolved task is reported separately unless a fresh preregistration makes it primary. All G1-G5 validity gates must pass, including the positive control. H4 must explicitly pass: the upper 95% bound on the no-lesson cost ratio is below 1.10 and the lower bound on the resolve-rate difference is above -5 points. A new runtime registers its own applicable task family and comparator before scoring.

For default promotion, name the intended primary benefit and minimum useful effect before the freeze, require a win meeting that effect, and retain task quality and the retrieval floor. A favourable point estimate, a tie, an inconclusive harm check or a failed validity gate does not promote a default. Instrumentation can ship without a task win if it preserves decisions and passes correctness and overhead checks; a connector can be supported for the delivery mechanics it proves without claiming better task outcomes.

**Independent confirmation.** Development tasks and frozen regression corpora may be reused for debugging. A scored task set is evaluated under its locked protocol, not repeatedly tuned against. After its result is inspected, a new component needs fresh held-out families or an explicitly registered sequential design and multiplicity budget. Do not peek at Z1c or any other locked held-out window to choose the next arm. Publish win, loss, tie, inconclusive or invalid; do not preselect a tie.

### Z10. Extend the per-turn delivery ledger [first; instrumentation]

The mutation audit's recall entry is not the whole trace system. [`src/recall-trace.ts`](src/recall-trace.ts) already writes `recall_traces`, `recall_trace_results` and `recall_trace_outcomes`, including returned IDs, ranks, scores and linked feedback. Extend that producer and Z0's memory-surface ledger.

- Correlate runtime, store identity, tenant/project, session, turn and triggering event. Record admitted candidate IDs, ranked IDs, gate/budget rejection reasons, emitted IDs and delivery evidence. Distinguish returned, emitted and confirmed delivered.
- Record injected tokens and elapsed time. Keep query hashing and structured-field allowlists; do not add raw prompts or tool outputs to the audit by default.
- For an authorised evaluation, correlate the observable trajectory: user turns, tool calls/results, store-version changes, compaction/resume and task checks. Keep permitted source snapshots outside the repo with hashes, access/retention rules and trace references; raw trajectories are evidence, not recall units. Redacted or unavailable inputs remain explicit gaps, and private model reasoning is not assumed available.
- Record task/check signals with their evidence and timing: repeated error, failed check, explicit correction, revert, resolved check or unknown. Application is `observed`, `judged` or `unknown`, never inferred solely from prompt presence.
- Cover prompt submission, relevant tool failures, compaction and session end. Define duplicate-event handling, concurrent-session isolation and unavailable-event states per runtime. A logging failure must not break the agent or change recall.
- On labelled fixtures, distinguish not-written, not-retrieved, rejected/not-injected, delivery-unconfirmed, delivered/application-unknown, applied-but-wrong and applied-with-supporting-outcome. A causal explanation requires more evidence than a trace.

**Exit.** Known fixture events are reconstructable end to end, existing recall decisions are unchanged, and overhead is measured against H4's budget before broad default installation. No task-benefit claim from instrumentation alone. Draft: [Z10 ledger](docs/evals/2026-09-30-z10-ledger-prereg.md).

### Z1d. Trigger-then-gate [experiment; after Z10]

Register a new arm using the current prompt, bounded recent conversational context and task state, alongside scoped path, error class, test identity or command-family triggers. Include indirect references such as continuing a previously agreed approach; do not require an explicit file or error to qualify. A path match alone is not relevance. Freeze query construction, allowed context sources and bounds before scoring. Retrieve a small set and admit it only when the registered gate clears; otherwise inject no additional claims. Applicable pins remain.

The 2026-09-26 lexical `promptRecall` arm stays off by default. Z1c's locked judge-gate experiment continues unchanged. Its 0.15 helpfulness difference is not automatically a threshold for shown-rate or task success: Z1d must define its own denominator, false-positive cost, sample and smallest useful effect. Compare useful delivered coverage on relevant tasks, irrelevant injection on no-match tasks, repeat mistakes, tokens and latency. A replay or judge pass permits an experimental arm; default promotion still requires Z0. Distinguish admission abstention (no additional memory) from agent uncertainty or a clarification request. Test missing, contradictory and confidently wrong evidence; report useful coverage, false-confident use and needless abstention, not refusal rate alone. Separate newly emitted blocks from valid unchanged context and user rescue turns; Z12 measures burden. Draft: [Z1d trigger and gate](docs/evals/2026-09-30-z1d-trigger-gate-prereg.md).

**Workflow adoption [planned].** CAE5 supplies a reviewed `build-eval` corpus for relevance/admission and a separate bounded `hillclimb` after Z10. Freeze the independent labels and vary query construction, gate wording or a threshold separately; Z1c's held-out window remains unavailable.

**CLEF integration [planned; CLF5/CLF12, CAE10].** Register a fresh shared-interface candidate for relevance, applicability and explicit no-applicable-memory decisions. Validate calibration, false-confident admissions and evidence coverage at matched input/token budgets; native fallback and applicable pins remain. Do not alter Z1c's judge or held-out window.

### Z2b. Evidence-specific outcomes [extends Z2]

Link feedback only to IDs confirmed delivered in the applicable turn/task, using Z10. A later pass does not credit every shown memory, and an unrelated failure does not blame them. Record ambiguous signals as unknown. Use evidence tied to the claim's prediction or prescribed action; log the rule, source and reversal. Preserve manual explicit-ID feedback. No default batch auto `--bad`, and no strengthening merely because a row appeared in context. Re-run SI0's validity checks before enabling automatic outcome writes.

**Workflow adoption [planned].** Use CAE5's outcome/experience `build-eval` fixtures to expose false attribution and ambiguous signals. Only an optional semantic extractor/classifier is a later `hillclimb` surface; delivered-ID linking, unknown states and the evidence/promotion rules stay fixed.

### Z3b. Correction writes [shared with Z3, Z6 and Z9]

Detect the correction, identify the claim it addresses, and establish whether it replaces that claim as separate steps. Match subject, attribute, tenant/project, environment or branch applicability and effective time. A next-turn contradiction alone does not close a row.

User preferences update in their stated scope; technical claims remain observations until supported. An uncertain conflict stays pending and preserves both sources. A supported replacement atomically closes the old version and writes its successor, with evidence, reason and reversal. Duplicate delivery is idempotent. No `hippo supersede` command on the happy path.

Register false-write and false-closure bounds, label agreement and abstention coverage before scoring. Include quotations, hypothetical changes, branch-specific facts, confidently wrong corrections and reversals. Task confirmation must lower stale-follow without raising repeat mistakes or failing H4. Draft: [Z3b correction writes](docs/evals/2026-09-30-z3b-correction-write-prereg.md).

**Workflow adoption [planned].** CAE5 shares a `build-eval` across Z3/Z6/S3 for detection, claim matching and replacement, scored as separate stages. An opt-in semantic prompt/threshold can `hillclimb` in isolated stores; atomic version writes, scope/time integrity and false-closure bounds are correctness gates.

**CLEF integration [planned; CLF6/CLF7/CLF12].** Test correction classification, affected-claim selection and supported-replacement decisions as separate typed stages. Preserve preference versus technical-observation status, unknown/pending conflicts, source/time/scope matching and deterministic atomic/reversible version writes.

### Zero-touch acceptance contract [shared by Z0, Z10, S6 and AZ]

For each claimed runtime, install/trust once, teach through an ordinary conversation, need the lesson in a later session, correct it, compact or interrupt, then resume. Verify the appropriate scoped version is durably stored and available, reaches the actual agent context, and is applied on a task where it matters. Include a no-match task, a plausible wrong memory, a long-lived session that never ends normally, duplicate events and a missing-input case. No routine user `remember`, `outcome` or `supersede` command is part of the acceptance path.

**Enterprise extension [planned].** EV9 applies this contract to EI15's objective/evidence links and CD14's reports, including administrator setup and ongoing burden.

Report stages separately on labelled fixtures or independently labelled eligible events:

| Stage | Measure | Limitation |
|---|---|---|
| Capture | Gold durable lessons saved within the registered delay; useful/correct write precision | Stored row count is not capture coverage. |
| Retrieval | Applicable evidence found and retained within the real token budget; irrelevant injection | CLI R@5 cannot establish automatic prompt usefulness. |
| Delivery | Confirmed context availability per eligible turn, including valid reuse/reset of an unchanged block | Emitting JSON or installing a hook is not confirmation. |
| Application | Observed or independently judged use, with unknowns reported | Presence is not use; correlated success is not causal credit. |
| Task impact | Registered repeat mistakes, stale-follow, task quality, priced cost and latency | A valid comparator and Z0 gates establish benefit. |

Freeze denominators, clustering and acceptance bounds before scoring. Publish descriptive per-prompt/per-session coverage only within the sampled runtime, repositories and users; general claims require broader independent pilots. Fixtures establish mechanics; task-benefit and default claims retain the gates above.

### Z11. Preserve defaults while experiments run

`hippo init` retains the current pinned + newest 5 hook, `promptRecall` off, no batch auto `--bad`, and no required embedder. This roadmap change does not change extraction settings, live-store half-lives, installed hooks or compaction capture. Existing compaction-item writes remain (they fade like any memory since 1.53.1); their presence is not a claim of task benefit. A ranker-only win cannot promote a hook default.

### Z12. Human supervision and memory growth [evaluation draft; after Z10]

Test whether Hippo reduces the effort needed to complete later tasks beyond built-in memory, while preserving task quality. Z0 already records teach/correction turns and work; this is a fresh extension with explicit burden labels and growth conditions, not an amendment to its locked endpoints or arms. A smooth session alone cannot establish memory benefit.

Separate user rescue/re-teaching from automatic memory delivery. Count correction turns and repeated explanation per assigned task under a fixed intervention/stopping protocol; measure active supervision time only in an independently registered human pilot. Simulated correction counts are a burden proxy, not measured human time. Keep unresolved tasks, abandonment, intervention limits and outcome censoring visible. Fewer prompts, injected blocks or input tokens alone cannot pass.

Freeze model, harness, task family, budgets and memory settings. Keep isolated stores and matched teach/apply/reversal sequences; retain no-memory and perfect-memory controls. Compare built-in memory, shipping Hippo and one frozen experimental component. Preserve relevant source evidence while adding unrelated histories at registered scale levels, with matched source access, distractor mix and scope across systems. Test plausible wrong, stale, conflicting, missing and wrong-project memories, compaction/resume and no-match tasks. Report both bad-memory delivery and supported evidence of bad-memory use; neither a model's self-report nor prompt presence proves attribution.

Register supervision benefit and growth reliability separately, including quality non-inferiority, no-lesson harm, useful coverage, false-confident use and needless-abstention bounds. Include extraction/embedding/maintenance/retry costs, priced cached and uncached input, output and latency tails. Cluster by independent repository/lesson sequence; a live team pilot randomises independent projects or teams so shared memory cannot contaminate arms. Success with little noticeable friction may still be valuable if the controlled difference is useful and quality holds; a ceiling, null or extra cost is reported honestly.

**Exit.** Publish the preregistered burden/quality result and scale-conditioned reliability with intervals and failure stages. No claim of real human-time savings from synthetic replay, no default change from Z12 alone, and no benchmark score replacing Z0. Draft: [Z12 supervision and growth](docs/evals/2026-09-30-z12-supervision-growth-prereg.md).

**Workflow adoption [planned].** CAE5 uses `build-eval` to review fresh burden/growth families, quality checks and label agreement on development data. Freeze the intervention protocol and independent confirmation before scoring; component `hillclimb` takes place in separate development flows, not on this study's outcomes.


**Native improvement and procedural pilots [planned].** CAE8/CAE9 inherit the burden labels and intervention rules through separate registrations. Include developer and administrator setup, review/promotion, rollout, maintenance and recovery time, not just later-task correction counts. Measure active human time in the human pilot; synthetic replay remains a proxy.
---

## Part XVII - 2026-09-30 update: Track S, compact memory experiments

**Motivation, measured and limited.** The [CLI recall evaluation](docs/evals/2026-09-28-recall-cli-longmemeval-result.md) found whole-session rows consumed most of the token budget; it did not test structured claims or generate answers. The [mechanism audit](docs/evals/2026-09-23-mechanism-audit-round2-result.md) found physics lost largely through missing BM25, sleep did not show a recall benefit, and correct outcome marks helped on a synthetic workload. These motivate component experiments, not a measured claim-stack win or a conclusion that age never matters.

**Flag and compatibility.** `{"stack":"claims-v1"}` is a proposed opt-in interface, not an implemented setting. It does not commit to new tables or a live-store migration. Keep separate evaluation controls for representation, ranking, closure, writes and packing; one public flag must not make their effects inseparable. Preserve CLI/API input contracts, mirrors, provenance and old rows. No automatic splitting of legacy rows in v1. Any new schema requires its own migration, rollback and compatibility plan.

### S0. Test the write unit before replacing the schema

Profile actual automatic writes on development data first: source, size, useful assertions, missing conditions, duplicate rate and missed lessons. The CLI benchmark's whole-session rows are not the unit of every ordinary Hippo write. Compare current short notes and larger rows, deterministic sentence/turn chunks and structured claims under equal retrieval and injection budgets. Use a separate representative automatic-write corpus alongside LongMemEval; preserving the benchmark floor alone cannot justify a live-store redesign. Prototype on the current store and Z9's write contract first. A claim preserves one assertion plus necessary reason, application conditions, subject/attribute, source and epistemic status. About 40-120 tokens is a target, not a minimum or permission to truncate exceptions; a short useful rule needs no padding.

Carry owner, tenant, origin project, scope, pin, source evidence, effective time and outcome links explicitly. Receipts are source evidence kept out of automatic injection. Retain source spans so a claim is credited only for evidence its returned text contains, not everything its parent session once said. Existing legacy-store tests must be accompanied by fixtures that actually write and retrieve the experimental units.

**Exit.** Pass the retrieval floor plus evidence-completeness, false-extraction, multi-evidence, no-match and scope fixtures. Task benefit is confirmed separately on Z0. Introduce claims/experiences tables only if the prototype exposes a concrete need the existing model cannot meet. Draft: [S0 claim units](docs/evals/2026-09-30-s0-claim-units-prereg.md).

**Workflow adoption [planned].** CAE5's write-quality `build-eval` reviews representative source spans and independently labelled useful claims before a representation change. Tune an optional extraction surface only in its own experiment; evidence fields, retrieval checks and schema decisions are outside that search.

### S1. Ranking ablations, including the outcome channel

Freeze the representation and candidate construction. Compare the shipping lexical rank path, that same path with recency/strength removed and other factors fixed, plain JavaScript BM25, and plain BM25 plus evidence-based outcome feedback. Ablate recency and strength separately before their combined removal. Register exact score equations and settings: decision, path, scope-tag, extraction, churn, temporal and DAG boosts, local/global source weighting and any other configured factor must be explicitly retained, removed or disabled per arm. Removing age/strength alone is not a pure-BM25 baseline. Mandatory tenant/project/scope/temporal admission and invalidation stay in every arm. Keep optional hybrid/graph/MMR/reranker changes out of these component comparisons or register them separately.

The current JavaScript BM25 and SQLite FTS5's native BM25 have different scoring contracts; switching between them is a separate comparison. Physics remains an explicit experimental arm. No pure-BM25 or physics-off default is established by this plan.

Apply tenant/project/scope and temporal eligibility before candidate limits and ranking, and recheck admission before injection. Report all-evidence coverage, stale intrusion, per-category regressions and latency alongside paired R@5. Draft: [S1 ranking](docs/evals/2026-09-30-s1-ranking-ablation-prereg.md).

**Workflow adoption [planned].** CAE5 applies `build-eval` to label/split and downstream Claude-task auditing while reusing the deterministic retrieval scorer. Prefer a finite parameter sweep for bounded weights; optional `hillclimb` stays on a separately registered development surface and cannot remove mandatory admission or tune benchmark test answers.

### S2. Optional hybrid, only when misses justify it

Use the existing optional embedder. Lexical and dense retrieval generate independent eligible candidate lists; union them, fuse through RRF, then pack. Dense retrieval restricted to BM25 candidates cannot rescue zero-overlap paraphrases. The zero-dependency path stays lexical.

Use at most 20 claims and one experience, with the token cap taking precedence. Preserve existing explicitly selected rerankers; do not introduce a required MS MARCO cross-encoder, cloud embedder or vector dependency. Optional SQLite vector indexing needs its own compatibility and latency evidence. Hybrid gains must hold after the claims exist and still cannot change defaults without Z0.

**Workflow adoption [planned].** After a measured paraphrase gap, use CAE5 to `build-eval` lexical/dense coverage and downstream task cases. Prefer existing RRF/parameter sweeps; any optional reranker `hillclimb` retains eligibility filters, the zero-dependency path and S1/Z0 gates.

### S3. Forget by evidence-based closure

Reuse `valid_from`, successor linkage and the existing `--as-of` contract. Current recall excludes closed/rejected/superseded versions; historical recall applies the requested temporal view. Closure and successor writes preserve scope, evidence, pins and reversibility.

Validity time and recorded knowledge time are separate: specify how late corrections and backdated facts behave before calling the design bitemporal. Preserve the existing public `--as-of` semantics; register any additional recorded-time selector and migration separately. Test historical queries before and after the correction was learned, gaps, chains, reversals and isolated scopes.

Age-only archival is deferred. A 180-day policy requires a retention study, protected-row checks and recoverable archive semantics; a short Z0 run cannot validate forgetting over months. Draft: [S3 temporal closure](docs/evals/2026-09-30-s3-temporal-closure-prereg.md).

**Workflow adoption [planned].** Use CAE5's correction eval to review temporal chains, backdated corrections and historical-query fixtures. Optional semantic matching can `hillclimb` only through Z3b; version-write integrity and public `--as-of` semantics retain deterministic correctness tests.

**CLEF integration [planned; CLF7].** Semantic relationship decisions can nominate a supported replacement; only the existing validated closure/successor path changes validity. Test branch/environment exceptions, late corrections and historical recall independently of the classifier.

### S4. Sleep as reversible hygiene

Close only supported contradictions through Z3b/S3. Merge duplicates only when assertion, scope, applicability and exceptions are equivalent; preserve all provenance and a reversible record. Shorter text alone is not a merge criterion. Do not concatenate episodes to manufacture a lesson.

Keep receipts and compaction records under their existing retention/privacy rules. Do not delete orphan evidence merely because no current claim references it. Compaction records remain outside recall/FTS/sleep memory passes; compaction-item memories fade like any memory since 1.53.1. No new LLM extraction path unless `extraction.enabled` and the applicable provider opt-in permit it; this does not change today's extraction default.

Pass the recall floor and evidence/temporal integrity checks. Deduplication alone is a useful hygiene outcome; do not label it better memory without task evidence. Draft: [S4 sleep hygiene](docs/evals/2026-09-30-s4-sleep-hygiene-prereg.md).

**Workflow adoption [planned].** CAE5's consolidation `build-eval` covers equivalence, exceptions, provenance and replay/reversal. `hillclimb` may tune an already permitted optional merge/summary prompt, with independent store rebuilds and evidence/recall/task checks; protected rows and reversible writes remain fixed.

**CLEF integration [planned; CLF7].** Use scoped typed decisions to screen equivalence, contradictions and merge candidates, retaining the current extraction opt-in and reversible hygiene contract. A model score cannot authorise unsupported compression, mixed-scope derivation or protected-row deletion.

### S5. Scoped experiences

A fail/resolve sequence can produce one experience: trigger, observed action, check evidence, outcome and a bounded lesson. A failure alone does not prove a remedy. Reuse trace/provenance infrastructure before creating another table. Retrieve by scoped trigger; inject at most one per turn. Version-dependent remedies carry applicability, and unproven lessons remain observations.

**Workflow adoption [planned].** Use CAE5 to `build-eval` fail/action/check sequences, unsupported remedies and version-specific applicability. `hillclimb` an optional experience-extraction prompt only after attribution passes; preserve evidence links, observation status, scope and the one-experience cap.

**CLEF integration [planned; CLF8].** Classify a permitted fail/action/check sequence and its current-task applicability; independent check evidence establishes the remedy. Keep one-experience delivery, version/condition support and observed status for unproven lessons.

### S6. Automatic writes

Start with structured existing inputs and conservative heuristics. Supported corrections use Z3b; repeated errors use S5. Preserve the existing compaction lesson-list capture and reuse it for the experimental write format; do not delay today's capture until a new schema exists or make a compaction dump retrievable. LLM extraction is a separately registered opt-in arm. Write precision, duplicate rate, evidence completeness and temporal correctness precede task confirmation.

**Durable capture contract.** Declare supported events and source coverage per runtime. Register a maximum lesson-write delay and test decisions stated early in a long session, before compaction and without a normal SessionEnd. Extend existing compaction replay and provenance machinery: persist supported ingestion progress, retry interrupted work, deduplicate stable event/source identities, and atomically commit a write with its progress marker where possible. Distinguish received, pending, processed, skipped and unavailable input; doctor/logs expose missing inputs, backlog and degraded capture without silently claiming success. Recovery is bounded and idempotent, respects retention and does not collect unsupported transcripts.

Separate durable receipt/progress handling from semantic extraction and the read path. Extraction failure or an unavailable optional model leaves recoverable pending work while the agent continues. Register provider/mode, extraction and embedding costs, timeout, retry/backlog limits and token/latency budgets; retries cannot cause unbounded spend. These are engineering fixtures on development data before the zero-touch task acceptance family.

**Workflow adoption [planned].** Share CAE5's reviewed write eval with SI4/S0 and Z3b. `hillclimb` addresses only semantic extraction/instruction quality; source receipt, atomic progress, idempotence, recovery and spend limits retain deterministic failure/retry fixtures.

**Procedural follow-up [planned].** CAE9 reuses supported capture and progress/retry handling for optional skill drafting off the recall path. Users should not have to curate each lesson or repeatedly launch extraction; preserve bounded cost, recoverable pending work and exception-based reporting.

**CLEF integration [planned; CLF3/CLF6].** Route supported capture events and candidate-memory screening through the shared decision interface under the existing provider opt-in, receipt/progress and write-quality contracts. Inference failure leaves bounded recoverable work; runtime coverage and source access must be proved rather than inferred from model availability.

**Pre-compaction coverage follow-up [planned; AZ4/AZ5].** Make supported early-session lessons/corrections and working state durable before context loss, using incremental capture plus a bounded flush where available. Explicitly distinguish saved memory, checkpoint and pending receipt; reuse the write/recovery contract across native adapters without requiring users to trigger each save.

### S7. Ledger

Use Z10. Extend the same trace producer and schema; no second ledger.

### S8. Graph reasoning [deferred; opt-in]

Reuse the existing entities, relations, graph recall and scope checks. PPR is a later traversal/ranking experiment, not a second graph product or required database. Register it only when a Z0 family demonstrates a multi-constraint retrieval gap that lexical/optional hybrid recall does not solve.

### S9. Packing and cache measurement

The experimental automatic memory block has a hard 1,500-token cap including IDs, provenance, labels, pins and any experience. Admit eligible pins first with deterministic ordering, then whole claims; never cut an assertion away from its conditions. If pins alone exceed the budget, inject the deterministic fitting subset and record/report omissions. Item limits never override the token cap.

Without a qualifying trigger, add no experimental claims or experience; the existing applicable pin path remains. Closed facts do not enter live context as current instructions. Use a fixture containing 10 live claims, two closed claims and one experience to verify selection and budget, with a separate historical-view case.

Keep unchanged rendering deterministic. Measure cached tokens, cache placement and actual priced input before claiming savings; byte-stable text does not guarantee a cache hit. Report input cache reads/writes or misses where exposed, output, extraction, embeddings, maintenance and retries, plus time to first token and end-to-end latency tails. Distinguish a smaller prompt from cheaper cached computation; freeze provider/model, placement and cache conditions for a cache comparison.

**Order.** Build Z10, capture reliability fixtures and S0/S9 development prototypes alongside Z0 runner/smoke preparation; they need not wait for the scored baseline write-up. Freeze and preserve the shipping comparator before confirmatory runs. Use observed failure stages to order S1 ranking, S3/S4 integrity and S5/S6 writing, then confirm Z1d/Z3b and the combined arm on fresh registered families. Run single-component ablations before the combined arm. S2 follows only a measured paraphrase gap; S8 follows only a measured graph gap. This parallel engineering work does not weaken the retrieval floor, independent confirmation or default-promotion gates.

**Workflow adoption [planned].** CAE5 connects TE3/TE7 and Z9's index/verification text: `build-eval` reviews evidence and downstream application at equal budgets; bounded `hillclimb` varies one rendering, index-description or verification surface. Measure cache/total cost and confirm task quality independently.

---

## Part XVIII - 2026-09-30 update: Track AZ, runtime delivery surfaces

**Contract.** Every adapter uses the same store discovery, admission, ranking, trace and packing contracts. Prefer a route that reliably delivers useful memory on that runtime; the order hooks/MCP/instruction files is a hypothesis to test. Keep agent-initiated recall available. Install only for a runtime the maintainer or a pilot actually uses.

Separate a supported connector (installation and delivery fixtures pass) from a task-benefit claim (its preregistered Z0 family passes). `hippo doctor` reports version, loaded config source, active events, store selection, opt-out state and delivery limitations. No task-benefit claim from a successful install.

### AZ1. Devin CLI and local surfaces [after baseline; explicit opt-in]

The [official hook configuration](https://docs.devin.ai/cli/extensibility/hooks/overview) documents project `.devin/hooks.v1.json` (the hook object is the whole file) and user settings, including automatic Claude-config import. The [lifecycle reference](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks) documents prompt/session events, `PostToolUse` and `PostCompaction`. These establish an adapter candidate, not a Hippo runtime result.

- SessionStart: discover the correct store and inject scoped context through the documented output envelope.
- UserPromptSubmit: retain pinned + newest 5 as the comparator; Z1d is a separate flag.
- PostToolUse: normalize `tool_response.success/output/error` before failed-tool capture. Do not assume Claude Code's separate failure event or payload.
- PostCompaction: consume the documented nullable `summary`; test capture and context restoration separately. Do not map it blindly to Claude's compact-resume command.
- SessionEnd: sleep/capture only from an established supported input. The documented event does not establish a transcript path; do not invent one.
- MCP: install the documented stdio route as an alternative; distinguish an available tool from a tool actually called.
- Installer/doctor: merge and uninstall only Hippo-owned entries, preserve other hooks, detect inherited Claude hooks to prevent duplicate injection, and test supported versions and local modes individually.

Cover nested/worktree/projectless discovery, concurrent sessions, resume, compaction without summary, no-match, wrong-project, install/update/opt-out and missing-input cases. Leftover Cascade-note import is optional, provenance-preserving and never silently enabled. Draft: [AZ1 Devin delivery](docs/evals/2026-09-30-az1-devin-hooks-prereg.md).

### AZ2. Cloud Devin knowledge exchange [separate from Z8; deferred]

Z8 above remains Claude Code cloud memory. Register Devin cloud as its own surface. Verify supported Knowledge read/write APIs, authentication and session access before designing import/export. MCP connectivity does not establish a transcript or lifecycle event stream.

Import/export is explicit and flagged, with external IDs, tenant/project admission, provenance, authority/conflict rules, idempotent replay and closure/deletion handling. No silent dual-write or feedback loop. Supported source events may become receipts; claim writes still pass the common write contract. Confirm cross-session persistence and task benefit separately.

### AZ3. Cross-platform plugins and consumer connectors [capability/pilot; explicit opt-in]

Prioritize ChatGPT and Claude packaging around the existing core, then a demand-backed Grok/Grok Bot pilot. Reuse the shipping Claude Code plugin and `hippo mcp`; build one common integration contract with small manifests/event mappings.

- ChatGPT: [plugins](https://developers.openai.com/plugins/concepts/plugins) can bundle MCP tools, skills and Codex/Work lifecycle hooks. Validate each mode; web installation does not deploy hook scripts. [MCP Events](https://developers.openai.com/plugins/build/mcp-events) deliver subscribed server updates into ChatGPT, not every user prompt back to Hippo.
- Claude: package local MCP as a [Desktop extension](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop); reuse an authenticated remote endpoint for other [supported surfaces](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors). Tool access alone does not establish automatic chat capture.
- Grok: test [custom MCP connectors](https://docs.x.ai/grok/connectors). Grok Bot's [Remote HTTPS/Command routes](https://docs.x.ai/grok-bot/team-bots) need separate computer/store and private/team identity mapping.
- Muse: identify the exact product/runtime and supported interface before allocating an adapter. Other clients start with a tested MCP recipe.

First check protocol/transport, local Node/SQLite support, authentication/scope, actual invocation and offline behaviour. Remote access projects a chosen canonical store; no silent cloud replication. Enforce permissions on the server regardless of client approval UI. Keep raw trajectory exports as permitted evidence outside recall.

The [capability and packaging plan](docs/plans/2026-09-30-cross-platform-memory-surfaces.md) records sources, implementation gaps and pilot order. [AZ3's draft](docs/evals/2026-09-30-az3-consumer-connectors-prereg.md) separates connector fixtures, capture/delivery coverage and task benefit beyond built-in memory. Automatic-memory support needs all three; rich UI and browser scraping are not prerequisites.

**Workflow adoption [planned].** CAE5 uses `build-eval` for capability/invocation/delivery cases and a bounded `hillclimb` of instruction or tool text in the Claude-backed pilot. Each target client still needs its own supported-interface and identity/delivery fixtures; source permissions and event mappings stay fixed.

**Contract and upgrade follow-up [planned].** Use CAE6 for per-client MCP schema/error/side-effect checks over the supported transports, then CAE7 for versioned capability and delivery revalidation after client/model/plugin changes. Passing one client's fixtures does not establish support in another.

**Native improvement follow-up [planned].** CAE8 evaluates Hippo-owned adapters over each client's supported interface, with actual scoped capture/delivery fixtures. ECC is an isolated research reference/comparator only; no ECC vault interchange or second product memory store is scheduled. Enterprise rollout uses the organisation's managed Hippo configuration.

### AZ4. Automatic memory saves before compaction across platforms [planned; hard: AZ6 foundation, CS1/S6, CD1; conditional adapters: AZ1/AZ3 per mode; added 2026-10-02]

**Goal.** After one-time installation, store/scope selection and required platform trust, Hippo automatically preserves supported lessons, decisions, corrections and working state before the host loses context. Users should not have to remember to run a save command, maintain a handoff file, watch a token threshold or approve each ordinary memory. Cover every available agent surface Hippo supports, not just ChatGPT and Cursor, through Hippo-owned adapters; record each exact runtime/mode/version separately. The complete named integration and MCP-client inventory below is required scope, with an extensible registration path for other compatible agents under AZ6. Preserve today's working Claude Code capture while extending coverage.

**Current baseline, checked 2026-10-02.** Package installation alone is not integration setup: [postinstall](src/postinstall.ts) prints setup hints and repairs only an already opted-in Codex wrapper. [Claude Code's installed hooks](src/hooks.ts) call pre-compact to record the compaction and save a derivable task snapshot, then post-compact to save the summary's memory items; they are separate phases. The [compactions table and item path](src/compaction-record.ts) are distinct from recallable memory. [Cursor](integrations/cursor.md) currently uses an instruction block; [Codex](integrations/codex.md) currently installs per-prompt and compact-resume hooks, with no Hippo PreCompact capture and a separately opted-in session-end wrapper. An instruction, installed hook entry or available MCP tool does not by itself prove automatic capture.

**Required coverage inventory [AZ6; checked 2026-10-02].** The [README framework table](README.md#framework-integrations), [hook detection/installation code](src/hooks.ts), native [OpenClaw plugin](extensions/openclaw-plugin/index.ts), [Pi extension](extensions/pi-extension/index.ts), [integration recipes](integrations/generic.md) and [MCP client recipe](extensions/mcp/README.md) establish the inventory. Named integrations are Claude Code, Codex, Cursor, OpenClaw, OpenCode and Pi; the MCP recipe additionally names Windsurf, Cline, Claude Desktop and VS Code. Include those now, together with ChatGPT and the already planned AZ clients. Native integration, generic tool connectivity, planned adapter and verified automatic preservation are distinct statuses. Do not drop a currently supported agent from the preservation backlog because it lacks a ready-made PreCompact hook.

All available modes of these products remain in the coverage register. Missing capture sources or upstream events are tracked blockers with a next action, not a reason to declare universal completion. Recheck official interfaces at implementation and release; the rows below are an implementation queue, not new shipped support.

| Surface / mode | Adapter work and capability boundary |
|---|---|
| Claude Code terminal / IDE / other supported execution environments | Extend and verify the existing pre/post-compaction path for both automatic and manual compaction. Confirm actual input, durable writes and resume delivery in each deployed mode; local configuration does not establish cloud coverage. |
| Cursor Agent desktop / CLI / cloud | Build a native adapter for the documented [preCompact event](https://cursor.com/docs/hooks), with supported response/tool events supplying bounded incremental capture where available. It is observational: its documented payload supplies compaction counts, not a transcript, and its output cannot change the summary. Verify any additional input source before using it. [Claude-hook import](https://cursor.com/docs/reference/third-party-hooks) maps names, not semantic capture correctness; prevent duplicate native/imported handlers. Test CLI and cloud separately, including cloud script/store installation and read-only turns without hooks. |
| Codex runtime | Current [official hooks](https://learn.chatgpt.com/docs/hooks) document PreCompact/PostCompact, but Hippo does not yet install them. Add version-checked native mappings and supported transcript parsing; the transcript path can be null and its format is not stable. Plain compaction-hook stdout is ignored, so Claude's summariser-instruction approach cannot be copied. Preserve required trust and existing public/wrapper behaviour. |
| ChatGPT Work with a Codex execution environment | Package the validated runtime adapter through AZ3/CD1. [Hook scripts must exist in that environment and require trust](https://developers.openai.com/plugins/build/plugins); enabling a web plugin alone does not deploy them. Test installation, execution, accessible capture sources and persistence independently from local Codex. Verify current distribution eligibility: [public plugin ZIP submission currently excludes lifecycle hooks](https://developers.openai.com/plugins/deploy/submission). Use an actually supported install/admin route rather than assuming marketplace delivery. |
| Ordinary ChatGPT web / desktop / mobile chat | AZ3 must establish an authorised automatic capture/checkpoint source for each mode and a persistent store route. MCP access or export import alone does not expose compaction or full history. Persist supported incremental checkpoints before loss where possible; otherwise track the missing interface as a coverage blocker and describe existing tool/import access accurately. Do not invent callbacks or scrape private chats. |
| Claude Desktop chat | Hippo's [MCP recipe](extensions/mcp/README.md) explicitly names this client. Package the local/remote tools through AZ3 and verify an authorised conversation/checkpoint source plus store/runtime access; a Desktop MCP extension alone does not prove pre-compaction capture. Keep this separate from Claude Code's hooks even when the applications share branding. |
| Claude web / mobile / Cowork and other supported Claude modes | Reuse AZ3's mode-specific packaging and permissions work, then verify automatic input, checkpoint timing, persistence and resume separately. A consumer connector, Cowork plugin or Claude Code result cannot establish another mode's capture coverage; missing sources stay tracked under AZ6. |
| OpenCode terminal / desktop / web / IDE / server-backed sessions | Extend the [shipping lifecycle plugin](integrations/opencode.md) using the documented [experimental.session.compacting and session.compacted routes](https://opencode.ai/docs/plugins/). The former fires before summary generation, but does not itself supply a complete transcript: verify supported SDK/message inputs, durable incremental progress and session identity. Keep summary augmentation separate from saving to Hippo; preserve the host's default prompt and other plugins. Pin the experimental contract and test each frontend against the actual server/store, without assuming Claude JSON hooks work here. |
| OpenClaw native plugin / supported agent runtimes and channels | Extend [Hippo's native plugin](extensions/openclaw-plugin/index.ts), which currently handles prompt context, tool errors and session end, to the documented [before_compaction / after_compaction / before_reset](https://docs.openclaw.ai/plugins/hooks/reference) observations. Validate actual event emission, permitted source payloads and durable state before resets/compaction; a completion with zero changes is not a new memory. Check embedded, Codex/Copilot-backed and other supported runtimes separately, including private/group session routing and identity. Keep basic capture independent of autoSleep's 10-memory threshold; no mandatory context-engine replacement or new agent-dispatch path. |
| Pi coding agent: interactive / RPC / JSON / print modes | Extend the [existing Pi extension](extensions/pi-extension/index.ts) using current [session_before_compact, session_compact and session_compact_failed declarations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts). Use permitted active-branch preparation/entries for pre-loss writes, handle manual/threshold/overflow reasons and abort/retry without cancelling the host's compaction. Test forks/tree navigation so abandoned branches do not become current facts. Install/update the extension through AZ5 rather than require routine manual copying; remove advice that delegates each save to the user. Revalidate the extension's existing event/tool API against supported versions and each non-interactive mode. |
| Windsurf / Cascade, including the current Devin Desktop surface | This is explicitly named in Hippo's MCP recipe. The [current Cascade hook docs](https://docs.devin.ai/desktop/cascade/hooks) expose prompt/response events and post_cascade_response_with_transcript; the old Windsurf docs now redirect here. Build permitted incremental capture and bounded transcript processing with trajectory identity/cursors, accounting for asynchronous completion and host file pruning. Verify the exact product/version and supported install route. No documented pre-compaction barrier is established by these response hooks, so test races/context loss and report the achievable checkpoint delay instead of claiming a synchronous flush. |
| Cline VS Code extension / CLI / SDK | Hippo names Cline as an MCP client. Current [extension hook guidance](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md) still labels PreCompact coming soon, and [SDK/file-hook examples](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md) say that event is not wired for file hooks. Build automatic incremental capture from the validated prompt/tool/run sources; investigate supported before-model/compaction interfaces independently for each mode. Do not treat an enum entry as a working hook. Test OS support, task identity/resume, cancellation and context truncation; revisit the native event when upstream actually ships it. |
| VS Code agent chat / Copilot Local / remote extension hosts | Already named in Hippo's MCP recipe and CD1. The [current VS Code Local harness docs](https://code.visualstudio.com/docs/agent-customization/hooks) include PreCompact; wire a native package with verified payload/source/output mappings, workspace trust and bounded writes. Remote Development executes on the extension host, whose OS/store may differ from the UI machine. Imported Claude/Copilot configuration formats do not preserve every matcher/schema behaviour. Test alternate harnesses separately; basic capture must not wait for CD3's optional visual extension. |
| Copilot CLI / GitHub Copilot cloud coding agent | Extend CD1 with the [documented preCompact / PreCompact contract](https://docs.github.com/en/copilot/reference/hooks-reference), normalizing camelCase versus compatible snake_case fields and supported transcript format. Verify hook installation and actual execution for CLI/cloud/SDK modes separately; provision scripts, authorised durable store access and any required cloud network policy. Ephemeral workspace loss and non-interactive operation need recovery tests; a VS Code Local result is not cloud evidence. |
| Gemini CLI: terminal / headless / approved cloud execution | Add a native AZ adapter for [PreCompress](https://geminicli.com/docs/hooks/reference/) plus permitted model/agent/tool inputs and the supported transcript parser. PreCompress is advisory and asynchronous, with flow-control fields ignored: maintain durable incremental checkpoints and test the race rather than assume the host waits for a save. Keep JSON output and event/matcher names native to Gemini, then test automatic/manual compression, headless execution, trust, quotas and store availability. Gemini consumer chat is a separate client registration if pursued. |
| Devin CLI | Reuse AZ1's [PostCompaction contract](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks), which supplies a nullable summary after compaction. Add permitted incremental prompt/tool capture before loss and verify any further source/flush route; the summary alone cannot prove pre-compaction preservation. Test inherited Claude configuration and duplicate handlers independently from Cascade/Devin Desktop. |
| Devin cloud | Keep AZ2's separate authentication, session/source and knowledge-exchange work. Establish an authorised automatic checkpoint source and durable selected-store route before claiming preservation; CLI/desktop lifecycle results do not establish cloud access. Track the missing capabilities rather than silently dual-write or rely on manual export. |
| Grok conversations: web / mobile and other supported modes | Extend AZ3's official connector pilot with a separately verified automatic input/checkpoint source, persistence and restore path. Tool discovery or built-in memory is not a compaction event stream. Keep inaccessible history/lifecycle cases as explicit AZ6 blockers. |
| Grok Bot: private / team / command / remote modes | Extend AZ3's Bot-computer and authenticated identity/store mapping. Verify permitted runtime/checkpoint/trajectory sources, group/private isolation, compaction/resets and installed scripts on the actual Bot computer. Do not infer a user laptop's hooks/store or automatic capture from remote MCP connectivity. |
| Muse | Retain AZ3's unresolved product/runtime identification as an owned coverage blocker. Once the exact available agent is identified, register its official hooks/SDK/MCP route and test the same save/restore contract; a name alone is not evidence of a supported interface. |
| Every other compatible MCP client and custom CLI / HTTP / TypeScript / Python agent | Provide the common adapter/capture contract and a registration recipe over Hippo's existing public surfaces. When a developer owns the harness, wire supported turn/message checkpoints and a before-compaction/trim/reset flush once, then operate automatically. For external clients, discover and verify their supported interfaces first. MCP memory tools alone do not report lifecycle events; never label tool-only connectivity as automatic preservation. New named clients enter AZ6's register and the same low-touch acceptance suite. |

- **Durable before loss.** Capture supported material incrementally under S6, with stable runtime/session/turn/source identities and a progress cursor, so an early decision is not lost outside a last-message tail. At pre-compaction, flush already validated memory candidates and the applicable working-state checkpoint within the host's time budget. If semantic extraction must finish later, persist permitted bounded evidence as pending work before loss; distinguish a durable receipt from a saved lesson. Do not count an empty event record as memory preservation or depend solely on the newly compressed summary or a normal SessionEnd.
- **One common safe write path.** Reuse S6/Z3b's idempotent writes, correction/version/provenance checks, scope and source permissions, secret exclusion and retention policy. Keep raw compaction/transcript receipts outside FTS, ordinary recall and automatic injection. Respect the agent-memory keep rules, compaction-table separation and reversal/history contracts. Optional CLF6 screening or generative extraction must not become a mandatory model/key/network dependency for basic capture.
- **Recovery without routine intervention.** Preserve bounded progress/spool/retry handling for busy stores, killed hooks, duplicate/out-of-order events, crashes and offline endpoints. Register a maximum capture/write delay and an explicit retention/backlog policy. Keep compaction and the user's task moving on failure; never block or repeatedly restart compaction to force a save. Report pending, skipped, failed or unsupported capture rather than an unconditional success, and recover automatically when the store/provider returns.
- **Restore useful context.** Verify same-session resume and a later session/agent retrieving the appropriate saved lesson from the selected canonical store, with correct project/tenant/source permissions and bounded context. Do not dump all preserved state into every prompt, silently replicate the store, reuse another concurrent session's snapshot or assume a post-compaction SessionStart exists everywhere.
- **Engineering and outcome evidence.** Reuse CS1's fixtures plus real supported host runs for automatic/manual repeated compaction and rolling context loss. Test an early correction/decision, near-threshold contexts, long sessions, missing payload/summary/transcript, process death, quota/outage, concurrency, worktrees/nested/projectless discovery, wrong tenant/project, opt-out, upgrade and uninstall. Assert useful memory/checkpoint persistence before loss separately from event receipts, post-compaction extraction and actual resume delivery. Compare preservation quality, false writes, duplicates, tokens, caller latency/cost and developer/admin effort under Z0/Z10/Z12/EI12; a hook firing is compatibility evidence, not task benefit.

**Exit.** Every named current Hippo integration and documented MCP client has an individual implementation/verification entry in AZ6; none remains hidden in an unowned other-agents bucket. For every claimed automatic surface, versioned live evidence shows one-time setup followed by preservation and useful recovery, with no per-compaction command or routine memory review. Where a true pre-compaction hook is absent, state the tested incremental-checkpoint guarantee and its coverage/delay. Missing sources/events remain coverage blockers, and the all-agents goal is not marked complete while available named modes lack a validated route. Existing capture stays available; new adapters/behaviour follow their parent flags, default-freeze and quality gates.

### AZ5. One-time setup and verifiable automatic-capture health [planned; hard: AZ6 foundation, relevant AZ4 mode, CD1; release gate: MSG6; added 2026-10-02]

- Make the authorised `hippo init` / `hippo setup` or native plugin journey detect supported installed agents, select the store and wire the relevant adapters in one guided setup. Use AZ6's full inventory, including OpenCode/OpenClaw/Pi packages and named MCP clients; replace manual extension-copy/hook-edit journeys with supported one-time installers where possible. Explain package installation versus integration, local versus remote execution and required host trust once. Do not silently wrap binaries, bypass trust, deploy remote scripts or enable customer-data egress from npm postinstall. Discover newly installed agents through an actionable setup/doctor check rather than assuming their hooks are present.
- Merge/update/uninstall only Hippo-owned configuration; preserve third-party handlers and avoid duplicates across user/project/plugin/imported configuration. Test executable discovery, Windows/macOS/Linux, supported Node/SQLite environments, version upgrades and explicit opt-out. Ordinary tasks and compactions need no repeated flags or save commands after setup.
- Extend `hippo doctor` and existing status/log surfaces to distinguish detected, configured, trust-required, executable-ready, capture-observed, memory-committed, pending and unsupported. A hook file's presence is not a verified save. Where host trust cannot be inspected, report unknown/trust-required rather than inventing approval. Offer a bounded synthetic readiness probe with no private transcript upload, and show concise last-success/failure/backlog/source-coverage evidence.
- For enterprise, CD1/EI10/EV6-EV8 govern approved script/adapter deployment and selected storage/data policy, so admins configure and maintain the integration once wherever the host permits managed settings. Keep basic adapter/setup/health functionality in MIT; org identity, managed rollout and reporting remain commercial. Count both developer and admin setup/recovery work and respect mandatory per-user host trust where it cannot be managed.
- Add the exact install-to-automatic-capture promise to MSG6's canonical facts and verify README, integration recipes, agent-install guidance, CLI help, hippo-memory.com, npm and enterprise content for the actual release. Distinguish before-compaction checkpoint/save, after-compaction extraction, session-end capture, model-initiated tools and manual imports. Do not advertise universal automatic saves until each mode's evidence exists.

**Exit.** A new user can complete the documented one-time setup and required trust, see an honest per-agent readiness result, then continue ordinary work without routine memory administration. An enterprise pilot demonstrates the managed route and total setup/recovery burden. Release checks catch any platform or install-only claim that outruns tested capture coverage.

### AZ6. Complete agent inventory and shared capture conformance [planned; foundation first; completion: AZ4/AZ5 and applicable AZ1/AZ3 modes; release gates: CAE6/CAE7, MSG6; added 2026-10-02]

**Scope.** Deliver automatic pre-loss memory preservation for all available Hippo-integrated agents and named compatible clients, with an extensible path for others. The dated AZ4 inventory is the starting backlog, not a permanent fixed list. Prioritise the six named framework integrations, named MCP clients and ChatGPT, then the remaining AZ targets; phasing does not remove them from required coverage.

**Foundation milestone [next in the current execution index].** Publish the initial versioned inventory, named owners/next actions, shared S6/AZ4 input/receipt/checkpoint/progress contract and reusable conformance fixtures before new adapter/setup work. Derive it from existing integration source and claims; it does not wait for AZ1-AZ5 to be complete or for every CAE6/CAE7 release probe. AZ4 and AZ5 depend on this foundation slice, not AZ6's final all-agent completion. This milestone is still implementation work, not a claim the registry or automation ships from this wording amendment.

- **One registry, no omitted integrations.** Maintain a versioned product/runtime/mode inventory derived from hook detection, plugin/extension packages, integration recipes, public SDK examples and current README/website/npm claims. For each entry record current integration type, owner, primary interface/version, actual input coverage, native pre/post-compaction versus incremental checkpoint route, before-trim/reset coverage, setup/trust/deployment, canonical store/scope, budgets/delay, tested save/restore evidence, status and next action. Separate shipped integration, planned automation, verified automation and blocked/unsupported modes; unknown is not pass.
- **Common adapters and fixtures.** Normalize native payloads into the S6/AZ4 receipt/candidate/checkpoint/progress contract while preserving source identity and permission semantics. Reuse one conformance family for early lessons/corrections, automatic/manual repeated compaction, rolling truncation, crash/retry, missing input, offline/busy store, concurrency/forks, wrong tenant/project and resume/cross-agent retrieval. A shared model/provider is not a shared host lifecycle: test the harness that actually owns context.
- **Live proof and timing.** For every enabled adapter, observe install/trust, real event/source capture, committed memory/checkpoint before loss and actual later delivery. Record asynchronous hook and deletion/pruning races and a maximum validated save delay. Keep fixture-only and live-host verdicts separate. Do not mark a pre-event enum, summary injection, event receipt or successful MCP response as a saved useful memory; test memory eligibility/support independently.
- **Growing coverage.** Reconcile named support claims with the registry in CI/release review under MSG6, with human review for new product names/aliases and current interfaces. A new named integration automatically creates a preservation/setup verification requirement. Recheck supported client/plugin/SDK upgrades through CAE7. Missing upstream events/source access have an owner, an incremental-route investigation and a compatibility recheck; do not substitute routine manual saves or browser scraping and call the goal complete.
- **Low-touch core and enterprise.** Use AZ5's one-time project/admin setup and truthful doctor/status results for every adapter, with bounded automatic recovery and exception-based reporting. Preserve shared MIT contracts/basic installers/health plus commercial identity/managed rollout/reporting ownership. Test deployed scripts, remote worker store access and required host trust per environment; after approved setup, users should not curate every memory or operate per-agent save commands.

**Completion milestone.** Populate each foundation entry with the relevant AZ4 capture/recovery and AZ5 setup/health implementation plus live save/restore/delivery evidence. Conditional AZ1/AZ3 adapters apply only to their modes; CAE6/CAE7 and MSG6 gate affected compatibility/release claims. Report the full required inventory, achieved coverage and blocked/unknown entries separately. Missing upstream events or source access remain owned blockers with an incremental-route investigation; do not remove a mode from the denominator to claim universal completion. Preserve checkpoint-before-loss versus post-compaction extraction timing, registered delay/quality bounds, and separate configured, live-compatible and task-benefit status.

**Exit.** The complete inventory agrees with all current support claims; each available claimed automatic mode passes its own save/recover/deliver and burden checks, and every remaining platform gap has an explicit owner/status. Track completion and release wording distinguish achieved coverage from the still-open all-agents goal. Optional rich UI, a particular model backend or a paying-customer request is not a prerequisite for implementing basic preservation on an already supported agent.

### Other surfaces: required coverage queue, phased by adapter readiness

AZ4 and AZ6 now hold the explicit per-agent capture inventory, including OpenCode, OpenClaw, Pi, Windsurf/Cascade, Cline, VS Code/Copilot, Gemini CLI and the existing Devin/Grok/consumer targets. Implement native hooks where verified and durable incremental checkpoints where supported; retain actual source gaps as owned blockers. Existing MCP recipes remain useful for tool access while lifecycle automation is built. This supersedes the earlier Cline/VS Code demand-only adapter wording for basic automatic preservation; CD3's visual extension remains optional.

### Next 90 days: gated milestones

**Supporting stage detail, not a second active queue.** These 2026-09-30 milestones retain the existing protocol and gates. The [current execution index](#current-execution-index) orders current work and the AZ6 foundation precedes AZ4/AZ5 delivery; calendar wording is not a result or refreshed capacity forecast.

1. Extend Z10, test capture/recovery fixtures and prototype S0/S9 on development data while completing Z0 stage 0. Then smoke, calibration, freeze and the scored write-up under the existing plan-usage go. Publish whatever the verdict is; prototypes need not wait for that write-up, and the calendar is not a result.
2. Prototype S0/S9 on the existing store, with equal-budget chunk controls, evidence scoring and the retrieval floor. Dogfood development data without spending held-out sets.
3. Run S1 ablations, then S3/S4/S5/S6 in the order the trace identifies. Prepare Z12 burden labels and growth fixtures on development data alongside Z10; scored extensions need their own freeze. Keep current defaults and capture paths.
4. Confirm Z1d and Z3b on fresh registered Z0 families, then the combined arm. If repeat mistakes or task quality regress, fix writes/admission and retain defaults.
5. Prepare AZ3 compatibility fixtures and ChatGPT/Claude packaging for an available pilot; add Grok/Grok Bot with real demand and source/scope coverage. Add AZ1 only for an actual Devin pilot; verify Cursor/Gemini capability instead of deferring them on obsolete hook assumptions. Add S2 only for demonstrated paraphrase misses. AZ2 and S8 remain deferred.

No new spending authorization, release, live-store migration or installer run is implied by these milestones.

### Evaluation drafts

The following files are **DRAFT / NOT REGISTERED**, not empty registrations. They contain hypotheses, proposed arms, primary metrics, controls and the decisions required before a freeze. No experiment has run under them, no default changes, and no result is implied. Fill corpus snapshots/hashes, independent hold-outs, sample/power rules, acceptance bounds, scorer, stopping rules and resource authorization before changing their status.

| Draft | Scope |
|---|---|
| [Z10 ledger](docs/evals/2026-09-30-z10-ledger-prereg.md) | Trace correctness and overhead, linked to Z0 validity/H4. |
| [Z12 supervision/growth](docs/evals/2026-09-30-z12-supervision-growth-prereg.md) | Correction burden, quality and reliability as unrelated history grows; fresh task registration. |
| [Z1d trigger/gate](docs/evals/2026-09-30-z1d-trigger-gate-prereg.md) | Useful delivery and a fresh Z0 task family. |
| [Z3b correction writes](docs/evals/2026-09-30-z3b-correction-write-prereg.md) | False closure and a fresh Z0 reversal family. |
| [S0 claim units](docs/evals/2026-09-30-s0-claim-units-prereg.md) | Representation, evidence and the recall floor. |
| [S1 ranking](docs/evals/2026-09-30-s1-ranking-ablation-prereg.md) | Ranking/outcome ablations and the recall floor. |
| [S3 temporal closure](docs/evals/2026-09-30-s3-temporal-closure-prereg.md) | History semantics, integrity and the recall floor. |
| [S4 hygiene](docs/evals/2026-09-30-s4-sleep-hygiene-prereg.md) | Reversible merges, evidence preservation and the recall floor. |
| [AZ1 Devin](docs/evals/2026-09-30-az1-devin-hooks-prereg.md) | Versioned delivery fixtures and a separate runtime task family. |
| [AZ3 cross-platform connectors](docs/evals/2026-09-30-az3-consumer-connectors-prereg.md) | Packaging/identity/delivery fixtures, then fresh runtime task and supervision evidence. |

---

## Part XIX - 2026-10-01 update: wording amendments for core and enterprise

### Track MSG - Product wording [planned; documentation and messaging only]

**Purpose.** Keep "memory" as the product category while explaining the architecture precisely: persistent state is stored outside the model; context management selects and formats what reaches the model; harness integrations connect capture and recall to supported runtime events. Persistent agent memory does not require changing model weights. Hippo implements memory and supplies context through integrations; it is not a general optimiser of an agent's entire execution harness.

This is a follow-up to FE4 and supports EV5/CD10. It changes no feature, default, licence boundary or evaluation gate, and does not displace Z0's priority.

### MSG1. Align core and enterprise positioning [planned]

Use the following as the copy direction, with capability and status qualifiers next to the relevant claim:

| Edition | Lead | Technical explanation |
|---|---|---|
| Core | Local-first persistent memory for AI agents. | Stores experience across sessions and supplies selected memories through hooks, MCP and APIs. Uses outcome feedback and supersession to update what gets recalled. |
| Enterprise [planned] | Shared organisational memory for AI agents. | Planned extensions add company identity, team and project administration, and governance to the open-source memory engine. |

- Distinguish the memory lifecycle from context selection and runtime delivery. Describe Hippo as persistent memory with context management and harness integrations.
- Do not reduce it to a context pruner: storage, writes, provenance, supersession and continuity persist beyond the active context window. Do not imply that it rewrites or prunes the host agent's entire conversation.
- Keep the hippocampus framing as design inspiration, with measured findings and limitations beside mechanism claims.

- Additional positioning direction: **"Continuous improvement for agent memory through context engineering and harness integration."** Keep persistent memory as the product category; explain the shipped outcome-feedback mechanism separately from the planned CAE eval workflows. Apply the same distinction to core and enterprise copy, retaining enterprise capability/status qualifiers.

### MSG2. Correct RAG and learning claims [planned]

- Replace "RAG searches a fixed corpus" in the README and website FAQ. Retrieval-augmented generation can use an updated corpus; distinguish Hippo by its writable memory lifecycle and integrations rather than an artificial static-corpus restriction.
- Qualify "learns what is wrong" and "stops repeating it". Prefer "ranks memories down when reported wrong" for the outcome mechanism. Feedback can come from a user or an agent; it is a signal, not independent proof of truth.
- Explain that supersession retires a fact when a replacement is supplied. Automatic truth detection, reliable correction capture and autonomous supersession remain subject to their Track Z experiments and gates.
- Separate a mechanism from a demonstrated benefit. Retrieval quality, installation success or a smaller memory block does not establish fewer mistakes, lower total cost or less human supervision. Preserve negative results and the Z0/Z10/Z12 evidence requirements; do not add unmeasured savings or reliability guarantees.

- Qualify continuous-improvement claims: outcome feedback updates memory ranking today; CAE's maintainer-invoked eval design, bounded optimisation and independent confirmation remain planned. Neither guarantees autonomous learning or a task-benefit gain.
- Reserve **"RL environment for agent memory"** for optional LC4 / Track G research until there is a documented observation/action space, resettable episodes, action-to-state transitions, independently checked rewards, termination/truncation semantics and a reproducible learner interface (see the [Gymnasium environment contract](https://gymnasium.farama.org/api/env/)). An environment can serve an external learner without fine-tuning the host LLM; claiming RL-driven improvement additionally requires evaluated policy updates. Memory-strength feedback and prompt hillclimbing alone do not establish that capability. Suggested research wording: **"Persistent agent memory with eval-driven optimisation and reinforcement-learning support on the roadmap."**

### MSG3. State delivery defaults and integration limits [planned]

- Document the shipping per-prompt path accurately: pinned memories plus five recent memories on supported installed hooks, with unchanged-block suppression and refresh behaviour where configured.
- State that prompt-matched recall is opt-in. Do not claim that every prompt or edited file automatically receives exactly three or four relevant lessons.
- Describe `hippo context --auto` as assembling context through git-aware recall and saved task state. Snapshot saving and context restoration are distinct operations; do not describe the command as automatically snapshotting the terminal.
- Keep a runtime-specific compatibility matrix: hooks, instruction-file guidance, MCP/API tool access, event/capture coverage, required trust or opt-in steps, and unsupported modes. An available MCP tool alone does not guarantee automatic invocation or capture.

### MSG4. Make enterprise status consistent [planned]

- Preserve the enterprise README's scaffold status until features are implemented and verified. `registerEnterprise(api)` is currently a stub; proposed enterprise capabilities are not shipped functionality.
- Use future tense or an adjacent "planned / in development" label for SSO, SCIM, company identity, team/project administration, source-permission-aware recall and approval-based promotion while those capabilities remain pending.
- Align the public teams page's hero, deployment diagram, feature labels and pilot offer with the enterprise README. Present existing tenants, API keys, roles, scope grants, audit, dashboard and connectors as MIT core capabilities, preserving EV1's open-core boundary.
- Label proposed pilot measurements separately from completed results. Reconcile deployed website copy with repository source when the wording amendments are published.

### MSG5. Surfaces and completion checks [planned]

**Surfaces.** Core `README.md` and current repository docs, including agent-facing installation guidance; website shared content, hero, FAQ, how-it-works, comparison, teams and metadata; GitHub repository description; `package.json` description/links and the README/metadata on the published npm package page; enterprise `README.md` and buyer-facing descriptions. MSG6 owns cross-surface consistency and publication verification.

- [ ] Core copy consistently distinguishes persistent memory, context management and harness integration.
- [ ] The fixed-corpus RAG claim is removed from current product copy.
- [ ] Outcome, supersession, automation and delivery claims match the shipping implementation and defaults.
- [ ] Enterprise copy consistently distinguishes shipped MIT features, the commercial scaffold and planned capabilities.
- [ ] Performance claims retain their metric, setup, evidence link and limitations; no task-benefit claim is inferred from retrieval alone.
- [ ] Documentation links and website rendering/build are checked when implementing the copy changes.
- [ ] Repository source, deployed website and the actual published npm README/metadata agree for the stated release and edition after publication; unreleased repository changes are clearly labelled.

**Completion.** Mark this track done only after the wording changes themselves are implemented and checked across both editions. Recording this roadmap item does not complete the amendments.

---

### MSG6. Keep website, GitHub and npm content consistent [planned; release requirement, added 2026-10-02]

**Goal.** Users should get the same accurate product facts wherever they discover or install Hippo, without reconciling conflicting descriptions themselves. Different page formats may use different wording; claims, capability/status, defaults and evidence must agree for the stated version and edition.

- **Canonical facts.** Maintain one reviewed, versioned claim/capability inventory in the repository: positioning and terminology from MSG1-MSG4, shipped versus opt-in/planned features, supported runtime/capture paths, install prerequisites, model/network behaviour, licence and core/commercial ownership, and benchmark metric/setup/source/limitations. Identify the owner and source for each claim. Generate reusable copy where practical and validate manually written sections against this inventory.
- **All current surfaces.** Inventory the full website (including teams/pricing/comparison pages, FAQs, SEO/Open Graph/structured metadata and agent-facing text), GitHub README/description/current docs/examples, package metadata and npm-rendered README/links. Include enterprise README, buyer copy and any future separate package listing. Historical releases, changelogs and eval records retain their dated evidence/status; link to current corrections rather than rewriting the audit trail.
- **Version-aware release checks.** Compare the intended npm release's packaged README and metadata with its GitHub tag and website's stated release. Distinguish development-branch additions from npm `latest`; keep planned enterprise capabilities explicit. Add a release checklist/check that catches contradictory claims, obsolete commands, broken npm-relative links and unexplained version/edition differences, with review for prose a script cannot establish.
- **Publication and verification.** Update source copy together, then use the existing website/package release processes and verify the deployed pages plus actual registry/package-page content after publication. npm's [README guidance](https://docs.npmjs.com/about-package-readme-files/) says the displayed README updates when a new package version is published: a GitHub README commit alone does not update that page. Record the checked commit, site deployment, npm version/dist-tag and any remaining discrepancy; route failures to the release owner.
- **Low-touch maintenance.** Run feasible checks in existing CI/release workflows, show a concise actionable diff and avoid adding a routine customer task. Re-check affected claims after capability/default/edition changes and after corrections or retractions.

**Exit.** MSG5's wording amendments are implemented and every current surface has been checked against the same facts, with version/edition differences explained. A roadmap commit is not evidence that live copy has been synchronised. No new release or deployment is performed by adding this item.

**CLEF publication [planned; CLF13].** Include deployment mode, free weights versus hosted allocation/pricing, supported automatic paths, data egress, fallback/defaults and role-specific evidence in the canonical facts. Verify website, GitHub, npm and enterprise descriptions for the actual release; do not advertise the planned CLF track as shipped.

**Compaction and installation claims [planned; AZ4/AZ5].** Keep a release-specific matrix of actual automatic capture/checkpoint/restore coverage and one-time setup/trust requirements. Package install, configured hooks, MCP access, pre-compaction state, post-compaction lesson extraction and manual imports are different capabilities; website/GitHub/npm/enterprise wording must reflect the tested phase and exact runtime mode.

---

## Part XX - 2026-10-01 update: official Claude eval workflows

### Track CAE - build-eval / hillclimb and Hippo-native improvement pilots [planned]

**Purpose.** Explicitly adopt Anthropic's `/claude-api build-eval` and `/claude-api hillclimb`, beyond the principles already referenced in TE5 and Z1. Research and copyable setup/invocation examples: [Claude eval workflow adoption](docs/plans/2026-10-01-claude-api-eval-workflows.md). The inspected official docs bundle both subcommands from Claude Code **2.1.259**; verify the loaded version and origin before use.

These are maintainer-invoked workflows around existing evals. Keep Hippo's shared runtime provider-neutral and preserve the [no-dispatch boundary](docs/plans/2026-09-12-work-plane-boundary.md). This track installs no skill today, runs no paid evaluation, changes no defaults and does not reopen a locked registration. Z0 remains the primary queue; setup, adapters and fresh development cases can proceed alongside stage 0/smoke preparation.

**Harness reference follow-up (2026-10-02).** Use the [awesome-harness-engineering collection](https://github.com/ai-boost/awesome-harness-engineering) as a source index. CAE6 and CAE7 adopt the relevant tool-contract and upgrade-revalidation practices from the primary guidance linked below; the collection is not a runtime dependency or an installation prerequisite.

**Product and enterprise review (2026-10-02).** Build Hippo's own memory lifecycle, supported runtime adapters and learning surfaces. ECC is a research reference and optional isolated comparator; this roadmap schedules no ECC product integration, vault adapter, combined deployment or required installation. The commercial edition extends Hippo's public API, with ownership and packaging governed by EV1; it is still a scaffold, not evidence that the capabilities below ship.

| Items | Decision and product ownership |
|---|---|
| CAE0-CAE5 | Keep as optional maintainer eval/optimisation tooling. Neither edition requires these skills or a Claude account to operate; use existing provider-neutral runners for customer environments. |
| CAE6-CAE7 | Keep as native contract/release-quality work across supported core and enterprise configurations. Authentication, source access and group/role revocation remain hard correctness requirements. |
| CAE8 | Re-scope to one measured improvement in Hippo's own capture/context/harness path. ECC comparison is research-only and subordinate to the built-in-memory baseline; remove coexistence/interchange delivery work. |
| CAE9 | Keep Hippo-owned lesson validation, skill artifacts and lifecycle in the MIT core. Planned org administration, IdP/team mapping, layered-role policy, managed rollout and SIEM/buyer reporting belong in the commercial package through EI11, EV6-EV8 and CD6/CD11-CD12. Basic self-hosted sharing, grants, audit and existing core capabilities stay MIT. |
| CAE10 | Adopt the accepted CLEF integration through Part XXI, CLF0-CLF13. Ship a shared Hippo decision contract with CLEF-flash/CLEF and private-endpoint adapters; use the existing eval workflows to confirm each role. Keep native fallback, explicit provider/data policy, MIT/commercial ownership and enterprise gates. |

**Customer data and effort.** Maintainer commands default to synthetic or permitted sanitised development cases. Customer history, skill bodies and traces stay within the customer's approved deployment/provider/retention boundary; do not send them to public community plugins or an external judge without explicit data/provider authorisation. Air-gapped/customer-endpoint deployments use EI10's supported path, with drafting disabled if its optional model is unavailable. After a project/admin configures policy, automate routine work within that policy and report actionable exceptions. Count both developer and administrator setup, review, rollout and recovery effort in Z12/EI12; a new curation job is not a low-touch benefit.

**Order.** These are gated native experiments, not additional Enterprise v1 release prerequisites. Z0 runner/smoke work retains priority; close source-permission/identity and deployment gaps in EI2/EI10/EI11 and EV6-EV8 before enabling their dependent shared-org capability. Keep all locked registrations, defaults and the no-dispatch boundary unchanged.

### CAE0. Install or enable the official workflows [planned; first]

- Check `claude --version`, `claude doctor`, `/skills` and slash completion on the pilot machine. Prefer the bundled `/claude-api` skill on Claude Code 2.1.259 or later; upgrade using its existing installation channel if needed.
- If the bundle is unavailable or a separate source distribution is needed, add `anthropics/skills` and install `claude-api@anthropic-agent-skills` at local scope. Verify its namespaced `/claude-api:claude-api build-eval` and `/claude-api:claude-api hillclimb` commands. Resolve disabled bundles and name overrides instead of silently invoking a different skill.
- Record Claude Code version, skill origin/revision/file hashes, model, explicit effort and account/usage route. Freeze the resolved distribution for a registered run; the research note records the inspected upstream revision.
- Smoke the loaded commands in a disposable development checkout through their scope/input/plan stages. Review installation output and any API requirements; a subscription session and separately billed SDK/judge calls are different resource routes. Do not add this installation to `hippo init`.

**Exit.** Both commands load the expected official workflow on the pilot machine, setup is reproducible, and the smoke is recorded separately from any scored result.

### CAE1. Adapt and audit the existing eval infrastructure [planned; CAE0, TE5/Z0 stage 0]

- Reuse `scripts/token-eval/` runners, graders and registrations. Add a thin adapter for rep-specific `results.jsonl`, observable `traces/`, summary, state and variant diffs; add only a focused trigger runner if the complete-task runner cannot measure Z1 invocation.
- Close TE5/Z0 grading, timeout-denominator and retry-state defects before scored use. Preserve both project-store and `HIPPO_HOME` isolation; prevent answer leakage from retained files, history or memory.
- Match grades, actual served model, four-bucket usage, latency and trace to the same attempt. Resume idempotently and report invalids by arm/reason. Unknown usage or delivery is not zero; arm-caused timeouts remain unresolved with observed cost.
- Verify aggregate scores against raw rows, known-good/bad grader examples, repeated grading, mechanism wiring, headroom and baseline noise. Keep Hippo's registered statistical analysis authoritative.
- Use the report builder actually present in the loaded skill. The inspected public source supplies `build-report-lite.mjs`, not the full viewer; validate trace links before offering reports. Keep permitted private snapshots/traces outside the repo, with hashes and retention.

- CAE6 supplies transport/tool contract fixtures; CAE7 adds a versioned execution manifest and upgrade-triggered smoke/replay checks. Join protocol failures and infrastructure faults to the attempt ledger without relabelling agent-caused failures as invalid.

**Exit.** A fixture run produces faithful results and a readable report, survives interruption/retry without cross-attempt contamination, and has a documented failure policy. No new runner framework or Anthropic SDK migration is required.

**CLEF eval adapter [planned; CLF12].** Extend existing result/trace manifests for requested/actual provider and model revision when known, decision schema/input bounds, candidate/evidence versions, fallback, quota/cost and cache/quantisation mode. Reuse the same deterministic scorers and attempt accounting; do not replace independent labels with the candidate model's own verdict.

### CAE2. Invoke build-eval for the Z1 pull-arm trigger pilot [planned; CAE0-CAE1]

Run `/claude-api build-eval` against the Claude Code `hippo_recall` trigger flow, using the example in the research note.

- Review and explicitly approve inputs, grading and resource ceilings through the upstream workflow. Source independently labelled fresh cases representing real task families, with applicable-memory and no-match tasks plus distractor, stale/conflicting, wrong-scope and absent-data cases.
- Freeze independent family-level train, validation and sealed final-test splits. Locked Z0 and Z1c corpora/answers stay outside the workflow.
- Programmatically measure useful invocations and unnecessary invocations separately; calibrate independent usefulness judging only where needed. Verify the real installed MCP tool and description, without conflating invocation, delivery, application and task benefit.
- Establish baseline repeats, variance/headroom, minimum useful change, guardrail bounds and adequately sized cases/repetitions before tuning. Review example grades with their actual traces.

**Exit.** A reviewed, runnable development eval, frozen starting description and baseline report exist, with input/grading/resource decisions and split manifest recorded. A smoke or synthetic trigger score is not a task-benefit result.

### CAE3. Invoke bounded hillclimb on the recall description [planned; CAE2]

Run `/claude-api hillclimb` with only the `hippo_recall` description editable. Constrain the exact surface in `src/mcp/server.ts` or an isolated description configuration; a whole-file allowlist alone does not protect the implementation.

- Freeze model/effort, tool implementation/schema, other tools, fixture stores, runner, grader, labels, split and shipping defaults. Register useful-invocation gain, no-match harm bounds, repetitions, maximum rounds, plateau rule, elapsed-time and usage/spend ceilings before round one.
- Propose one reversible change per round from train diagnostics. Use validation aggregates for keep/revert decisions; the proposer cannot access sealed final-test cases, answers, traces or summaries through files, memory, git history or network.
- Keep `_state.json`, baseline/`v<N>` results, `change.md`, `change.patch`, per-round metrics and decisions, including failed/reverted attempts. Stop on regression or resource cap; after the registered plateau rule (at least three rounds in the inspected guide), diagnose the remaining train failures before more edits.
- Keep the eval and grader outside the optimiser's edit scope. Version and consistently regrade/rebaseline an independently fixed eval defect; never weaken tests or paste case-specific answers into the description.
- After the interactive pilot, test optional `claude -p "/claude-api hillclimb ..."` invocation with the approved plan persisted, bounded permissions, cancellation/resume and event logging. Headless skill expansion is documented; an unattended Hippo integration remains unverified. Do not bypass upstream review checkpoints.

**Exit.** A reproducible bounded search leaves a candidate patch and complete attempt record. More calls alone cannot pass, and optimisation does not automatically merge, release or promote a default.

### CAE4. Confirm independently before adoption [planned; CAE3]

- Treat the split repeatedly scored during candidate selection as validation, even if the upstream guide names it test. Freeze the selected patch and all run artefacts, then score a separately sealed final set once under the registered protocol.
- Report paired, family/repository-clustered intervals, useful/no-match outcomes, cost, latency and guardrail failures against the frozen starting description; publish a null or negative verdict. Additional tuning after that result requires fresh confirmation families.
- A trigger win only permits the separately registered Z1 pull-arm task experiment. Benefit beyond built-in memory and any default promotion still require Z0; preserve Z1c, the retrieval floor and Z10 delivery/application distinctions. Keep the Codex comparison as its own runtime evidence.

- CAE7 scopes evidence to the frozen model/runtime/resource configuration. An upgrade requires its own comparison and, before renewed benefit claims or default promotion, fresh independent confirmation under an appropriate registration; do not reuse a repeatedly inspected final set.

**Exit.** A frozen-confirmation report and explicit adopt/reject decision exist. No claim of fewer mistakes or lower total cost from a trigger score alone.

### CAE5. Apply the workflows to existing roadmap items [planned; parent gates retained]

**Coverage.** All 46 parent items covered by this application map, including SI1's attempt-history follow-up, carry direct workflow adoption notes. These are planned execution tasks: each specifies eval design, an eligible bounded optimisation surface or a design-only role, and retains the parent's readiness and release gates.

**Use.** `build-eval` helps source and review cases, calibrate graders and adapt runners. `hillclimb` follows only when that eval can distinguish a useful change on an explicitly editable surface. The following is an adoption map for existing work, not additional feature tracks or evidence that any optimisation has run.

Fresh case/rubric preparation can proceed after CAE0-CAE1 alongside the first Z1 pilot. Repeated scored optimisation follows the CAE2-CAE4 pilot pattern and each parent item's readiness; no need to postpone ordinary deterministic fixtures until the trigger pilot finishes. Scope the commands to the Claude-backed evaluation flow and preserve other providers' runners. For a small finite parameter space, use the existing deterministic sweep/grid first; do not add model calls solely to choose a threshold.

| Existing items | Use `build-eval` for | Bounded `hillclimb` target / adoption condition |
|---|---|---|
| **Z1 pull arm; CD1/CD10 tool guidance** | Applicable-memory and no-match invocation cases, real tool exposure, valid/invalid argument checks and safe sandbox installation tasks. | First pilot: `hippo_recall` description only (CAE2-CAE4). Later, separately test short usage/instruction text against successful supported actions and needless calls; install scripts, trust settings and tool schemas stay fixed. |
| **Z1d / TE6 admission** | Label whether evidence bears on the task, including indirect continuation, distractors, wrong scope, contradictions and missing inputs; separate delivered coverage from application. | Query construction or relevance-gate prompt/threshold, one surface per arm after Z10. Preserve useful coverage, no-match harm, token and latency bounds; retain Z1c's locked window and the cheap replay-first check. |
| **SI4 / S0 / S6 / EI1 / Z9 writes** | Review source-to-memory pairs: durable lessons versus transient/code-derived noise, full conditions/Why/How, provenance, duplicates and missed lessons. Include git diffs/bodies and the real capture events. | One opt-in extraction prompt or `hippo_remember`/capture instruction surface at a time. Improve write precision and coverage without losing evidence or crossing scope. Independent memory builds, capture/retry fixtures and the retrieval floor remain required. |
| **Z3 / Z3b / Z6 / S3 corrections** | Independently label correction detection, addressed claim and supported replacement separately; include quotes, hypotheses, branch/time applicability, wrong corrections and reversals. | Optional detector or semantic matching prompt/threshold in isolated stores. Measure false writes/closures and supported coverage. Atomic closure, historical semantics and permission rules remain invariant; task adoption requires a fresh stale-follow family. |
| **S9 / TE3 / TE7 / Z9 index and verification text** | Equal-budget evidence-completeness and downstream application cases; cached/uncached cost, stale-follow and missing-qualification checks. | Compact rendering, index descriptions or the verify-before-use instruction, one at a time. Keep the 1,500-token cap, pins, provenance and source conditions. Verify actual cache/usage and task quality, then confirm on fresh families; shorter text alone is not the goal. |
| **S1 / S2 / FE3 / LC3 retrieval** | Audit relevance labels, family splits and real CLI-budget coverage; add the Claude-backed downstream task check where needed. | Only preregistered ranking weights, candidate settings or an optional reranker prompt on development data. Deterministic sweeps precede agent search. Keep mandatory admission and the recall floor; LC3 still needs its outcome-data floor and S2 a measured paraphrase gap. No tuning on published benchmark test answers. |
| **S4 / TE9 / D10 consolidation** | Label equivalent versus distinct assertions, scope/exception preservation, provenance and reversibility; score recall and task effects on independently rebuilt stores. | An already permitted opt-in merge/summary prompt. Judge supported evidence preservation and useful compression together. Keep protected-row rules and reversible writes; a generated summary cannot create new facts. |
| **Z2b / SI0 / S5 outcome-linked experience** | Known helped/harmed/ambiguous signal cases with delivered IDs and check evidence, including unrelated passes and failures. | An optional experience-extraction/classification prompt after attribution fixtures pass. Unknown remains unknown; promotion/feedback rules cannot be optimised to reward the optimiser's own verdict. Preserve SI0's validity checks and its separate task registration. |
| **W1 / CS1 / Z7 / W3 handoff and resume** | Resume tasks from an envelope alone, early decisions lost by compaction, missing sidechain lessons and interrupted capture. | Bounded handoff/continuation wording or summary selection on the Claude side, once capture/delivery mechanics pass. Preserve constraints, evidence, next action, isolation and same-runtime parity; another runtime requires its own test. W3 still prints launch recipes and starts no runtime. |
| **CD5 / SI3 / EI2 / AZ3 / EV8 trust and integration** | Independently labelled poisoning and legitimate-content cases, quarantine release/rejection, permission-negative fixtures, connector capability and actual invocation/delivery. | Optional untrusted-content detector or integration/tool instruction text only after hard-policy fixtures pass. ACLs, tenant/project isolation, quarantine access and supported lifecycle events are fixed correctness requirements, never score/cost trade-offs. Claude Code tooling does not establish support in another client. |
| **Z0 / TE5 / F8 / Z12 evaluation design** | Review fresh development task families, executable acceptance checks, grade stability, controls, growth conditions and burden labels. Reuse the current runner/analyser. | Component candidates are tuned in their separate development flows, then frozen before task confirmation. The Z0/Z1c registrations, final-test tasks, judges/labels and Z12 intervention protocol remain outside search. Synthetic correction counts cannot establish human-time savings. |
| **EI8 / EI12 / EI13 / CD11 / CD12 tenant evidence** | Adapt reviewed customer development cases and convention/organisational-knowledge rubrics, baseline comparators and cost/telemetry joins under permitted retention. | Optional company-specific extraction/admission text on isolated development history, after source access and independent labels are established. Customer shadow hold-outs, assignment, buyer metrics and reports stay outside optimisation; no tuning on the live control group's outcomes. |

**Order.** Keep Z0 runner/smoke work first. Establish CAE0-CAE4 with the recall description; prepare admission and write/correction evals alongside Z10/S0/S6. Choose the next search from the observed bottleneck: not recalled/admitted → Z1d; not written or falsely replaced → SI4/S6/Z3b; useful evidence delivered but expensive/unclear → S9/TE7. Measure single components before their combination. Consolidation, handoff, learned rankers and tenant tuning follow their existing dependencies and demand; security/capture correctness fixtures do not wait for a task-benefit win.

**Cost-specific flow.** Read the upstream cost-hillclimb guide and separately register caching conditions, quality floors and model/effort choices. Keep model changes outside a fixed-model component study. Total accounting includes extraction, embeddings, maintenance, retries and actual cached/uncached usage.

**SI1 extension.** Once enough CAE attempt histories exist, compare recalling previous attempts with the plain attempt log at equal budget. This retains SI1's research status and does not assume memory improves the optimiser.

**Exit.** Each selected application has its own reviewed scope, baseline, family splits, failure policy, resource ceiling and independent confirmation. Eval-design-only uses produce reviewed drafts/fixtures, not automatic feature adoption. Existing public benchmarks, migrations, authentication, retention policy, database scaling and model-weight research keep their own methods and release gates.

**Native applications [planned].** CAE8 uses these workflows to review Hippo-specific capture/context/harness cases; CAE9 uses them for source-to-skill validity and applicability. They extend Hippo's own adapter and skill-lifecycle work, keep existing runners and parent gates, and count developer/admin effort as an outcome. Enterprise permission and deployment rules are fixed outside optimisation.

### CAE6. Audit MCP tool contracts and truthful annotations [planned; CD1/AZ3 integration fixtures]

**Purpose.** Make the advertised tool contract match the real behaviour before optimising how agents choose tools. Follow the supported published MCP revision and the [official tool-annotation guidance](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

- Inventory every tool's inputs, outputs, errors, scope, reads/writes, retry effects and external access. Include recall's retrieval-strength/count updates and any ledger/telemetry writes; a search-like name is not evidence of read-only or idempotent behaviour.
- Add only justified `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` values after that audit, recording deployment differences where needed. Annotations are client hints; server authentication, tenant/actor/project scope and role enforcement remain authoritative.
- Test advertised input schemas against valid, missing, malformed and unsupported arguments; check successful/empty results, output budgets and retry behaviour. Map protocol errors and tool-execution errors correctly for the negotiated revision. Evaluate additive output schemas/structured results where clients support them, preserving existing text clients and public APIs.
- Run reproducible protocol/conformance probes, using MCP Inspector or scripted clients as appropriate, over stdio and authenticated HTTP in isolated disposable stores. Include permission-negative and cross-project/tenant cases; record client, transport and protocol versions. A successful tools/list response does not establish successful invocation or delivery.
- Use `build-eval` to draft/review invocation and error cases after deterministic contracts pass. Any later `hillclimb` edits only the declared description/instruction surface, with schemas, annotations and permissions frozen; contract defects are correctness work, not score trade-offs.

**Exit.** A per-tool side-effect/annotation inventory and repeatable client conformance report exist, including failures and unsupported combinations. Mechanical fixes can ship after their own checks without claiming improved agent task performance or changing memory defaults.

**Enterprise acceptance [planned].** Reuse the same core tool contract in the commercial extension/release matrix. Add actor/group/project-role and revoked-source negative fixtures as EI11/EV6-EV8 become available, including derived skills under CAE9. A tool annotation or licensed feature flag never grants source access.

### CAE7. Revalidate after model and runtime upgrades [planned; CAE1/CAE4, CD1/AZ3]

**Purpose.** Check whether integrations and optional scaffolding still help when their underlying assumptions change. Use Anthropic's [long-running harness guidance](https://www.anthropic.com/engineering/harness-design-long-running-apps) and [infrastructure-noise findings](https://www.anthropic.com/engineering/infrastructure-noise) to design Hippo-specific checks.

- Maintain a versioned run manifest: actual served model/effort, host runtime/client, plugin/skill revision, Hippo commit/settings, hook/MCP transport/schema versions, fixture/corpus/prompt hashes and isolated-store setup. Record execution image/dependencies, CPU/RAM allocation and kill limits, concurrency, timeouts/retries, cache/usage route and pricing basis; mark unavailable fields unknown.
- On a model/runtime/plugin/hook or tool-contract change, rerun the affected installation, invocation, capture/delivery, permission and interruption/resume fixtures first. Use cheap deterministic/smoke/replay checks before a separately budgeted scored experiment; a detected upgrade does not auto-install software or launch paid runs.
- Compare Hippo against the appropriate shipping/built-in-memory baseline within each frozen configuration. To study the upgrade itself, compare old/new configurations explicitly under matched resources; do not attribute a model or hardware change to memory. Preserve the registered timeout/failure policy and report infrastructure incidents separately.
- Ablate optional memory instructions, relevance gates or formatting one component at a time on development/validation families. Record why each component exists and the evidence for keeping/removing it, including task quality, useful/no-match coverage, total cost and latency. Authentication, scope/isolation and protected-memory rules are fixed invariants, outside the ablation/search surface.
- Use `build-eval` to review fresh upgrade/regression cases and grader calibration; use bounded `hillclimb` only if validated headroom warrants it. Freeze a candidate before independent confirmation. Reusable engineering fixtures establish compatibility; renewed task-benefit claims/default promotion still need CAE4 and the existing Z0/retrieval gates.
- Keep locked Z0/Z1c registrations and final windows unchanged. Record a new manifest and an appropriately registered fresh confirmation for the changed configuration rather than silently extending old evidence or repeatedly searching its final set. Revalidation does not delete stored memory or weaken the no-dispatch boundary.

**Exit.** Each supported upgrade has a manifest diff, fixture verdict, component keep/remove decisions and an explicit compatibility-only or independently confirmed benefit verdict. Unsupported/negative results stay visible; Z0 runner/smoke work retains priority.

**Enterprise release follow-up [planned].** Record compatible core/commercial-extension versions and the approved customer deployment/model route. Revalidate membership changes, source revocation and managed artifact rollback alongside runtime upgrades; public Claude tooling is not required in an air-gapped customer installation.

**CLEF revalidation [planned; CLF2/CLF12].** Pin private model/code/head/tokenizer and quantisation artifacts. Hosted model names are not sufficient evidence of an immutable revision; record available metadata and fixed compatibility/drift probes. Provider/schema/serving changes require affected fixtures and fresh confirmation before renewing benefit/default claims.

### CAE8. Hippo-native memory and harness improvement pilot [planned; CD1/AZ3, CAE1-CAE7, EI12]

**Purpose.** Build and measure improvements in Hippo's own capture, context delivery and memory lifecycle that reduce repeated explanation and supervision. Use patterns from the inspected [ECC research reference](https://github.com/affaan-m/ECC/tree/ef648e01899ba3e8dc6371642deaaf64b4477775) to form hypotheses; implementation and supported delivery remain Hippo-owned.

- Choose one observed bottleneck from Z10/S0/S6 diagnostics: missing capture, inappropriate recall/admission, unclear delivery or unsafe stale use. Reuse the existing core hooks/MCP, stores, provenance and bounded context path; keep the product focused on memory and its supported adapters. Change one declared component per arm, with cheap deterministic fixtures before scored work.
- Validate Hippo's own plugin lifecycle through CAE6/CAE7: preservation of user settings, stable ownership, idempotent install/update/uninstall, duplicate-event handling, compaction/resume, and degraded/offline behaviour. Record actual invocation/delivery, supported runtime versions, context budgets, latency and bounded retries. A managed enterprise install must not require a separate setup step for every developer.
- Compare shipping Hippo with one frozen native candidate on independent stores and matched teach/apply/reversal families, retaining built-in memory as the primary comparator. An optional ECC-only benchmark may use public/synthetic approved data in an isolated research setup if it answers a useful question; it adds no combined ECC + Hippo arm, connector, vault migration or customer deployment dependency.
- Use `build-eval` to review the selected failure/applicability cases and graders. Permit bounded `hillclimb` only on the declared optional instruction/rendering/admission surface with source permissions, capture integrity, schemas, labels and shipping defaults fixed. Use existing runners; keep locked Z0/Z1c corpora and final windows outside search.
- Apply the edition boundary: engine changes and ordinary adapters stay MIT; planned organisation distribution, group/project policy and fleet administration extend them in the commercial package. Customer-history evaluation follows EI12/CD11-CD12 and EI10's approved deployment/provider route; shared-org tests wait for the required source-access, identity and team/role features.
- Register repeat mistakes, stale-follow, useful/no-match coverage, task quality, total cost and latency alongside developer/admin setup, correction, supervision and recovery effort. Use Z12's separately registered human pilot for time claims and CAE4 for fresh-family confirmation. Report null/negative results and reject improvements that simply shift work into manual curation.

**Exit.** A Hippo-owned candidate has a reproducible fixture verdict and independent retain/reject result, with edition ownership, supported deployment and user/admin burden explicit. No ECC product integration is planned; task-benefit/default promotion retains Z0 and the retrieval floor.


### CAE9. Hippo-native lesson-to-skill lifecycle and enterprise governance [planned; E2, SI2/SI4/S6, EI2/EI10/EI11, EV6-EV8, CAE1-CAE4]

**Purpose.** Test whether Hippo's supported lessons can become scoped reusable workflows that reduce repeated explanation and supervision. Extend the existing Hippo `skill` object and public export/API surfaces with native validation and lifecycle; an external project's instinct design is a research reference, not a runtime or trust dependency.

- **Core artifact and evidence [MIT].** Draft off the recall path from permitted structured capture under existing extraction/provider opt-ins and budgets. Record tenant/project/scope, source lesson IDs and versions, provenance, trigger, steps, preconditions/exceptions, runtime/tool applicability, owner, lifecycle status and invalidation conditions. Validate source support and independent task outcomes under SI2 plus target-runtime `SKILL.md`/invocation/no-match fixtures. Confidence, repetition, the agent's verdict or user silence cannot substitute for evidence; keep reversible versions and exported-artifact/source links.
- **Permissions and invalidation [core correctness; enterprise identity adapters separate].** Apply EI2's source-access predicate before derivation and delivery, retaining the most restrictive source permissions; never infer an org-wide skill from private/team evidence. The same grants/roles must protect artifact reads, exports and mutations. Correction, source supersession, deletion or access revocation invalidates affected derived versions and managed cached/exported copies before subsequent permitted delivery; register propagation bounds and stale-copy failure cases. This is gated on the missing E2-object/derived-scope support, not a claim it exists today.
- **Promotion and low-touch use [planned].** Start with inactive drafts, a compact evidence/rationale record and batch/exception review. Define a one-time project/admin promotion policy; separately validate any bounded automatic project-local promotion under that approved policy before enabling it. Routine capture, checks, selection and use of approved versions should run through supported host interfaces without per-lesson commands or approval prompts. Uncertain evidence, authority changes and widening scope go to the relevant owner; generated content cannot override governed instructions, install privileged hooks or grant access. The host owns execution and Hippo starts no runtime.
- **Organisation governance and distribution [commercial package, after dependencies].** Use EI11/EV6-EV8 identity, group roles and project-to-team mapping for admin-configured allowed sources, publishers/approvers and distribution scope. Extend CD6 with artifact status, evidence, exception batches, staged rollout and rollback; use the core audit trail and EI11's commercial SIEM export. Re-check membership/source access when serving a skill, and test revocation, team changes, wrong-tenant requests and interrupted rollback. Basic self-hosted sharing and existing grants/audit stay MIT; org policy cannot bypass the core's permission checks. The enterprise scaffold gains none of these capabilities from this roadmap edit.
- **Deployment and data [both editions].** Keep Hippo's own stores and public extension boundary authoritative. Use the customer's approved local/VPC/air-gapped model route under EI10 where supported; no mandatory ECC plugin, community observer, public judge or extra Claude subscription. If drafting is disabled or unavailable, ordinary memory continues with bounded pending work. Freeze schemas/artifacts and compatible core/enterprise versions for customer rollout; private history and generated skill bodies follow the customer's retention and egress policy.
- **Evaluation [planned].** Use `build-eval` on permitted development cases for source-to-skill validity, applicability, exceptions, scope, poisoned candidates, correction propagation and review burden. A bounded `hillclimb` may edit one draft/template or description surface; evidence requirements, ACLs, promotion rules, judges and held-out labels stay fixed. Compare the same lesson evidence as ordinary recall versus a frozen approved skill at matched budgets, with a built-in-memory baseline and independent confirmation. Enterprise evaluation follows EI12/CD11-CD12; count both developer and administrator review, rollout, recovery and maintenance effort alongside task quality, unsupported/stale use, cost and latency.

**Exit.** A native artifact/permission/invalidation contract and separate core/enterprise pilot verdict exist, with an evidenced retain/reject decision and deployment/edition ownership. Recommend rollout only for useful outcomes or reduced total user/admin burden within quality and resource bounds; generated skill count/export success is not benefit. Preserve Z0/default gates, the retrieval floor and negative findings; do not make this gated experiment an Enterprise v1 release prerequisite.

**CLEF integration [planned; CLF8/CLF11/CLF12].** Use typed decisions for supported-lesson selection, applicability and approved-skill routing. CLEF supplies no new free-form skill body: retain the existing permitted drafting producer, evidence/invalidation lifecycle and core/commercial split. Fast approved guards remain local rather than making a decision-model call per tool action.

### CAE10. CLEF decision-layer integration and evaluation [planned; Part XXI, CLF0-CLF13; direction accepted 2026-10-02]

**Decision.** Integrate the pretrained CLEF models into Hippo's own memory pipeline, extending the successful query-conditioned Jev path and testing additional roles separately. Part XXI is the implementation, dependency and acceptance plan. Cloudflare's engineering-assisted fine-tuning service is not a prerequisite for pretrained inference.

**Scope.** One versioned Hippo decision interface serves native rules/statistical policies, existing Jev, CLEF-flash and CLEF, with hosted and customer-controlled transport. Cover supported CLI, hooks/context, MCP and HTTP/library surfaces; preserve synchronous public APIs and ordinary no-model memory. CLEF selects supplied choices; source extraction and free-form lesson/skill drafting retain their existing permitted producers.

**Delivery and evaluation.** Start with CLF0-CLF3 contracts, free-first operation, private serving and runtime parity, then CLF4 ranking and CLF5/CLF6 admission/corrections. CLF7/CLF8 extend validated workflows; CLF9 learning and CLF10 multimodal use remain separate research/optional gates. CAE1/CAE5 and CLF12 reuse the existing runners with explicit `/claude-api build-eval` and bounded `/claude-api hillclimb` on permitted development cases. Labels, confirmation windows, scope/permission rules and deterministic mutation checks stay outside optimisation.

**Ownership and user effort.** Shared adapters/contracts, ordinary self-hosting, basic budgets, permissions and audit stay MIT; CLF11/EV1 place org identity, administrator policy, managed rollout and buyer/SIEM reporting in the commercial extension. After one-time project/admin setup, automate supported routine decisions with bounded fallback and actionable exceptions. Count total developer/admin work alongside task quality and resource use.

**Exit.** CLF12 records separate compatibility and independently confirmed benefit verdicts for each enabled role; CLF13/MSG6 align published claims. Model availability, provider benchmarks or a roadmap edit do not establish task benefit. Preserve Z0 priority, frozen defaults, locked registrations and the no-dispatch boundary.

---

## Part XXI - 2026-10-02 update: CLEF integration across Hippo (Track CLF)

### Track CLF - Hippo-owned, free-first decision layer [planned; accepted 2026-10-02]

**Product goal.** Improve what Hippo captures, retrieves, injects, corrects, retains and reuses so people encounter fewer repeated mistakes, less irrelevant context and less memory-management work. Integrate CLEF into Hippo's own core and enterprise workflows through a reusable decision interface. After one-time install/trust, provider/data policy and any project/admin setup, routine supported work should run automatically; users should not issue per-memory commands or review every decision.

**Accepted deployment direction.** Start with pretrained CLEF-flash in a free-first hosted profile, with a compatible customer-controlled endpoint path. Compare the larger CLEF where Flash is insufficient. Paid inference requires explicit opt-in; customer training is not required for pretrained use. Keep SQLite, BM25, existing optional embeddings and the working native/no-model path. Integration availability does not promote a default: Z0, H4, retrieval/correctness floors and each parent registration remain authoritative.

**Research basis.** The [Jev reranker results](docs/evals/2026-09-19-jev-reranker.md) show query-conditioned ranking gains on a private developer store and LongMemEval, plus shorter-context evidence; they do not establish better answers than the free cross-encoder. The [Jev experiment ledger](docs/EXPERIMENT-PROTOCOL.md) records failed generic durability/error-tag promotion work and the contaminated no-answer labels in Lane 21. Reuse the successful decision shape and preserve the failed findings. CLEF has not been benchmarked inside Hippo by adding this track.

Primary implementation references: [CLEF announcement](https://blog.cloudflare.com/clef-decision-models/), [CLEF API](https://developers.cloudflare.com/workers-ai/models/clef/), [CLEF-flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [Workers AI REST transport](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), [pricing/allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/), [data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), [Flash model card](https://huggingface.co/Cloudflare/clef-flash), [released decision-head implementation](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py). Recheck current API, serving support, licence, allocation and prices when implementing.

**Planning map; existing parent gates stay in force.**

| Deliverable | Existing work extended | Ownership / sequencing |
|---|---|---|
| CLF0-CLF3 | Current Jev/reranker seams, CD1/AZ3, CAE6, EI10 | MIT contracts, free-use controls, private-serving interface and transport/runtime parity first |
| CLF4 | S1/S2, LC3, current reranker evidence | MIT query-conditioned ranking; preserve the native and small learned baselines |
| CLF5 | Z1d/TE6, Z10/Z12 | MIT context admission/coverage; fresh registration after delivery instrumentation |
| CLF6 | SI4, S0/S6, Z3/Z3b/Z9 | MIT capture/write/correction screening; source and false-write gates |
| CLF7 | Z3b/S3/S4, EI2 | MIT reversible reconciliation/consolidation; permission and temporal correctness |
| CLF8 | S5, SI2, Z4, CAE9 | MIT experience/lesson/skill selection; org distribution remains commercial |
| CLF9 | LC1-LC4, Z2b, EI9, Track G | Research/data-gated lifecycle learning; no prerequisite for pretrained inference |
| CLF10 | Supported AZ capture paths, S0/S6, EI10 | Optional multimodal extension after text workflows |
| CLF11 | EI2/EI10/EI11, EV1/EV6-EV8, CD6/CD11-CD12 | Core correctness/private-serving hooks MIT; org administration and reporting commercial |
| CLF12 | CAE1/CAE4/CAE5/CAE7, TE5/Z0/Z12/EI12 | Existing runners, independent confirmation and upgrade/release checks |
| CLF13 | MSG1-MSG6 | Consistent source and published website/GitHub/npm/enterprise claims |

**Order.** CLF0-CLF3 foundations and development fixtures can proceed alongside the primary Z0 runner/smoke queue. Then validate ranking, admission and corrections, followed by write/reconciliation and reusable lessons. Keep lifecycle training and multimodal work separate. Close the applicable identity, source-permission and deployment gaps before shared-org rollout. This track does not make every research role an Enterprise v1 prerequisite or exempt an enabled feature from its correctness gates.

### CLF0. Shared typed decision contract and provider adapters [planned; foundation]

- Define a Hippo-owned, versioned task/result contract for native rules/statistical policies, existing Jev, CLEF-flash and CLEF. Include task/schema identity, bounded state, allowed options, evidence IDs/versions and applicable tenant/project/scope. Record requested/actual provider/model/revision when available, probabilities, decision/abstention, input bounds/truncation, timing/usage, cache and fallback reason.
- Support the released `noul`, `choice` and `score` semantics through transport adapters. Normalize the Cloudflare REST `result` envelope and the Jev/SystemOne-style response rather than only changing Jev's URL. Validate complete expected question/option sets, finite in-range values, response type and model identity; malformed or partially scored responses invoke the registered fallback.
- Keep classification probability separate from Hippo's observed/inferred/verified memory status. Binary `noul` provides a true probability, not a separate confidence signal; choice confidence is the chosen option probability. Include explicit none/unknown choices where appropriate, and measure calibration/abstention per task rather than trusting one global threshold.
- Scope/redact input before transmission and apply deterministic permission, rejection, supersession/temporal and evidence checks before delivery or mutation. Treat source content as untrusted data; model output cannot grant access, widen applicability, execute tools or change guarded policy. Configure endpoints/credentials through trusted local/admin settings, not arbitrary remote call arguments.
- Freeze question wording, field/order/batching and input construction per comparison. The decision head scores fields jointly, so adding a presence/quality question to a ranking request is a separately tested change. Keep stable tie handling and original score/rank provenance. Ordinary memory remains usable when no decision backend is configured.

**Exit.** Native, Jev, hosted CLEF and private-endpoint fixtures implement the same documented contract; invalid inputs/responses and unavailable providers degrade predictably without partial mutation, secret leakage or a silent paid-provider switch.

### CLF1. Free-first setup, quotas and low-touch operation [planned; CLF0]

- Provide one-time project/admin setup with clearly named native/off, free-first hosted, private endpoint and explicitly enabled paid profiles. Selecting a profile enables only its supported validated roles. Preserve today's shipping defaults until their existing promotion gates pass; environment keys alone do not authorise a new provider or data route.
- Separate free Apache-2.0 model weights from inference/hosting costs. Snapshot checked 2026-10-02: Workers AI lists 10,000 free neurons/day shared across account usage; Flash $0.09 and CLEF $0.24 per million input tokens outside the allocation. At 10,000 total input tokens per request, the published conversions imply about 122 Flash or 45 CLEF calls if that is the account's only usage. These are illustrative estimates, not reserved capacity or a forever-free product claim.
- Budget by provider/account as well as store/tenant: request input, daily usage, concurrency, retries and backlog. Include schema/context tokens and all other inference stages in cost accounting. Use authoritative provider limits/usage where available; unknown usage is not zero. Strict $0 hosted operation needs provider-enforced free-plan/allocation controls: local counters alone cannot guarantee no overage on a shared paid account.
- Batch compatible decisions only after CLF0 equivalence checks. Cache within tenant/permission boundaries using task/schema/model/input and source-version identity; re-authorise and recheck invalidation before reuse. Avoid duplicating raw private state in caches/logs. Register timeout, circuit-breaker, bounded retry and quota-exhaustion policies; free-first failures fall back to native/local behaviour, not paid Jev or a paid larger model.
- Run routine decisions automatically after setup. Expose concise health, usage, provider/fallback and pending-work status through existing doctor/log/dashboard surfaces; notify actionable exceptions without repetitive prompts. Capture queues preserve source receipts/progress idempotently under S6 while the read/task path continues.

**Exit.** Tests cover shared-account exhaustion, unknown usage, racing callers, provider outage, timeout/retry, cache invalidation and interrupted backlog processing. Ordinary memory continues, configured spending is respected, and setup/review/recovery work is counted in CLF12.

### CLF2. Customer-controlled CLEF serving and hardware validation [planned; CLF0, EI10]

- Provide an optional serving recipe/service implementing the same typed endpoint with the released `systemone` / `joint_schema_model` path. Load the trained joint decision head, backbone and processor together. A generic Qwen/chat-completion server or model-download success is not proof of CLEF decision-head compatibility.
- Keep Python/PyTorch/GPU dependencies and weights outside the zero-runtime-dependency npm core. Installation/download is explicit and one-time; support an already managed customer endpoint. Pin model commit, weight/head hashes, tokenizer/processor, serving code/image and dependencies, with health/schema probes, bounded requests and rollback.
- Validate a 16 GB consumer-GPU path with quantisation or offloading before recommending it: the released Flash BF16 artifacts total roughly 19 GB before runtime overhead. Report actual peak memory, input-length/concurrency limits, warm/cold latency, startup/download footprint and CPU-offload tradeoffs. Test decision quality, calibration and head/processor integrity against the reference model; do not assume a community quantisation or generic runtime preserves them.
- Support approved local/VPC/air-gapped modes under EI10, including offline artifact installation, credentials/TLS where applicable, capacity and upgrade/recovery guidance. Private means the configured data boundary is tested; no mandatory Cloudflare account, Gateway/storage service or outbound inference/telemetry. Preserve the no-agent-dispatch boundary.

**Exit.** Hosted/private conformance and a documented hardware/support matrix exist. Each recommended private configuration has measured resource and decision-quality evidence plus a working native fallback; unsupported combinations are explicitly identified.

### CLF3. Full integration across supported runtime and API surfaces [planned; CLF0/CLF1, CD1/AZ3]

- Trace the actual entrypoints before wiring: the shipping Jev flag is in the CLI reranker path and does not automatically upgrade prompt hooks, MCP or library recall. Reuse public search/decision seams and expose consistent opt-in configuration through supported CLI, context/hooks, MCP and HTTP/library routes.
- Preserve current synchronous public recall APIs and their side-effect contracts. Use additive asynchronous enrichment through appropriate existing/new async surfaces for network decisions; do not turn synchronous calls into Promises or introduce blocking network calls. Retain native behaviour when disabled and avoid duplicated scoring, strengthening, audit or trace writes.
- Build scoped eligible candidates before provider input/limits and pack only validated admitted results. Preserve each caller's established scope semantics, temporal view, applicable pins, rendered token accounting, score/rank stage order and default-off controls. Do not let a later boost/sort silently undo decision ordering; any changed stage composition is explicit and registered.
- Join proposed/scored/admitted/delivered IDs and decisions to Z10's per-turn ledger, distinguishing unchanged valid context, newly emitted blocks, fallback and unavailable delivery. Keep attribution tied to what the host actually received. AZ's runtime capability matrix remains truthful: CLEF cannot create events/prompts/transcripts a host does not expose.
- Test installation/trust, invocation, supported capture/delivery, opt-out, duplicate hooks/calls, interruption and upgrade behaviour per runtime and transport. Ordinary tasks should invoke the configured policy without users adding a reranker flag or memory command each turn.

**Pre-compaction coverage [planned; AZ4/AZ5].** Route only permitted captured candidates through the shared decision interface. Native durable checkpoints and validated basic writes do not wait for CLEF availability; actual pre-loss preservation, one-time setup and runtime gaps remain independently tested.

**Exit.** A supported-surface matrix and end-to-end fixtures prove configured decisions reach the actual host, disabled paths preserve existing behaviour, permissions/tokens agree, and failure/capture gaps are observable.

### CLF4. Query-conditioned ranking and evidence packing [planned; hard: CLF0/CLF1/CLF12 comparison slices; rollout gate: CLF3; baselines: S1/native/Jev, conditional S2/LC3]

**Experiment versus rollout.** A development-only matched-input comparison can start with the shared schema/transport, quota/native-fallback and independent-eval slices of CLF0/CLF1/CLF12. It does not require full all-surface integration, an optional S2 dense stream or LC3's future training data. Complete the applicable CLF3 compatibility/delivery path and CLF12 confirmation before enabling a supported backend; retain Z0/default gates and the full CLF integration scope. S1's shipping/native baseline remains available without completing every ablation.

- Start with the measured Jev request shape: query plus the same eligible top-40 pool and one relevance question per candidate, at matched content/input bounds. Compare native shipping order, available local cross-encoder, pinned Jev, CLEF-flash and CLEF in one runner; include the LC3 small learned baseline only when its data floor is met.
- Measure ranking and the real rendered token-budget cut separately. Preserve original scores/order, deterministic tie fallback and all evidence/condition text needed for delivery. Smaller context must retain the sources needed for an answer; evaluate any-evidence and all-evidence coverage, multi-hop/temporal cases and per-category regressions.
- Candidate recall is a separate ceiling: a reranker cannot recover evidence absent from its pool. Diagnose miss types before widening candidates or adding S2's optional independent dense stream. Keep representation, candidate generation, MMR/RRF and lifecycle-factor changes out of this comparison unless separately registered.
- Select Flash or the larger CLEF by the measured quality/resource tradeoff for this role, not vendor leaderboard claims. Register repeat-score/near-tie behaviour, calibration where used, end-to-end latency and actual usage/fallback. Context compression, answer quality and task benefit need their own comparisons.

**Exit.** CLF12 records reproducible paired ranking/packing and task/resource results, including failed arms. Add an opt-in supported ranking backend only after the applicable compatibility/retrieval gates; default promotion remains Z0-gated.

### CLF5. Context relevance, applicability and no-memory admission [planned; CLF3/CLF4, Z1d/TE6, after Z10]

- Separate ranking from admission: the first-ranked item can still be irrelevant. Register typed relevance/applicability decisions with explicit no-applicable-evidence/unknown handling, bounded task/recent context and preserved applicable pins. Abstaining from extra memory is different from making the agent refuse a task or ask the user a question.
- Build fresh independently labelled negatives: topics the store never held, plausible distractors and stale/wrong-condition evidence. Accept alternative valid evidence and near-duplicates in labels; Lane 21's missing-target-ID label is not a clean no-answer population.
- Calibrate probabilities and operating points on development cases; freeze before confirmation. Include reliability/Brier checks, useful delivered coverage, confidently wrong admissions, needless abstention, contradictory/missing evidence and prompt-injection cases. Do not inherit a Jev threshold or treat CLEF's probability/confidence as truth.
- Test evidence sets: selecting one high scorer must not drop the second fact/condition a multi-hop task needs. Bound final claim/experience counts and rendered tokens under the parent contract. On uncertainty or inference failure, use the registered native/fallback policy rather than routine human review.
- Confirm repeat-mistake, task-quality, token/latency and user-supervision effects through Z0/Z12. Keep Z1c's locked judge, final window and registration unchanged.

**Exit.** A fresh admission policy has supported thresholds/fallback and independent false-admission/coverage results, with no misleading answerability claim or loss of required evidence.

### CLF6. Capture, correction and memory-write decisions [planned; CLF3, SI4/S0/S6, Z3/Z3b/Z9]

- Screen supported capture inputs/candidate memories for useful standalone assertions, source support, preserved conditions/subject, duplicates and existing tag/type choices. Where useful, classify whether extraction is warranted before an optional drafting call. Retain evidence spans, source/date, tenant/project/scope and observation status.
- CLEF returns bounded choices; it does not supply new free-form lesson text. Keep deterministic source extraction, host-provided structured candidates or the existing permitted generative producer for factual wording, with extraction/provider opt-ins and full cost accounting. High classification probability cannot manufacture evidence or graduate a long-term lesson.
- Register correction classification, affected-claim selection and replacement/support as separate stages. Include implicit corrections, frustration without correction, quotations, hypotheticals, branch/environment differences and confidently wrong technical claims. User preferences apply in their stated scope; technical claims remain observations until independently supported.
- Use Z3b's deterministic idempotent write/version path; unresolved matching/support remains pending with both sources intact. Routine supported capture/correction runs automatically after setup, including durable receipt/progress handling without depending on normal SessionEnd. Source loss or provider failure stays visible and recoverable under bounded retention/backlog.
- Score write precision, missed lessons, false extraction/closure, duplicate rate, condition/evidence completeness and correction delay before task confirmation. Compare explicit-phrasing rules, applicable Jev and CLEF arms on fresh supported labels; do not re-score the failed detector's final set into a new verdict.

**Exit.** Automatic writes preserve source/epistemic/permission contracts, meet registered false-write/correction bounds and reduce useful-task or correction burden without extra curation work.

### CLF7. Reversible conflict, supersession, merge and sleep decisions [planned; CLF6, Z3b/S3/S4, EI2]

- Classify eligible candidate relationships as supported replacement, contradiction, equivalent duplicate, compatible under different conditions or unknown. Match subject/attribute, source authority, applicability and effective time; compare only within permitted derivation partitions.
- Let Hippo's validated executor apply closure/successor writes atomically and reversibly. Model output cannot directly delete, overwrite, auto-pin or widen scope. An unsupported/uncertain contradiction is a pending conflict; a next-turn disagreement alone does not establish replacement.
- Screen consolidation/merge candidates for assertion and condition/exception equivalence. Retain provenance and source links, preserve pins/rejections and source-revocation propagation, and test undo/replay plus historical/as-of retrieval. Mixed restricted scopes remain unmergeable under the current accepted scope contract.
- Keep sleep as the reversible hygiene work in S4. Shorter text or a confident classification is not a memory/task improvement. Respect existing extraction opt-ins, receipts/privacy rules, compaction-table separation, the agent-memory keep rules and the rule that no automatic pass deletes a memory backing an object.

**Exit.** Relationship classification and deterministic mutation each have independent verdicts; evidence, scope/time, history and retrieval floors survive consolidation and reversal.

### CLF8. Experiences, reusable lessons, skill selection and fast guards [planned; CLF6/CLF7, S5/SI2/Z4, CAE9]

- Classify permitted fail/action/check/outcome sequences and whether a supported experience/lesson applies now. An observed failure alone does not validate its proposed remedy; retain trigger, version/runtime/tool requirements, preconditions/exceptions and evidence-specific outcome links.
- Use CLEF for selecting supported lessons and routing among approved native skill/workflow artifacts, including no-match. Keep CAE9's existing permitted free-form drafting producer, inactive-draft/evidence/promotion rules, invalidation and core/commercial distribution ownership. No ECC runtime/plugin or vault integration is introduced.
- Evaluate ordinary recall versus the same evidence in an approved experience/skill at matched budgets, counting unsupported/stale use and all developer/admin review/rollout effort. Preserve the one-experience delivery limit and independently tested applicability.
- Keep fast tool guards local: build/cache approved deterministic rules through Z4's evidenced promotion path rather than call a decision model before every tool action. Guard runtime failures, permissions and rollback follow the existing registered contract.

**Exit.** Approved selection/reuse improves task outcomes or reduces supervision within quality/resource bounds; generated artifact count is not benefit, and per-tool guard latency stays within Z4's gate.

### CLF9. Outcome attribution, retention and optional learning [research; LC1-LC4, Z2b, EI9/Track G]

- Pretrained ranking/capture decisions do not require customer training. Retain LC2/LC3's small statistical scorer, cold-start/data-floor and opt-in contracts as baselines. Generic durability scoring failed in the Jev campaign; any new learned keep/forget/promotion feature needs a fresh label, registration and long-run store-growth/retention evidence.
- Join feedback to IDs confirmed delivered and evidence tied to the prescribed action/prediction. A later task pass does not reward every memory; model self-ratings, repeated retrieval, user silence and repetition do not prove usefulness. Missing/ambiguous outcomes remain unknown.
- Existing recall traces persist query hashes/IDs and structured scores, not a reconstructable full training prompt. Build replayable permitted episodes only through explicit data capture/retention authorisation; preserve the privacy contract and keep private frozen corpora outside the repository.
- Separate trace collection, independent checks, offline replay, policy/model fitting, held-out confirmation and versioned deployment. Customer training requires tenant opt-in; datasets and derived artifacts obey deletion/source-revocation/retention policy. Any pooled training needs separate authorisation.
- For an RL claim, LC4/Track G must establish the environment/state/actions/reset/transition/reward/termination contract, a real learner and training evidence. RLCD in pretrained CLEF does not make Hippo a live RL system; prompt hillclimbing alone is not that learner. No silent live weight updates, autonomous policy promotion or irreversible model-directed forgetting. Freeze candidates, stage confirmed rollouts and retain rollback.

**Exit.** A separate research verdict supports or rejects each learning/retention role against simpler baselines; no learning requirement blocks pretrained inference or changes existing default gates.

### CLF10. Optional multimodal decision inputs [planned experiment; after text workflows, supported AZ capture, S0/S6]

- Test screenshot/document evidence only from a runtime/source Hippo is authorised and able to capture. Define source identity, permitted input types/sizes, processing/retention and output evidence references; no assumption that a model's vision support exposes a host's screen or full trajectory.
- Use bounded decisions such as document/receipt relevance, legibility or applicability. Free-form transcription, new facts and lesson text retain their appropriate permitted producer and independent support checks. Keep image source evidence outside automatic injection unless its permitted derived claim passes the write contract.
- Validate the actual hosted/private processor path, encoding, input limits/truncation, cost, memory/latency and scope/egress behaviour. Compare text-only/current handling first; add multimodal processing only for a measured evidence gap and useful outcome, with disabled/failure fallback.

**Exit.** Each supported multimodal source has a tested capability/privacy/resource matrix and independently validated use; no mandatory image pipeline or new default is implied.

### CLF11. Enterprise policy, deployment, permissions and rollout [planned; EI2/EI10/EI11, EV1/EV6-EV8]

- Keep the shared contract, hosted/private adapters, ordinary self-hosted setup, basic usage/fallback controls and existing tenants/grants/audit in MIT. The commercial extension adds organisation identity/group/project/role policy, administrator provider/model/egress controls, managed rollout/rollback and buyer/SIEM reporting through the public API.
- Configure approved providers, endpoints, permitted source classes and role-specific decision features once at the appropriate admin/project boundary. Check actor/tenant/source access before constructing model input and again before delivery/export/mutation/cache reuse. Ranking probability never substitutes for authentication/authorisation.
- Derived memories/skills retain the accepted source-scope partition and applicable restrictions. Revocation, membership/team/project changes, correction/deletion and managed-copy invalidation have registered propagation bounds; test wrong-tenant and stale-cached-source cases. Close dependent scope/identity gaps before enabling shared-org use.
- Support approved customer-local/VPC/air-gapped serving and explicit external-provider egress under EI10. Keep credentials server/local-side and raw customer prompts/skill bodies out of routine logs. If an optional AI Gateway route is used, configure and verify its payload logging/retention explicitly; its logging is enabled by default. No mandatory traffic capture, training dataset export or third-party storage.
- Join provider/quota/fallback and rollout status to existing core audit plus planned CD6/admin, CD11-CD12 pilot reports and commercial SIEM export. Test supported core/enterprise version pairs, outages, interrupted rollout/rollback and offline operation. Count administrator setup, calibration, exception review, maintenance and recovery alongside developer burden.
- Enterprise remains a scaffold today. This item defines planned ownership and release gates; an optional model adapter does not implement SSO/team governance or establish enterprise readiness.

**Exit.** A supported tenant pilot proves data/permission boundaries, native fallback, staged rollout/recovery and total user/admin value on the approved deployment; enabled capabilities pass their own gates.

### CLF12. Evaluation, workflow use and upgrade revalidation [planned; CAE1/CAE4/CAE5/CAE7, TE5/Z0/Z12/EI12]

- Reuse existing runners, deterministic scorers and attempt/usage ledgers. Use explicit `/claude-api build-eval` for permitted fresh development labels, coverage and grader review; bounded `/claude-api hillclimb` may vary one declared schema description/prompt/threshold after headroom is shown. Retain ordinary finite sweeps for weights. These maintainer workflows are optional for customer operation and are not assumed free or installed by this roadmap.
- Freeze representation, allowed state sources, candidate/input bounds, questions/order/batching, provider/model/serving/quantisation, budgets, fallback, labels and graders before confirmation. Independent evidence/labels cannot be replaced by the candidate CLEF's own judgement. Use development family/time/store splits and new confirmation where required; do not reopen sealed Z0/Z1c windows.
- Compare native/shipping and built-in agent memory baselines, repaired local reranker, applicable Jev, Flash and larger CLEF as relevant to each task. Include cold-start, clean no-match/alternative-evidence, multi-hop, stale/contradictory evidence, source injection, false corrections and scope/revocation fixtures. Diagnose candidate-pool ceilings before claiming model gains.
- Report repeat mistakes, resolved-task quality, stale-follow, correction count, supervision time/burden and growing-store behaviour; retain all-evidence retrieval/evidence completeness as diagnostics and regression floors. Count total token/inference/hosting cost, caller-observed latency, timeouts/retries/fallbacks, quotas, setup and administrator work. Unknown usage/delivery is not zero; synthetic burden is labelled a proxy until a human pilot measures it.
- Test provider conformance and real mechanism/delivery wiring, not only mocked rank order. Record actual served revision when available; a hosted model name alone does not guarantee immutable weights. Pin private artifacts and use fixed compatibility/drift probes, run manifests and CAE7 upgrade checks for provider/model/schema/runtime/quantisation changes.
- Freeze a winning candidate before independent confirmation. Publish negative/unsupported results with role-specific compatibility versus task-benefit verdicts. Default changes still require Z0 and H4 with the existing retrieval/correctness gates; research adoption and lower token counts alone do not satisfy them.

**Exit.** Reproducible manifests, faithful reports and separate retain/reject verdicts exist for each proposed enabled role and supported deployment. No paid run, install, live-data export or default promotion occurs by adding this plan.

### CLF13. Release documentation and cross-surface consistency [planned; MSG1-MSG6, CLF12]

- Update the canonical claim/capability inventory for each actually shipped role: pretrained decision backend, supported runtime/event coverage, automatic versus opt-in behaviour, model/network/deployment route, provider allocation/paid costs, private-serving requirements, fallback and edition ownership.
- Keep free weights distinct from unlimited free inference, and decision-model probability distinct from verified memory/truth. Retain the measured Jev findings and CLEF-specific limitations; do not transfer provider benchmarks, ranking gains or RLCD terminology into unsupported task-benefit/live-learning claims.
- Coordinate core README/current docs/CLI help and agent-install guidance, GitHub/package metadata, website hero/FAQ/comparison/teams/SEO/agent-facing content, published npm README and enterprise buyer/package descriptions. Explain development versus released and core versus planned commercial capabilities.
- Verify the tagged package, actual npm dist-tag/page and deployed website through MSG6's release/publication checks. Include current pricing-source dates and supported serving/version evidence. Basic operation needs no CLEF account/model; optional private/hosted setup and graceful fallback must be clear without routine per-memory work.

**Exit.** All current product surfaces agree on the shipped release's facts, defaults, evidence and enterprise status. This roadmap addition schedules the implementation/documentation work and does not itself publish the feature.

---

## Part XXII - 2026-10-02 update: durable workspaces and bounded context execution (Track CW)

### Scope and ownership

Use Cloudflare Computer as an optional workspace/execution adapter for externally hosted agents. Hippo continues to own scoped memory, context decisions, provenance, correction and lifecycle contracts. The external host owns the agent loop, model calls, Computer runtime selection and execution. Hippo starts no agent process, supervises no runtime and gains no dispatch switch.

Reuse Z8/AZ3-AZ6/W3-W4, Z10/Z12, SI0/SI4/SI5, CAE6-CAE9 and CLF0-CLF13. This track adds Computer-specific contracts and experiments, not competing stores, generic orchestration or a new Enterprise v1 prerequisite. Keep the local, no-model path and zero-runtime-dependency core. Use an optional adapter/example package; proposed names and methods below are not existing public APIs.

**Low-touch requirement [AZ4-AZ6, Z12].** After one-time install/trust and necessary project policy setup, supported evidence capture, context delivery, checkpointing and receipts run through ordinary agent tasks. Do not require a per-turn memory command, backend choice or manual receipt tagging. Count setup, curation, review/approval, notifications, maintenance and recovery as total user/admin burden; surface actionable exceptions under existing permissions. Computer does not create a host's missing capture or compaction events. Join AZ6's versioned agent register and conformance evidence rather than creating a conflicting support list.

**Research basis (2026-10-02).** The source review used Computer commit `f15437c9b7ce0fecfd39c32951e58232db4c55b4` and compared the 0.3.2 tagged daemon documentation. Primary references: [runtime contracts](https://github.com/cloudflare/computer/blob/f15437c9b7ce0fecfd39c32951e58232db4c55b4/docs/05_runtime_interface.md), [JavaScript execution/journal](https://github.com/cloudflare/computer/blob/f15437c9b7ce0fecfd39c32951e58232db4c55b4/packages/computer/src/backends/worker-javascript/worker-javascript.ts), [host capability bridge](https://github.com/cloudflare/computer/blob/f15437c9b7ce0fecfd39c32951e58232db4c55b4/packages/computer/src/runtime/bridge.ts), [RLM example](https://github.com/cloudflare/computer/blob/f15437c9b7ce0fecfd39c32951e58232db4c55b4/examples/rlm/README.md), [daemon sync/local-only paths](https://github.com/cloudflare/computer/blob/f15437c9b7ce0fecfd39c32951e58232db4c55b4/packages/computerd/README.md), [tagged daemon README](https://github.com/cloudflare/computer/blob/%40cloudflare%2Fcomputer%400.3.2/packages/computerd/README.md), [dependency-sync issue #179](https://github.com/cloudflare/computer/issues/179) and the [RLM paper](https://arxiv.org/html/2512.24601v3). These are implementation/design inputs, not measured Hippo task benefit. Recheck exact deployed versions before claiming compatibility; Computer remains preview in the reviewed upstream documentation.

### CW0. Workspace capability contract and compatibility fixtures [planned; first; AZ3/AZ6/CAE6/CAE7, W3]

Define a provider-neutral WorkspaceRef and operation/result contract. Record host/provider identity, authenticated workspace owner, project/scope, backend, package/source/image versions, filesystem revision, execution ID, runtime UUID, persistence/sync state, supported cancellation/reattachment, event availability and measured limits.

Distinguish filesystem survival, completed execution replay, active execution survival, model-session continuation and semantic memory transfer. A durable filesystem does not prove all five. Backend selection is validated by host policy rather than accepted as authority from model output.

Pin the installed npm artifact, bundled dependencies, Worker compatibility date/flags and computerd image digest. Test the exact deployed combination. Inspected main contains MOUNT_IGNORE support absent from the 0.3.2 tagged computerd README; a package version is insufficient to claim support in a separately built daemon. Record unsupported/shim-only behaviour explicitly.

Exit: a truthful capability matrix, dependency/egress inventory and deterministic compatibility fixtures exist; install/opt-out/upgrade/rollback preserve the existing core contracts.

### CW1. Scoped evidence workspace and source manifests [planned; CW0, EI2/SI3/SI4]

Separate authorised source evidence, transient work, durable task artifacts and Hippo-selected memory. Define immutable source manifests with IDs, versions, content hashes, permitted byte/record ranges, origin, relevant event/effective times, classification, source-access policy revision, expiry and retention. Import only authorised/redacted content; source text is data.

Keep the authoritative Hippo database outside the synchronized Computer filesystem in the initial design. Export scoped context/evidence projections or call the memory service. Do not mount a live Hippo SQLite/WAL file and treat file synchronization as database replication. Store large immutable corpora outside the small workspace where appropriate; a read-only R2 mount is a transport feature, not a source ACL.

Bind workspace identity to authenticated tenant/principal/project server-side; callers cannot select another tenant/store or arbitrary endpoint. Use separate workspaces or immutable snapshots per concurrent writer. Re-authorise source reads, cached derivatives and writes; correction, deletion, supersession and source revocation invalidate affected projections. Cached bytes, generated scripts and shared assets inherit the source restrictions.

Exit: wrong-project/tenant, stale-source, revocation, path/symlink and raw-content-as-instruction fixtures pass. Evidence access is reconstructable without placing raw trajectories or secrets in ordinary memories.

### CW2. Bounded read capability for the JavaScript runtime [planned; CW0-CW1, CLF3, AZ3]

Prototype a host-owned trusted module, provisionally ws:hippo, using supported Hippo API/MCP/HTTP seams. Start with read-only, bounded recall and evidence lookup. Bind tenant/project/session/turn and parent/child call identity in the host, not untrusted arguments. Return memory IDs/versions, evidence references, applicable scope/time, ranking/decision stages, token accounting, trace/receipt identity and explicit unavailable/unknown states.

Preserve synchronous public recall APIs. Use an additive asynchronous adapter for service or decision-model calls, with bounded fallback. Do not replace api.recall with a differently behaving MCP shortcut: current MCP recall strengthens rows and caches the latest recalled IDs per client, while exported API recall has a different side-effect contract.

Worker filesystem access is explicitly read-only, with ambient egress disabled and only declared trusted modules installed. The trusted module enforces its own allowed methods, source ACLs, provider route, total-call/token/cost/deadline/concurrency limits and cancellation. Worker egress restrictions do not constrain host-side model/service calls by themselves.

Exit: actual host delivery, disabled/native fallback, limits, concurrent-child isolation and cancellation are proven using the existing real-database fixture style; remote failure cannot partially mutate ranking or broaden access.

### CW3. Explicit evidence receipts and delivery/outcome attribution [planned; CW2, Z10/LC1/Z2b/S7]

Join Computer operation spans and execution events to Z10 using workspace/run/session/turn, parent/child call, backend/runtime UUID, source-manifest revision and memory/evidence IDs/versions. Keep retrieval, delivery, observed application, check result and sync durability as separate stages.

Do not use implicit last-recall feedback for concurrent child calls. Require explicit IDs and a scoped receipt linking the delivered evidence, later action/check and outcome. Unknown or redacted application remains unknown. A model verdict, file write, zero exit code or overall task pass cannot credit every recalled memory.

Record command completion and artifact synchronization independently. A completed command with pending or skipped sync cannot establish a durable output claim. Include duplicate-event handling, idempotent write/outcome receipts, stale-memory rejection, missing-event gaps and fail-soft instrumentation. Policy failures deny protected operations; optional logging failures do not change recall decisions.

Exit: fixture events reconstruct correctly without changing selected IDs/rendered context; overlapping recalls, replayed receipts, pending sync, cancellation and orphaned executions cannot cross-credit or duplicate memory mutations.

### CW4. Verified checkpoints and pull-mode handoffs [planned; CW0-CW3, W1/W3/W4/Z8, AZ4-AZ6]

Extend existing handoff evidence additively with workspace/provider/backend identity, source/code/artifact digests, persisted execution receipt, sync status, verifier identity/result and relevant memory revisions. Keep credentials host-owned and outside the envelope.

The source runtime quiesces its own work, persists selected artifacts, verifies their readability/hash and writes the envelope. A human or existing external scheduler starts the next runtime; it validates access and artifact freshness, claims the card and resumes through the existing pull-mode contract.

Use AZ4-AZ6's incremental capture, bounded pre-loss flush and per-runtime conformance where the external host exposes supported signals. Verify confirmed memory/checkpoint saves and post-loss restore separately; otherwise record the actual coverage gap in the shared agent register. Workspace persistence alone cannot establish pre-compaction capture across agents.

Do not transparently replay a command whose spawn may have been accepted. Treat replacement runtime IDs, lost unsynchronized outputs and orphaned JavaScript executions as explicit recovery states. A cancelled execution can already have accepted host writes; cancellation is not rollback. Drain cooperative calls, reconcile receipts and surface ambiguity.

Exit: two-session retention and cross-runtime rehydration fixtures pass; restart at each write/exec/sync/check/receipt boundary produces either a verified continuation or an explicit blocked/unknown state, with no duplicate protected mutation.

### CW5. Workspace-backed context workflows and bounded RLM pilot [research; CW1-CW3, S1/S2/S9/TE3/TE5/Z12]

Test broad corpus tasks that sparse recall may miss: contradiction inventory, versioned decision chronology, source-supported incident/lesson aggregation and candidate consolidation review. Keep the parent host-owned; Hippo provides scoped memory/evidence and optional policy decisions, not an internal agent supervisor.

Compare scoped retrieval, deterministic grep/structured processing, code-only workspace processing and bounded semantic map/reduce at matched source access and declared budgets. Start with a single bounded decomposition layer. Model leaves return evidence IDs/ranges plus typed results; code validates structure and performs counting, ordering, deduplication and reduction. A structurally valid reducer does not make semantic classifications correct.

Track the permitted manifest, visited/skipped/failed partitions and unsupported conclusions. Bound calls, bytes, output, retries, aggregate concurrency, tokens, actual priced cost and elapsed time across the whole run and recovery. Fallback/partial completion preserves coverage gaps. Full-corpus scans are not the default recall path.

Exit: fresh broad-coverage task families establish useful evidence/answer quality at registered cost/latency and supervision bounds beyond simpler methods; fail or defer if ordinary retrieval/code suffices.

### CW6. Verifier-backed lesson and procedural-artifact loop [research; CW3-CW4, SI0/SI2/SI4/SI5/S6/CAE9/CLF6-CLF9]

Use Computer artifacts and checks as candidate outcome evidence. A write candidate identifies the scoped lesson, supporting source/action/check receipts, versions, applicability/exceptions, uncertainty and invalidation. Auto-write only under an explicitly configured supported write contract; protected changes and insufficient evidence follow existing fallback/review rules.

Keep the verification trust boundary explicit. Agent-authored tests, altered check commands and cached passing output cannot serve as independent acceptance. Run frozen checks from the host/evaluator against the exact artifact snapshot; record check input/output identity and missing evidence.

For reusable procedures, derive declarative workflows or referenced scripts with code hash, preconditions, allowed host capabilities, independent tests, owner, lifecycle and rollback. A retrieved memory cannot itself authorise code execution. Raw trajectories remain an evidence archive; successful scripts do not automatically graduate to global skills.

Exit: independent held-out recurrence tests show fewer repeated errors or lower total burden at preserved quality; supported source reversal/revocation invalidates affected lessons and procedural versions. No RL claim without a learner/environment/reward contract and actual training evidence.

### CW7. Optional CLEF-assisted context and execution advice [research; CW0-CW5, CLF0/CLF1/CLF4/CLF5/CLF12]

Through the shared CLF contract, evaluate bounded advice such as recall-only versus scoped evidence scan versus abstention; selection among already permitted processing plans; or applicable procedural artifact versus no-match. Keep each decision a separate component study. The external host executes any accepted plan.

Start with deterministic rules and the registered small statistical baseline. Use CLEF/Jev only where independent evidence justifies inference and maintenance. Host policy fixes allowed backends, endpoints, spend and source access before scoring; decision probabilities cannot grant authority or bypass invariants.

Account for shared inference quotas, Computer/Workers/DO/container/storage costs, unknown provider usage, retries and background work. Native fallback must not silently enable a paid provider. Re-authorise permission-scoped caches against source/model/schema/code revisions. Evaluate calibration, useless scans, false-confident decisions and needless abstention alongside task quality.

Exit: a frozen candidate improves its registered objective beyond the simpler policy within CLF12/Z0/Z12 gates; otherwise retain native advice. This does not create a self-updating runtime controller.

### CW8. Independent evaluation, edition packaging and release truthfulness [planned; registration begins with CW0; rollout gated on CW2-CW7 as applicable]

Use separate registrations for adapter compatibility/durability, Hippo installation benefit, each context or policy component and any prospective human-time claim. Hold Computer/model/tools/harness fixed in a memory comparison. Test runtime changes separately. Retain built-in memory, isolated shipping Hippo, one frozen component, and applicable no-memory/perfect-memory controls under their own declared arm IDs.

Prevent persistent files, transcripts, git history, caches, credentials and retained execution logs from leaking taught lessons into a memory-off arm or across treatments. Equalise authorised task evidence; distinguish an evidence-corpus comparison from a cross-session learning comparison. Keep verifier/held-out checks outside agent access.

Measure correction/re-teaching per assigned task, unresolved/abandoned tasks and total intervention burden; active supervision time requires a separately registered prospective pilot. At registered growth levels preserve relevant evidence while adding controlled unrelated/stale/conflicting histories, with permission and capture coverage reported.

Retain Z0 validity/quality and retrieval floors. Where applicable, explicitly pass existing H4: upper 95% total-cost-ratio bound below 1.10 and lower 95% resolve-rate-difference bound above -5 percentage points. Freeze the minimum useful primary effect, further latency/user-work harm bounds, sample, clustered analysis and multiplicity before scoring. Runtime durability checks alone cannot satisfy these efficacy gates.

Basic contracts/adapters remain MIT. Organisation identity, group/project policy, fleet administration and buyer/SIEM reporting stay in the commercial extension under EV1/EI2/EI10/EI11/EV6-EV8. Shared deployment waits for those requirements; start with one authenticated principal. Preserve a supported local/customer-controlled route without a mandatory Cloudflare service.

Pin release/runtime/image/compatibility versions and publish a supported-surface matrix with fallbacks, costs and retention/deletion/export behaviour. Update website, GitHub and npm wording through MSG6/CLF13 only for actually supported, independently evidenced capabilities. Describe Computer as preview while upstream does; do not claim infinite memory, universal zero-touch support, guaranteed free hosting or active-execution survival.

Exit: a scoped retain/reject verdict, failure matrix, operational burden and supported deployment/edition ownership are published. Default promotion still requires the existing governing gates; this track is not an Enterprise v1 prerequisite.

### Sequence and stop rules

First deliver CW0-CW3 against read-only JavaScript and a separate Hippo service; register CW8 before scored work. Then test CW4 continuity and one narrow CW5 task family. Consider CW6/CW7 separately only after an observed bottleneck and appropriate parent gates. Package wider deployment only on demand and verified benefit.

Stop or narrow the adapter if local files/Docker plus Hippo's existing service achieves the same result with less total burden. Defer a native Durable Object memory-store port and live SQLite-through-FUSE operation until a separately approved storage design and consistency/recovery evaluation justify them. Keep provider-independent evidence/receipt improvements even if the Cloudflare adapter is rejected.
