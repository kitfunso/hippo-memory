# Z0 redesigned: hippo against the memory Claude Code and Codex already have. Pre-registration

**Date:** 2026-09-29
**Roadmap:** ROADMAP Part XV, Track Z, Z0 (the scored run of Part IX, Track TE, TE5, re-registered)
**Replaces as the Z0 design:** `docs/evals/2026-09-23-te5-token-ab-preregistration.md`. That file is kept as the record, but its comparison against no memory is no longer the headline.
**Statistics:** `src/eval-stats.ts` (pricing, bootstrap); stage 0 adds the two-level bootstrap below.
**Review:** an adversarial methods review on 2026-09-29, before registration. Its fixes are applied here, and its findings are summarised at the end.
**Status:** draft. It is registered when merged. No run under this design exists. After the first scored session, the thresholds, arms, endpoints and gates do not move; any change is a new registration with its own date.

## Why Z0 was redesigned

The first design asked whether hippo beats an agent with no memory. That is the wrong comparison, and the runner could not deliver it anyway.

1. **Memory is already there, or one switch away.** Claude Code turns auto memory on by default. Claude writes its own notes during the session: who the user is, the corrections and approaches they confirm, project facts and references. It loads the first 200 lines or 25 KB of a `MEMORY.md` index at every start (Claude Code docs, "How Claude remembers your project", fetched 2026-09-29). Codex ships memories that are off by default and switched on with `[features] memories = true`. They are generated in the background from past sessions, are global per user, and live under the Codex home (OpenAI docs, "Memories", fetched 2026-09-29). A buyer asks what hippo adds to what they have, and whether it follows them from one tool to the other.
2. **The no-memory arm was not no memory.** `ab-run.mjs` passes the operator's environment to Claude Code (`scripts/token-eval/ab-run.mjs:400-401`) and never turns auto memory off, so every arm could keep and load notes. Those notes live in the operator's real `~/.claude/projects/`, keyed on a workspace path that repeats across runs. The runner clears the workspace (`:387`) but not the notes.
3. **The hippo arm never had its instruction block.** `hippo init` writes its block only into a `CLAUDE.md` that already exists (`src/cli.ts:778`). Where a base had one, `checkoutBase` (`:241-247`), which runs before every task (`:433`), restored the committed file with `checkout -f` and removed untracked files with `git clean -fdq -e .hippo`, taking the block (written at `:416`) and anything the agent wrote with it.
4. **The tasks gave memory nothing to do.** Tasks mined from commits mostly need knowledge that is in the code, and in a `claude -p` run nobody ever corrects the agent. Both memory systems were starved of the input they exist for. No arm showed whether the task set could register a memory effect at all, so a null would not have meant "memory does not help".

The pilot run under the first design is kept as a shakedown of the runner. It is not evidence either way, and its numbers are not published.

## Questions, in order

1. When a user corrects Claude Code once, does hippo make it less likely to repeat the mistake in a later session, beyond what Claude Code's own memory already does?
2. Does a lesson taught in Claude Code reach Codex, beyond what a user gets by pointing both tools at one instruction file?
3. Does hippo cut the tokens a task costs?
4. What does hippo cost when nothing it holds bears on the task?

Two reference questions sit under these. Can any memory help on this task set? That is tested by a perfect-memory arm against no memory, and it is the positive control; without it a null cannot be read. And does built-in memory help? That is tested by built-in memory against no memory.

**Expectations, written before any run.** Question 1 is open. With about ten lessons per repository, Claude Code's index loads whole. Hippo's prompt hook injects pinned rules and the five newest memories (`src/hooks.ts:142`). Its instruction block also asks the agent to run a whole-store recall at the start of each task (`src/cli.ts:7936-7943`), but agents skip that often (ROADMAP Z1, pull arm). A tie or a loss on question 1 is a real possibility, and either would redirect Z1. Question 2 is harder than it looks: a user who imports `AGENTS.md` into `CLAUDE.md` gets portability for free, and that setup is the comparator.

## Unit of test: the lesson family

A **lesson** is one rule an agent needs for a task. It qualifies only if:
- it cannot be worked out from the checkout (the screen below tests this);
- a user would state it in one or two sentences;
- a script can check it from the session's diff, commit or command log, with no model judging.

