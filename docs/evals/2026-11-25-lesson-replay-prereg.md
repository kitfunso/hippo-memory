# Decision-point replay of round 3 first applies

**Current disposition, 25 November 2026.** Route A is closed. Route B is the next experiment and requires Keith’s explicit approval for API spend. Amendment B below sets its request, grading, gate order and price. Earlier sections record the Claude Code design and its observed outcomes.

Registered 25 November 2026 before the local wire check and before any subscription smoke calls. The question is whether changing the text available at a particular test-command decision changes the command an agent proposes. The unit of inference is a frozen decision opportunity. The experiment does not measure completion of a new coding task.

## Decision order

1. Rebuild the prefix from the observed round 3 request. Use a credential-free loopback receiver and the pinned Claude Code executable to inspect the outgoing request. Require the saved stable system instruction, Bash, the requested model and effort, every ordinary text block, every previous tool choice and every tool result. Record exact hashes of system and tools, missing and added tools, changed definitions and message differences. This is a transport check.
2. Replay unchanged on one family. Require agreement with the real **whole-first-apply lesson verdict** on at least 80% of calls, at least 70% in each historical class and an absolute pass-rate difference of at most 10 percentage points. All thresholds are inclusive. Complete the entire fixed smoke, subject to the stop on infrastructure errors. An incomplete smoke gives no fidelity verdict.
3. A future operator may run the independent full unchanged gate only after the smoke passes. Use the same thresholds. A failed completed gate kills this replay route and all downstream replay claims. No search for a passing family, model, threshold or decision point. A smoke pass alone cannot release the treatments.
4. After both gates pass, test the cut first. The primary estimand is the Opus pass probability with the unchanged visible lesson minus that with its span removed. Positive favors the lesson. The practical null is within ten percentage points of zero. An interval wholly inside that band kills the stored-content claim on this panel. A wide interval around zero is inconclusive.
5. Compare a near reminder with a start reminder, and zero distractors with each registered load. A near advantage supports at-action delivery. Falling compliance with load supports a scale regime. If all four intervals lie wholly inside the practical-null band, kill both regimes here. Wording and model differences are descriptive, two-sided. Need is the probability of missing the required command when the lesson has been cut. It is conditional on the original prefix, which may retain earlier consequences of having seen the lesson.

Design source is brainstorm section 6, row 2. Read with `rg -n "Decision-point replay on saved requests" C:/Users/skf_s/Documents/hippo-mechanisms-2026-11-24/brainstorm/index.html`. Experiment 1 supplies the families, first applies, request coverage and the warning about whole-session command checks. Slice 1's Stop hook observes end-of-task omissions. It is disabled throughout this one-decision experiment.

## Corpus and eligibility

Freeze with `node docs/evals/lesson-replay/freeze.mjs` from the worktree. It imports Experiment 1's round 3 loader and prints the complete inventory and arm budget. It reads only first-session requests, never a correction or a round 4 run. The archive is **C:/z0-lessons/lesson-replay/corpus/**. It contains the selected prefix bodies, original verdicts, source paths, copied checkers and their local imports, schedules, inventory and SHA-256 seal. It can run independently of live agent transcript retention. Re-freezing refuses to replace differing inputs.

Experiment 1 reports 646 logs from 646 first applies. Independently recover arm counts with the freeze command, and the coverage counts with `Get-Content C:/Users/skf_s/Documents/hippo-mechanisms-2026-11-24/experiment1/data/replay-coverage.json`. The gate uses all five original arms. Restrict to the ten named command families in `design.mjs` with an explicit test invocation and a command-only grader. File edits, omissions and repository-state checks need a different outcome measure. This removes 527 records. In a session, take the request immediately before the first observed assistant response whose shell commands the family's original checker grades pass or fail. Match the prior tool ID sequence and the model on consecutive decision requests. The downstream request supplies the historical choice for locating the cut only. Its answer, later actions and outcome are absent from the replay prefix. A final choice without an observable successor cannot qualify. One record has no qualifying successor. No exclusion is based on agreement with the grade.

The gate panel has 118 prefixes, 79 historical passes and 39 failures. The historical **first gradable command** already differs from the whole-session verdict on 13 prefixes. These stay in the gate. The treatment panel is the census of 18 A4 prefixes across the ten families with one literal source-rule line at start and no remaining family-specific target marker after removal. A4 gives an identifiable instruction span. Interpret the cut as removing that carrier, conditional on the earlier actions and remaining context. The panel cannot establish an effect for omitted steps, unseen repositories or every kind of Hippo delivery.

