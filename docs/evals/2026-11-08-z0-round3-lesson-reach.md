# Z0 round 3 lesson reach: where hippo's lessons go between teach and apply

Date: 8 Nov 2026. Build read: hippo 3.3.1 at `z0-r3-freeze` (`cb992a079`), the round 3 scored build.
Inputs: the same 35 runs files as the frozen final read (`C:/z0-runs/scored/r3-final-read.sh` lines 8 to 15),
4,862 records. Script: `node scripts/token-eval/z0-reach.mjs --scored C:/z0-runs/scored` (add `--json` for one
JSON object). This is a debugging read of round 3, not a verdict. Round 3's result stays as
`2026-11-08-z0-round3-result.md` records it.

All rates here use the runner's first check on each lesson (after the post-fix regrade where one ran), on first
applies: the first apply task of each family, valid and not leaked, 162 per rule arm and 110 for A4.

## Answer

Round 3 cannot show hippo's lessons beating sham hippo, whatever hippo does with them. Claude Code's own memory
already held the taught rule at the start of 112 of sham hippo's 162 first applies. At the other 50, sham hippo
failed 11 times. If real hippo fixed all 50 at the perfect-memory arm's rate, it would gain 7.8 failures, which is
4.8 points. The prereg's full-win line is 15 points (`2026-11-02-z0-round3-prereg.md` line 8). That line is on
H1's unit-level estimate and this bound is pooled over lessons, so the two compare only roughly.

Hippo's prompt block is mostly not lessons. Over A2's 162 first applies it held 470 entries: 56% summaries of past
tasks, 17% copies of Claude Code's own memory notes, 14% captured rule fragments and 11% tool errors.
Only 5 (1%) were a user's rule as the user said it. Header counts put it at about 390 tokens a session.

## 1. The memory chain (`funnel`)

`chain.shown` counts the lesson's key phrase in an instruction file or the loaded part of `MEMORY.md` at session
start (`scripts/token-eval/leaks.mjs:140`). It does not count hippo's prompt or SessionStart text.

| Arm | First applies | Stored | Built-in shown | Failed when shown | Failed when not shown |
|---|---|---|---|---|---|
| A1 built-in | 162 | 103 | 81 | 2 of 81 | 38 of 80 |
| A2 hippo | 162 | 159 | 148 | 14 of 148 | 4 of 14 |
| A5 sham hippo | 162 | 136 | 112 | 4 of 111 | 11 of 50 |
| A4 perfect | 110 | 108 | 108 | 7 of 107 | 0 of 2 |

Installing hippo, with or without capture, makes Claude Code's own memory hold the lesson more often: shown in 112
of 162 sham hippo sessions against 81 of 162 for built-in memory alone. This is part of the install effect that
round 3's H1 measured.

## 2. Real hippo against sham hippo, position by position (`paired`)

At 112 positions both arms showed the lesson. Real hippo failed and sham hippo passed at 8; the reverse happened at
none. At 11 positions sham hippo had not shown the lesson and failed; real hippo passed at 7 of them. The two
effects cancel, which is the round 3 null.

Built-in reach is not hippo's reach. Counting the lesson's key phrase in hippo's own text (a SessionStart rule line
or the prompt block), hippo reached 142 of A2's 162 first-apply lessons: 75 by rule line only, 12 by prompt block
only, 55 by both. A2 failed 14 of the 142 it reached and 4 of the 20 it missed. Sham hippo, at the same positions,
failed 13 of 141 and 2 of 20 (`hippoReach`).

## 3. What hippo's prompt block held (`blocks`)

150 of 162 A2 sessions had a hippo prompt block; 7 of them had two, so 157 blocks in all.

| Entry type | Entries | Share |
|---|---|---|
| Summary of a past task (`session-digest`) | 264 | 56% |
| Copy of a Claude Code memory note (`claude-code-memory`) | 78 | 17% |
| Captured rule or preference fragment | 68 | 14% |
| Tool error | 52 | 11% |
| User rule, as said (`from-user`) | 5 | 1% |
| Other (`changelog`) | 3 | 1% |

