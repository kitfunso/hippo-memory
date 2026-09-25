# Buyer KPIs: showing a company what hippo changed

**Date:** 2026-09-24. **Status:** design. Nothing in this file has been measured yet.
**Roadmap:** Part X (CD7, CD11 to CD13), Part IX (TE5, EI12).

## The question a buyer asks

"We turned hippo on for 300 developers. What did it save us, and how do you know it was hippo?"

A believable answer needs three things:
1. **Numbers the buyer already trusts**, taken from their agent's own billing telemetry rather than from hippo's estimates.
2. **A comparison that rules out everything else changing.** Model prices, model versions, team mix and the kind of work all move month to month, so a before-and-after comparison on its own proves little.
3. **Hippo's own cost counted.** Hippo adds tokens to every prompt it helps, so only the net figure counts.

## What exists today

| Piece | What it measures | Gap for a buyer |
|---|---|---|
| TE0 token ledger (`hippo tokens`) | Tokens hippo itself sends to agents, per surface and session | Hippo's cost only, not the agent's total spend or any saving |
| TE4 session replay | Hippo's overhead on recorded sessions | Offline; no agent in the loop |
| TE5 A/B runner | Cost per resolved task with and without hippo, on task sequences in a lab | Lab tasks, not the buyer's work; no scored run yet |
| EI12 tenant replay | TE5 on the buyer's own history | Offline estimate before a pilot; still not live use |
| CD7 value report | Planned monthly report | Has no live comparison group to report against |

So hippo can prove its own cost today, and can estimate savings offline once TE5 and EI12 have run. **It cannot yet measure a saving in a company's live use.** That is the gap this design closes.

## KPIs

Four tiers, in the order a buyer cares about them. Every KPI is reported for hippo sessions and for holdout sessions (next section), never as one absolute number.

**Tier 1: money.** Source: the agent's telemetry, never hippo's estimate.
- **Cost per merged PR, and per session.** Cost-weighted tokens (uncached input, cache write, cache read, output) at list price, with hippo's own tokens included.
- **Tokens per session, by type.** Cache reads are about a tenth of the input price, so a raw token total misleads. Always cost-weight.
- **Read-token share per session.** Tokens spent on file reads and searches. Reads are most of a coding agent's input, so this is where memory should show first.
- **Turns and active time per session.** A secondary signal for "less wandering".

**Tier 2: what hippo is for.** Attributable to memory by construction.
- **Repeat-error rate.** How often a session hits a failure whose signature (`failureSignature`, `src/capture-error.ts`) another session hit first. This is the most direct measure of "your agents stop repeating mistakes". It needs every signature logged, not only the ones stored: the CD13 failure log does that (`src/failure-log.ts`).
  - **Headline: repeats per session, per arm.** The session count comes from the agent's telemetry, because a session with no failures leaves no row in the log. The share of failures that are repeats comes second: hippo can prevent new failures as well as repeats, and then the share can rise while repeats fall.
  - **What counts.** Stored, duplicate and could-not-be-stored failures. Routine skips are logged with the rule that skipped them, so declines can be rated later, but they are not rated now.
  - **Known biases.** A session retrying one failure counts each retry, so also count each (session, signature) pair once. The log keeps 90 days, so early failures have a shorter lookback; both arms share that bias.
- **Re-exploration.** File reads per session in areas the repository has been worked in before. TE8 targets this.
- **Corrections.** How often a developer restates a rule hippo already holds. This is hard to detect reliably, so it is exploratory only.

**Tier 3: guardrails.** Hippo must not make these worse.
- Revert rate and review-rejection rate of agent-authored PRs.
- CI failure rate on agent commits.
- Stale-memory incidents: a recalled memory later marked bad or superseded.

**Tier 4: hippo's cost.**
- Tokens hippo injected (TE0), hook latency, and store size.

**Not KPIs:**
- Lines of code, and suggestion acceptance rate.
- Developers' own estimates of time saved. In controlled studies, developers have believed they were faster when they were slower.

These can appear as context, never as proof.

## How to make the comparison causal

Three stages, each more credible than the last.

1. **Before the sale: an offline replay (EI12).** Replay the company's own history with memory on and off. The output is an estimated saving with a confidence interval, before anything is installed. It is still an estimate on past work.
2. **Pilot: a live holdout (CD11).**
   - A fixed share of sessions, for example 20%, run in shadow mode. Hippo still captures, but injects nothing into the prompt.
   - The split is by session id: random, and invisible to the developer.
   - Both arms run on the same days, the same models, the same people and the same work, so model price changes and seasonality cancel out.
   - The comparison is paired by developer, with a cluster bootstrap by developer (`clusteredPairedBootstrap` in `src/eval-stats.ts`).
   - Holdout sessions still feed the store, and developers carry what they learned between sessions. Both effects push the result towards no difference, so the estimate is conservative.
3. **Rollout: staggered by team.** Teams that turn hippo on later are the comparison group for teams that turned it on earlier (difference in differences). Use this when a holdout is not acceptable.

**Sample size (rough).** Assumptions, not data:
- the spread of per-session cost is large, with a standard deviation about twice the mean;
- the analysis uses log cost;
- the test is two-sided at 95% with 80% power.