## Allocation, controls and budget

The smoke has 20 fresh unchanged forks on gr3-f1. Half come from each historical outcome class, cycling within class in seeded hash order. It covers 13 distinct prefixes. Repetitions sample generation noise. The full gate takes two fresh unchanged forks per eligible prefix, including fresh forks for smoke inputs. Each treatment receives twelve fresh forks per clean prefix. All decisions use medium effort. Every phase has a separate deterministic permutation keyed by the seed in `design.mjs`, session ID, arm and replicate. Different arms never resume another arm's result. Outcome scorers receive only generated command strings.

| Phase or arm | Model | Calls | Change from saved prefix |
|---|---|---:|---|
| Smoke, outside full budget | Opus | 20 | Unchanged |
| Full gate | Opus | 236 | Unchanged |
| Reference | Opus | 216 | Unchanged on clean treatment panel |
| Cut | Opus | 216 | Delete the entire visible rule line |
| Start | Opus | 216 | Put the original rule wording in the original start slot, without the author's rationale |
| Near | Opus | 216 | Put that same wording immediately before the continuation cue |
| Near + 2 | Opus | 216 | Prepend two unrelated catalog rules to the near reminder |
| Near + 50 | Opus | 216 | Same nested list through 50 |
| Near + 300 | Opus | 216 | Same nested list through 300 |
| Paraphrase | Opus | 216 | Replace near wording with the family's frozen equivalent directive |
| Checklist | Opus | 216 | Frame the same near instruction as a completion check |
| Need | Sonnet | 216 | Same cut as Opus, change only requested model |

The loads use distinct catalog IDs and a repeated, unrelated formatting instruction. This measures sensitivity to repetitive background instructions, not real-world semantic diversity. Near, paraphrase and checklist are the three wordings. The Opus cut supplies the matched model baseline.

The full maximum is **2,396 single-turn Claude Code forks**, comprising 236 gate and 2,160 treatment calls. A gate stop spends only calls already attempted. The projected subscription usage is **98,728,162 input tokens including cache reads and writes, and 640,948 output tokens**. Smoke separately projects 825,841 input and 5,554 output. The freeze script uses each original first session's logged token totals divided by turns and adds a planning allowance of 18 input tokens per distractor. These are estimates, particularly for cache reuse, rebuilt context and Sonnet output length. Weekly subscription utilization cannot be inferred from those counts. The ledger records actual token classes. No API allocation is needed.

This is a finite-panel screen. With 216 independent draws per arm, the largest approximate 95% sampling half-width for a difference on this fixed, equally weighted panel is 0.0943 (run `node -p "1.96*Math.sqrt(.5/216)"`). This supports screening for large effects. Repeated draws do not increase the number of independent lessons. There is no population-level power claim or sample-size escalation after looking. Reproduce panel size and budget with `node docs/evals/lesson-replay/freeze.mjs`. To recover the full token sums, run `node -e "let p=require('C:/z0-lessons/lesson-replay/corpus/inventory.json').phases;console.log(['gate','treatment'].flatMap(k=>Object.values(p[k].usage)).reduce((s,v)=>[s[0]+v.input,s[1]+v.output],[0,0]))"`.

## Claude Code route

Use the frozen executable from the brief. Verify with `C:/z0-runs/scored/bin/claude.exe --version` and `Get-FileHash C:/z0-runs/scored/bin/claude.exe`. Replay uses 2.1.323, SHA-256 `5064e6e0572dca86257363ca04d48653eef20ef27f1bd04b504ed7199ed3fd13`. The archived version is attached to each manifest row. The round 3 gr3 example is 2.1.288. Model IDs come from the saved request and the allowed setup file `C:/z0-runs/r4/pins-r4.json`.

The client resumes a linked JSONL prefix from a fresh config and forks a fresh session. It supplies the saved stable instruction via system prompt file and requests the original tool names. Rebuilt aspects include billing/version text, tool definitions, ephemeral message/cache metadata, current working directory and environment, tool availability, and the final neutral “Continue.” cue. The archived environment message is retained as a reminder. Signed thinking is omitted. These differences apply to unchanged as well as treatment. No response is graded until the client produces its own assistant decision. An empty work directory, isolated config, no MCP servers, a deny-all PreToolUse hook and one-turn limit keep historical commands from operating on the source repository. No model is asked to grade outputs.