A **family** is one lesson plus its tasks:
- a **teach task**, where the lesson first applies;
- two **apply tasks** later in the sequence. They are fresh sessions on different files and wording. Their acceptance tests force the action the lesson governs, and their prompts never state the lesson;
- one **screen task**, used only in the screen and never scored.

About a quarter of families are **reversal families**. After the first apply task, a later task's teach message reverses the rule ("we moved from X to Y"), and one more apply task checks the new rule.

**No-lesson tasks** (set N) are drawn from the same repositories' history, the way the first design drew them, rewritten as symptoms. They carry no lesson, and they measure what memory costs when it has nothing relevant. They make up a third of the tasks in each sequence; their total is sized for H4 at calibration.

### Where lessons come from

These rules are fixed before authoring.
- **Maintainer rules, at least two thirds of families.** Rules taken from the agent-instruction and contributor files of public repositories (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `CONTRIBUTING.md`). Those files are deleted from the eval checkout and the history is truncated. The maintainers wrote each rule, not us.
- **Template lessons, at most one third.** Environment and preference lessons from a fixed list published with the task set. Examples: a test command that needs a flag, generated files that must not be edited by hand, changelog entries that go in fragments, the repository's logger instead of `console`. Every result is also reported on maintainer rules alone.

### Repositories

At least five scored repositories and at least three development repositories (the pilot's three). All are public, in at least two languages, each with a working test command and, where possible, commits after the pinned model's training cutoff. The pilot repositories are development-only and are never scored.

### Authoring, blind to hippo

An author session writes the families, prompts, teach messages and checkers from the repositories and rule sources only. It has no access to hippo's source, its capture rules or any earlier result.

For every family the author lists the lesson's key phrase. An apply prompt may not contain it unless the task cannot be stated without it, and the word overlap between each apply prompt and its lesson is published.

A **teach message** is built from the maintainer's own sentence plus a fixed reason template, never reworded to suit any memory system. Checkers return pass, fail or not-applicable.

### Screen

Before scoring, each candidate family runs under the two control arms only, A0 and A4, on two seeds. A0 runs the teach and screen tasks. A4 runs the screen task with the family's teach message already written into `CLAUDE.md`, exactly as its arm definition does after a teach task. A family is kept if A0 breaks the lesson on at least 2 of its 4 attempts, so there is something to learn, and A4 follows it on both of its attempts, so memory can fix it. The drop list is published. The screen never runs a hippo or built-in arm, so it cannot select for or against either.

## Arms

All Claude Code arms use one model, pinned by id, and one Claude Code version with auto-update off. The same holds for all Codex arms. Each run gets fresh, empty directories for everything that could hold memory, checked empty before its first session, and its own tool installs on `PATH`.

Every arm starts from the same one-line stub `CLAUDE.md` committed into each task's base. This gives hippo's init a file to patch, and puts every arm under the same rule for when Claude Code reads `AGENTS.md`.

`ANTHROPIC_API_KEY` is removed from every arm's environment, and hippo's LLM extraction is off. That is hippo as shipped for a user without an API key.

**Claude Code (sets R and N, the same sequences):**
- **A0, no memory.** Auto memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `autoMemoryEnabled: false`). No hippo. Instruction files reset to the base before every task. This is the floor.
- **A1, built-in memory.** Auto memory on, in the run's own config directory. Instruction files the agent writes (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/rules/`) carry to later tasks. This is Claude Code with nothing installed.
- **A2, built-in memory plus hippo.** A1 plus `hippo init --no-schedule` on the stub, at the freeze tag: its hooks, its `CLAUDE.md` block and its store, all kept across tasks. This is the primary treatment, because users do not turn auto memory off to install hippo.
- **A4, perfect memory.** A0 plus the family's teach message, written by the runner into `CLAUDE.md` right after each teach task. That is perfect saving and perfect recall. This is the positive control.
- **A5, sham hippo.** A2 with capture removed. hippo's capture hooks (session end, pre-compact, post-compact once it exists, tool failure) are dropped, and a `hippo` shim on `PATH` turns `remember`, `capture`, `learn` and `outcome` into no-ops. The same block, prompt hook and injection channel stay, fed only by what init seeded. Only the lessons hippo captured differ from A2.

