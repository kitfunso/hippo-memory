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

## S6: calibration build

#781 merged as `cf53aebb`. D5 does not ship (0 of 54 held-out corrections flagged), so A2 runs on #781 alone. Master was merged into the runner branch once, as `9dc3981e`, with no conflicts; the read-check fixes above sit on top as `0635b4fc`, then `f945de49` (the cwd fix), then `548cbd95`. That last one gives the Codex adapter the same per-call `cwd` field as the Claude one; without it `typecheck:tests` failed in CI, since a test hands the Codex adapter to code typed from the Claude one. `548cbd95` is the calibration build: S7 and S8 run from a detached worktree at it, so every record carries it, and the branch takes no rebase or merge until S9 tags it. Its pins are `C:/z0-runs/s6/pins-s6d.json`: Claude Code 2.1.288, `claude-opus-5-5`, dist hash `59e0c77e`. Both fixes changed only `scripts/token-eval`, so the dist hash is the one `0635b4fc` had (`pins-s6b.json`). The screens finished before the fix ran on `0635b4fc`, and the reruns ran on `f945de49`. For a Claude session `f945de49` and `548cbd95` give the same read check: the check reads the transcript line's cwd on both.

On that build the capture tables match #781's in all five repositories (`tables-<key>-s6.md` against `-s4-781.md`, 0 changed lines).

The smoke's A2 set R sequence re-run on `0635b4fc` (`C:/z0-runs/s6/smoke-a2-run3`, seed 1): all five cells valid, none void, and every record carries `0635b4fc`. The teach failed its check, then passed once taught. On a1 and a2 the prompt hook's context held the taught rule (put each change note in its own new file under `changelog.d/`, never edit `CHANGELOG.md` by hand), with 2 and 3 injections in hippo's record, and both apply cells passed their lesson check on the first try.

The first re-run (`smoke-a2-run2`) is not used. Its teach and apply cells were invalid as `checker`: the stage 1 toy checkers in `C:/z0-runs/toy1` and `toy2` still read the `Z0_*` env names that `de41d9a9` renamed to `CHECK_*`, so their `git` calls failed. They now read `CHECK_*`; the S3 checkers already did.

## Contract limits found

- A checker's `CHECK_POST_COMMIT` is a state commit whose parent is the pre-session commit, so the agent's own commits are not visible to it. Commit-message rules are checked from the `git commit` commands in `CHECK_COMMANDS`.
- Task `test` and `setup` commands run through cmd.exe on Windows, so they cannot set variables inline, and `./gradlew.bat` does not run there. Each repository's variables come from the run environment through `--pass-env`, which hands the named keys to the agent, the setup, the tests and the checkers, and records them. Calibration runs one repository per chunk (D7), so each chunk sets its own:
  - fifty: `PYTHONNOUSERSITE`, `PIP_NO_INDEX`, `PYTHONDONTWRITEBYTECODE`
  - Metrolist: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, `GRADLE_USER_HOME`, `JAVA_TOOL_OPTIONS`
  - Comonicon.jl: `JULIA_DEPOT_PATH`, `JULIA_PKG_OFFLINE`
- A session's PATH is the launching shell's PATH with hippo launchers removed, and PATH cannot go through `--pass-env` because the runner sets it. Each chunk's launch puts its toolchain first on PATH: Comonicon.jl `C:\eval-envs\julia-1.13.1\bin`, fifty `C:\eval-envs\fifty\Scripts`.