Run from the worktree with `python -B docs/evals/lesson-replay/wire.py` and then `python -B docs/evals/lesson-replay/run.py smoke --token-var Z0_SUB_TOKEN`. The wire receiver discards requests after comparing their bodies, never forwards them and has no subscription credential. Live mode opens the named User variable only for the Claude Code child, which contacts its usual service directly. Never send the credential to a proxy or raw API client. The runner admits one call at a time, reserves each attempt before launch, stops at the first infrastructure error and refuses to retry an uncertain attempt. The full phases use the same entry point with `gate` and `treatment`. They are future launches.

## Analysis and outputs

Run `python -B docs/evals/lesson-replay/analyze.py smoke`, substituting `gate` or `treatment` for later phases. One JSON line per invocation. Before smoke the exact output is:

```json
{"phase":"smoke","planned":20,"completed":0,"errors":0,"status":"INCOMPLETE","metrics":null}
```

An unavailable model, malformed response, rate limit, aborted reservation or checker error is missing, never an outcome. No replacements or retries. Partial phase reports have no effect estimates. A valid first reply without the required command, including an unrelated next action, scores zero. The original grader's exits 0, 1 and 3 map to pass, fail and absent respectively. The last two are both failures for this next-action measure. Ignore any generated prose claiming success.

On a complete smoke or gate, the same outer keys contain status `PASS` or `KILL_REPLAY` and metrics `agreement,classAgreement,historicalPass,replayPass,rateDifference`. The signed difference is replay minus historical. On complete treatment, status is `COMPLETE` and metrics are `pass,contrasts,contentInert,noPlacementOrScale`. Every contrast reports first-minus-second pass-rate difference, a two-sided 95% Newcombe score interval, and a practical-equivalence flag. The unadjusted secondary intervals describe this fixed panel. A timing-and-load kill requires all intervals to establish equivalence. For the model contrast, Opus pass minus Sonnet pass equals Sonnet need minus Opus need. A nonsignificant result alone triggers no mechanism kill.

## Amendment A — launcher and scoring repair, before the second smoke

The original 11/20 agreement is a harness fault. Recover it with `python -B docs/evals/lesson-replay/analyze.py smoke --first-pass`. The first fixture recorded a permission denial followed by a turn-limit error. The code set a one-turn limit (the CLI reported two), installed a deny-all hook, restricted the tool names, and accepted only one assistant message ID. See `Get-Content C:/z0-lessons/lesson-replay/wire.json`. Keep all first-pass files in place.

Repeat the identical sealed smoke schedule once, recording new attempts in `C:/z0-lessons/lesson-replay/repair/`. Keep the historical outcome labels, checker and all three inclusive fidelity thresholds above. Score the first new assistant decision containing a checker-recognized shell command, skipping intervening nongradable decisions. A normal finish without a gradable command counts as absent. An infrastructure failure leaves the gate incomplete. This changes the observation window from the first response to the next gradable command. A fork can make several underlying requests. Count forks and observed turns separately.

Trace the launcher with `Get-Content C:/z0-runs/scored/s4-run.ps1` and `git -C C:/Users/skf_s/hippo show 08a7352873714bf93101a6841ddb5885cff7f503:scripts/token-eval/turns.mjs` (also `arms.mjs` and `runs.mjs` at that revision). It selects project settings, an arm-specific settings file, strict MCP configuration, bypassPermissions and the pinned model. It sets effort through the environment and supplies no CLI turn cap. Compare native and saved-system variants on the same first scheduled prefix with local synthetic responses. Prefer the exact system array, otherwise use native settings unless the saved file recovers the stable system block exactly. Report both results, including differences in tool definitions and messages. Verify real tool execution and a later gradable decision before opening a subscription credential.

### Second-pass wire result and disposition

Run `python -B docs/evals/lesson-replay/wire.py` and inspect `Get-Content -Raw C:/z0-lessons/lesson-replay/repair/wire.json | ConvertFrom-Json`. Both variants matched the requested model, effort, prior tool choices and tool results. The saved file matched two original system blocks, including the stable instruction. The native prompt matched one. Neither matched the complete system array. The selected variant returned `systemExact=false`, `toolSetExact=false`, `allSchemasExact=false` and `messagesExact=false`. Among shared tools seven definitions matched and five differed. Fifteen source tools were absent from the initial request and two appeared only in the replay. The original had 14 messages and the replay had 17. The receipt lists each tool by name. These counts describe the initial offline request, including any deferred tools that were advertised there.

