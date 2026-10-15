# Z0 stage 2 record

What stage 2 (plan `z0-stage2-plan.html`, D1 to D7 and S1 to S9) decided and found, step by step. Corpora and author folders stay outside git; each entry names the command that regenerates its numbers.

## D5: correction detector

The detector does not ship, so A2 runs on #781 alone (plan line 37).

- Build split: 415 turns, 8 flagged, all 8 true corrections (precision 1.0, recall 0.186).
- Held-out split, scored once after the freeze at 2026-10-11T01:58Z: 409 turns, 54 gold corrections, 0 flagged. Recall is 0 (95% interval 0 to 0.066), and precision has no value, so the 0.9 precision bar is not met.
- Regenerate: `node C:/z0-runs/d5/score-heldout.mjs`, which writes `C:/z0-runs/d5/result.json`; the frozen `correction.ts` hash is in `freeze.json`.

## S2: blind repository picker

**Run 1 was discarded** under D3: 122 requests, 638 hits on hippo from request 86 onward. The author listed the box's temp folder to look for its own leftovers, and that folder held a `hippo-test-tmp-*` test folder. The launcher's first count, 882, also held chance `z0` matches in regex classes and base64; those are no longer hits.

Fixes before run 2, in `z0-author.mjs`:
- TEMP, TMP and TMPDIR point at `<work>/.tmp`, and the prompt tells the author to stay inside its working directory.
- The `z0` pattern skips regex classes and base64 runs.
- Request bodies are scanned without ciphertext (thinking signatures, redacted thinking, base64 images). Run 2 was launched before this fix, so its `verdict.json` uses the old scan; its verdict is re-derived with the fixed scan.

**Run 2 is kept.** It made 90 requests. Its launcher, still on the old scan, flagged 11 hits, and the fixed scan finds 0 in the requests and the output, so all 11 were ciphertext. The author reports one out-of-tree command, `ls ~/.m2`, which showed only that the folder exists; no forbidden term reached it, so D3 keeps the run.

It examined 14 candidates in star order, from root `AGENTS.md` files found by GitHub code search, with TypeScript, JavaScript and forks removed up front. The first two that pass all four criteria:

| Pick | Commit | Language | Licence | Offline test, second run |
|---|---|---|---|---|
| MetrolistGroup/Metrolist | 76fa5a78 | Kotlin | GPL-3.0 | 15.5 s, 186 tests (`:app:testFossDebugUnitTest`) |
| comonicon/Comonicon.jl | 02160658 | Julia | MIT | 77.2 s, 232 pass, 1 broken (`Pkg.test()`) |

The author judged Comonicon.jl the thinner rule set: two of its five rules come from the formatter setup.

Timing in the eval setup, offline, toolchains and caches under `C:/eval-envs/` (detail in `C:/z0-runs/repos/pick-timings.md`):

| Pick | Clean checkout | One test file | Warm rerun |
|---|---|---|---|
| Metrolist | 51 s, 186 tests, 0 failures | 35 s (`--tests` one class; the app still compiles) | 22 s, 15 s |
| Comonicon.jl | 122.7 s, 232 pass, 1 broken | 37 s (`Pkg.instantiate()` first, since `Manifest.toml` is not committed) | 86.0 s, 90.1 s |

Metrolist's Gradle caches were filled by one online build. It needs `maven.aliyun.com` for one dependency, and that host failed DNS twice before the third try passed. The clean-checkout run took 38 of its 61 Gradle tasks from the shared build cache.

Regenerate a scan: `node rescan-author.mjs <out> <repo> [set]` (the session scratchpad script; it imports `leakHits`, `readableBody` and `FORBID_SETS`).

## S3: author inputs

Snapshots from `scripts/token-eval/eval-snapshot.mjs`, manifests in `C:/z0-runs/snapshots/`:

| Repository | Source commit | Snapshot commit | Forbid set |
|---|---|---|---|
| boring-maths | a90c6718 | 0ae43d9d | default |
| fifty | 8976f4a4 | a21d50f2 | default |
| hippo (author) | 5d1e5470 | 32742277 | hippo-repo, capture, extract and hooks sources left out |
| hippo (runs) | 5d1e5470 | 90ba6d25 | hippo-repo |
| Metrolist | 76fa5a78 | 584d3624 | default, 7 earlier rule versions |
| Comonicon.jl | 02160658 | f88bec6f | default, 1 earlier rule version |

The author's hippo tasks are written against 32742277 and carried onto 90ba6d25, which differs only by the left-out files (both drop `website/package-lock.json`).

fifty's venv is reached through `C:/eval-envs/fifty`, a junction whose path names nothing the author may not see; its fast suite passes through the junction (642 passed, 2 skipped, 4 deselected).

## S3: authored families

