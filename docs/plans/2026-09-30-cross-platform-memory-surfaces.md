# Cross-platform Hippo memory: capability and packaging plan

**Date:** 2026-09-30

**Status:** RESEARCH REVIEW / PROPOSED ADAPTERS / NO NEW EVALUATION RESULTS

**Roadmap:** [Track AZ / AZ3](../../ROADMAP.md)

## Decision

Build a common Hippo integration contract and thin packages for platforms a maintainer or pilot uses. Start with ChatGPT and Claude, then Grok/Grok Bot when a pilot is available. Keep SQLite, one chosen canonical store per declared scope, and the shared capture/admission/ranking/packing/trace rules. Existing Claude Code and Codex integrations remain useful starting points.

Consumer-platform reach is valuable for carrying project knowledge between coding and ordinary conversation. Personal preferences, project facts and shared team procedures need distinct admission and permission rules. Installation alone cannot establish useful learning or universal per-prompt capture.

## Capability matrix, checked against current primary docs

These are platform capabilities as of this review, not verified Hippo adapters. Record client modes, versions, account policies and execution environments at pilot registration.

| Surface | Documented route | Candidate Hippo package | Automation boundary |
|---|---|---|---|
| ChatGPT / Codex / Work | [Plugins combine MCP, skills and runtime hooks](https://developers.openai.com/plugins/concepts/plugins); [packaging and trust requirements](https://developers.openai.com/plugins/build/plugins). | Shared plugin manifest with focused Hippo tools and optional existing-hook mappings for a validated Codex/Work environment. | Hook scripts must exist in the execution environment; web installation does not deploy them. Validate each mode's capture and delivery. |
| ChatGPT remote tool access | [Remote MCP server integration](https://developers.openai.com/plugins/build/mcp-server). | Authenticated HTTPS MCP endpoint over the selected store; custom UI can wait. | Server sees requests sent to it. Tool availability does not establish a call on every prompt or receipt of full conversation history. |
| ChatGPT subscriptions | [MCP Events](https://developers.openai.com/plugins/build/mcp-events). | Optional later server-event extension with user-selected subscriptions. | Direction is Hippo server to ChatGPT, not a universal prompt/transcript capture feed. Requires MCP 2.0, version `2026-07-28`. |
| Claude Desktop | [Local MCP extensions packaged as `.mcpb`](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop). | Package the existing local MCP server with explicit store selection and compatibility checks. | Local tool access does not establish chat lifecycle callbacks. Test the bundled Node runtime against Hippo's floor. |
| Claude remote / Cowork / Code | [Remote connectors and mode-specific local plugins](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors). | Reuse the common authenticated remote endpoint and the existing Claude Code plugin where appropriate. | Remote connectors cover web/mobile and other documented surfaces. A local Cowork/Code plugin is distinct from a Desktop chat extension; verify each mode. |
| Grok conversations | [Custom MCP connectors](https://docs.x.ai/grok/connectors). | Test the same remote endpoint and tool contract. | Requires a publicly reachable endpoint. Discovery, invocation, automatic capture and model use are separate stages. |
| Grok Bot | [Custom Remote HTTPS and Command MCP servers](https://docs.x.ai/grok-bot/team-bots). | Remote package or command recipe on the Bot computer with explicit private/shared scope mapping. | Command location depends on the conversation's computer; it is not the user's laptop store. Shared Bot credentials cannot authenticate individuals by prompt-supplied names. |
| xAI API | [Remote MCP transport and parameters](https://docs.x.ai/developers/tools/remote-mcp). | Compatibility recipe for people who own their harness. | Streaming HTTP/SSE are documented; `require_approval` and `connector_id` are unsupported. Enforce writes on the server. API access does not establish consumer lifecycle access. |
| Muse / other named products | Exact product/runtime not established. | Identify official interfaces and an actual pilot first; use an MCP recipe if supported. | Do not infer hooks, history access, persistence or installability from a name. |

Grok Bot already has [team memory and private notes](https://docs.x.ai/grok-bot/team-bots). Its [security FAQ](https://docs.x.ai/grok-bot/security-faq) describes opt-in Enterprise action recording/OpenTelemetry export, with an additional opt-in for conversation content. This is a possible authorized trajectory-evidence source, not a default Hippo capture path. Compare against built-in memory and preserve private/team boundaries; no silent memory synchronization.

## Existing Hippo assets and gaps

At repository snapshot `9bdda2a1ddf90e9370c44341ae34c0051f1cda6b`:

- [The MCP recipe](../../extensions/mcp/README.md) already exposes `hippo mcp` over stdio, including recall, context and memory tools.
- [The Claude Code plugin](../../extensions/claude-code-plugin/README.md) already packages hooks and a memory skill. Reuse the relevant commands, then verify another surface's payload/output contract.
- [HTTP serving](https://github.com/kitfunso/hippo-memory/blob/9bdda2a1ddf90e9370c44341ae34c0051f1cda6b/src/server.ts) already dispatches MCP requests through the common handler. This does not establish current remote-client transport/OAuth conformance.
- [The MCP handler](https://github.com/kitfunso/hippo-memory/blob/9bdda2a1ddf90e9370c44341ae34c0051f1cda6b/src/mcp/server.ts) advertises `2024-11-05` and tool capabilities. ChatGPT's newer event interface needs separate compatibility work.
- The [README](../../README.md) requires Node 22.16+. Desktop packaging must verify `node:sqlite`, FTS5, install/update and executable discovery; a bundled Node label is insufficient.

Run a protocol/transport compatibility spike before writing multiple installers. Keep adapters/dependencies optional, preserve public CLI/MCP APIs and the zero-dependency local path, and version any protocol upgrade with regression fixtures.

## Common integration contract

**Identity and scope.** Select the canonical store and workspace explicitly once at setup. Remote chat has no reliable repository working directory. Resolve actor, allowed private/team/project scopes and inheritance from authenticated server-side mapping; reject unauthorized scope switches even when requested by the model. Broader enterprise hierarchy follows existing A5 work; single-user remote access does not complete it.

**Transport and deployment.** Local stdio packages use the chosen local store. Web/mobile needs an authorized, reachable gateway to that store or an explicitly selected hosted canonical store. Document availability, latency and offline behaviour. Do not place live SQLite on a network filesystem or create an implicit second store. This plan authorizes no deployment, tunnel, hosting spend or live-store migration.

**Tools and writes.** First test a server-enforced read-only remote subset. Subsequent opted-in write fixtures exercise the common conservative capture/correction contract, provenance, idempotency, reversal and permitted inputs. Tool annotations, client approval cards and prompt instructions do not authorize writes. Where supported, the automatic journey needs no routine memory commands after installation/trust.

**Delivery evidence.** Trace availability, invocation, eligible candidates, returned IDs, delivered context and observed/judged/unknown use through Z10. If the host supplies no allowed lifecycle/capture source, document the limit and test model-initiated tools without calling it automatic per-prompt memory. Empty/error responses must not invent memories.

**Lifecycle and retention.** Test opt-out, revocation, install/update/uninstall and unavailable-store behaviour. Event retries are idempotent. Raw permitted exports stay as scoped receipts/evaluation evidence outside automatic recall. No transcript scraper or retention change follows from packaging.

## Pilot order and acceptance

1. **Development compatibility:** test shared tools, transport, auth/scope, Node floor and doctor diagnostics. Inventory exact modes and permitted inputs before spending held-out tasks.
2. **ChatGPT and Claude:** select available pilot modes, package tools, and validate lifecycle automation separately where supported. Reuse Claude Code assets. Add a status/scope inspector only if setup problems justify it; rich UI can wait.
3. **Grok / Grok Bot:** reuse the remote work or test a command recipe on the Bot computer. Include personal/team/shared-channel fixtures when requested. API and consumer surfaces get separate coverage.
4. **Others:** capability check and MCP recipe first; native adapter only for an actual gap and pilot. Muse remains pending exact identification.

Use [AZ3's draft](../evals/2026-09-30-az3-consumer-connectors-prereg.md) for connector reliability and a fresh Z0/Z12 family on each claimed mode. Distinguish installation/tool access, supported automation coverage and measured reduction in mistakes/supervision at preserved quality and cost. All adapters remain flagged until their gates pass.

No evaluation result, default change, new runtime implementation or promise of support is made by this document.
