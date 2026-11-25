# Lesson knockout in Claude Code, stratum C

Registered before the smoke. The smoke is a plumbing check and has no weight in the study. No full launch is authorised here.

## Claim and decision

Does a captured lesson cause an agent to respect the rule on the first apply when Hippo is the only carrier from the teaching session? The experimental unit is one original lesson family in one repository, with one teach and one first apply task. The first hypothesis predicts more first-attempt violations in N than in T. The second predicts that independent applies on two intact copies will ordinarily agree. This study tests a controlled prompt-time delivery of stored content. The product’s retrieval ranking, opt-in Slice 1 Stop check, ordinary built-in carry, and model-based capture are separate interventions.

The primary estimand is the N minus T difference in first-attempt violation probability, averaged within each repo and then equally across repos. Score the frozen lesson checker before any corrective apply turn. Count fail and not-applicable as violations. Repeat the paired analysis dropping a pair if either verdict is not-applicable. Report both paired Student intervals, two-sided 95%, over repository means with df = contributing repos minus one. Retain the unclipped intervals. Noise is the share of eligible intact-arm comparisons on which T and T′ differ in binary violation status under the primary coding. Report flagged follows within the 11 roster families labelled `variant` in experiment 1. A failed check qualifies when a logged command contains the key phrase. Print eligible and flagged counts for each arm. The three unlabelled families have no flag. Reproduce membership with `node docs/evals/lesson-knockout/plan.mjs labels`. They remain in the primary endpoint.

Kill content if the primary point estimate is **below 0.15**. Kill the fork design if disagreement is **above 0.15**. Equality survives either kill. Require a point estimate at least 0.15 and a lower confidence bound above zero under both codings for a positive result. A failed integrity gate voids interpretation even if an observed effect crosses a threshold. Inspect gates before contrasts. No expansion, optional stopping, independent-seed counting or replacement of failed captures.

## Roster, allocation and precision

Use seed 1, the 29 repositories named by the two batch key lists in the allowed pins, and 49 distinct families. Take the first unreversed lesson and its first apply under Z0’s seed-one task ordering. Give each repository one family by SHA-256 rank, then allocate the remaining places from the unused families by a separate hash rank. The labels and historical grades have no role in the draw. Separate hash domains assign the order of units and the permutation of T, T′ (disk label Tp) and N. The order is fixed before teaching. The manifest includes both task ids, both base refs and hashes of the task spec and checker. The roster digest is `7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42`. Rebuild it with `node docs/evals/lesson-knockout/plan.mjs`. The sampled population is the available task setup, including families omitted by the historical grading filter.

This is a large-effect screen. At the design assumption of 0.40 SD for repo contrasts, the 95% half-width is 0.152 with 28 df. Power against zero is 0.50 at a true difference of 0.15 and 0.90 at 0.25, before the point-estimate hurdle, exclusions or integrity gates. The sample can stop an unpromising direction or motivate independent replication. It cannot reliably distinguish a borderline effect. Reproduce the illustration with `python -c "from scipy.stats import t,nct; from math import sqrt; n=29; c=t.ppf(.975,n-1); print(c*.4/sqrt(n),[(d,nct.sf(c,n-1,d*sqrt(n)/.4)+nct.cdf(-c,n-1,d*sqrt(n)/.4)) for d in (.15,.25)])"`. The SD is a design assumption. Section 4 of the brainstorm supplies the large-effect rationale and the thresholds.

## Treatment and session setup