The fixture reached a later assistant decision, but Windows returned `EPERM` on both attempts to start Git Bash, including the hook shell. The execution marker was absent. The checker treats this as an infrastructure error. A direct invocation of the same Bash executable under the restricted account also failed at MSYS `CreateFileMapping` with Windows error 5. The smoke entry point refused before credential lookup. Reproduce with `python -B docs/evals/lesson-replay/run.py smoke --token-var Z0_SUB_TOKEN`. The repaired result is **INCOMPLETE**, with zero of the 20 scheduled forks completed and agreement undefined. There is no second fidelity verdict to trigger route B. The full run remains unlaunched.

The runner uses a private workspace drawn from the most recent accessible commit named in the saved prefix. The wire fixture could recover only the earlier snapshot (`Get-Content C:/z0-lessons/lesson-replay/repair/wire-*/workspace.json`). It lacks the exact filesystem state at the decision. The prefix carries the historical instructions. An execution hook redirects historical workspace paths to the private copy, and an observation hook ends the fork at a gradable command. The settings file retains the historical arm hooks with log paths redirected. If an archived Hippo shim names a missing executable, the runner records the installed replacement in `hook-runtime.json`. These replay-specific differences, the synthetic continuation cue and the unverified execution hooks limit any claim of setup identity. A new test of this route requires a read-only frozen tree and a worker on which the pinned Claude Code client can execute Git Bash.

### Third pass, registered before the subscription gate

Use the sealed smoke schedule, Amendment A's scoring window and the original inclusive thresholds. Stop at the first infrastructure error. Keep this pass in `C:/z0-lessons/lesson-replay/third/`. The first offline repeat ran both shell commands successfully outside the earlier sandbox. Its receipt is `third/wire-before-git.json`. The historical environment names a Git repository. The repaired launcher had unpacked its files without a repository. Fetch the available prefix commit into a private shallow repository and check it out detached, with no configured remote. Run the native and saved-system fixtures again. Compare the initial request with the saved decision request and retain both receipts. No later round or historical continuation supplies workspace state.

Run `python -B docs/evals/lesson-replay/wire.py`, then `python -B docs/evals/lesson-replay/run.py smoke --token-var Z0_SUB_TOKEN` and `python -B docs/evals/lesson-replay/analyze.py smoke`. A completed gate below threshold stops this Claude Code implementation. Only failure with matched setup triggers the paid route B proposal. An incomplete gate has no agreement estimate. The full phase remains a separate launch.

#### What the client sent

The corrected checkout passed both execution checks. The saved-system variant reproduced the SDK identity and stable instruction blocks in the offline request. Native mode reproduced the identity alone. Neither reproduced the historical billing/version header. Full system, initial tool set, tool definitions and messages all differed. The model, effort, ordinary text, previous tool calls and results passed the registered transport checks. Reproduce the two comparisons with `Get-Content -Raw C:/z0-lessons/lesson-replay/third/wire-before-git.json` and `Get-Content -Raw C:/z0-lessons/lesson-replay/third/wire.json`. The restored Git repository corrected the environment description. Its presence did not remove the tool differences.

The first authenticated fork also recorded its initial request locally. The offline probe measures what the loopback client sends. Some service-dependent behavior appears only in the live subscription session. Run `python -B docs/evals/lesson-replay/live_wire.py` to regenerate `third/live-wire.json` from attempted forks. It reads Claude Code's own request shape, parameters and message references. The local shape omits the billing header and stores cache markers separately. It cannot establish byte identity with a live network body.

