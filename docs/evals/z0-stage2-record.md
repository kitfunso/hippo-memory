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

## Contract limits found

- A checker's `CHECK_POST_COMMIT` is a state commit whose parent is the pre-session commit, so the agent's own commits are not visible to it. Commit-message rules are checked from the `git commit` commands in `CHECK_COMMANDS`.
- Task `test` and `setup` commands run through cmd.exe on Windows, so they cannot set variables inline, and `./gradlew.bat` does not run there. Each repository's variables come from the run environment through `--pass-env`, which hands the named keys to the agent, the setup, the tests and the checkers, and records them. Calibration runs one repository per chunk (D7), so each chunk sets its own:
  - fifty: `PYTHONNOUSERSITE`, `PIP_NO_INDEX`, `PYTHONDONTWRITEBYTECODE`
  - Metrolist: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, `GRADLE_USER_HOME`, `JAVA_TOOL_OPTIONS`
  - Comonicon.jl: `JULIA_DEPOT_PATH`, `JULIA_PKG_OFFLINE`
