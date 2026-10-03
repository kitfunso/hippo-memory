# Z0 SessionEnd capture extractor, attempt 2: pre-registration

**Date:** 2026-09-27. **Status:** PRE-REG-LOCKED at the commit that adds this file. The extractor is frozen at tag `z0-extractor-v2-freeze` (commit `764f73f`, branch `fix/capture-extractor-2`). The held-out set does not exist yet: it is sessions that start on or after 2026-09-28. Nothing is scored in this PR.

Attempt 1: `docs/evals/2026-09-27-z0-session-capture-prereg.md` and `-result.md`. It ended with no verdict: the two labellers agreed on 70 of 100 items (floor 80%), and the new tail extractor scored 0.48 useful against a 0.60 bar. Its held-out split was read for error analysis and is spent.

## What changed since attempt 1

All four changes were made on the attempt-1 tune split only (62 sessions).

1. **Subjectless definite leads.** A sentence that opens with "The fix", "The cause", "The issue", "The problem", "The bug", "The workaround", "The reason", "The solution", "The culprit", "The answer" or their plurals (optionally "real", "actual", "main" or "underlying" before the noun) or "Root cause" is dropped unless it also names a code token: backticked text, a file name with an extension, a CLI flag, an issue or PR number, a camelCase identifier (two or more lowercase letters first, so "iPhone" is not one), a snake_case identifier, or a path with two separators (so "read/write" is not one). Attempt 1: 5 of A1's 12 misses.
2. **Agent status lines with no "I".** An assistant sentence that opens with a past-tense verb followed by a determiner, preposition or number ("Added a test", "Fixed in #12", "Ran the suite") is dropped. An adjectival lead followed by a noun ("Cached embeddings must...") is kept. Attempt 1: 3 misses.
3. **User messages stored as content arrays.** A user message whose content is an array (for example text plus a pasted image) now contributes its text blocks, unless the array carries a tool result. The "[Request interrupted by user" marker is dropped. On the tune split this touched 28 user lines out of 24,542 array lines (the rest are tool results), and it changed the old arm's output on 0 of 62 sessions.
4. **Pointing back and glued sentences.** A sentence with a bare "this" or "these" anywhere ("wipes this silently") is dropped, as is one with no space after a full stop ("...a key.Refunds go..."), outside backticked code. Found in round 1 of the tune check below: 2 of A1's 9 misses. No tune item labelled useful had either shape.

The rest of the extractor is unchanged from `26444bf`: whole sentences, cue families, the deictic, narration, session-local, transient and label gates, reason joining, scoring, and a cap of 3 per session.

## Arms

Each is run on every held-out session from the frozen build.

- **A0 (old):** `summariseTranscript` then `extractFromText`. Built from the freeze tag, so its input parser includes change 3; on tune that changed nothing.
- **A1 (new, tail):** `extractSessionMemories(sessionCaptureWindow(collectSessionTurns(jsonl)))`. This is the shipping candidate.
- **A2 (new, whole session):** `extractSessionMemories(collectSessionTurns(jsonl))`, same cap.

A session with no human turn is skipped for all arms. Store dedup is not applied.

## Labels

- **Pool:** every held-out memory from A0, A1 and A2. Exact-text duplicates are merged, so a text is labelled once and credited to each arm that wrote it. The pool is shuffled with seed 20260928. The labeller sees only the text, never the arm or the session.
- **Primary labeller:** Opus labels the whole pool.
- **Second labeller:** Sonnet labels a seeded random 100 of the pool (the whole pool if smaller), blind to the Opus labels. The sample is drawn with seed 20260929.
- **Mechanism:** both run as `claude -p --safe-mode --tools '' --no-session-persistence --strict-mcp-config` with a fixed system prompt, from an empty working directory. A setup probe asks each model to list any instruction-file headings it was given; anything but a bare NONE stops the run (exit 5) before the marker is written. Batches of 20; a batch missing any id is asked once more; still missing makes the run VOID.
- **Rubric v2, given verbatim to both labellers:**

