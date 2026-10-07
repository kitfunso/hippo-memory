# Product facts and publication checks

Reviewed 2026-10-02 against core source commit `2b3ec52047b98fe3ad462bad4bc6a1f80ba468c8`. This is the initial claim inventory for MSG6, not a completed audit of every public page. The README owns public capability wording; website FAQ and comparison tables read it at build time. The npm page receives the README and metadata from its published package, not from later commits to master. The release maintainer owns reconciliation across those surfaces.

## Status and evidence

Track implementation, availability and evidence separately. `building` means work in progress; `merged` means source on the default branch; `released` means an identified published package or deployment. A fixture test, live compatibility observation and independently verified user benefit are different evidence states. Record the runtime/model/configuration, edition, observation date, evidence link and remaining unknowns. A roadmap amendment does not implement a capability.

## Current claim contracts

| Claim | Permitted wording and boundary | Source/evidence to check |
|---|---|---|
| Product category | Persistent agent memory, supplied through context selection and harness integration. Continuous improvement is a goal; do not claim a shipped RL environment or online weight learning. ECC is a research reference, not a product dependency. | README; ROADMAP MSG1-MSG5, CAE8/CAE9; `docs/plans/2026-09-12-work-plane-boundary.md` |
| Setup and automation | Package installation alone does not enable automatic preservation on every agent. Complete the documented setup and required host trust; capture and compaction coverage depend on the integration. | README setup/FAQ; `src/cli.ts`; `src/hooks.ts`; `integrations/`; website `getStarted.notice` |
| Claude Code preservation | Configured PreCompact hooks save a derivable working-state snapshot and a compaction record. PostCompact extracts lessons listed in the summary. Records, snapshots and useful memories are distinct; this is not evidence that every lesson was preserved before loss. | `src/capture.ts`; `src/hooks.ts`; `tests/compaction-pre-compact.test.ts`; `tests/compaction-post-compact.test.ts`; S6/AZ4-AZ6 |
| Codex preservation | Installed hooks deliver prompt context and re-inject it after compaction once trusted in `/hooks`. They provide no PreCompact save hook. Session-end capture requires the opt-in launcher wrapper; actual delivery and all-agent preservation have separate gates. | `integrations/codex.md`; `src/hooks.ts`; `src/capture.ts`; AZ4-AZ6 |
| Supported agents | Init detects Claude Code, Codex, Cursor, OpenClaw, OpenCode and Pi, with different instruction/hook/plugin paths. MCP tools and CLI/HTTP access do not imply lifecycle capture. Required coverage includes every agent and mode in AZ6's inventory, including blockers and unknowns. | README agent FAQ; `integrations/`; `extensions/`; CD1/AZ1-AZ6 |
| Default context | Current prompt hooks send pinned memories plus five recent memories; task-triggered recall is not enabled by default. Do not describe every prompt as query-conditioned lesson selection. | `src/hooks.ts`; README; Z1/Z1d/Z10 and the default freeze |
| Core and commercial edition | The commercial edition is planned; its private repository is a scaffold, not a released enterprise product. MIT core includes tenants, API keys, admin/member roles, per-key scope grants and audit logging. SSO/SCIM, organisation/team/project policy, enterprise reports/joins, SIEM export, offline licensing, serving agent hooks to laptops that keep no store of their own, hosted SaaS and SLA support are planned commercial capabilities. | README open-source/commercial section; CONTRIBUTING; `src/server.ts`; ROADMAP Part XII/EI/EV/CD |
| Data location and egress | Local SQLite and markdown mirrors; default recall makes no network call. Optional API features can send text externally. Sleep uses Anthropic fact extraction when `ANTHROPIC_API_KEY` is set unless extraction is disabled. Never describe all configured operations as having zero egress. | README data FAQ; website privacy copy; `src/consolidate.ts`; provider settings |
| Jev and CLEF | Jev ranking evidence does not establish an answer-rate or user-task win. CLEF integration is planned and role-specific; free weights or a free hosted quota do not make hardware, hosting or operation free. Ordinary memory retains the native path and paid inference is explicit opt-in. | `docs/evals/2026-09-19-jev-reranker.md`; CLF0-CLF13; CAE10 |
| Retrieval and task benefit | Default `hippo recall`: 85.6% R@5 on LongMemEval-S within its 4,000-token budget. The benchmark scripts' best of five settings reach 98.0% with MiniLM. These are different configurations, not proof of better agent work; retain published losses and retractions. | `docs/evals/2026-09-28-recall-cli-longmemeval-result.md`; eval index; Z0 and applicable parent gates |
| Enterprise value and low touch | Customer defines objectives and accepted outcomes; Z10/Z2b joins are provider-neutral and CW3 is an optional producer. Count developer and administrator setup, supervision, review and recovery. Unknown outcomes stay unknown; simulated actions do not measure active human time. | EI15/CD14/EV9; Z12; current execution index |

## Dated publication observations

These observations describe the review snapshot, not a perpetual assertion about the current release.

| Surface | Observation on 2026-10-02 | Remaining reconciliation |
|---|---|---|
| GitHub source | Reviewed master at `2b3ec52047b98fe3ad462bad4bc6a1f80ba468c8`; root package version `1.53.0`. This amendment updates source documentation and website copy. | Record the amendment commit separately; it is not an npm or website release. |
| npm registry | `latest` was `1.53.0`; package `gitHead` was `ba9f95e14bcc17e3506673cb8ea21897e3ca288a`. | Inspect the README/metadata in the actual release artifact and listing after the next normal release. Do not claim these amended sentences are already on npm. |
| Live website | The 2 October review observed a `1.52.7` footer, while website source imports root `package.json` (`1.53.0`) and already had newer setup copy. | Verify deployed commit/version and rendered copy after the normal website deployment. Changing source is not a live-site update. |
| Commercial edition | Review found a private scaffold, not a released enterprise package. Public descriptions must show planned availability. | Commercial maintainer must supply an identified package/deployment and acceptance evidence before changing availability claims. |

## Release and publication checklist

1. Update this inventory, README and affected hand-written website/agent-install/integration copy together. Reconcile edition, default, setup/trust, egress and benchmark qualifiers. MSG6 still owns the wider semantic audit, including package metadata, historical entry points and all relevant public pages.
2. Run `node scripts/check-roadmap.mjs` and `node website/scripts/check-readme-sync.mjs`; build affected website pages. These guards check document structure and selected shared wording, not every semantic claim or live compatibility.
3. Follow `docs/release-policy.md` for an npm release. Verify tag, package version, tarball README/metadata, npm dist-tag and the rendered listing against the release commit. Do not publish a package merely to label a roadmap change complete.
4. Follow the website deployment process and check rendered setup, enterprise availability, FAQ, comparison, metadata, footer and `/llms.txt`/`llms-full.txt`. Record deployed commit and date. A source-derived version label alone cannot prove deployment or npm consistency.
5. Record availability and fixture/live/task evidence separately for core and commercial capabilities. Leave planned features, absent telemetry, blocked runtime modes and unmeasured outcomes explicit; never promote them because a document guard passed.

The current governing order is [ROADMAP's execution index](../ROADMAP.md#current-execution-index). Historical queues and forecasts remain records of earlier decisions.
