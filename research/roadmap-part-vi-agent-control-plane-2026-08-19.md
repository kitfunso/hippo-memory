## Part VI - 2026-08-19 update: agent control plane / cross-agent routing — scoped verdict

Triggered by the question of whether hippo should become a coding-agent platform ("an OpenRouter for coding agents", or a Claude Code competitor). Two independent Codex reviews converged on the same counter-proposal: do not clone Claude Code, build an **agent control plane** instead — route Claude / Codex / Gemini / local models, add persistent project memory, task state, handoffs, outcome tracking, permissions and evals, let existing agents connect via SDK/MCP/API, and ship a thin hippo CLI as the reference client.

**Verdict: the platform framing is rejected. One narrow track (M) is adopted.** The Codex diagnosis is right (cloning Claude Code is indefensible) and the prescription is wrong (the layer it escapes to is more contested, not less). Reasoning and sources below; every claim about hippo's own code was source-verified against `origin/master` (v1.32.1) on 2026-08-19, per the Part V discipline note.

### VI.1 Market check (all figures retrieved 2026-08-19)

| Layer | State | Implication for hippo |
|---|---|---|
| Model routing | Commoditized, and now owned by payments infrastructure. OpenRouter reached ~$140M annualized revenue and 8M users by July 2026 and is being acquired by Stripe for >$7B. The acquisition analysis is explicit that the asset is the **metering and billing relationship**, not the routing algorithm. Free open-source equivalents already route Claude Code / Codex / Gemini per request type: Claude Code Router, TeamoRouter, LiteLLM, and Gemini CLI's native smart routing. | Closed. Routing is a giveaway feature attached to a billing rail hippo does not own and cannot build. |
| "Agent control plane" | The most contested phrase in enterprise AI in 2026, not an opening. OpenHands published this exact layer stack (harness / orchestrator / control plane, covering cost attribution, policy, secrets access, LLM routing, budgets, audit) on 2026-04-03 and claims first-to-unify; Google Cloud Next 2026 ran the same race across the enterprise vendors. | Closed at single-engineer cadence. Also duplicates non-goal #5. |
| Cross-agent memory | Filling fast. `agentmemory` hit #1 GitHub trending in May 2026 (1,048 stars in 24h, 5,000+ since) at roughly $10/yr; `threadctx` and ByteRover target the same seam; the funded tier is mem0 ($24.5M raised, ~41-48k stars, exclusive memory provider in the AWS Agent SDK), Zep/Graphiti, Letta, Cognee, Supermemory. | Contested but not closed. hippo's differentiator is lifecycle + audit, not storage or recall (Bets #1, #4). |
| Outcome-conditioned routing | Real, researched, and with a **measured ceiling**. SkillRouter (arXiv 2603.22455) routes coding agents inside the Claude Code harness by task success and reports +1.78pp top-1 / +2.33pp top-10 over baseline routers. FlyRoute (arXiv 2605.22057) does live-traffic agent profiling. Braintrust ships performance-based routing commercially. | The honest read: a ~2pp task-success gain is **feature-sized, not company-sized**. This is the right shape for a hippo track and the wrong shape for a pivot. |

Context on hippo's own scale while reading the above: v1.33.0 on npm, 2,829 downloads in the 30 days to 2026-08-18. `agentmemory` gained more GitHub stars in one day than hippo has in total. Any plan whose first move is a land-grab against that curve is not a plan.

### VI.2 Source-verification of the "we already built most of this" claim

Codex asserted hippo already has, accidentally: devrl, cross-runtime handoffs, shared lessons, model-run memory, retrieval replay, and evidence-gated routing. Checked against `origin/master` 2026-08-19. **Two of the six do not exist and one is agent-blind.**

| Claimed piece | Verdict | Evidence (reproduce with the command shown) |
|---|---|---|
| Cross-runtime handoffs | **Real, but agent-blind** | `src/handoff.ts`; `session_handoffs` at `src/db.ts:155-164`. Columns: `session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at` (+ `tenant_id`/`scope` from the v16-era migration). **No agent, model, or runtime column** — a handoff cannot state which agent produced it, so it cannot support routing. `git show origin/master:src/db.ts \| grep -A 11 "CREATE TABLE IF NOT EXISTS session_handoffs"` |
| Outcome tracking | **Real, but memory-scoped not run-scoped** | `outcome_score` / `outcome_positive` / `outcome_negative` / `trace_outcome` on `memories` (`src/store.ts:93-95`, `:211`). These score a *memory*; nothing records an *agent run's* cost, tokens, duration, or verdict. |
| Retrieval replay | **Real** | `src/recall-history.ts` (LC1). |
| Shared lessons | **Real** | capture / consolidation / auto-learn. |
| Model-run memory | **Does not exist** | `git show origin/master:src/db.ts \| grep "agent_id\|agent_name\|model_name\|runtime"` returns nothing. The only actor attribution in the schema is `actor TEXT NOT NULL` on two tables (`src/db.ts:428`, `:938`). |
| Evidence-gated routing | **Does not exist in hippo** | `grep -c agent_runs` on `origin/master:src/db.ts` = 0. devrl is a separate `~/.claude` skill with its own SQLite trajectory store; it is not a hippo surface and shares no schema. |