**Codex (set X, the portability test).** Each family's teach task runs in Claude Code, and its apply tasks run in Codex in the same workspace. Codex apply tasks get **no teach messages**, so Codex's own memory cannot learn the lesson there, and the second apply task still measures what crossed over.
- **X1, built-in memory, the floor.** Claude Code auto memory is on for the teach task, Codex memories are on for the apply tasks, and instruction files carry. Codex reads `AGENTS.md` and not `CLAUDE.md`, so a lesson crosses only if the agent wrote it into `AGENTS.md`.
- **X2, hippo.** X1 plus hippo in both tools on one shared store: Claude Code's hooks, and the Codex setup `integrations/codex.md` documents at the freeze tag, with its session-end launcher wrapper, pointed at the run's own `CODEX_HOME`.
- **X3, do it yourself.** X1, with the stub `CLAUDE.md` importing `AGENTS.md` (`@AGENTS.md`), plus one line telling the agent to add each correction it receives to `AGENTS.md`. This is the free route to portability, and the comparator for H2.
- **X4, perfect memory.** X1 plus the teach message written into `AGENTS.md` after the teach task.

How Codex hooks are trusted in a fresh Codex home is settled in the smoke stage and written into the runner, the same way for every Codex arm. If Codex memories cannot run headless, or are not offered on the account, X1 to X4 run with them off, and the write-up says so.