```text
You label short notes that a tool saved automatically from a coding agent's work session. A later agent will read each note on its own, with no other context. Label each note USEFUL or NOT_USEFUL.

Ask these four questions in order. The first "no" makes the note NOT_USEFUL. A note is USEFUL only when all four answers are "yes".

1. Subject. Does the note itself name what it is about: a specific component, file, command, tool, library, service, project, practice or person? A reader with no session context must be able to tell which thing it means. A note whose only subject is "the fix", "the cause", "the issue", "the problem", "it", "this", "the script" or "the test", with nothing saying which one, fails.
2. Content. Does it state a decision, rule, preference, lesson, gotcha, cause or lasting fact that could change what a later agent does? A general maxim that would apply to any project fails.
3. Durable. Would it still be true and worth knowing next week? Progress or status ("the build passes", "the PR is open"), a one-off instruction for that moment ("run it again"), a question, and a narration of what the agent just did ("Added the flag and pushed") fail.
4. Whole. Is it a complete statement? A fragment, a table row, a code line or a heading fails.

Be strict on question 1: a note that is true but does not say what it is about fails, however reasonable it sounds.

Worked examples (invented):
- "The fix is to raise the timeout to 30 seconds." NOT_USEFUL (1: which timeout, in what?)
- "The fix for the flaky upload test in upload.spec.ts is to raise its timeout to 30 seconds, because CI runners are slower than laptops." USEFUL
- "The root cause was a stale cache entry." NOT_USEFUL (1)
- "Always keep things simple and avoid unnecessary complexity." NOT_USEFUL (2: a maxim with no subject)
- "The billing service must never call the payments API without an idempotency key, because retries double-charge." USEFUL
- "Added a regression test and pushed the branch." NOT_USEFUL (3)
- "The staging deploy passed its smoke check." NOT_USEFUL (3)
- "I prefer pnpm over npm in this monorepo because installs are faster." USEFUL
- "must never run migrations on" NOT_USEFUL (4)

Output one line per note and nothing else: `<id> USEFUL` or `<id> NOT_USEFUL`.
```

## Tune-split check (done before the freeze)

The scorer's own tune mode ran the full pipeline above on the 62 tune sessions with the candidate extractor. The labellers and rubric are identical to the scored run.

Three rounds, all with rubric v2 unchanged. Round 3 is the freeze tag, built by the scorer's own `buildFrozen` path; its compiled `session-extract.js` and `capture.js` are byte-identical to the working build used in round 2. The last code change (plurals, tighter code tokens) wrote no different memory on tune, so rounds 2 and 3 labelled the same 88 texts.

| round | extractor | sessions with a human turn | pool | agreement (Sonnet sample) | kappa | A0 useful | A1 useful | A2 useful |
|---|---|---|---|---|---|---|---|---|
| 1 | changes 1 to 3 | 55 | 93 | 75 of 93 (80.6%) | 0.50 | 1 of 49 | 4 of 13 (0.31) | 14 of 44 (0.32) |
| 2 | changes 1 to 4 | 55 | 88 | 72 of 88 (81.8%) | 0.52 | 1 of 48 | 4 of 10 (0.40) | 13 of 39 (0.33) |
| 3 | frozen tag | 55 | 88 (same texts as 2) | 74 of 88 (84.1%) | 0.57 | 1 of 48 | 6 of 10 (0.60) | 15 of 39 (0.38) |

Attempt 1 with rubric v1 had 70% agreement on its held-out sample. Under rubric v2 on tune, agreement clears the 80% floor in all three rounds, by a thin margin (a swing of 2 items would drop round 2 below it).

**Labeller retest.** Rounds 2 and 3 relabelled the same texts: Opus gave the same label to 82 of 88 (93%) and Sonnet to 84 of 88. Two of Opus's six flips fell on A1's ten memories, which moved A1 from 0.40 to 0.60. So on tune, A1 sits at the 0.60 bar within labeller noise, and a held-out A1 set of about 20 memories carries roughly one item of noise either way (0.05). The scored run labels once, as registered; this is disclosed so a pass or fail near the bar is read as close.

The tune rate does not set the bar: the bar is unchanged from attempt 1, and no gate was added after round 2.

This agreement measures reliability: whether the two judges read the rubric the same way on the tune pool. It does not show the rubric is right; no human labels exist to check that against. The tune useful rates are in-sample, because the rules were tuned on these sessions, and are not evidence for the verdict.

## Held-out window

- **Source:** top-level `*.jsonl` session files under the Claude Code projects directory (sub-agent transcripts excluded).
- **Start:** a session is in the window when its earliest timestamp is on or after `2026-09-27T23:00:00Z` (2026-09-28 00:00 UK time). A session resumed from before that date is out.
- **Exclusions**, each counted and reported:
  - a `cwd` with an `eval-runs` path segment (eval harness runs), or inside the scorer's `--out` folder;
  - the eval's own work: a session that mentions `z0-capture`, `session-extract`, `capture-extractor`, `extractSessionMemories` or `sessionCaptureWindow` as a whole token, or whose recorded git branch contains `capture-extractor`;
  - any session that shares a human message of 30 or more characters with the frozen corpus the tune split came from (resumed sessions and repeated briefs);
  - sessions with no human-typed turn.
- **Minimum:** 110 eligible sessions. The scorer refuses to run below it (exit 3) and prints the count only.