| Difference | Evidence and possible effect on the next decision |
|---|---|
| Client and system | The frozen launcher pins 2.1.323. The selected historical request identifies 2.1.288. The rebuilt billing header is principally attribution metadata. Its behavioral effect was untested. Live, the client appended WebSearch mode guidance to the saved stable text. It can steer search choices. |
| Deferred tools | In the first live fork, CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, Monitor, NotebookEdit, PushNotification, RemoteTrigger, SendMessage, TaskStop, WebFetch and WebSearch moved out of the initial schema list. The generated environment named each for lookup. ToolSearch and DeferredToolPlaceholder appeared in the list. The placeholder is reserved. A lookup can become the next action. The offline fixture also lacked PowerShell and did not advertise PushNotification for lookup. Both were available live. |
| Tool definitions | Agent, Bash, PowerShell and Read changed input definitions in the first live fork. Agent, Bash, PowerShell, Skill and Workflow changed descriptions. These can change tool selection, arguments or shell syntax. The shared live definitions also carried a changed `eager_input_streaming` field, including Edit, Glob, Grep, ListAgents, ReportFindings, ScheduleWakeup and Write. The field concerns streaming. Its independent effect on the command was untested. Per-fork names and fields are in the live receipt. |
| Message history | The client retained ordinary text, historical tool inputs and results in the controlled receipt, dropped signed thinking, represented the old environment as a reminder, supplied a new environment and skill/tool descriptions, and added the continuation cue. Message roles, boundaries and cache placement differ. Instructions and the removed reasoning can affect the next action. Cache metadata principally affects reuse. |
| Settings and filesystem | The frozen launch uses isolated Claude configuration, project settings plus the arm settings file, strict MCP with no supplied servers, bypassPermissions, pinned effort/model and no CLI turn cap. No operator plugin or skill directory was imported. The historical config recorded built-in plugin use. A clean current client can choose different built-ins and service features. Neither an arbitrary feature override nor loading personal settings reproduces the frozen launch. The fresh checkout, redirected paths, local runtime, possible Hippo shim substitution and missing decision-time edits can alter command results and later choices. The observation hook stops after the first recognized command. |

Trace the settings with `Get-Content C:/z0-runs/scored/s4-run.ps1` and the pinned `turns.mjs`, `arms.mjs` and `runs.mjs` commands in Amendment A. Inspect the source config's directory names with `Get-ChildItem -Name C:/z0-runs/scored/r3run/gr3-w1b/run/runs/gr3/A0/seed2/claude-config`. The executable, flags, project files and the observed deferred-tool reminder explain the launch and discovery paths. These comparisons do not isolate a particular server-side flag from version changes.

#### Third-pass outcome

**INCOMPLETE. Of the 20 scheduled items, 15 matched, three disagreed and two have no grade.** All ten historical failures matched. Five of the eight graded historical passes matched. Fork 19 exceeded the launcher's 600-second timeout. Its local transcript shows dependency synchronization followed by a shell action that included the target pytest filter. The client returned no final result for scoring. The registered infrastructure rule excludes the attempt, even though the proposed command is visible. The runner stopped before fork 20. There were no replacements or retries. The timed-out client's surviving shell tree was identified from its private session PID, creation time, folder and command, then stopped.

The registered analyzer returns exactly:

```json
{"phase":"smoke","planned":20,"completed":18,"errors":1,"status":"INCOMPLETE","metrics":null}
```

The pass-rate criterion is already unreachable. Five graded replays passed. Even if both ungraded items passed, the replay would have seven passes against ten historically, a gap of 15 percentage points. The allowed gap is ten points. This is a bound on the missing outcomes. The registered verdict remains incomplete.

All 19 launched forks have a local request record. Each matched the historical model and effort and retained the saved stable instruction text. Each appended the same WebSearch guidance, advertised 14 historical tool definitions by lookup, and added ToolSearch and DeferredToolPlaceholder. All live tool shapes differed from the offline fixture. None of the recovered Git snapshots matched the first commit named in its prefix. Configured launch settings therefore reproduced some, but not all, conditions relevant to the next choice.

The full 2,396-fork schedule was left unlaunched. The smoke did not qualify it. The condition for proposing paid route B, a completed failure under matched setup, was unmet. The only live model calls were through the frozen Claude Code client. A local preflight presence check read the named User variable and emitted a Boolean. No credential value was printed.

Reproduce the verdict with `python -B docs/evals/lesson-replay/analyze.py smoke` and the live comparisons with `python -B docs/evals/lesson-replay/live_wire.py`. Inspect the timeout code with `Get-Content C:/z0-lessons/lesson-replay/third/smoke.jsonl -Tail 1` and its limit with `rg -n 'timeout=600' docs/evals/lesson-replay/session.py`. To reproduce the class counts and the upper bound from the frozen schedule and ledger, run from PowerShell:

