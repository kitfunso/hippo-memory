# Claude API eval workflows for Hippo

Researched 2026-10-01. **Status: adoption plan, not an installed integration or a scored result.** Implementation is tracked by ROADMAP Part XX, CAE0-CAE5.

## Decision and boundary

Use Anthropic's `/claude-api build-eval` and `/claude-api hillclimb` as maintainer-invoked development workflows around Hippo's existing Claude Code evals. Start with the Z1 pull-arm trigger experiment: improve the `hippo_recall` tool description while holding its implementation, model, effort, memory fixtures and other tools fixed. This is a context/tool-use experiment, not a claim to optimise an entire agent harness.

Reuse `scripts/token-eval/make-tasks.mjs`, `ab-run.mjs`, `ab-analyze.mjs` and existing registrations where applicable. Add only a thin output adapter and missing workflow controls; a small trigger-specific runner may be necessary because TE5 measures complete tasks. Hippo's shared engine and non-Claude integrations stay outside the editable scope. The upstream skill specialises in Claude and can stop when it detects a non-Anthropic target; scope it to the Claude evaluation integration rather than authorising a provider migration.

The maintainer starts Claude Code. No `hippo` command installs this skill, launches an optimiser or dispatches agents. This follows the [work plane boundary](2026-09-12-work-plane-boundary.md). Z0 stage 0, smoke, calibration and its existing freeze remain the primary queue. Setup, adapter work and new development cases can proceed alongside them.

## Installation and verification