The build is therefore materially larger than "already built accidentally" implies. Recording this because the Part V discipline note applies: an LLM-authored audit of hippo's code inherits LLM-report failure modes, and this one overstated on two of six items in the optimistic direction.

### VI.3 Why the platform framing is rejected — it breaks hippo's own written positions

Not a matter of taste; the proposal contradicts three commitments already in this file:

1. **Routing execution puts hippo in the model data path** — holding API keys, owning uptime, reconciling spend. That is adjacent to non-goal #6 (hippo is memory infra, not inference infra) and directly against Bet #2 (the local-first zero-dep core never gets worse).
2. **A control plane is a heavyweight enterprise backend**, which is non-goal #5 stated verbatim.
3. **Neither is affordable** against OpenHands, Google, LiteLLM, and a Stripe-owned OpenRouter at the cadence this roadmap is actually built at.

The Codex framing swapped "compete with Anthropic on harnesses" for "compete with Stripe on billing and OpenHands on governance". That is a worse trade, not a better one, and it is the classic escape-upward-into-abstraction move: the abstract layer feels safer because its competitors are less vivid, not because they are weaker.

### VI.4 What IS adopted: Track M — agent-run outcome memory (advice, never execution)

The defensible half of the Codex proposal is the memory-shaped half. hippo records what each agent run cost and whether it worked, then answers *"which agent should take this task, in this repo"* with evidence a human can inspect and challenge. **hippo advises; the caller's existing harness executes.** No proxy, no API keys, no billing, no sandbox, no data path.