1. Stage a fresh shallow checkout of the teach base. Initialise a native Hippo store with 20 real background rules drawn deterministically from other repos, filtering the target key phrase. Seed the private Claude project memory with one of those rules. Save the pre-teach home and repo instruction inventory with file bytes and hashes. Every arm keeps built-in memory enabled.
2. Run the task once, grade it, and resume the *same* session with Z0’s confirmation or correction. Use the Slice 1 build’s local pattern extractor on the actual user follow-up in the CLI transcript. Include changed auto-memory notes. Stamp every emitted memory with the teaching session UUID and its source. This restricted writer admits the person’s lesson and its note copies, without unrelated assistant summaries, secondary model calls or asynchronous imports. Store a single frozen Hippo snapshot per teach. A capture with zero rows gives identical stores in every arm and stays in the denominator.
3. Start a **new Claude session** for each apply. Fork the filesystem snapshot, never the teach conversation. All arms reuse the same active absolute paths sequentially. T and T′ copy the snapshot. N starts from the pre-teach Hippo store and rewrites the UUID-owned entries with neutral factual text, preserving each row id, slot order, byte length and pin. Fresh construction prevents old text surviving in SQLite free pages, search tables, or Markdown mirrors. Fail on unattributed changes to the background. The only cue is the identical user-prompt hook reading the live database in row-id order. The cue still fires if capture failed.
4. Fetch the clean apply base directly into a new repository with no teaching commit or remote containing a future fix. The reset copies the pre-teach memory and instruction files from the private home and restores the repo instructions by relative path. It removes apply-only instruction paths and checks the complete path-to-hash maps, including absence of new teach files. This covers user, root, nested and local CLAUDE files, AGENTS, .claude/rules, the entire per-project config tree (all project folders, topic files, MEMORY.md and transcripts), and the controlled home instruction files. Pin the config directory, project key and auto-memory directory. Refuse external ancestor instructions, managed instruction files, linked memory surfaces or unresolved instruction imports. The background is a controlled pre-teach background, with no personal account memory. [Claude Code memory locations](https://code.claude.com/docs/en/memory)
5. Use the model, effort, native CLI and toolchain from the frozen launcher. Setup and the CLI run locally as the operator, with the network on. The launcher reads the named subscription token from the operator's User environment. Native CLI request-body files supply the leak audit. Smoke uses restricted file tools and skips dependency installation. Only a confirmed subscription limit or overload can trigger the scored retry procedure below.

## Validity, exclusions and planned read

Require all planned arms, distinct session ids, common teach id, equal pre-teach hash, equal frozen-store hash, matching slot identities, and no target provenance in N. Audit the full rule and its key phrase on the delivery surfaces defined below. A missing, withheld or unreadable request series is an integrity failure. Hook loss must be strictly below 5% over scheduled applies. Count a cue only when the first indexed request contains the complete expected block in the prompt-hook context. Keep timeouts and other missing cues in their assigned arm with their observed grade. Report misses by arm and apply the pooled gate before interpreting any contrast. A hook miss never triggers a rerun. Infrastructure failures (login, timeout, setup, store proof, missing transcript, invalid checker exit or incomplete fork) interrupt collection and leave a visible partial run. Do not code these as compliant applies. No score until there is a complete, valid roster. A missed capture, unsuccessful code change, genuine fail or not-applicable verdict is not an infrastructure failure.

Before making a public claim, have a person blind to arm, delivery text and filenames audit 100 apply grades sampled by a pre-specified SHA-256 rank of `audit|unit-id|arm` over the frozen roster. Compare the first-attempt diff and command evidence against the checker. Disclose discrepancies; do not overwrite primary grades. An independent packaging and human review step is required before a positive claim.

Rebuild the roster and budget with `node docs/evals/lesson-knockout/plan.mjs usage`. Analyse with `python docs/evals/lesson-knockout/analyze.py`. It reads scored units only. Exact initial output:

```json
{"planned":147,"observed":0,"status":"incomplete"}
```

A complete read first reports integrity gates, including `contaminatedByArm`, `contaminatedPairs` and `scheduledPairs`. Above the contamination limit it emits `protocol-failure` and stops before computing any effect or disagreement. Otherwise it emits `violation` and `excluded` for the two primary codings, `gates.disagreement` for the intact arms, and `sensitivity` with both codings and disagreement on all pairs. Each contrast holds `pairs,repos,df,estimate,low,high` in probability units. It also reports `kill`, empty captures, eligible and flagged counts by arm, and the unfiltered raw grades. The remaining status order is invalid, kill, audit-required, inconclusive.

## Usage and launch

49 teach sessions plus 147 independent applies = **196 sessions**. A teach has an initial invocation and one resume, giving **245 planned CLI invocations**. Full-run usage uses experiment 1’s round 3 loader, 202 usable Hippo-arm teach records with a resume and 148 filtered first applies. Average token components in input / cache write / cache read / output order are 42 / 35,137 / 947,386 / 7,962 per teach (both turns) and 16 / 13,521 / 328,352 / 2,846 per apply (first session only). The full projection using unrounded means is **99,211,796 metered tokens**, including 94,689,673 cache reads. Cut-off subscription attempts add unprojected invocations and usage. This planning proxy cannot determine a weekly subscription percentage. No dollar charge or quota fraction is inferred. The same `plan.mjs usage` command gives every component and denominator.

Historical smoke command (budget exhausted): `node docs/evals/lesson-knockout/run.mjs smoke q145-f1 Z0_SUB_TOKEN`. One unit, T and N only, sequential, with at most three model turns in each of four task invocations. The shortened session may hit its turn cap and is never analysed. Full collection, after separate launch approval and the registered launch checks, uses the `unit` command in roster order, one unit at a time. Existing unit directories are refused. Retain failed attempts. Run data lives under `C:/z0-lessons/lesson-knockout`.

Design sources: the supplied brainstorm sections 4 and 6, experiment 1’s results and loader, Slice 1’s plan and code, and the numbered preregistration format before the round 4 amendments. Frozen setup comes only from `C:/z0-runs/r4/tasks`, `pins-r4.json`, and `pin-roles.txt`. The launch constants come from `Get-Content C:/z0-runs/scored/s4-run.ps1` and the task turn driver. The captured branch revision is available with `git -C ../wt-slice1 rev-parse HEAD`. The source for fixed smoke limits and thresholds is the experiment brief and the design choices declared above.

### Engineering amendment after the shortened smoke, before any scored session

The original task smoke completed both forks. Both failed the prompt-hook delivery gate: the Windows job refused to spawn Git Bash. Keep those results. Use the same UserPromptSubmit event and response, served by a session-bound loopback HTTP hook reading the live SQLite store. This local endpoint receives hook events only. Check completeness against the native body index, response and message ids; the CLI turn counter includes a turn refused by its smoke cap. The records are under `smoke/q145-f1/evidence`. Count bodies with `(Get-ChildItem C:/z0-lessons/lesson-knockout/smoke/q145-f1/evidence -Filter *.request.json -Recurse).Count`.

Before trying the new delivery transport, register one no-tool, single-turn diagnostic for each of T and N on the existing smoke snapshot. No repeated task, teach or grade. `node docs/evals/lesson-knockout/check-smoke.mjs` checks the full expected block in the outgoing request, target present in T, absent in N, and enforces the shared 20-call ceiling. These diagnostics are engineering evidence only. The arm, cue, roster, endpoints and kill thresholds stay as registered. [Claude Code HTTP hooks](https://code.claude.com/docs/en/hooks#http-hook-fields)

### Readiness record after the diagnostics

The request index and body checks passed in both diagnostics. T contained the captured target, N contained the equal-length neutral slot, and both received the complete expected block. The original shortened coding sessions did not receive the block. No coding session was repeated after the transport change. Reproduce the receipts with `Get-Content C:/z0-lessons/lesson-knockout/smoke/q145-f1/delivery-check/*/delivery.json`. Reproduce the native request count with `(Get-ChildItem C:/z0-lessons/lesson-knockout/smoke/q145-f1 -Recurse -Filter *.request.json).Count` (14). The smoke measures delivery and reset only.

Run `node docs/evals/lesson-knockout/verify.mjs` for an offline check of task pins, the changed and missing instruction files, both intact forks, a missed capture, and neutralisation of distinct rule, summary, error, cue and imported-note texts sharing provenance. The analyzer was also exercised with synthetic complete, killed, invalid and incomplete rosters. Its scored input currently has zero observations.

The original smoke skipped dependency setup. Scored sessions use the task's frozen setup command.

### Outside-sandbox smoke protocol, before dispatch

The original task's saved `evidence/apply-0/settings.json` called the experiment's `deliver.mjs`. Hippo's installer selects a different command, `hippo context --pinned-only --include-recent 5 --format additional-context` (see `wt-slice1/src/surface/hooks-install/rules/shared.ts`). Test the installed command from the pinned slice in fresh no-tool T and N sessions with `node check-smoke.mjs command Z0_SUB_TOKEN`. Use the existing complete-block and target-presence checks. Retain HTTP for collection if the installed command cannot reproduce the registered cue. The diagnostic records the CLI exit separately from delivery.

Reuse q145-f1's frozen teach for one fresh coding apply per smoke arm, with its original task, order, reset and checker. The request count command above found 14 prior bodies. Reserve two one-turn diagnostics and cap each coding apply at two turns to fit the original 20-call ceiling. Keep the earlier evidence and exclude this smoke from analysis.

### Outside-sandbox results, 25 November 2026

**The installed command ran in both arms and failed the registered full-block check in both.** Each CLI exit was zero. The no-tool requests contained Hippo's complete emitted `Project Memory` context with all 21 notes, and the target appeared only in T. The experiment expects the `Project notes` block in store order. The full run will keep the amended loopback HTTP transport, which delivers that cue. The command diagnostic tests the installed Hippo CLI. The old task's custom command was not rerun.

**The shortened HTTP coding smoke passed.** `node run.mjs smoke q145-f1 Z0_SUB_TOKEN frozen-apply` reused the original teach. T and N had distinct sessions, matched reset and snapshot hashes, verified stores and complete request evidence. Both received the registered block. Only T received the target. Both reached their smoke turn cap and both task checkers returned fail. These receipts establish delivery and reset only. The cumulative smoke count reached 20 request bodies. Scored collection still requires separate launch approval.

Read the receipts from PowerShell:

```powershell
$unit = 'C:/z0-lessons/lesson-knockout/smoke/q145-f1'
Get-Content "$unit/command-check/*/delivery.json"
foreach ($arm in 'T','N') {
  $d = "$unit/command-check/$arm"
  $context = (Get-Content "$d/command-output.json" -Encoding utf8 -Raw | ConvertFrom-Json).hookSpecificOutput.additionalContext.Trim()
  $req = Get-ChildItem "$d/bodies/probe" -Filter '*.request.json' | Get-Content -Encoding utf8 -Raw | ConvertFrom-Json
  $arm, [bool]($req.messages.content.text | Where-Object { $_ -and $_.Contains($context) })
}
Get-Content "$unit/coding-check/evidence/*/grade.json"
Get-Content "$unit/coding-check/evidence/*/apply.json" | Select-String 'subtype'
(Get-ChildItem $unit -Recurse -Filter '*.request.json').Count
```

## Review amendment before scored collection

These rules govern scored collection. The preceding smoke records describe their original settings.

1. **Neutral-arm leaks.** Inspect every indexed request for the full rule and key phrase in system text, system-role messages, initial user text and tool results linked by tool-use ID to explicit memory, instruction, configuration or operator paths. Exempt the key phrase only in the exact frozen task prompt when it has `keyPhraseAllowed`. A full rule still counts. Assistant answers, command inputs and ordinary repository output are evidence for grading. The transcript path audit below scores protected paths independently. The executable cases in `verify.mjs` include an unaided follow, an allowed prompt, a protected read, a system leak and a later echo of a missed hook.
2. **Scored launch.** Follow `C:/z0-runs/scored/s4-run.ps1` for operator identity, network access, toolchain selection and the box check before each CLI attempt, including retries. Use the private CLI home, clean checkout, strict MCP configuration and explicit settings. Keep designs, pre-teach state, frozen snapshots, retries and grades outside the fixed `active/live` directory.

   **Transcript path audit.** Before scoring, read the main apply transcript and its sub-agent transcripts, including saved cut-off attempts. Inspect Bash and PowerShell command inputs and the paths in Read, Glob, Grep, Edit and Write inputs. Resolve relative paths against the recorded working directory, or the fixed work directory when it is absent. Count an explicit protected path in a shell command even if the command failed or returned no file contents. A recorded path into the experiment outside `active/live`, `C:/z0-runs`, a source repository, or an operator task or checker file contaminates that family-and-arm apply. Allow the fixed live tree, the pinned Hippo dist, toolchain installs (including frozen Poetry), private caches and task-tool temporary files. In smoke replay, only that session's original live tree stands in for `active/live`. Keep the file, line, tool and path for each hit. Missing or unreadable transcript evidence stops collection.

   Count each scheduled teach/apply pair once per arm, even when it has several hits or retries. Pool those counts over all 147 family-and-arm pairs. More than 5% is a protocol failure. At or below 5%, omit a family from N versus T if either of those arms is contaminated. Apply the same rule to T versus T′ for disagreement. Compute the sensitivity analysis with all pairs under both verdict codings. Count flagged follows among clean eligible applies in each arm. Evaluate request evidence, cue loss and fork gates on the full roster.
3. **Dependencies and home state.** Freeze the controlled memory and instruction files before teach setup. Each teach and apply runs its registered setup command in its clean checkout with a separate `setup-home`, task-local caches and a fresh venv for Python. Use the existing Z0 tool installations, Python constraints and Poetry from round 4. The task tools can fetch dependencies. Preserve the private cache settings in `toolchain.ps1`. Ignore ordinary temp/cache links in the memory inventory. Reject linked instruction and memory paths.
4. **Flagged follows.** Use the historical variant subset declared above. Ineligible rows store JSON null. The analyzer rejects a boolean on an ineligible row or a missing flag on an eligible row.
5. **Managed policy.** Refuse managed instructions, settings files and settings fragments in both `C:/ProgramData/ClaudeCode` and `C:/Program Files/ClaudeCode`, along with uncontrolled instructions on workspace ancestors. See `externalCheck` in `state.mjs`.
6. **Build identity.** Set `KNOCKOUT_SLICE_ROOT` to the Slice 1 checkout at `70eb87c0fdabdcc96754c80ccb4f975df87213ca`. Both consumers use `slice.mjs`, which checks HEAD and the sorted path-and-byte fingerprint of every file in dist, the CLI entry point, package manifest and lockfile before importing. The SHA-256 is `f02c2334a659c0fb245be0f7dbb809fb10ef79160f80ea4868bf093976fa0d4f`. The build command below verifies and prints both pins.
7. **Teach and grade parity.** Only fail selects correction. Pass and not-applicable select confirmation, following `scripts/token-eval/task.mjs:166`. Hold the pre-session commit through execution and parent the post-session snapshot on it. Reject project settings before freezing state, after setup and at session start. The CLI disables settings discovery and loads the explicit per-session file.

### Hook loss and subscription waits

Keep the five-second hook deadline for T, T′ and N. A timeout, cancellation or silent hook with a complete first request counts as a missed delivery. Retain the original grade, report misses by arm and apply the pooled gate before interpreting either contrast. A later echo cannot repair a missed cue. A missing request series independently fails the evidence gate. Historical confirmed task-prompt losses were 6/522 and 2/296 in rounds 2 and 3. Read the denominators with `Get-Content C:/z0-lessons/hook-timeouts/report.md -TotalCount 5`.

Use the limit detector and wait schedule in `scripts/token-eval/records.mjs:6–12`, `turns.mjs:52–71` and `runs.mjs:101`. Only an error or absent result containing a registered subscription-limit or overload message triggers a scored retry. Keep the named token. Checkpoint the entire live tree before each invocation, privately archive each cut-off attempt, wait 15 minutes, then restore the checkout, cache, store, settings, home and transcript. Replay the reserved session ID and identical input. A resume returns to the saved transcript boundary. Stop incomplete after 768 waits. Timeouts, turn caps, hook losses, ordinary errors and checker outcomes never select retries. The smoke budget is exhausted.

## Limits

The agent runs as the operator and the network is on, as in Z0. We use detection in place of isolation. An agent can read a file the operator can read or fetch information from the network. The audit can detect paths visible in tool inputs. It can miss indirect access, paths built while a command runs, and information passed over the network. A clean transcript cannot prove that the agent saw only the assigned lesson.

## Model-free reproduction

Run from the experiment worktree in PowerShell. The verifier checks both generations of saved smoke applies, the no-tool probes and a synthetic sub-agent transcript with a sibling database Read and a checker read from Bash.

```powershell
$d='docs/evals/lesson-knockout'
$env:KNOCKOUT_SLICE_ROOT=(Resolve-Path ../wt-slice1).Path
node --input-type=module -e "import {revision,build} from './docs/evals/lesson-knockout/slice.mjs'; console.log(revision,build)"
node "$d/plan.mjs" labels
node "$d/plan.mjs" usage
node "$d/verify.mjs"
python -B "$d/verify-analysis.py"
powershell -NoProfile -ExecutionPolicy Bypass -File "$d/verify-tools.ps1"
python -B "$d/analyze.py"
& 'C:/Program Files/Git/bin/bash.exe' C:/z0-runs/s7/box-check.sh
```

Before scored collection, the audit flagged both planted reads and found no hits in the four saved smoke applies or the four no-tool probes. The synthetic rosters passed the exclusion, sensitivity and protocol failure checks. The scored roster had zero observations.

Scored collection requires separate launch approval, an available operator subscription, passing pins and a passing box check at launch. The smoke budget is exhausted.

25 Nov 2026: Keith authorised scored collection on Z0_SUB_TOKEN ("use the subscription key").

**25 Nov 2026.** At this amendment, there were zero scored knockout observations. If the pinned box check reports a median above 150 ms, the runner waits five minutes and checks again at the same invocation. The refusal leaves unit state intact. It records no intent or call and uses no assignment or subscription wait.