**hippo's agent-memory import is part of hippo.** `hippo init` and `hippo sleep` copy the memories each agent keeps on disk (Claude Code auto memory notes, Codex memories and the rest) into hippo's store (`docs/plans/2026-09-29-import-agent-memories.md`). Each run's environment sets `HIPPO_AGENT_MEMORY_TOOLS=claude-code,codex`, which the hooks inherit and which overrides store config (config cannot do it, since `hippo init` creates the store in the same command that imports), so the import reads no other tool, and each tool's home is found the way the tool finds it, so a run reads only its own `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. At init both are empty. Session end imports, so in A2 and X2 the notes Claude Code wrote during a task can reach the next task through hippo, and in X2 that is one way a lesson crosses to Codex. A5 drops the session-end and compaction hooks, so A2 minus A5 measures hippo's capture and this import together. In A2, hippo can repeat a note Claude Code already loads itself; the run ledger records the source prefix of every row hippo injects, so the write-up reports what share of A2's injected memory was imported notes, and the token measures price it.

**Dropped from the first design, and why.**
- **Random repository text** is replaced by A5, which matches hippo's own channel.
- **Another repository's memories** (the old stale-memory arm, which tested irrelevant memory) are replaced by the reversal families, which test an on-topic lesson gone out of date.
- **Hippo with built-in memory off** is not run: no Claude Code user is in that state by default.
- **A misleading-memory arm** (a planted, plausible, wrong memory) is the next registration after this one. It needs a planted note for built-in memory too, designed separately.

## Session protocol

- **Fresh sessions.** Every task is a fresh session: `claude -p`, or `codex exec` for Codex apply tasks.
- **Before a task.** The code is reset to the task's base, and memory carries per the arm's definition. The runner snapshots every memory surface: the auto memory directory, the Codex memories directory, the hippo store and the instruction files. It records their hashes and sizes in the run ledger.
- **Teach tasks.** After the session, every arm gets the family's teach message once, as a resumed turn (`claude -p --resume <id>`):
  - if the check failed, as a correction: "No: <rule>, because <reason>. Please fix it.";
  - if it passed, as a confirmation: "Yes, keep doing that: <rule>, because <reason>."

  So every arm is taught every lesson, whether or not it happened to comply.
- **Apply tasks in Claude Code.** A failed check gets the correction once, which is how a user behaves. Its tokens count toward the task. H1 is also reported on first apply tasks alone, before any re-teaching can differ between arms.
- **What a teach message never says.** It never says "remember" and never names a memory tool: the claim under test is memory that works with no command.
- **Grading and waits.** The hidden acceptance tests run after the last turn. For Codex, the runner waits after each session for memory generation to finish, in the way the smoke stage establishes.
- **Transcripts and rollouts** stay where each tool writes them, because hippo's capture and Codex's memory generation both read them. A session in which the agent itself reads a past transcript, a past rollout or another arm's directories is void (gate G1).
- **Retries.** A retry after a plan-limit cut-off first restores every memory surface from the pre-session snapshot. A run that stops partway is reported as abandoned and never analysed.

**Order.**
- **Sequences.** For each seed there is one sequence per repository, used by every arm, with the order drawn from the seed.
- **Spacing.** A family's teach task comes before its apply tasks, with at least two other tasks between them, and apply tasks spread across the sequence. So some lessons are older than hippo's five-newest window when they are needed. That is how real stores look; it is not a trap.
- **No-lesson tasks** are interleaved.
- **Timing.** Arms run in lockstep: at each task position the arm order rotates, so time of day, plan windows and service changes fall on every arm alike.

**Seeds.**
- A1, A2, A5, X1, X2 and X3 run three seeds.
- A0, A4 and X4 run two, since their gate needs a large effect. Any comparison with a two-seed arm uses seeds 1 and 2 only.

## Hypotheses

The primary family is H1 to H3, Holm-adjusted at a two-sided 0.05.

Each hypothesis gets exactly one verdict, checked in this order:
- **loss:** adjusted p below 0.05, with the estimate in the harmful direction. A loss leads the write-up.
- **win:** adjusted p below 0.05, with the estimate in the helpful direction. The write-up says whether the estimate reaches the minimum effect; a win below it is called a small win.
- **tie:** neither of the above, and the 95% CI lies inside the tie band.
- **inconclusive:** anything else.

These cannot overlap. A CI inside the tie band that excludes zero is a win or a loss, since those are checked first.

- **H1, repeat mistakes (Claude Code, set R).** A2's repeat-mistake rate differs from A1's. Minimum effect 15 points; tie band plus or minus 15 points. A win must hold under both codings of not-applicable: counted as a violation, and excluded.
- **H2, portability (set X).** On Codex apply tasks, X2's repeat-mistake rate differs from X3's. Minimum effect 15 points; tie band plus or minus 15 points. X2 against X1 is reported outside the family.
- **H3, tokens (sets R and N).** The ratio of A2's mean priced tokens per task to A1's, with teach and correction turns included. Minimum effect: a ratio of 0.95. Tie band: 0.95 to 1/0.95. The write-up splits it into first-session tokens and teach-and-correction tokens, so a saving from fewer repeat mistakes is not read as a saving from shorter sessions.

**Harm gate H4 (set N), not a claim.** On no-lesson tasks, both of these must hold:
- A2's cost ratio to A1 has an upper 95% bound below 1.10;
- A2's resolve rate is no more than 5 points lower (its lower 95% bound is above -5 points).

If H4 fails, the write-up leads with it.

**Attribution.** H1 is written as "hippo's lessons cut repeat mistakes" only if A2 also beats A5, with the 95% CI excluding zero. Otherwise it is written as "installing hippo changed behaviour, and this run cannot say its lessons did".

**Definitions.**
- The **repeat-mistake rate** is the share of (apply task, lesson) pairs whose check fails on the agent's first attempt: its state at the end of its first session, before any correction on that task.
- **Priced tokens** come from each tool's own usage fields, in four buckets (input, cache write, cache read, output), at list prices on the freeze date, through `priceUsage`.

## Validity gates

Every gate must pass before any hypothesis gets a verdict. A failed gate makes the run **invalid**, reported under that gate's name, never as a null.

- **G1, isolation and delivery.** Checked on what the model received. If the smoke stage shows a local logging proxy works with plan login, it records every request. Otherwise, unique canary strings are planted in the operator's own Claude Code and Codex configuration and memories, and in each arm's memory surfaces at probe time, and every transcript and tool output is searched for them. A session is void if:
  - A0 or A4 received auto memory;
  - any arm but A2, A5 and X2 received hippo text;
  - an operator canary appears anywhere;
  - the agent read a past transcript, a past rollout or another arm's files.
- **G2, positive control.** A4 beats A0 on repeat mistakes by at least 30 points, with the 95% CI excluding zero, and X4 beats X1 the same way. If not, the task set cannot show what memory is worth, and the run says nothing about hippo either way.
- **G3, no leaks.** No lesson's text is in any arm's memory surfaces, workspace or prompts before its teach task. A leak voids its sequence. More than 5% of sequences voided makes the run invalid.
- **G4, plumbing.** Invalid sessions (a crash with no result) are at or below 5% in every arm, and no two arms are more than 3 points apart. A timeout is scored as not resolved and priced from its transcript, not dropped.
- **G5, grading.** Every lesson check and acceptance test runs a second time on the saved diff, and a lesson whose verdict flips is dropped from every arm before unblinding. A reader who cannot see the arm checks 30 sampled (diff, verdict) pairs. If more than 10% disagree, the checker is fixed and every arm is re-graded before unblinding.

**Blind analysis.** The analyzer prints arms as codes until the gates are checked and the drop list is committed. Then the codes are opened.

## Measurements (per task, arm and seed)

- **Lessons:** first-attempt and final verdicts, and teach and correction turns used.
- **Outcome:** resolved, meaning the acceptance tests pass and every lesson check passes at the end.
- **Cost:** priced tokens in four buckets, split by first session and extra turns.
- **Work:** turns, tool calls, file reads (the Read tool and shell reads such as `cat`, `head`, `sed -n`, `grep`, `rg` and `Get-Content`) and wall time.
- **Plumbing:** the invalid reason, if any.

**Where memory fails, per family and arm (reported, not tested):**
- **stored:** after the teach task, does any memory surface hold the lesson? This is judged by the author's key phrase, checked against a hand-labelled sample, with agreement reported.
- **shown:** is the key phrase in the apply session's context, whether injected or read?
- **followed:** given shown, did the agent obey it?
- **captured:** for A2 and X2, did hippo's capture store the teach message at all? This rate is published per family, since hippo's capture is phrase-based (`src/capture.ts:4-9`).

This chain says why an arm won or lost. It is the input to Z1 to Z4.

## Analysis

- **Units.** For H1 and H2, the unit is a family on one seed (the mean over its apply tasks). For H3 and H4, it is a task on one seed. Every comparison is paired on the same family or task and seed.
- **Intervals.** A two-level bootstrap with 10,000 resamples. It draws repositories, then families within each repository (no-lesson tasks count as families of one), keeping each family's seeds together. Every family in a sequence shares one store, so a capture fault moves them together, and only a draw at the repository level carries that. The p-value is 2 × min(share ≤ 0, share ≥ 0) from the same resamples. Stage 0 adds this to `src/eval-stats.ts` with tests; today's `clusteredPairedBootstrap` has one level and no p-value.
- **Reported, outside the primary family:**
  - A1 against A0: does built-in memory help here?
  - A4 against A1: how much memory value is still on the table?
  - X2 against X1;
  - resolve rate and cost per resolved task;
  - the stale-follow rate after a reversal;
  - H1 to H3 on maintainer-rule families only;
  - H1 on first apply tasks only;
  - repeat-mistake rate by how many tasks ago the lesson was taught;
  - word overlap between prompt and lesson against the hippo effect.

## Sample size

Calibration (stage 2) runs the development repositories under every arm on two seeds. It measures:
- A1's repeat-mistake rate;
- the spread of paired differences between families and between repositories;
- the no-lesson cost spread;
- sessions per task and per plan window.

K, the number of scored families, is set with 2,000 simulated runs of the full analysis, drawn from those estimates on three seeds and bootstrapped as above. K is the smallest number that gives at least 80% power for both of these, at Holm's strictest level (0.05/3):
- H1 a win when the true effect is 15 points;
- H1 a tie when the true effect is zero.

Set X gets its own K from the same rule for H2, and set N its size from 80% power for H4 to pass at a true difference of zero. H3 is sized too: calibration also measures the spread of paired token ratios, and sets R and N together must give H3 80% power, at the same level, to be a win at a true ratio of 0.95 and a tie at a true ratio of 1. Where H3 needs more tasks than H1 and H4 give, the larger size is used.

If any of these exceeds 60 families, or the session total exceeds the ceiling set at the founder's go, the run does not start, and the needed sizes are reported instead. An underpowered run is not started.

## Stages, each closed by its check

0. **Runner and hippo prerequisites** (code PRs, before any session). This stage:
   - turns auto memory on or off per arm, and gives each run its own Claude Code config directory (`CLAUDE_CONFIG_DIR`), with the plan login supplied through the environment rather than copied files; transcript lookup (`ab-run.mjs:566`) points there;
   - adds the stub `CLAUDE.md`, and per-arm carry lists in place of the `checkoutBase` wipe;
   - adds teach messages, confirmations and correction resumes;
   - adds lockstep rotation of the arm order (`planRuns`, `:333`) and wider file reads (`:198`);
   - adds snapshot-and-restore on retry, and the three grading checks listed under TE5 in the ROADMAP;
   - adds a Codex runner with per-run installs and `CODEX_HOME`;
   - fixes hippo's Codex wrapper, which reads `~/.codex` and ignores `CODEX_HOME` (`src/hooks.ts:254`);
   - sets `HIPPO_AGENT_MEMORY_TOOLS=claude-code,codex` in every run's environment, and shows in the dry run that hippo's agent-memory import reads only the run's own homes: `hippo import --agents --dry-run` in each run lists only those two tools, resolved to that run's `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (the dry run fails when either is unset or any other tool is listed), and a canary note in the operator's real Claude Code, Codex and Copilot user memories never reaches a run's store (the shim changes HOME and USERPROFILE, not APPDATA);
   - adds the sham-hippo shim, the memory-surface ledger, the read check, the two-level bootstrap and blind mode in the analyzer.

   **Check:** a unit test per change, and a dry run showing fresh, empty memory directories per run.