```powershell
python -B -c "import json,collections;from pathlib import Path;d=Path('C:/z0-lessons/lesson-replay/third');c=d.parent/'corpus';jobs={j['id']:j['sid'] for j in json.loads((c/'smoke.json').read_bytes())};history={r['sid']:r['pass'] for r in json.loads((c/'manifest.json').read_bytes())};ok=[r for r in map(json.loads,(d/'smoke.jsonl').read_bytes().splitlines()) if r['status']=='ok'];pairs=[(history[jobs[r['id']]],r['pass']) for r in ok];print(collections.Counter(pairs));print('matched',sum(a==b for a,b in pairs),'best possible pass-rate gap',(sum(history[sid] for sid in jobs.values())-sum(b for a,b in pairs)-(len(jobs)-len(ok)))/len(jobs))"
Get-ChildItem C:/z0-lessons/lesson-replay/third/smoke.*/workspace.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json } | Group-Object exactStartCommit
```

## Amendment B. Direct Messages API replay, priced before any calls

The third Claude Code gate matched 15 of 20 scheduled decisions. Its two unscored items left a best-case pass-rate gap of 15 points against the inclusive 10-point limit. The client also appended system instructions, deferred tools and rebuilt messages. Keith closed that route and requested a price for replaying the saved body directly. This amendment supersedes the earlier requirement for a completed, matched-setup Route A failure. Source command: `Get-Content C:/z0-lessons/lesson-replay/third/report.txt`.

### Paid request and endpoint

After Keith authorizes spend, send one direct `POST https://api.anthropic.com/v1/messages` per scheduled draw, authenticated only with the operator’s `ANTHROPIC_API_KEY`. Use the standard first-party global endpoint. The estimator has no network client and reads no credentials. Subscription credentials have no role in Route B.

`python -B docs/evals/lesson-replay/route_b.py` recovers the complete original UTF-8 body by matching the sealed Round 3 projection, including effort, to the first-apply wire log. It verifies the preceding tool ID sequence against the successor and joins that decision’s tool IDs to a single historical assistant message and usage receipt. It freezes 118 byte-exact bodies in `C:/z0-lessons/lesson-replay/route-b/bodies/` and their byte sizes, hashes and usage in `route-b/receipts.json`. The successor and the receipts are measurement inputs only. The new request contains no historical answer. The receipt index SHA-256 is `36d514ee267e335495bfb967566f313150c36b17334ab0530233d7d274b0e587`. Recompute with `Get-FileHash C:/z0-lessons/lesson-replay/route-b/receipts.json`.

Both unchanged gates and the treatment reference send the archived bytes. Preserve system, ordered tools and definitions, messages and roles, signed blocks, cache markers, metadata, thinking, output configuration, context management, output limit, model and streaming. The log preserved the body but did not record HTTP headers. Supply the API version and any required feature headers at transport level. If the paid endpoint rejects a saved field, role, signature or model, stop with an infrastructure error. A body rewrite, dropped field or replacement model would require a new registration.

For the other arms, `route_b.variant` constructs the request. The cut deletes the exact frozen source line. Start replaces it in place with the frozen rule. Near cuts the line and appends the rule as a final text block in the last user message, after its saved tool results. The load arms use the same block with their registered nested distractors before the rule. Paraphrase and checklist change only that near wording. The Sonnet arm uses the identical cut with the registered Sonnet model ID. No arm adds the Claude Code continuation cue. The near text follows the original final cache marker. JSON spelling may change when an edited body is serialized. Unedited fields retain their values, order and content.

### One decision per draw and two fidelity checks

End each fork at the first complete assistant response. Assemble its stream through `message_stop`, collect Bash and PowerShell command arguments from that response in order, and grade the whole list with the frozen family checker and arguments. A checker exit of 0 passes. Exits 1 and 3 fail, as does a valid decision with no gradable command. Prose does not establish a pass. No tool executes and no historical tool result is appended after the decision. This window measures the proposed next action. The historical comparator remains the whole-first-apply lesson verdict, including the registered cases where it differs from the historical next action.

Keep the original sealed schedules, sampling rationale, permutations, primary Opus reference-minus-cut contrast, intervals and practical-null kills above. No substitutions, retries, judge calls or token-count API calls. An HTTP error, incomplete stream, malformed decision, model mismatch or checker error stops the phase as incomplete. Preserve the attempt and any available actual usage.

1. **Route B entry gate.** Run only the 20 unchanged draws in `smoke.json`. Require a complete gate, at least 80% overall agreement, at least 70% in each historical class, and an absolute pass-rate gap of at most 10 percentage points.
2. **Full schedule, conditional on the entry gate passing.** Start with the 236 fresh unchanged draws in `gate.json`. Apply the same thresholds. Only a second complete pass releases the 2,160 draws in `treatment.json`. A completed failure at either gate kills Route B. An incomplete phase releases nothing. Route A receipts cannot release either phase.