**How 110 was set.** On tune, the frozen A1 wrote 10 memories on 55 sessions with a human turn (0.18 per session). At 110 sessions that is about 20 A1 memories, above the rule-1 floor of 15; at 100 it would be about 18, too close to the floor. The live projects directory held about 120 sessions with a human turn between 2026-09-01 and 2026-09-26, eval runs excluded: about 4.6 a day. The own-work token scan reads tool output too, so any session that opens the extractor's files is dropped; that is deliberate and makes the date below optimistic by the excluded share, which the scorer reports.

**Scoring date.** At that rate the window reaches 110 around **2026-10-22**. By default Claude Code deletes session files after 30 days, so the run must happen before 2026-10-27, when the first window sessions start to expire. The scorer refuses to start on or after that date (exit 7). If the window is still short on 2026-10-26, the result is NO VERDICT (window too small), recorded as such; the extractor does not ship.

## Scoring command

```
node scripts/z0-capture-eval.mjs --out <scratch folder outside the repo> --frozen-corpus <the frozen SI0 transcript copy>
```

It builds the extractor from `z0-extractor-v2-freeze`, refusing if the tag does not resolve to `764f73f767528a5d09f476aa8ef38ded286ee754` (`git archive`, `npm ci --ignore-scripts`, `tsc`), collects and copies the window, runs the arms, labels, scores, and writes `result.json` and `labels.json` into `--out`. Stdout carries aggregate numbers only.

**One scored run.** Right before the first label call it creates a marker at `~/.hippo-eval-locks/z0-capture-v2.json`, atomically, so two concurrent runs cannot both pass. A second run with the marker present is refused (exit 4), and so is any run whose `--out` already holds a `result.json`. Held-out memory text is written to `--out` only after the marker exists. A crashed or VOID run after the marker is not re-run; a rerun needs a committed amendment to this file that says why.

## Decision rule (locked)

**A1 ships** as the SessionEnd extractor when all hold:

1. A1 wrote at least 15 held-out memories (else: no verdict).
2. Opus and Sonnet agree on at least 80% of the sample (else: no verdict).
3. A1 useful rate is at least 0.60.
4. A1 useful rate beats A0's by at least 0.25.
5. A1's useful count is at least 0.8 times A0's.
6. No session gets more than 3 A1 memories.

**Fails** when rules 1 and 2 hold and any of 3 to 6 fails. Useful means labelled useful by Opus. Every bar is checked with integer arithmetic on the counts. The Wilson 95% interval is reported beside each rate; the bars are on point estimates.

**Window.** A2 replaces the tail as the default only when A1 ships and A2 clears rules 3 to 5 against A0 by itself, sits no more than 0.05 below A1's rate, and has a useful count at least A1's. Otherwise the tail stays.

## What ships where

The extractor code is not on master. It lives at the freeze tag, and the PR that adds this file removes it again, so default capture is unchanged. If A1 ships, a follow-up PR brings the frozen code to master unchanged. If it fails or has no verdict, the result doc is the deliverable.

## Retraction conditions

- Any change to the extractor after the freeze tag: the score does not apply.
- Any change to the rubric, the labeller mechanism, the seed, the window rule, the exclusions or the bars after this file is locked: the score does not apply.
- Held-out text read before the score (beyond the counts the scorer prints): retract and move the window start.
- A window session later found to be the extractor's own development: report it; if more than 5 such sessions, the verdict is retracted.

## Amendment 1 (2026-10-03, before any scored run; no marker exists)

Found by a count of the window from session metadata only (timestamps, `entrypoint`, `cwd`, git branch, turn types); no held-out text was read and no arm was run. No arm, rubric, labeller, seed, bar or window start changed.

- **Headless sessions excluded.** The `eval-runs` path rule missed the 2026-09-28 TE5 pilot, which ran under `hippo-archive/te5-pilot/runs/...`. As locked, the window held about 105 eligible sessions and 80 of them were the pilot's scripted `claude -p` runs, so the scorer would have cleared the 110 floor within days on mostly automated data. Any session with an entry whose `entrypoint` is `sdk-cli` (a `claude -p` or SDK run) is now excluded, wherever it ran, and counted as `headless`. Of the 100 headless sessions in the window, 94 had one typed prompt and 6 had two or more. The `eval-runs` rule stays.
- **Counts after the change:** 13 interactive sessions in the window, about 5 eligible after the other exclusions (frozen-overlap not yet applied).
- **Scoring date withdrawn.** The 4.6 a day rate behind 110 was measured without this rule and is overstated by an unknown share. Unless the interactive rate rises sharply, the window stays short and the result on 2026-10-26 is NO VERDICT (window too small), as the rule above already says.

## Disclosures

- One user wrote every session in the corpus and the window.
- The worked examples in the rubric are invented. No corpus text appears in this file.
- Both labellers are Claude models run on the founder's plan. No money is spent.