1. **Smoke.** About 30 sessions on a toy repository. It shows:
   - canaries arrive, or are absent, as G1 requires, and whether a logging proxy works;
   - `--resume` delivers a teach message;
   - hippo's hooks fire under `claude -p`;
   - auto memory saves under `-p`;
   - Codex memories generate under `codex exec` with a per-run home, and how long they take;
   - Codex hooks can be trusted in a fresh home.

   **Check:** a committed smoke report that settles each point. If auto memory does not save under `-p`, every Claude Code arm runs through an interactive driver instead. If no driver works, H1 is not run, and the report says why.
2. **Development task set and calibration.** Author and screen the development families, then run every arm on two seeds. Runner faults found here are fixed and listed. **Check:** the sizes computed and committed, and the analyzer committed with its hash recorded. Then **hippo is frozen at a tag.** A later hippo change means a new registration.
3. **Scored task set.** Authored after the freeze, by the blind author, and screened on the control arms. Only its hash is committed; the files stay outside the repository until the result is published. **Check:** the hash, the drop list and the overlap table are committed.
4. **Scored run**, once, on the scored repositories. **Check:** G1 to G5.
5. **Analysis and write-up.** Blind first, then unblinded. **Check:** a result doc in `docs/evals`, whatever it says. The README and decks change only after it lands.

