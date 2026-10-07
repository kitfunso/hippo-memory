# AZ3 cross-platform consumer connectors: evaluation draft

**Date:** 2026-09-30

**Status:** DRAFT / NOT REGISTERED / NOT RUN

**Roadmap:** AZ3 / Z10 / Z12, [Parts XVI-XVIII](../../ROADMAP.md)

**Default policy:** No default change.

This planning stub proposes arms and endpoints; it is not a frozen protocol or a run. It does not amend [Z0's locked registration](./2026-09-29-z0-built-in-memory-prereg.md). Implementation, runtime, account policy, permitted inputs, corpus, primary endpoint, sample, acceptance bounds and resources remain to be registered.

## Questions and gates

1. Can a user install/trust once, select the correct store/scope and complete the connector journey on the declared mode?
2. Where supported, does capture/delivery work without routine memory commands, including correction, interruption/resume and opt-out?
3. Does Hippo reduce repeat mistakes, cost per resolved task or supervision burden beyond the host's built-in memory, preserving quality and existing Z0 harm/isolation gates?

These are separate gates. A route lacking lifecycle access can pass as a tool connector. Tool calls alone cannot pass automatic per-prompt memory; a connector without task evidence carries no task-benefit claim.

## Proposed endpoints and arms

**Connector primary endpoint:** fraction of independently specified installation/lifecycle scenarios completing every required step, including store/scope correctness. Freeze required steps and pass/fail bounds; report each scenario's failures, unsupported steps and setup/retry burden. Unsupported automation stays visible in an automatic-memory denominator.

**Task primary endpoint:** choose one endpoint and fresh Z0 or [Z12](./2026-09-30-z12-supervision-growth-prereg.md) family before registration. Z0 covers repeat mistakes or cost per resolved task with its validity/harm gates. Z12 proposes correction/re-teaching burden with quality and total-intervention guardrails. Do not select the winning endpoint after scoring.

| Arm | Host and memory access |
|---|---|
| A: built-in | Fixed host/runtime/model/settings and recorded built-in memory policy; no Hippo. |
| B: connector | A plus one frozen Hippo tool package, scope map, memory policy and evidence budget. |
| C: automation, if available | B plus one validated capture/delivery mechanism; source access and differences from B are explicit. |

Compare A/B for connector task value and B/C for automation. If C is unavailable, register only the connector comparison. Optional no-memory/perfect-memory controls need explicit estimands and source limits. Arms share permitted histories and task stopping/quality policy. Record native memory contents, persistence, reset/isolation feasibility and uncontrollable model updates. If clean comparisons are infeasible, label the pilot observational.

## Development fixture matrix

Freeze supported OS/client versions, plan/admin policies, transport and execution location. Use synthetic, non-sensitive fixtures first.

| Area | Required coverage |
|---|---|
| Installation | Fresh install, executable discovery, Node/SQLite compatibility, update/uninstall, preserved unrelated config, duplicate-hook prevention, doctor and opt-out. |
| Protocol | Discovery/initialization, tool list/call, supported HTTP/stdio semantics, errors/timeouts, auth renewal/revocation and server-enforced tool subset. New event protocols get separate fixtures. |
| Scope | Correct canonical store, projectless chat mapping, private/team identity, authorized switches, wrong actor/project, revoked scope and empty results; use existing G1 principles. |
| Delivery | Available but unused tools, invoked recall, eligible/returned/shown IDs, budget/gate rejection, interrupted responses, offline stores and unknown context receipt. |
| Capture | Supported teach/correct inputs, successor/reversal, deduplicated retries, missing transcript/event, interruption and restart. Do not fill gaps by scraping all conversations. |
| Host modes | ChatGPT chat versus Work/Codex; Claude Desktop extension versus remote/local plugin; Grok app versus API versus Bot computer. Register actual pilot modes only. |
| Shared Bot, if selected | Personal versus shared-channel computer, per-person versus Bot credentials, denied private-memory access, explicit shared writes and export disabled/enabled. |

Unbuilt adapters or undeclared platform capabilities remain pending. Record official capability snapshots from the [packaging plan](../plans/2026-09-30-cross-platform-memory-surfaces.md).

## Scoring and cost

Use Z10's observable chain and independent task outcomes. Report invocation/capture coverage over defined eligible inputs, bad-memory delivery/use, missed lessons, unnecessary abstention, correction burden, failed/abandoned tasks and full cost/latency. Separate install effort from recurring supervision. Invocation traces alone cannot establish application or saved human time.

Use paired histories with isolated accounts/stores/native-memory states where feasible; rotate/randomize arms and preserve quality controls. Freeze blinded labels, unknown handling, samples/power, cluster unit, improvement/noninferiority bounds, multiplicity, stopping and priced maintenance/extraction/embedding costs. Unsupported/blocked journeys follow the preregistered policy; held-out content stays unseen until freeze.

## Decisions required before registration

- [ ] Exact product/mode, runtime/model versions and pilot availability; Muse needs identification.
- [ ] Canonical store and authenticated actor/private/team/project mapping.
- [ ] Implemented protocol/transport and server-enforced read/write permissions.
- [ ] Permitted inputs, retention/redaction and reset/isolation procedure.
- [ ] Independent fixture inventory, primary endpoints, task family and evidence budgets.
- [ ] Sample/power, gates, scorer agreement, unknown/failure policy and resource authorization.

No installer run, hosted endpoint, export, spending, live-store write or scored evaluation is authorized by this draft. No defaults or support claims change.