Of the 12 sessions with no block, 10 got the hook's rules text with an empty memory result. The other 2 show no hook
output at all; the logs cannot tell a failed hook from an empty one there. No log carries hook-failure text.

Examples from the 8 positions where real hippo failed and sham hippo passed (quoted from the request logs):

- q256 seed 1, lesson "run tests with `uv run`": a past-task summary said "I ran these with the existing venv's
  Python rather than `uv run`, because setting up the uv environment has failed on this machine before".
- q173 seed 2: a captured "rule" read "Every relocator after it in the set was never checked", a sentence from a
  past fix.
- q105 seed 2: two versions of the changelog rule, the old and the changed one, side by side.

## 4. How the taught rule reached the agent (`rules`)

Hippo 3.3.1 also prints the user's rules at session start, under "Rules from the user". A2 had that block in 148
of 162 first applies, with 484 rule lines; 213 of them open with "No:", the user's correction lead, as in
"- No: Check and format code: `./gradlew spotlessApply`, because the project's maintainers require it". In 8
sessions the agent wrote a note about it, such as "Hippo hook rules phrased 'No: <action>' ... mean 'you failed to
do <action>' — a correction, NOT a prohibition".

The harness teach template writes the "No:" lead, and only when the agent failed the lesson's check at teach time
(`task.mjs:166` sets the teach form to `correction`; `lessons.mjs:270` renders it). Hippo stores the user's text as
given and prints it back with the lead. Every "No:" line in round 3 came from a correction
teach. So the fair comparison stays inside lessons that each arm's own teach also taught as a correction:

| How A2's block held the lesson (correction-taught only) | A2 failed | A5, same positions | A1, same positions |
|---|---|---|---|
| As "No: rule" | 14 of 95 | 12 of 86 | 26 of 90 |
| As the rule, no lead | 0 of 9 | 0 of 9 | 4 of 9 |
| Not in the block | 4 of 21 | 2 of 21 | 6 of 21 |

Per lesson, by each arm's own teach form:

| Arm | Correction-taught failed | Confirmation-taught failed |
|---|---|---|
| A0 no memory | 79 of 84 | 11 of 23 |
| A1 built-in | 38 of 127 | 2 of 34 |
| A2 hippo | 18 of 125 | 0 of 37 |
| A5 sham hippo | 15 of 126 | 0 of 35 |
| A4 perfect | 6 of 86 | 1 of 23 |

Sham hippo fails at the "No:" positions at almost the same rate as real hippo. So the lead shows no measured harm
at this sample size. It is still a defect: it reads as the opposite instruction. Nearly all the room left is in
correction-taught lessons, where perfect memory fails 7% and both hippo arms fail 12 to 14%.

## 5. Room for hippo's lessons (`headroom`)

| | Value |
|---|---|
| A5 first-apply lessons not loaded | 50 of 161 |
| A5 failures there | 11 |
| A4 first-apply lesson fail rate | 7 of 109 |
| Best-case A2 gain | 7.8 failures, 4.8 points |

All counts here are lessons, not sessions.

## What this means for round 4

1. **Cut the prompt block to lessons** (ROADMAP Z9.3, Z9.4, SI4). Past-task summaries, tool errors and copies of
   Claude Code's notes are most of what hippo injects. This is the lever for goal 3 (tokens) and removes the text
   that contradicted a lesson.
2. **State a correction as its rule.** Print "Check and format code: `./gradlew spotlessApply`", not "No: Check
   ...". A cheap defect fix with no measured gain yet.
3. **Keep task fragments out of user rules** (Z3, SI4).
4. **Test where built-in memory fails.** On round 3's tasks Claude Code's memory leaves hippo's lessons at most
   4.8 points. Round 4 should score settings where it fails: a Codex apply after a Claude Code teach (H2, never
   run), more lessons than the 200-line `MEMORY.md` index loads, and longer gaps after the teach. Round 3's
   families are debugging data now; round 4 needs fresh families (ROADMAP Z0, independent confirmation).

HG5 (dreaming against transcripts), Z4 (guards) and Z9.1 (why and apply fields, a schema change) wait for these.