| Repository | Families (maintainer, template) | Reversal from | Sequence tasks | Screens | Requests, leak hits | Proof |
|---|---|---|---|---|---|---|
| boring-maths | 5 (4, 1) | template `test-flag` | 17 | 5 | 91, 0 | passed on LF, 22 tasks, 0 transient locks (14 on the CRLF run) |
| hippo | 4 (3, 1) | template `test-flag` | 14 | 4 | 52, 0 | passed on LF, 18 tasks, 0 transient locks |
| fifty | 3 (2, 1) | template `test-flag` | 11 | 3 | 58, 0 | passed on LF, 14 tasks, 0 transient locks |
| Metrolist | 4 (3, 1) | template `test-flag` | 14 | 4 | 75, 0 | passed on LF, 18 tasks, 0 transient locks (the CRLF run failed `ml-f2`'s good diff, artefact below) |
| Comonicon.jl | 4 (3, 1) | template | 14 | 4 | 68, 0 | passed on LF, 18 tasks, 0 transient locks |

- boring-maths: the rule file's one history change (line 62, trailing slashes) cannot be a maintainer reversal, because its current text fails criterion 3 (derivable from the checkout).
- fifty: the author examined 21 candidate rules and kept 2, so fifty adds few maintainer families.
- Proof: `node C:/z0-runs/s3/prove.mjs --out <author out> --repo <author checkout> --origins C:/z0-runs/s3/origins.json --scratch <empty dir> [--env K=V]`. It runs the runner's own validator, source check, `runCheck` and `stateCommit`. Per task, the hidden tests must fail at base and pass at fix, and both validation diffs must pass them. The checker must pass the good diff and fail the bad one. The proof counts transient `Permission denied` locks on `stateCommit` instead of hiding them.
- The 14 boring-maths locks came in 44 state commits of the first (CRLF) proof. Windows antivirus held a fresh loose object, git failed with `unable to write file .git/objects/..: Permission denied`, and the runner would have voided the cell and blamed the agent. Fixed in the runner's git helper by 411c3e57: a counted retry, with the count printed at the end of a run.
- Metrolist's first proof failed all 18 tasks, at fix as well as base, with `'gradlew.bat' is not recognized`. Claude Code sets `NoDefaultCurrentDirectoryInExePath` in its own process environment, and the runner passed it on to task commands, so cmd.exe stopped looking in the checkout and a task's result depended on which shell launched the runner. The runner now drops the variable with the other parent-session keys.
- The first proofs checked tasks out with this box's system `core.autocrlf=true`, while the runner's workspaces pin `core.autocrlf=false` and `core.eol=lf`. The state commit then changed every file, so a checker that reads the changed-file list failed Metrolist `ml-f2`'s good diffs, and any bad-side fail from such a checker proved nothing. The proof now uses the runner's git and work config, and all five repositories are proved again on LF checkouts.
- hippo's tasks were written against 32742277 and replayed onto 90ba6d25 by `C:/z0-runs/s3/replay-onto.mjs`, which checks that each replayed diff is byte-identical. All 72 commits replayed. A self-test that replays boring-maths onto its own main reproduces all 89 shas.

## S3: set N tasks

Set N tasks carry no lesson, and the prereg (line 46) makes them a third of each sequence: ceil(L/2) of them for L lesson tasks, so boring-maths 9, fifty 6, hippo 7, Metrolist 7, Comonicon.jl 7.

- Sources: tasks ported from each repository's history, with requests written by a blind author, then tasks a blind author makes by breaking one tested behaviour on `main` in a `base` commit (`main` is the fix).
- Merge rule, fixed before any author output was read (`C:/z0-runs/s3/merge-setn.mjs`): ported tasks first, then authored, each in id order. A task is dropped if it changes a file that a family task or screen changes, or if its request holds a lesson's key phrase. The first `target` survivors are kept.
- Ported tasks often get no fair request, because their tests call a helper the change added: boring-maths dropped 2 of 4, Metrolist 6 of 9, hippo 1 of 1. Comonicon.jl's port kept no tasks. Author briefs now require every name the tests call to survive at the base.
- hippo's first 8 authored tasks each changed a source file that a hippo family task changes, so the merge kept none of them. The brief never told the author which files the families change. Briefs now list every such file (hippo 45, fifty 24, Metrolist 27, Comonicon.jl 28), and hippo gets a top-up of 9 tasks (`hp-b1` to `hp-b9`) on that brief. Authored tasks written before the fix lost the same way in Metrolist (3 of 6) and Comonicon.jl (5 of 9), so they get top-ups of 3 and 5 (`<key>-b1` onward).
- The hippo top-up session built and checked all 9 bases, then ended its turn to wait on a background suite run, which ends a print-mode session, so it never wrote its task file. A continuation session on the same folder finishes the job, and every later brief says to run commands in the foreground and write the files before the last message.

| Repository | Target | Ported: requests, kept | Authored: made, kept | Proof |
|---|---|---|---|---|
| boring-maths | 9 | 2 of 4, 1 | 9, 8 | passed, 9 tasks |
| fifty | 6 | 5 of 6, 2 | 5, 4 (target met before the fifth) | passed, 6 tasks |
| hippo | 7 | 0 of 1, 0 | 8, 0; top-up 9, 7 (target met) | passed, 7 tasks |
| Metrolist | 7 | 3 of 9, 3 | 6, 3; top-up 3, 1 (target met) | passed, 7 tasks |
| Comonicon.jl | 7 | none ported | 9, 4; top-up 5, 3 (target met) | passed, 7 tasks |

Regenerate: `node C:/z0-runs/s3/merge-setn.mjs --key <k> --name <repo> --fam <family tasks.json> --fam-repo <dir> --run-repo <new dir> --out <new dir>` writes `merge-report.json`; the proof is `prove.mjs` on the merged spec with `--only` per set N id. `ff-n5` fails at its base on an import of `MAX_SPAN`, a name its request gives, so it stays. The S4 screen reads these merged specs: `C:/z0-runs/s3/<key>-run/tasks.json` for boring-maths, fifty, Metrolist and Comonicon.jl, and `C:/z0-runs/s3/hp-all/tasks.json` for hippo.

## S3: overlap and keyword tables

Drafts, from the runner checkout before #781; they are rerun on the S6 commit. Per lesson: source line, key phrase, task count, the highest word overlap between a task prompt and the rule, and the capture categories hippo's `extractFromText` finds in the rule and in its correction teach message.

| Repository | Lessons | Captured from the teach | Highest prompt overlap |
|---|---|---|---|
| boring-maths | 6 | 0 | 0.25 |
| fifty | 4 | 1 | 0.29 |
| hippo | 5 | 2 | 0.25 |
| Metrolist | 5 | 1 | 0.25 |
| Comonicon.jl | 5 | 0 | 0.20 |

So before #781, capture fires on the teach message for 4 of these 25 lessons. #781's build (27f58449) captures the same 4 and no others: it changes what happens to a captured rule, not which teach messages yield one. Regenerate: `node C:/z0-runs/s3/tables.mjs <tasks.json>` per repository, into `C:/z0-runs/s3/tables-<key>-draft.md`; with `EXTRACT_JS=<#781 worktree>/dist/capture/extract.js`, into `tables-<key>-781.md`.

## S4: key phrases re-picked before the screen

The first screen launches refused in preflight: the runner's stub-tree check (`assertNoPhraseInStub`, `leaks.mjs`) found lesson key phrases in repository files. A scan of every task and screen (`C:/z0-runs/s4/phrase-scan.mjs`) found 14 of 25 lessons colliding: boring-maths 5 of 6, fifty 1 of 4, hippo 5 of 5, Metrolist 2 of 5, Comonicon.jl 1 of 5. Authors had picked the rule's subject, such as `npm test`, `JSDoc` or `affiliates.ts`, which READMEs, CI files and docs also hold. Neither the S3 proof nor `--dry-run` ran that check, so S3 passed them.

This departs from prereg 62, where the author lists the key phrase. The session re-picking can read hippo's capture code, so each colliding phrase is re-picked by one fixed rule, set before any screen result:

- take the shortest span of whole words of the verbatim rule that holds the author's phrase, ties going to the earliest;
- trim quotes, backticks and sentence punctuation from its ends;
- reject a span that any stub-tree file, any other task's prompt in the sequence, or any other lesson's rule or reason holds, compared case-folded with whitespace collapsed.

| Lesson | Author's phrase | Re-picked phrase |
|---|---|---|
| bm-f1-l1 | `affiliates.ts` | ``Use `affiliates.ts`` |
| bm-f3-l1 | `npm run build` | ``Verify `npm run build`` |
| bm-f4-l1 | `Kit:` | `Kit: <brief` |
| bm-f5-l1 | `npm test` | ``with `npm test`` |
| bm-f5-l2 | `npx vitest run` | ``with `npx vitest run`` |
| ff-f2-l1 | `eval/baselines/` | ``They live only in `eval/baselines/`` |
| hp-f2-l1 | `changelog.d` | `changelog.d/<branch-with-dashes>.md` |
| hp-f3-l1 | `npm run build:all` | ``without `npm run build:all`` |
| hp-f4-l1 | `npm test` | ``with `npm test`` |
| hp-f4-l2 | `npx vitest run` | ``npx vitest run`; `npm`` |
| ml-f2-l1 | `metrolist_strings.xml` | `Metrolist/app/src/main/res/values/metrolist_strings.xml` |
| ml-f3-l1 | `:app:assembleFossDebug` | `bash ./gradlew :app:assembleFossDebug` |
| cj-f4-l1 | `Pkg.test()` | `Pkg; Pkg.test()` |

Some re-picked phrases differ from repository text only by a word or the markdown around a command; Metrolist's development guide and Comonicon.jl's tests give the same commands. The screen's A0 arm shows whether the agent already follows those rules unprompted.

hp-f1 ("Document public APIs with JSDoc") has no such span: the whole rule is a fixture string in hippo's `tests/importers.test.ts:342`, so G3 (prereg 164) would void every hippo sequence. It leaves before the screen. That leaves 19 families, 14 from maintainer rules, and 114 screen sessions. Capture still fires on the same 4 teach messages, now of 24 lessons; hp-f1 had none. Prompt overlap and capture columns of the other tables are unchanged.

The S3 proof (`prove.mjs`) now runs the runner's real preflight, `cacheTaskRepos`, and fails on any hit. Set N stays as merged; after the screen, the merge's target (half the lesson tasks, rounded up) is re-applied to the kept families before calibration.

Regenerate: `node C:/z0-runs/s4/repick-phrases.mjs <key>=<merged tasks.json> ...` writes `tasks-s4.json` beside each merged spec and `C:/z0-runs/s4/repick.json`; `node C:/z0-runs/s4/phrase-scan.mjs <key>=<tasks-s4.json> ...` then reports 0 collisions in all five; tables are `C:/z0-runs/s3/tables-<key>-s4-draft.md` and `-s4-781.md`.

## S4: a read-check fault in the runner

The first boring-maths screen session was void under G1 (prereg 162) as an `other-run` read. The agent had run a `grep` whose pattern held an import path, `../../lib/affiliates`. The read check (`readcheck.mjs`, `pathHits`) treats every slash-bearing shell word as a path, so it resolved that word against the work folder, landed under `runs/<run>/A0/`, and classed it as another run's files. Nothing exists there, so nothing was read. Prereg 162 voids a session that read a past transcript, a past rollout or another arm's files; a word that names nothing on disk is none of those.

The fix, at the check: a path that does not exist when the session is checked is skipped. Runs are in lockstep, so no other cell writes between a session's end and its check, and what exists then is what the session could see. The fake Claude Code used in the runner tests only emits tool calls and never runs them, so the tests now create the files their probes read, and a new case covers an import path in a `grep` pattern.

A second fault of the same kind voided one Comonicon.jl session (cj-f4, A0 seed 1) as an `ancestor-search`. The agent ran `grep -rn "lower()\|replace(\"_\"\|replace('_'" --include=*.py .` inside its own work folder. The old shell lexer split commands on `|` even inside quotes and did not know `\"`, so the pattern left a bare `\` word. Windows resolves `\` to the drive root, `C:/`, which exists, and the grep was recursive. The existence check above cannot catch this, since `C:/` exists.

The fix, also at the check: the lexer now reads each line with the agent shell's quotes, its escape character (backslash in Bash, backtick in PowerShell) and line continuations. A grep-family command's first operand is its pattern, and it no longer counts as a path unless `-e` or `-f` supplied the pattern. New tests cover the Comonicon.jl command, an escaped quote, a bare `/` pattern, a `-e` pattern whose operand still voids, and a line continuation.

Both are runner faults, fixed and listed under prereg 240. The boring-maths screen restarted from the fixed runner in a new out folder (`C:/z0-runs/s4/screen-bm-2`); the one void record stays in `screen-bm` and is not used. Neither earlier Comonicon.jl screen is used; see the next section.

A third fault of the same kind showed on `0635b4fc`, in the Comonicon.jl rerun: cj-f2, A0 seed 2, void as an `outside-work` read. The agent ran `cd src && sed ...` in one call and `cd .. && git commit ...` in the next. Claude Code's shell keeps its cwd between calls, and each transcript line records it, so the second call started in `work/src` and its `cd ..` went back to `work`. The check read every Claude call from `work`, so it put that `cd ..` in the seed folder.

The fix, at the record reader: `toolInputs` (`records.mjs`) now carries each line's recorded cwd, and the check resolves a call against it, as it already did with a Codex call's workdir. The fake Claude Code records a cwd on each line, and a `CWD:` probe moves it. A new case covers both directions: `cd ..` from `src` stays in the work folder, and a relative read from `src` that reaches another arm's files still voids. Over every screen transcript so far, 8 calls in 6 sessions ran from a moved cwd. Seven began with an absolute `cd` back into their own work folder, so cj-f2 is the only session the fault changed. Its family reruns on the fixed build.

## S4: screens stopped for low memory

On 2026-10-11 Claude Code stopped the boring-maths, Metrolist and hippo screens for low memory: four screens ran at once, with Metrolist's Gradle builds (about 7 GB) and a test run beside other sessions. Sessions done by then: boring-maths 24 of 30, Metrolist 19 of 24, hippo 3 of 18. A family those runs finished keeps its verdict. So does a family whose recorded sessions fix the verdict whatever its missing ones would say: hp-f2's no-memory agent followed its rule in 3 of 4 sessions, so at most 1 of 4 could break it, and it is dropped. Rerunning it whole would give it a second draw. The runner has no resume, so each family still undecided (bm-f5, hp-f3, hp-f4, ml-f4) reruns whole on the calibration build (S6), into a new out folder, from a tasks file that `C:/z0-runs/s4/rerun-tasks.mjs` cuts from `tasks-s4.json`. Their partial records stay in the first folders and decide nothing. `split-sets.mjs` applies the settled rule and takes a rerun file only for families its earlier files left undecided. Screens now run two repositories at a time.

## S4: each repository's tools on the agent's PATH

Prereg 72 gives each run "its own tool installs on `PATH`". The task tests call each toolchain by full path (`C:/eval-envs/julia-1.13.1/bin/julia.exe`, `C:/eval-envs/fifty/Scripts/python.exe`), so the S3 proofs passed, but the agent's shell had no `julia` at all, and its `python` was the system Python 3.12, not fifty's environment. In both Comonicon.jl screens (`screen-cj` on `0142c3be`, `screen-cj-f4` on `0635b4fc`) agents ran `which julia` and looked for it. Two sessions searched from `C:/` or the home folder and were voided as `ancestor-search`, which G1 got right, and one downloaded Julia from the internet into `/tmp`. Those sessions measured a missing toolchain, not the lesson, so neither run decides a family.

A session's PATH is the launching shell's PATH with hippo launchers removed (`armEnv` in `arms.mjs`), so the fix is in the launch, beside the `--pass-env` values, and the runner at `0635b4fc` is unchanged. Each repository's launch now puts its toolchain first on PATH:

- Comonicon.jl: `C:\eval-envs\julia-1.13.1\bin` (Git Bash then resolves `julia` to it, checked before launch)
- fifty: `C:\eval-envs\fifty\Scripts`
- boring-maths, hippo, Metrolist: nothing; `node`, `npm`, `npx` and `java` (with `JAVA_HOME`) already resolve.

The whole Comonicon.jl screen reruns this way into `C:/z0-runs/s4/screen-cj-2`, and only that run decides its families. S7 and S8 launch the same way.

## S4: how kept families split into sets R and X

Neither the prereg nor the plan says which family goes to which set. This rule was set on 2026-10-11, before any screen verdict was read:

- Set X takes 4 families, the minimum, since Codex usage is shared with the whole account (smoke report, set X limit). Set R takes every other kept family.
- The 4 come from 4 different repositories, so H2 is not one repository's result.
- Among the splits that meet both, take the one with the highest lower maintainer share of the two sets; ties go to lower family numbers, in the repository order boring-maths, fifty, hippo, Metrolist, Comonicon.jl.
- If no split leaves both sets at two thirds maintainer rules or more, the S4 check fails.

`C:/z0-runs/s4/split-sets.mjs` applies it.

## S4: the split rule could not run

The rule above cannot be run, whatever the verdicts. A set X sequence holds no set N task (README, set X), so its only spacers are other families' tasks. The runner puts at least two tasks between a teach and its lesson's first apply (prereg 118), so a set X sequence needs 3 families from one repository. One family per repository never orders. A set R sequence carries ceil(L/2) set N tasks, and a lone reversal family needs 4 spacers but gets 3, so it never orders either. Checked with the runner's own `drawOrder` on seeds 1 and 2 (`node C:/z0-runs/s7/orderable.mjs <runner> <tasks-s4.json> <R|X> <family ids>`): bm-f3, bm-f4 and bm-f5 order as set X, and so do the three ml families. ff-f3 alone does not order as set R, and neither does hp-f4 alone.

Putting set N tasks into set X sequences as spacers would keep the four-repository rule, but it is rejected. The prereg runs set N in the Claude Code sequences (prereg 78, "sets R and N, the same sequences"), set X applies run in Codex, and the runner would need a change after the calibration build is fixed.

The plan's S4 numbers (8 set R, 4 set X) carry no derivation, and the prereg sets no family minimum for calibration. The set R floor of 8 stays as the plan set it, since lowering it after the verdicts would fit it to them. This amendment, set on 2026-10-11 after 18 of 19 screen verdicts were read, while hp-f4 was still screening and before any calibration run, makes the smallest change the runner can run:

- Set X takes 3 or more kept families of one repository, and its sequence must order on seeds 1 and 2. 3 is the smallest set X sequence that orders.
- Set R takes every other kept family. A repository whose set R sequence does not order on seeds 1 and 2 runs no set R sequence in calibration, and its families count in neither set.
- The S4 check needs at least 8 set R families and 3 set X families, with maintainer rules at two thirds or more of each set.
- Among the splits that pass, take the one with the highest lower maintainer share of the two sets. Ties go to the smaller set X, since Codex usage is shared, then to the repository order above, then to lower family numbers.

With hp-f4 undecided, set R holds 7 kept families, one short. Two families can close the gap: hp-f4, and bm-f6, a new family from the last unused maintainer rule in the five repositories (boring-maths `AGENTS.md` line 78), whose blind author started on 2026-10-11. The split uses the families decided when the check first passes. If hp-f4 is kept, the check passes and bm-f6 is not used in calibration. If neither is kept, the check fails, and no calibration chunk that depends on the split starts until a new repository adds families through S2 and S3. Comonicon.jl's set R sequence (cj-f1, cj-f2, cj-f3) is the same in every passing split, so it may start before the check settles.

What this costs: set X is one repository's result in calibration, which sizes H2 from one repository's variance. The scored run needs the same 3-family floor per set X sequence, and S9's sizing has to plan for it.

## S4: bm-f6, the top-up family

bm-f6's author worked in a copy of the boring-maths author's folder (`C:/eval-authors/s3-bm6`), told to add one family from `AGENTS.md` line 78, change no earlier output, and keep off the 11 files the set N tasks change. It ran 20 minutes: 32 requests, no leak hits, not discarded. The rule is "Include model attribution trailer: `AI-Model: claude-sonnet-4-6`", key phrase `AI-Model`, four tasks (teach, two applies, screen), and a checker that reads the trailer from the commit messages the agent wrote. The nine earlier checkers are byte-identical to the run's.

The S3 proof on LF checkouts passes all four tasks (`C:/z0-runs/s3/proof-bm6-lf.log`: base fails its hidden test, fix, good and bad pass it, the checker passes good and fails bad). That log also prints "PROOF FAILED" for its stub-tree check, which stops at bm-f1's pre-S4 key phrase in the author's copy of `tasks.json`; the run spec carries the re-picked phrase, and bm-f1 is dropped.

bm-f6 joins the run without a new set N merge: its 16 task branches are fetched into `C:/z0-runs/eval-repos/bm` (same `main` commit), its two checker files are added beside the others, and `C:/z0-runs/s4/add-family.mjs` writes `bm-run/tasks-s4-f6.json`, the S4 spec plus bm-f6 with its tasks after bm-f5's and before set N. Its screen runs on `f945de49` with `pins-s6c.json`, like the other reruns, into `C:/z0-runs/s4/screen-bm-f6`. The runner's stub-tree check passed `AI-Model` at launch, so the phrase needed no re-pick.

## S4: the last two verdicts and the split

bm-f6 is dropped. Its A0 broke the rule in 4 of 4 sessions, but A4, told the rule, followed it in 0 of 2 (`C:/z0-runs/s4/screen-bm-f6`). It is not used in calibration.

hp-f4 is kept. Its rerun (`C:/z0-runs/s4/screen-hp-r`) recorded all 6 sessions. The A0 teach on seed 1 was void as an `operator` read: the agent ran `ls -d` on `C:/Users/skf_s/.hippo`, the operator's hippo folder. `ls -d` prints only the folder's name, so nothing from the folder reached the agent, and that session broke the rule anyway. The other 3 A0 sessions broke the rule, and A4 followed it in 2 of 2. The keep rule needs 2 of 4 breaks, so the voided session cannot change the verdict.

`split-sets.mjs` settled only families with sessions not recorded. It now also counts a void or invalid session as missing, since its result is thrown out either way. This change was made on 2026-10-11 after reading hp-f4's records, so it is stated here. It rests on the precedent in "screens stopped for low memory": a family whose recorded sessions fix the verdict keeps it, because a whole rerun would give it a second draw. Under the old rule hp-f4 would rerun whole, and set R would wait on that rerun.

The same rule now settles cj-f2 from its first file, `screen-cj-2`: 3 valid A0 breaks and 2 of 2 A4 follows, its one void being the cwd fault above. Its rerun on the fixed build (`screen-cj-f2`) agrees, with 4 of 4 breaks and 2 of 2 follows.

The S4 check passes (`C:/z0-runs/s4/split-final.txt`). Set X is ml-f1, ml-f2 and ml-f3 (maintainer 100%). Set R is bm-f3, bm-f4, bm-f5, hp-f3, hp-f4, cj-f1, cj-f2 and cj-f3 (8 families, maintainer 75%). ff-f3 is in neither set, since fifty's set R sequence does not order with one family. With bm-f6 dropped, the order in which the two verdicts landed does not matter. Regenerate with:

```
T=C:/z0-runs/s3; S=C:/z0-runs/s4; node $S/split-sets.mjs C:/Users/skf_s/hippo-wt-z0cal bm=$T/bm-run/tasks-s4.json,$S/screen-bm-2/screen.jsonl,$S/screen-bm-r/screen.jsonl ff=$T/ff-run/tasks-s4.json,$S/screen-ff/screen.jsonl hp=$T/hp-all/tasks-s4.json,$S/screen-hp/screen.jsonl,$S/screen-hp-r/screen.jsonl ml=$T/ml-run/tasks-s4.json,$S/screen-ml/screen.jsonl,$S/screen-ml-r/screen.jsonl cj=$T/cj-run/tasks-s4.json,$S/screen-cj-2/screen.jsonl,$S/screen-cj-f2/screen.jsonl
```

## S6: calibration build

#781 merged as `cf53aebb`. D5 does not ship (0 of 54 held-out corrections flagged), so A2 runs on #781 alone. Master was merged into the runner branch once, as `9dc3981e`, with no conflicts; the read-check fixes above sit on top as `0635b4fc`, then `f945de49` (the cwd fix), then `548cbd95`. That last one gives the Codex adapter the same per-call `cwd` field as the Claude one; without it `typecheck:tests` failed in CI, since a test hands the Codex adapter to code typed from the Claude one. `548cbd95` is the calibration build: S7 and S8 run from a detached worktree at it, so every record carries it, and the branch takes no rebase or merge until S9 tags it. Its pins are `C:/z0-runs/s6/pins-s6d.json`: Claude Code 2.1.288, `claude-opus-5-5`, dist hash `59e0c77e`. Both fixes changed only `scripts/token-eval`, so the dist hash is the one `0635b4fc` had (`pins-s6b.json`). The screens finished before the fix ran on `0635b4fc`, and the reruns ran on `f945de49`. For a Claude session `f945de49` and `548cbd95` give the same read check: the check reads the transcript line's cwd on both.

On that build the capture tables match #781's in all five repositories (`tables-<key>-s6.md` against `-s4-781.md`, 0 changed lines).

The smoke's A2 set R sequence re-run on `0635b4fc` (`C:/z0-runs/s6/smoke-a2-run3`, seed 1): all five cells valid, none void, and every record carries `0635b4fc`. The teach failed its check, then passed once taught. On a1 and a2 the prompt hook's context held the taught rule (put each change note in its own new file under `changelog.d/`, never edit `CHANGELOG.md` by hand), with 2 and 3 injections in hippo's record, and both apply cells passed their lesson check on the first try.

The first re-run (`smoke-a2-run2`) is not used. Its teach and apply cells were invalid as `checker`: the stage 1 toy checkers in `C:/z0-runs/toy1` and `toy2` still read the `Z0_*` env names that `de41d9a9` renamed to `CHECK_*`, so their `git` calls failed. They now read `CHECK_*`; the S3 checkers already did.

The smoke then ran on the calibration build (`C:/z0-runs/s6/smoke-a2-run4`, `pins-s6d.json`, seed 1). All five cells are valid and resolved, none void, and every record carries `548cbd95` and dist hash `59e0c77e`. Both applies passed their lesson check on the first try. The run does not prove delivery, though. Claude Code's transcripts show that 6 of hippo's 8 start and prompt hooks hit hippo's own 5 s limit (`src/hooks/json-hooks.ts:343`) at 5.8 to 9.4 s. Those include the prompt hook on a1 and a2, so neither apply got hippo's text from the hook. Their `injectedRows` is 0, while hippo's own count says 3, because hippo logs the injection before Claude Code drops the output. The rule reached both applies only through the agent's own `hippo context --auto` call, which the CLAUDE.md block asks for. The same hooks took 0.3 to 1.3 s in run3 that morning. In the afternoon a bare `cmd /c exit` took 0.1 to 1.3 s against a healthy 40 ms, with two screens and four other sessions on the box. The cause is the box, not the build.

So from here on, G1 delivery for hippo's hooks is checked on what the model received. `C:/z0-runs/s7/hook-check.mjs` reads each session's transcript and lists every hippo start and prompt hook per arm. It exits 1 when a prompt hook timed out (run4: 6 failed, run3: 0). Calibration starts one chunk at a time after a bare-launch check (`C:/z0-runs/s7/box-check.sh`, median of 7 at or under 150 ms). A second chunk joins only while the slowest hippo hook stays under 2.5 s. A stopped chunk cannot resume, because lockstep carries each arm's store from task to task. So one timeout does not stop a chunk. The stop comes once more than 5% of an arm's sessions have had a prompt hook time out, the G4 plumbing bar. The chunk then reruns from the start on a quiet box. hippo's 5 s limit stays as it is: users install it, and raising it would change the build under test. The calibration report gives every arm's hook counts.

## S7: a leak voids Comonicon.jl's seed 1

The Comonicon.jl chunk (`C:/z0-runs/s7/cal-cj`) recorded seed 1's first task, cj-f3-teach, in all five arms. The G3 check then found cj-f2-l1's key phrase, "Conventional commits", in A2's memory: Claude Code's auto memory, hippo's global store and the work store. A2 had filed cj-f3's rule (mark a breaking change with `feat!:` or `fix!:` or a `BREAKING CHANGE:` footer) as "Conventional Commits style". So the runner voided seed 1 in every arm, and the other 65 of its 70 sessions were skipped as `invalid: leak`.

The check did what G3 says. The fault is in S3. cj-f2 and cj-f3 are lines 72 and 73 of one list in Comonicon.jl's AGENTS.md, two parts of one convention. f3's rule is part of a standard the agent knows, so its memory names the standard, and that name is f2's key phrase. The S4 screen could not catch this: it runs only A0 and A4, which keep no memory, and the phrase re-pick reads repository files, prompts and the other lessons' text, never what an agent writes.

Seed 2 teaches cj-f2 at position 2, before cj-f3 at position 3, so this direction cannot happen there. The other direction can: a memory written at cj-f2-teach that names `BREAKING CHANGE`. If G3 voids seed 2 as well, Comonicon.jl gives no calibration records and S9 sizes from hippo and boring-maths alone, and says so.

No other pair is nested. bm-f3 and bm-f4 come from two sections of boring-maths' AGENTS.md (the new calculator checklist at line 64, Git at line 77). hp-f3 is in hippo's "Never Do" list (line 31). hp-f4 and bm-f5 are templates. ml-f1, ml-f2 and ml-f3 are three different rules: commit names, the strings file and the build command.

The scored task set is authored after the freeze (prereg, "Scored task set"), so the fix goes there. Its author brief gets one more rule: two families from one repository may not come from one convention, and no key phrase may be the name of a convention that another family's rule belongs to. The S3 check reads each same-repository pair against that rule before the screen.

The A5 seed 1 teach also lost its prompt hook, at 7.3 s. The hippo chunk had joined at a slowest hook of 0.8 s, and its first session ran beside that teach while other sessions' test runs held the bare-launch check at 640 to 700 ms. The session is in the voided seed, so it does not count toward any arm's bar.

## S7: the hippo chunk stopped, to rerun alone

Keith stopped the hippo chunk (`C:/z0-runs/s7/cal-hp`) on 2026-10-11 so the first sizing comes sooner. It had recorded 1 of its 120 sessions in 45 minutes. That session, hp-f4-teach in A1 seed 1, took 38 minutes and $0.98, because the hp-f4 task leads the agent to run hippo's whole test suite. At that pace the chunk needed about a day, and its test runs were slowing cj's hippo hooks. A stopped chunk cannot resume, so hippo reruns whole and alone into a new out dir. boring-maths took its place beside cj (`C:/z0-runs/s7/cal-bm`). S9 sizes first from cj and bm, then adds hippo.

The one hippo record is voided as `read`. While debugging a test about home folders, the agent ran `ls -d ~/.hippo`. The arms keep the operator's `USERPROFILE`, so in Git Bash `~` is the operator's home, and the read check classed the path as `operator`. The S4 hippo screen shows the same void on 1 of its 6 hp-f4 sessions (A0), so the rerun will lose some hp-f4 sessions to it. The check is doing its job: a void session is not data. Whether arms should get their own home folder is a question for the scored-run build, not calibration, since the calibration build is pinned.

## S7: both chunks stopped for low memory

On 2026-10-11 at about 18:36 Claude Code stopped the cj and bm chunks, and their hook watchers, for low memory. Another session had started several Python training runs of about 3 GB each, and the box's commit charge reached 119.5 of 133.6 GB. By then cj had 98 records (seed 1 whole, seed 2 at 28 of 70) and bm had 23 of 170. No hippo hook had failed in either. The runner has no resume, so both chunks rerun whole into new out dirs (`cal-cj2`, `cal-bm2`) once the box has the memory. The partial records stay in `cal-cj` and `cal-bm` and decide nothing. The cj seed 1 leak can recur in the rerun, since its task order is the same.

## S7: the plan's weekly limit voided both reruns

`cal-cj2` and `cal-bm2` started on 2026-10-11 at about 19:56 UTC. At about 23:10 UTC the Claude plan reached its weekly limit, which resets on 17 October at 05:00 London time. From then on every session ended at once with `is_error` true, `subtype` "success", zero tokens and the text "You've hit your weekly limit · resets Oct 17, 5am (Europe/London)". The runner's limit test (`LIMIT_RE` in `records.mjs`) matched "hit your limit" and "hit your usage limit" only. So it graded each empty session as a failed task and went on, instead of waiting. Both chunks ran to the end: cj2 has 48 real sessions of 140 ($16.90) and 92 empty ones, bm2 has 56 of 170 ($17.62) and 114 empty ones. Both chunks are void, as a chunk that stops partway is (prereg), and nothing in them decides anything. G3 voided no seed in cj2's 48 real sessions.

The fix is `cb656ba4`. The Claude and Codex limit tests now match "hit your <any words> limit", so the weekly, session and model-named forms all count as a limit. The limit loop now polls every 15 minutes for up to 8 days (`limitMaxWaits` 96 to 768), so a run waits out a weekly reset and is not abandoned after a day. The fix changes only `scripts/token-eval`, so `cb656ba4` becomes the calibration build with the same hippo dist. It runs from a detached worktree at `C:/Users/skf_s/hippo-wt-z0cal3`, and `launch-run.ps1` points there. The S9 freeze tag moves to it.

hook-check found one failed hippo hook per chunk, both in A2 seed 1: in cj a prompt hook cancelled at 9.7 s (1 of A2's 65 hippo hooks), in bm a start hook cancelled at 11.4 s (1 of 82). A5 lost none. Other sessions' Python jobs held the box at the time. As the chunks are void, these count toward no arm's bar.

Both chunks rerun whole on `cb656ba4` into `cal-cj3` and `cal-bm3`, then hippo alone, then Metrolist set X.

## S7: calibration moves to the Console credit

`cal-cj3` and `cal-bm3` started on 2026-10-14 at about 21:04 UTC, met the weekly limit on their first session and waited. Keith approved running calibration on the Console's free credit instead (2026-10-14). Both were stopped before any session ran, with one pre-session ledger row each, and rerun whole into `cal-cj4` and `cal-bm4` at about 21:30 UTC.

The runner is unchanged. `launch-run.ps1 -ApiRoute` passes `ANTHROPIC_BASE_URL` with `--pass-env`, so each session's G1 request-log proxy forwards to a second local proxy, `C:/z0-runs/api-route/swap-proxy.mjs` (sha256 `134c4fff2a75f409c9c27c1e8834467061ad6d24ad497e698ad1c5aa479bc91e`). On `/v1/` paths it swaps the plan login for the Console key and drops the OAuth beta flag; other paths keep the plan login. The key lives only in that proxy's process, so no arm's environment holds it and prereg 76 stands. The records list `ANTHROPIC_BASE_URL` in `passEnv` and `envKeys`. Model, Claude Code version and hippo build are the pins' own; only the billing route differs from the earlier chunks.

The proxy tallies each reply's usage at Opus 5.5 list prices. On a test call its figure matched Claude Code's `total_cost_usd` ($0.378). At $150, or when the credit balance runs out, it answers 429 `rate_limit_error`, so the runner waits instead of grading empty sessions. Writing `plan` to its mode file sends traffic back through the plan login. The account's limits read 10,000 requests, 10M input tokens and 2M output tokens a minute.

## S7: the Console-route chunks

`cal-cj4` recorded all 140 sessions by about 04:55 UTC on 2026-10-15, at $41.93 by its records. No sequence was voided for a leak and no session is invalid, so the seed 1 leak in `cal-cj` did not recur. hook-check found one failed hippo hook in each memory arm, both in seed 1: an A2 prompt hook cancelled at 11.1 s (1 of A2's 69 hippo hooks) and an A5 start hook cancelled at 5.7 s (1 of 34). Both sessions are listed as G1 delivery voids.

Its G5 regrade started next. Claude Code's low-memory reaper stopped it at about 05:51 UTC, and it resumed at about 06:00 UTC from its own ledger (`g5/regrade.jsonl`), so no regraded record was lost.

The Metrolist set X chunk did not start the first time (`cal-ml`, about 05:50 UTC). The runner refused it because the pins file had no Codex version or model, and set X runs Codex. `pins-cb656ba4-x.json` adds `codexVersion` "codex-cli 0.153.4" and `codexModel` "gpt-5.6-sol" to the calibration pins and changes nothing else. `cal-ml2` started on it at about 06:02 UTC.

The Console credit has $150 of room for Z0. A detached guard (`C:/z0-runs/api-route/flip-to-plan.ps1`) reads the proxy's tally each minute and writes `plan` to its mode file at $145. From then on, new requests go through the plan login at no cost. Until its weekly reset (17 October, 05:00 London time) the runner waits there, as `cb656ba4` makes it, and then runs on. The model and pins are the same on both routes.

`cal-bm4` recorded all 170 sessions (last start 07:58 UTC on 2026-10-15), at $54.12 by its records. No sequence was voided and no session is invalid. hook-check found A2's 82 hippo hooks all delivered. A5 lost 2 of 47, both in one seed 2 session: a start hook cancelled at 10.9 s and a prompt hook at 14.9 s. That session is listed as a G1 delivery void.

The first bm4 regrade refused to start: every record lists `CLAUDE_CODE_OAUTH_TOKEN` among its env keys, because the runner strips it only from setup and test envs, and the regrade stops on a key the run had. The regrade compares names, never values (G5 reading 16), so `C:/z0-runs/s9/g5-run.ps1` sets a placeholder. The real token stays disabled.

## S9: G5 on Comonicon.jl, round 1

The blind reader's round 1 (seed 41, 30 pairs) disagreed with the checkers on 7 pairs, 23%. That is over 10%, so G5 failed and a checker fix became allowed (reading 19). Both causes were checker defects:

- `cj-f1-l1` judged `src/` only, but the repository's `format-pr.yml` formats the whole tree. Five disagreements were 108-character lines in test files, all in teach cells. The checker now reads every `.jl` file. On the saved diffs this changes teach verdicts only: every apply with a long test line already failed on `src/`.
- `lib.mjs` counted the message of a commit that `git commit --amend` replaced, so a corrected message could never pass. Two disagreements. An amend now replaces the message before it, and `--amend --no-edit` keeps it.

The S3 proof of the fixed checkers (`C:/z0-runs/s3/proof-cj-g5fix.log`) passed 8 of 9 tasks. On `cj-f1-a1` the widened checker fails the validation's good commit `b1c322d4`, which leaves a 161-character line in `test/frontend/cast.jl`; it was written when the checker read `src/` only. A corrected good commit, `134a0984` on ref `task/cj-f1-a1/good-g5`, splits that line as the `src/` line already is. Run directly, the checker passes it and fails the bad commit `d433c50f`. On 2026-10-15, on Keith's go, `validation.json` was pointed at it, and the same ref was fetched into the runner's repository `C:/z0-runs/eval-repos/cj`. The one-task proof, then the post-fix regrade and round 2, come next. The proof's stub preflight also flags `cj-f4-l1`'s key phrase in a stub tree; `cj-f4` is not in calibration.

## S9: preliminary sizing

z0-size on `cal-cj4` and `cal-bm4`, before G5, at 200 simulations: no grid row reaches 80% power at a minimum effect of 15, 20 or 25 points, up to 40 repositories and 600 families. Under prereg 215 the run does not start, and the needed sizes are reported (`C:/z0-runs/s9/prelim/report.html`).

- H3 (hippo at most 0.95 of built-in memory's cost) reaches at most 25% power in every run, even with the repository variance at its point estimate. Hippo cost more than built-in memory on cj and less on bm, and that spread between repositories (an SD of about 0.15 on the log ratio) is about three times the 5% saving.
- D6 takes the repository variance at a one-sided 80% bound and assumed five calibration repositories. With two, the bound puts H1's at 0.708 against an estimate of 0.028. At the point estimates, H1 fits at 25 points with 6 repositories of 6 families, and at 20 points with 10 of 6; H4 fits with 10 repositories of 26 no-lesson tasks.
- The two-level bootstrap of prereg 189 calls too many wins with few repositories. At the D6 bound, 1000 simulations at 60 families: 5.0% (H1) and 16.6% (H3) of true-zero runs were wins at 5 repositories, 2.2% and 9.9% at 10, against Holm's 1.7%. At the point variance, 2000 simulations: 2.9% and 5.6% at 5 repositories of 6 families, 1.7% and 3.0% at 10, 1.2% and 1.9% at 20.
- A t test over repositories with G-1 degrees of freedom (H1 on repository means, H3 on the pooled ratio with a cluster-robust error) kept every point-variance cell at or under 1.7%, at a cost in power that is gone by 20 repositories: H1 at 20 points, 6 families, 21% against the bootstrap's 59% at 5 repositories, 68% against 82% at 10, 98% against 99% at 20. At the bound, H3 still made 5% to 7% false wins under both tests. Script and logs: `C:/z0-runs/s9/prelim/smallsample.mjs`, `ss-point.log`, `ss-bound.log`.
- First-try repeats on applies, cj and bm together: A0 23 of 26, A1 3 of 26, A2 1 of 26, A4 2 of 26, A5 4 of 26.

## S9: Amendment 2, fixed repositories

S9 sizing with the repository as the unit found no feasible design (`C:/z0-runs/s9/sizes.json`, `sizes-point.json`). Two set R repositories give the repository variance one degree of freedom, and its 80% bound, 0.708, is 25 times the estimate, 0.028. At that estimate H1 needs 20 scored repositories at 25 points and H4 more than 30, and H2 cannot be sized with one set X repository. Amendment 2 narrows the claim to the scored repositories and makes the family the unit (plan `hippo-archive/z0-amend2-plan.html`, sent to Keith on 2026-10-15).

An outside review (Opus, plan plus prereg and code) found two blockers, both now fixed:

- Power rested on a noise variance measured on 4 degrees of freedom (2 for H2). At its 80% bound a fixed three seeds gives H1 52% power at 5 repositories of 8 families. The fix is the blind seed rule (Amendment 2, item 5).
- The symmetric delta interval for the cost ratio passed 5.2% to 5.6% of runs at a true 1.10 under the harsher spreads. The log form passes 3.2% to 4.7%. The committed skew check (`z0-skew-check.mjs` at `f21ff8d3`, 20,000 runs a cell) gives the log form 3.44% to 4.59% in the skewed cells, against 5.37% to 6.00% for the symmetric form in four of them; the table is in the analyzer doc.

Probes, all in the session scratchpad and run against `feat/z0-repo-t`:

- `TEST=pooled node crossed-probe.mjs 400 cj4 bm4 ml2` gives the calibration components. H1 (12 units, 2 repositories, 3 families, 2 seeds): noise 0.141 on 4 degrees of freedom, family 0 (bound 0.033), sequence 0 (bound 0.039). H2 (6 units, ml only): noise 0.292 on 2 degrees of freedom.
- `level-check.mjs` (20,000 runs per cell, 8 families, 3 seeds) gives the share of true-zero runs with p under 0.025: 0.014 to 0.027 with 2 or more repositories, and up to 0.040 with one. At two seeds and the bounds it was 0.027.
- `node pilot-probe.mjs 4000 5 8` tests the seed rule at 5 repositories of 8 families. At the calibration's family and sequence estimates and noise up to its bound, win power is 0.90 to 0.94 and tie 0.88 to 0.95, with a mean of 3.1 to 5.9 seeds. With family and sequence at their bounds, win is 0.69 to 0.77 and tie 0.58 to 0.69. False win or loss is 0.015 to 0.028.
- `node pilot-probe.mjs 1500 20 3`: at the bounds, 20 repositories of 3 families reach win 0.85 to 0.88 and tie 0.82 to 0.86. More repositories beat more seeds, because seeds do not shrink the family term.
- `node h4-pooled-probe.mjs 400 cj4 bm4`: set N had 22 pairs and none resolved on one side only, so the resolve half had no spread. With 5% discordance per side, the H4 gate passes 0.92 at 5 repositories of 40 tasks and 0.95 at 8 of 26. The cost half at a true 1.10 passed 1.0% to 3.7%.

Families per repository are bounded by the distinct conventions a repository has: the development repositories gave 3 (cj), 3 to 4 (bm) and 2 (hp). The sizer therefore searches repository counts at up to 4 families each.

## S9: sizing under Amendment 2

`bash C:/z0-runs/s9/size-a2.sh 229.2 cj4 bm4 ml2` on `d06ae697` (`C:/z0-runs/s9/sizes-a2-d06ae697.json`; 2,000 runs a row, 20,000 a level cell). At the preregistered 15 points the sizer picks 12 repositories: set R 24 families, set N 48 tasks, set X 48 families, 5,751 sessions, $1,135 of Claude and $449 of Codex at list price ($1,925 and $723 if every rule arm reaches 9 seeds). H1 has 0.81 power at the point spreads and 0.22 at their 80% bounds, where the rule stops 75% of runs; H2 has 0.92 and 0.00; H4 passes 0.85 with 36 tasks. No row passes at the bounds. At 20 points: 10 repositories, 3,752 sessions, $750. At 25 points: 5 repositories, 2,672 sessions, $545.

The level holds for H1 at every effect (at most 2.3%). It fails for H2 at 15 and 25 points. Set X calibration has one repository, so H2's bounds are wide and the rule stops almost every run there: all 20,000 at 15 points, all but 14 at 20, all but 106 at 25, where 5.7% of the runs it let go were false wins against a 5.5% bar. A cell the rule empties fails by design (the test at `tests/token-eval-z0-size.test.ts` asserts it), because the rule's level there is unmeasured. The freeze at 15 points therefore waits for a second set X repository in calibration. The run itself waits for funding: $1,135 is past the $200 a month of free Console credit.

`d06ae697` fixed the level check on the way: it judged every cell against 0.025 plus 2 simulation errors of all 20,000 runs, even when the rule left a few hundred, which fails a sound test about half the time. Each cell now uses its own run count. No verdict above changed.

## Contract limits found

- A checker's `CHECK_POST_COMMIT` is a state commit whose parent is the pre-session commit, so the agent's own commits are not visible to it. Commit-message rules are checked from the `git commit` commands in `CHECK_COMMANDS`.
- Task `test` and `setup` commands run through cmd.exe on Windows, so they cannot set variables inline, and `./gradlew.bat` does not run there. Each repository's variables come from the run environment through `--pass-env`, which hands the named keys to the agent, the setup, the tests and the checkers, and records them. Calibration runs one repository per chunk (D7), so each chunk sets its own:
  - fifty: `PYTHONNOUSERSITE`, `PIP_NO_INDEX`, `PYTHONDONTWRITEBYTECODE`
  - Metrolist: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, `GRADLE_USER_HOME`, `JAVA_TOOL_OPTIONS`
  - Comonicon.jl: `JULIA_DEPOT_PATH`, `JULIA_PKG_OFFLINE`
- A session's PATH is the launching shell's PATH with hippo launchers removed, and PATH cannot go through `--pass-env` because the runner sets it. Each chunk's launch puts its toolchain first on PATH: Comonicon.jl `C:\eval-envs\julia-1.13.1\bin`, fifty `C:\eval-envs\fifty\Scripts`.