Later Z items (Z1 to Z9) are tuned on the development families only. Each is scored once, as a new A2 arm on the frozen scored families.

## What gets published, whatever the result

The run publishes all of this, whatever the verdicts:
- the task catalogue, with its sources and checkers;
- the drop list and the smoke report;
- every arm's settings and shims;
- the runner and analyzer at the frozen commits;
- per-session records, with transcripts removed;
- the result, with every verdict: losses, wins, ties, inconclusives and invalid gates.

## Limits, stated now

- **Headless sessions.** Teach messages are scripted, and a person corrects with more variety.
- **Small stores.** About ten lessons per repository. Built-in memory's index loads whole at that size, and real stores are larger. Scale is a later registration.
- **One model per tool.**
- **User-stated lessons only.** Lessons the agent finds for itself, such as dead ends and environment facts, are tested only through the template lessons.
- **Our own templates.** We wrote the template lessons, which is why every result is also reported without them.

## Decisions for the founder at the run go

The run spends plan usage, not billed money, but it is large. Calibration converts it to days of usage before the scored run. Two numbers are set at the go and recorded here before stage 3:
- **The session ceiling.**
- **The minimum effect.** Raising it from 15 points cuts the families needed sharply, but a real gain smaller than it then comes out as a tie or a small win.

## Review findings applied (2026-09-29)

An adversarial review of the first draft found 14 issues. All were accepted:
- the power rule required an estimate at the minimum effect, so it capped power near 50%;
- there was no loss verdict;
- the scored tasks existed before hippo froze;
- hippo's block never landed without a `CLAUDE.md`;
- the headless fallback would have gutted the baseline;
- teaching depended on chance compliance;
- the placebo broke the arm rotation and could carry the target lesson;
- set X had a comparator that could never win, and a Codex wrapper blind to `CODEX_HOME`;
- the one-level bootstrap ignored the shared store per sequence;
- not-applicable coding needed both readings;
- H3 restated H1 and had no tie band, and H4 had no size rule;
- G1 and "shown" were not observable as written, and retries kept memory from aborted sessions;
- teach wording was not tied to the maintainer's sentence;
- several claims were loose or wrong.

Nothing was rejected.