Analyze only the new `C:/z0-lessons/lesson-replay/route-b/{smoke,gate,treatment}.jsonl` ledgers using `python -B docs/evals/lesson-replay/analyze.py smoke --route-b`, substituting the relevant phase. Use the registered result schema above. The exact entry-gate output at registration is:

```json
{"phase":"smoke","planned":20,"completed":0,"errors":0,"status":"INCOMPLETE","metrics":null}
```

### Estimated API spend in USD

The **entry gate** costs an estimated **$4.68 with the saved cache settings** or **$3.61 at uncached rates**. If it passes, the **full schedule adds $191.40 with caching or $400.32 uncached**. The full figure includes the independent fidelity gate and excludes the entry gate. The full schedule stops at its fidelity gate if that gate fails. All figures are pre-tax planning estimates.

| Schedule | Calls | Total input | Ordinary input with caching | 1-hour write | Cache read | Output | With caching | Uncached | Cache on, all misses |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Entry gate, Opus | 20 | 853,786 | 40 | 553,128 | 300,618 | 9,594 | $4.68 | $3.61 | $7.02 |
| Full fidelity gate, Opus | 236 | 9,894,632 | 472 | 5,737,512 | 4,156,648 | 82,458 | $48.38 | $41.23 | $80.80 |
| Treatments, Opus | 1,944 | 81,821,280 | 2,030,184 | 10,761,427 | 69,029,669 | 666,900 | $121.36 | $340.62 | $659.79 |
| Sonnet on the cut | 216 | 8,863,992 | 432 | 5,136,703 | 3,726,857 | 74,100 | $21.66 | $18.47 | $36.20 |
| Full schedule after entry | 2,396 | 100,579,904 | 2,031,088 | 21,635,642 | 76,913,174 | 823,458 | $191.40 | $400.32 | $776.79 |

Reproduce every budget row with `python -B docs/evals/lesson-replay/price_route_b.py`. The command prints JSON with phase and model counts, token classes and three USD scenarios. The historical **decision request’s** ordinary input, cache write and cache read sum to its metered size. The output estimate uses the matched decision response, including billed thinking. For an edit, convert the difference in compact UTF-8 message bytes to tokens at that request’s measured ratio of total input tokens to serialized tool, system and message bytes. Round the changed start span and any appended suffix separately. Sonnet uses the matched Opus decision as a size and output proxy. Sampling, changed wording and model choice can change the actual output.

For the cached estimate, keep the saved one-hour markers and the frozen call order. Start each phase cold. Assume one request every 30 seconds, an explicit planning input in `price_route_b.py`. Credit a read only if the same model’s complete marked prefix was seen less than one hour earlier in the phase. Refresh the timestamp on each hit. On a miss, bill the entire marked prefix as a one-hour write. This deliberately gives no credit for a shorter common prefix, so actual cache reuse can be better. A slower cadence or eviction can increase writes. The historical cache split sizes the marked prefix, but the historical warm cache does not carry into the API experiment. Text after the marker stays ordinary input. Five-minute writes are zero. At uncached rates all input is ordinary and cache reads and writes are zero. That column is a billing comparison only. Keep the saved gate body intact. The all-miss column holds output at its historical estimate and shows the cost of cold writes, not a spending cap.

Prices read 25 November 2026, in USD per million tokens. For `claude-opus-5-5`, ordinary input is $4, one-hour writes $8, hits $0.20 and output $20. For `claude-sonnet-5-5`, those rates are $2, $4, $0.10 and $10. Five-minute writes would cost $5 and $2.50 respectively. The calculation multiplies each token class by its model’s rate, sums before rounding to cents, and applies standard synchronous pricing. [Anthropic model pricing](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing) · [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**Status.** Body recovery, decision-receipt matching and offline pricing are complete. API acceptance, realized cache reuse and fidelity remain untested. Keith’s money approval is required before the first gate request.

25 Nov 2026. Keith approved the entry gate and conditional full schedule using Windows User `Z0_CONSOLE_KEY_2` as `ANTHROPIC_API_KEY`, with `Z0_CONSOLE_KEY_3` for a first-request authentication or credit stop.