The [current Claude Code skills documentation](https://code.claude.com/docs/en/skills#work-on-claude-api-projects) lists both subcommands as bundled from **Claude Code 2.1.259**. Prefer the bundle; a marketplace plugin is optional.

In a shell:

```bash
claude --version
claude doctor
```

Upgrade through the machine's existing installation channel, following [setup](https://code.claude.com/docs/en/setup): `claude update` for a native install, `brew upgrade claude-code` for the Homebrew cask, or `winget upgrade Anthropic.ClaudeCode` for WinGet. If Claude Code is absent, use its official installer. Restart, open a disposable development checkout with `claude`, and inspect `/skills` and slash completion for `/claude-api`.

Check bundled-skill disabling and project/personal name overrides if the command is missing or loads unexpected instructions. Record the Claude Code version, loaded skill origin, model and explicit effort; availability is not proof that an eval runs correctly.

### Optional official plugin fallback

The inspected [Anthropic marketplace manifest](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/.claude-plugin/marketplace.json) names the marketplace `anthropic-agent-skills` and includes the `claude-api` plugin.

In an interactive Claude Code session:

```text
/plugin marketplace add anthropics/skills
/plugin install claude-api@anthropic-agent-skills
```

Choose **local scope** for the first pilot. Follow the install summary's activation instructions, or restart. Confirm the installed skill in slash completion. Plugin skills are namespaced, so its explicit invocations are:

```text
/claude-api:claude-api build-eval
/claude-api:claude-api hillclimb
```

The [plugin installation documentation](https://code.claude.com/docs/en/discover-plugins) also supports shell installation:

```bash
claude plugin marketplace add anthropics/skills
claude plugin install claude-api@anthropic-agent-skills --scope local
```

Do not assume marketplace `main` matches the bundled skill or remains fixed during an experiment. Record the resolved revision and file hashes; freeze updates for the registered run. The public source inspected here was `anthropics/skills@8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4`. If a pinned local copy is needed, retain the complete `skills/claude-api/` directory and its licence/provenance, including shared eval/report files, rather than copying only `SKILL.md`. Verify the loaded command after any override. Shipping a vendored skill is a separate implementation choice, not required by this plan.

## Invoke build-eval

At the Claude Code prompt, after CAE0 and the runner audit:

```text
/claude-api build-eval Build the Claude Code Z1 hippo_recall trigger eval.
Reuse Hippo's existing Node evaluation infrastructure where applicable.
Measure useful recall invocation on applicable-memory tasks and unnecessary
invocation on no-match tasks; do not maximise total calls.
Use isolated fixture stores and production-representative task families.
Keep all locked Z0 and Z1c corpora and registrations outside this workflow.
Design family-disjoint train, validation and sealed final-test sets.
Review inputs, grading and resource limits with me before scored runs.
```

The workflow interviews the maintainer, sources cases, reviews inputs, calibrates grading, creates or adapts a runnable eval, and produces a baseline with traces. Upstream requires explicit input, grading and cost sign-offs. A future operator must complete those checkpoints; this research/roadmap commit is not their completion.

Source new cases from permitted real failure reports and task patterns, supplemented by independently labelled examples. Include applicable memory, no match, distractors, wrong-project scope, stale/conflicting memories, absent data and paraphrases. Freeze labels before tuning. Never treat every difficult case for one current model as the production distribution.

Use programmatic tool-call and fixture checks for the trigger metric. Independently judge usefulness when fixture labels alone cannot establish it; calibrate against human-reviewed examples and avoid the exact model under test judging itself. Confirm the installed MCP tool is actually exposed and that its description is the one being changed. Treat invocation, useful evidence returned, confirmed delivery, application and task success as separate observations.

Baseline repeats must establish headroom, grader stability and an attainable smallest useful effect. Choose independent families and repetitions from the measured variance; a tiny smoke corpus cannot support a general benefit claim.

## Runner and report adaptation

Before scored use, close the TE5/Z0 runner defects: repeat grading on saved final state, keep arm-caused timeouts in the unresolved denominator with observed cost, report infrastructure invalids by arm/reason, and restore both project store and `HIPPO_HOME` on retry. Preserve the existing experiment's failure policy rather than adopting an upstream default that drops difficult attempts.

Adapt each completed attempt to the upstream `results.jsonl` and rep-specific `traces/` contract. Grade, full observable trajectory, actual served model, usage and elapsed time must refer to the same attempt. Keep case, repetition, arm/variant and fixture identity; resume without duplicating attempts. Persist failed/interrupted attempts and their costs separately but visibly.

Use the report schema as a presentation adapter, not a replacement for Hippo's preregistered statistics. Preserve input, cache-read, cache-write and output usage, retries and maintenance costs where relevant; missing usage or delivery evidence remains unknown, not zero. Distinguish actual API spend from token-priced equivalents for subscription sessions. A Claude Code subscription is not an allowance for separate SDK/judge API calls.

The inspected public source ships `shared/evals/report/build-report-lite.mjs`, `runner-scaffold.mjs` and `SCHEMA.md`; it does not ship the full `build-report.mjs` viewer mentioned as an option in its guide. Use the available lite builder after a variant finishes:

```bash
node <loaded-skill-directory>/shared/evals/report/build-report-lite.mjs <flow-directory>
```

This yields a summary/per-case report with trace links. Do not promise richer viewer features until they are verified in the loaded distribution. Retain existing result layouts if an adapter can supply the contract. Track `_state.json`, baseline and `v<N>` results, `change.md`, `change.patch`, decisions and progress. Keep private source snapshots and raw traces outside the repository, with permitted retention, hashes and references; commit sanitised manifests and reports.

## Invoke hillclimb

After the reviewed eval is runnable:

```text
/claude-api hillclimb Optimise the Z1 hippo_recall description against the
reviewed Claude Code trigger eval. Only that description is editable.
Freeze the tool implementation/schema, model, effort, other tools, stores,
runner, grader, case labels, split and all shipping defaults.
Use train diagnostics to propose one change per round and validation
aggregates to select candidates; keep the sealed final test inaccessible.
Register minimum useful gain, no-match harm bounds, rounds, repetitions,
time and usage/spend ceilings before the first round.
Record every patch and keep/revert decision; stop on regression or budget.
After the registered plateau rule, diagnose remaining train failures
instead of spending on unmeasurable wording changes.
```

Translate the description-only scope into exact editable ranges or an isolated configuration surface. A whole-file allowlist for `src/mcp/server.ts` alone would also permit unintended implementation edits; review each diff and verify untouched ranges, schema and exports. No optimiser edits to grader, labels, answers, task tests, dependencies or source-permission rules. Changes to the evaluation itself require a versioned correction and consistent regrading/rebaselining outside the optimisation loop.

The article repeatedly scores its held-out split to choose a winner. For Hippo, that split is **validation**, even if the upstream workflow calls it test. Always reserve a third, independently held-out confirmation set for a claim-bearing run. Split by independent repository/lesson/task family, not adjacent turns or near-duplicate prompts. Keep final-test cases, answers, traces and summaries inaccessible to the proposer through files, memory, git history and network. File hashes detect edits; they do not provide this isolation.

Each round has one hypothesis and reversible diff. Select under the registered useful-invocation objective and no-match harm bounds, with cost and latency reported. A higher call rate is not success if it retrieves irrelevant evidence or harms tasks. Stop after the preregistered cap or plateau; the inspected hillclimb guide specifies at least three plateau rounds. Retain failed attempts in the search record.

### Headless use after the interactive pilot

[Programmatic Claude Code documentation](https://code.claude.com/docs/en/headless) explicitly supports user-invoked skills in `-p` prompts. A possible development invocation, **after** inputs, grading, scope and resources are approved and persisted, is:

```bash
claude -p "/claude-api hillclimb Follow the approved Z1 development plan and its stored bounds." --output-format stream-json --verbose
```

This documents supported skill expansion, not a verified unattended Hippo run. Validate loading, permission boundaries, approval behaviour, output events, cancellation, resume and persisted state before offering a wrapper. Install a fallback plugin beforehand; interactive `/plugin` commands do not run in `-p` mode. Use a maintainer-invoked development script, not a new product dispatch feature. Do not bypass upstream approval checkpoints to make headless execution convenient.

## Confirmation and later flows

Freeze the selected description, runner/grader, model/effort, fixtures, corpus hashes and search record before scoring the sealed final set once under its registered protocol. Compare with the frozen starting description, report clustered paired intervals, guardrail failures and nulls, and archive the selected patch separately from adoption. A failed final result consumes that set; further tuning needs fresh confirmation families.

A trigger win permits the separately registered pull-arm task experiment. It does not prove reduced repeat mistakes, lower total cost or superiority to built-in memory, and cannot bypass Z0's task/default gates. Never reopen or reuse locked Z0, Z1c or another claim-bearing hold-out for optimisation.

Prepare fresh cases and grader reviews alongside the first pilot; start further scored searches after the pilot pattern is sound and the parent gates pass:
- **S9/TE6/TE7:** optimise memory packing/rendering under the actual token cap, retrieval floor, evidence-completeness and task-quality bounds; measure cache behaviour and total costs rather than assuming fewer characters save money.
- **S6/SI4/Z3b:** optimise capture/correction prompts in isolated stores with independently labelled writes and false-closure/false-write bounds. Repeat independent memory builds as well as downstream scoring; repeated queries against one lucky store underestimate variance.
- **SI1:** compare recall of previous optimisation attempts with the plain attempt log at equal budget once enough histories exist. Do not assume memory helps the optimiser.
- **Cost-specific flow:** read the upstream cost-hillclimb guide, measure cache health, audit prompts and separately register model/effort choices. A model change belongs to that experiment, not the fixed-model Z1 description pilot.

## Review of existing roadmap applications

The CAE5 matrix in [ROADMAP Part XX](../../ROADMAP.md) records the complete adoption map. The review found several existing tasks with clear outputs and editable text, beyond the initial recall-description pilot:

| Flow | Existing items | Why it is a useful candidate |
|---|---|---|
| Admission | Z1d / TE6 | Relevant versus irrelevant evidence has independently labelable outcomes. Query/gate text can be varied separately from delivery and ranking. |
| Writes and corrections | SI4 / S0 / S6 / EI1 / Z3b / Z6 / Z9 | A source-to-memory or source-to-replacement pair exposes missing conditions, false writes and wrong closures; the model's extraction/matching instructions are a bounded surface. |
| Rendering | S9 / TE7 / Z9 | The same supported evidence can be presented in different formats, making equal-budget application and real usage comparisons possible. |
| Consolidation | S4 / TE9 / D10 | Independent labels can distinguish genuine duplicate assertions from superficially similar facts with different exceptions; optional merge text can be measured against evidence preservation. |
| Handoff | W1 / CS1 / Z7 | Envelope-only resume tasks establish whether constraints and evidence survived. Delivery mechanics must pass before summary/continuation text is optimised. |
| Tenant development | EI8 / EI12 / EI13 | Reviewed customer tasks can reveal specific convention/admission failures without tuning against the independent live control or buyer report. |

**Readiness follows the failure stage.** Keep Z0 runner/smoke work first. Prepare admission and write/correction cases alongside Z10/S0/S6, then choose the next scored search from observed failures. A missed lesson suggests write/capture work; rejected useful evidence suggests admission work; unclear or expensive supported delivery suggests rendering work. Running every candidate loop in parallel would obscure attribution and consume resource ceilings before the useful bottleneck is established.

**Eval-design-only applications.** Z0/TE5/F8 and Z12 benefit from fresh task, control, burden and growth-case review, grader calibration and trace checks. CD5/SI3/EI2/EV8 benefit from independently labelled poisoning and permission-negative fixtures. These are not permission to let an optimiser alter endpoint definitions, intervention policy, source ACLs, quarantine access or gold labels. Published LongMemEval/LoCoMo, VibeMemBench and DolphinBench protocols retain their locked scoring; use separate development data for tuning.

**Prefer existing non-model methods where they fit.** S1/S2/FE3/LC3 already specify ablations, sweeps, data floors or trainable rankers. Use `build-eval` for review/auditing and a Claude-backed downstream task adapter, while retaining the deterministic retrieval scorer. Start a `hillclimb` only for a genuinely uncertain bounded surface with measurable headroom; a small grid does not need an LLM optimiser. Database/authentication/backup engineering and model-weight research keep their own tests and methods.

### Additional invocation examples

These are future operator prompts; select one reviewed scope and persist its allowed surfaces, metric/failure policy, corpus and resource manifest before scored optimisation. All command loading and confirmation rules above still apply.

For the admission gate:

```text
/claude-api build-eval Prepare the Claude Code Z1d admission study on fresh
development families. Review whether each candidate memory is applicable,
irrelevant, conflicting or unknown. Reuse Z10 delivery evidence and the
existing replay/scorer. Include indirect continuation and no-match cases.
Keep the locked Z1c window inaccessible; propose independent family splits
and useful-coverage/no-match/latency metrics for review.
```

For source-to-memory quality and correction matching:

```text
/claude-api build-eval Prepare the reviewed Claude-backed SI4/S6 and Z3b
development evals. Reuse authorised source snapshots and isolated stores.
Label durable extraction, evidence completeness, addressed claim and
supported replacement separately. Include git noise, exceptions, quoted
corrections, branch-specific facts and wrong corrections. Keep heuristic
baselines, durable receipt/recovery fixtures and public store APIs fixed.
```

For a reviewed rendering study:

```text
/claude-api hillclimb Follow the approved S9/TE7 development plan. Vary only
the allowlisted memory-rendering text, one hypothesis per round. Preserve
the supported facts, conditions, provenance and hard 1500-token cap.
Select using reviewed validation evidence/application and measured usage;
keep model, effort, ranking and cache conditions fixed. Keep final task
families sealed and stop at the stored resource and regression bounds.
```

The same pattern can target an already enabled optional merge prompt (S4/TE9) or bounded continuation text (W1), after their parent readiness checks. It does not enable LLM extraction, change live stores or establish another runtime's support.

### Records each application needs

Use one flow manifest naming parent roadmap items, loaded skill/version, actual model/effort, exact editable surface, baseline, source/fixture hashes, independent splits, scorer, failure policy, minimum useful effect, guardrail bounds and resource/stop limits. Retain paired attempt/usage/trace records and candidate diffs. Separate design review, mechanics smoke, development search, sealed confirmation and adoption statuses. An automated report is not the decision to release.

## Primary sources

- [Lance Martin: Automating eval design and hillclimbing with Claude](https://claude.dev/blog/automating-eval-design-and-hillclimbing/), 2026-09-28.
- [Claude Code skills and bundled workflow versions](https://code.claude.com/docs/en/skills).
- [Claude Code installation/update](https://code.claude.com/docs/en/setup), [plugin installation/scopes](https://code.claude.com/docs/en/discover-plugins), and [programmatic skill invocation](https://code.claude.com/docs/en/headless).
- Pinned public skill [entry point](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/SKILL.md), [build-eval](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/shared/evals/build-eval.md), [eval audit](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/shared/evals/eval-audit.md), [hillclimb](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/shared/evals/eval-hillclimb.md), [cost search](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/shared/evals/cost-hillclimb.md), and [report schema](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/claude-api/shared/evals/report/SCHEMA.md).
- Hippo [current Z0 preregistration](../evals/2026-09-29-z0-built-in-memory-prereg.md) and [work plane decision](2026-09-12-work-plane-boundary.md).

Version and behaviour claims above describe the inspected sources on 2026-10-01. CAE0 must verify the distribution actually loaded on the pilot machine.