On those assumptions, with a 20% holdout:
- a 10% difference needs about 1,400 holdout sessions, about 7,100 in total;
- a 20% difference needs about 320 holdout sessions, about 1,600 in total.

At 200 developers and three sessions a day, that is about 12 working days for the first and 3 for the second. Pairing by developer lowers these numbers. The pilot measures the real spread in its first week and recomputes the size before the report is due.

## What to build

- **CD11. Shadow holdout.**
  - A setting, `holdout.rate` with default 0, makes a deterministic share of sessions (hashed by session id) skip injection while capture continues.
  - Each such session is logged in the ledger as a holdout, so the report knows its arm.
  - The per-prompt hook, `hippo context` and the compaction resume respect it. MCP recall, which the agent asks for itself, returns a note that memory is held out.
- **CD12. Agent telemetry join.**
  - Import per-session cost from the agent's own telemetry: Claude Code's OpenTelemetry export or its usage API, keyed by session id, which hippo's ledger already records.
  - `hippo report --pilot` joins the two and computes tiers 1 to 4 per arm, with confidence intervals.
  - Copilot and Cursor expose less per-session data. Their reports fall back to tiers 2 to 4 plus organisation-level usage, without repeat-error rate for now: only Claude Code's PostToolUseFailure hook feeds the failure log.
- **CD13. Failure-signature log.** Record every failure signature seen, with session and time, including skipped and duplicate ones, so repeat-error rate can be computed per arm.
- **CD7, upgraded.** The monthly value report becomes the pilot report: each KPI per arm, the difference with its interval, and hippo's own cost. It gives no saving figure until the interval excludes zero (non-goal 16).

## What the agents already report (checked 2026-09-24)

**Claude Code** (read on code.claude.com and platform.claude.com):
- **OpenTelemetry export.** Set `CLAUDE_CODE_ENABLE_TELEMETRY=1` with an OTLP or Prometheus exporter.
  - `claude_code.token.usage` is split by `type` (input, output, cacheRead, cacheCreation) and by `query_source` (main, subagent or auxiliary).
  - Also exported: `claude_code.cost.usage` (USD), `claude_code.session.count`, `claude_code.pull_request.count`, `claude_code.commit.count` and `claude_code.active_time.total`.
  - Every metric carries `session.id` and `user.id`.
  - `tool_result` events give success and `error_type` per tool call.
  - Prompt text is off by default.
- **Organisation usage API.** `GET /v1/organizations/usage_report/claude_code` returns, per user per day: sessions, commits and PRs by Claude Code, tokens by type, and estimated cost. Bedrock and Vertex usage is not included.
- **Anthropic's published baseline:** about $13 per developer per active day, $150 to $250 a month.

This is enough for a per-session join. Hippo's ledger already stores the same session id.

**GitHub Copilot** (read in GitHub's docs source):
- **What it reports:** per-user daily usage, `ai_credits_used`, and a per-repository `pull_requests` object (created, merged, `median_minutes_to_merge`, created by Copilot).
- **No per-session token cost.** So a Copilot pilot randomises by developer rather than by session, and reports credits per developer, PR throughput and time to merge.
- **GitHub's own caution:** its "adoption multiplier" compares two different populations, not the same users over time, so it is not causal.

**Cursor** (search snippets only): per-user daily requests and lines, with no per-session cost.

**Evidence that shapes the design** (mostly search snippets; the sites were blocked):
- **Developers' sense of speed is unreliable.** In METR's 2025 randomised study, experienced developers were 19% slower with AI yet believed they were 20% faster. METR's 2026 update switched to randomising by developer. Every framework reviewed (DX, DORA 2025, SPACE) warns against acceptance rate and lines of code.
- **Randomised field trials are the accepted form.** Microsoft, Accenture and a Fortune 100 company randomised Copilot access across 4,867 developers (+26% completed tasks). Google ran a randomised trial with 96 engineers.
- **Vendors mostly compare AI users with non-users.** Jellyfish, LinearB and Swarmia work this way per one review, which is observational. A randomised holdout is a real differentiator in a pilot report.
- **Where the tokens go.** On SWE-bench Verified, Claude Sonnet 4.5 spent 76% of its tokens on read operations (SWE-Pruner, arXiv 2601.16746). This makes **read tokens per session** the most direct token KPI for memory: a memory that says where things live should cut reads. It comes from `token.usage` plus `tool_result` events.
- **No published data on repeated mistakes across sessions was found.** Hippo's repeat-error rate would be new, and it has to be defined carefully (CD13).

**Design changes from this research:**
- **The randomisation unit is a setting.**
  - Per session (more statistical power) is the default for Claude Code.
  - Per developer (cleaner, no crossover) is used where the agent has no per-session cost, or where a buyer asks for it.
  - The analysis is clustered by developer either way.
- **Read-token share per session joins Tier 1** as the token KPI hippo is most likely to move.
- **The report is computed inside the customer's network,** from their own telemetry export. Hippo sends nothing home, which fits the no-telemetry promise in the roadmap's Company section.

## What to promise a buyer

**Promise the measurement, not a number.**

"Run hippo on 80% of sessions for four weeks. We report your cost per merged PR and your repeat-error rate with and without it, from your own telemetry, with confidence intervals. If there is no difference, the report says so."

The saving figure comes after TE5 and the first pilots.