This sits inside the existing moat rather than beside it: it is lifecycle and provenance applied to agent runs instead of facts (Bets #1 and #4), and every primitive lands in SQLite (Bet #7). It also gives Track E and the LC track a genuinely new supervision signal — run outcomes are ground truth in a way memory outcomes are not.

**Protocol finding: the OpenRouter analogy stops at the policy layer.** OpenRouter normalizes model inference and provider selection. Coding-agent runtimes expose richer, incompatible state: sessions/threads, streamed tool events, approvals, terminal processes, file changes and resumable execution. MCP is the wrong abstraction for that job (model-to-tool/context); ACP standardizes client-to-coding-agent sessions; A2A standardizes agent-to-agent tasks and artifacts; Claude Agent SDK and Codex app-server expose vendor-native lifecycle streams. Track M therefore stores a provider-neutral **run envelope** and keeps thin adapters at the edge. It does not pretend one universal execution API already exists.

**M0. Runtime event envelope + adapter canaries [next, blocks M1-M2].** Specify one append-only envelope for `run_started`, `context_injected`, `tool_event_ref`, `approval`, `artifact`, `verification`, `handoff`, `run_finished` and `run_abandoned`. Required identity: runtime, agent, model, native session/thread id, repo/worktree, task id and schema version. Build read-only canaries against Claude Code hooks/SDK events, Codex app-server/rollout events and the existing OpenClaw plugin. Prefer native lifecycle APIs; wrappers remain compatibility fallbacks, not the architecture.
**Effort:** 2-3d. **Success:** the same fixture task in all three runtimes produces schema-valid envelopes; unknown event fields survive round-trip; interrupted runs close as `abandoned` rather than false success; no prompt, provider key or full tool payload is persisted by default.

**M1. Agent attribution on handoffs and runs [next, small].** Add agent/model/runtime identity to `session_handoffs` and to the capture path. This single missing column is what currently makes cross-agent continuity unusable for routing: a handoff knows *what* happened but not *who* did it.
**Effort:** 1-2d (migration, writer plumbing, MCP/CLI surface, tests). **Success:** a handoff written by Codex and resumed in Claude Code reports both agents by name in `hippo handoff show`; existing agent-less handoffs read back unchanged (null-safe, no backfill invention).

**M2. `agent_runs` table [next].** One row per agent run: task ref, repo root, agent, model, tokens, cost, wall-clock, verdict (pass/fail/abandoned), artifacts, linked handoff and recall-trace ids. Written by hooks and by explicit CLI calls. Read-mostly; no orchestration.
**Effort:** 3-4d. **Success:** 30 days of dogfood accumulates a queryable (task-class, agent, model, cost, verdict) dataset across at least three runtimes; tenant-scoped from the first migration (do not repeat the `session_handoffs` v16 leak, Part V / db.ts:633-638); storage overhead <2% of DB size.

**M3. `hippo advise "<task>"` [next].** Ranked agent/model suggestion for a task in a repo, with the evidence inline and no network call: *"codex: 7/9 refactors in this repo, median $0.42, median 4m; claude-code: 2/9 refactors but 4/4 debugging."* Refuses to rank below a minimum-sample threshold rather than inventing confidence.
**Effort:** 3-4d. **Success:** `advise` cites the exact run ids behind every number; below N runs for a task class it returns "insufficient evidence" and says how many rows it needs; a pre-registered A/B on Keith's own repos shows the advice beats always-picking-one-agent on cost-per-passed-task, or the track is cut per the cut criteria.

**M4. `hippo run` thin wrapper [speculative — gated on M3].** Shells out to the already-installed `claude` / `codex` / `gemini` binaries (invoke, never proxy), injects repo memory, records the run, writes the handoff. Explicitly **not** a router, gateway, editor, sandbox, or agent framework.
**Gate:** only starts if M3's A/B clears its bar AND someone other than Keith has used `advise` for a month. Absent both, M1-M3 stand alone as memory features and M4 is dropped.

### VI.5 Interop boundary (source-verified)

| Surface | What it standardizes | Track M use |
|---|---|---|
| MCP | Agent/model access to tools, resources and prompts | Keep Hippo's memory tools available inside each runtime; **not** run orchestration |
| ACP | Editor/client interaction with coding agents over JSON-RPC, including sessions, terminals and permission requests | Candidate adapter seam where a runtime supports it; do not wait for universal adoption |
| A2A | Agent discovery, tasks, status and artifacts between independent agents | Later handoff transport only; unnecessary for local M0-M3 |
| Claude Agent SDK | Claude-native sessions, hooks, permissions and resumability | Native Claude adapter and event capture |
| Codex app-server | Codex-native threads, turns, streamed events and approval requests | Native Codex adapter and event capture |

Primary references retrieved 2026-08-19: [OpenRouter overview](https://openrouter.ai/docs/overview), [OpenRouter provider routing](https://openrouter.ai/docs/features/provider-routing), [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), [Codex SDK](https://developers.openai.com/codex/sdk), [Codex app-server](https://learn.chatgpt.com/docs/app-server.md), [ACP](https://agentclientprotocol.com/overview/introduction), [MCP](https://modelcontextprotocol.io/docs/getting-started/intro), [A2A](https://a2a-protocol.org/latest/).

### VI.6 Execution order and gates

1. **M0 + M1:** prove portable identity and handoff continuity across Claude Code, Codex and OpenClaw. No ranking yet.
2. **M2:** dogfood run capture until each runtime has at least 30 completed, verification-backed runs and the abandonment/error rate is measured.
3. **M3 shadow mode:** issue advice but never auto-select. Compare it with the agent Keith actually chose and the verified outcome.
4. **M3 decision gate:** ship recommendations only if the pre-registered test beats best-single-agent and cheapest-agent baselines on cost per verified pass, with no statistically credible pass-rate regression.
5. **M4 external canary:** only after the existing dual gate. One repo, one user outside Keith, reversible local wrapper. No hosted control plane.

### VI.7 New non-goal (append to the non-goals table)

| # | Non-goal | Why | Source |
|---|----------|-----|--------|
| 11 | Sitting in the inference data path: routing/proxying model traffic, holding customer provider keys, or reselling tokens | Adjacent to non-goal #6 and fatal to Bet #2 (local-first, zero-dep). The 2026 market settled this layer — OpenRouter's value was the metering and billing relationship (Stripe acquisition, >$7B), which hippo cannot and should not contest. hippo may *advise* which agent/model to use and *record* what a run cost; it never carries the call | Part VI market check 2026-08-19 |

### VI.8 Cut criteria specific to Track M

In addition to the standing criteria: M is cut if M3 cannot beat a fixed single-agent policy on cost-per-passed-task within two pre-registered A/B cycles. SkillRouter's +1.78pp is the public reference point for how small this effect can be — if hippo cannot clear a comparable bar on real repo data, the track is a research curiosity and should not consume a sprint.

**Sources (retrieved 2026-08-19):** Sacra OpenRouter profile; FourWeekMBA Stripe/OpenRouter acquisition analysis; OpenHands "The Software Agent Control Plane" (2026-04-03); SiliconANGLE Google Cloud Next 2026 control-plane coverage; arXiv 2603.22455 (SkillRouter); arXiv 2605.22057 (FlyRoute); GitHub `rohitg00/agentmemory`; Braintrust LLM-router survey 2026; npm `hippo-memory` downloads API.
