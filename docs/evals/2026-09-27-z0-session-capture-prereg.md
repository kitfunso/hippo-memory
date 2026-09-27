# Z0 SessionEnd capture extractor: pre-registration

**Date:** 2026-09-27. **Status:** PRE-REG-LOCKED at the commit that adds this file. No held-out extractor output is read or labelled before the extractor is frozen in a later commit.

## Question

ROADMAP Part XV, Z0, the open trade left by #258: SessionEnd capture is now the only automatic capture path, and its extractor writes mostly junk. The pre-compact audit found 2 useful of the last 45 extracted memories. Can a rule-based extractor, with no model call inside the hook, write memories a later agent can use on their own, and write nothing when nothing qualifies? Then, with the same data: can the capture window grow from the transcript tail to the whole session?

## Mechanism claim

Today `summariseTranscript` (`src/capture.ts`) keeps the last 20 human messages and the last 10 assistant replies, flattens them to markdown, and `extractFromText` runs keyword regexes over it. Every regex match starts AT the keyword (`never`, `must`, `the fix is`, `going with`), and the captured text is cut at the first comma after it. So the subject before the keyword is dropped ("The deploy script must never run migrations" is stored as "must never run migrations"), the reason after a comma is dropped, and table rows, code and markdown reach the regexes as prose.

The new extractor, `extractSessionMemories(turns)` in `src/session-extract.ts`, works on turns, not a flattened summary:

1. Skips fenced code, table rows, headings, block quotes and tag lines; strips list markers and bold.
2. Splits into sentences and keeps a candidate as the WHOLE sentence, from its first word, so the subject stays.
3. Admits a sentence only when it carries a lesson cue (root cause, "the fix/cause/issue is", workaround, fails/breaks because, silently), a decision cue, a rule cue (never, always, must), a preference cue (prefer, instead of, rather than, avoid), or is a human's own stated preference ("I don't like...", "I prefer...").
4. Rejects what cannot stand alone: questions, sentences opening with a pronoun or connective (this, that, it, so, then...), assistant first-person narration, session-local references (this session, above, option B), transient status words (yet, still, now, currently), label leads ("Update:", "Cost if patched:"), a human's one-off imperative, and sentences outside 40 to 300 characters.
5. Keeps the reason: a sentence with because/since/so that scores higher; a following sentence that opens with "Because" or "The reason" is joined on.
6. Scores each candidate (lesson 3, others 2, +1 for a stated reason, +1 when a human wrote it), keeps those scoring 3 or more, and writes at most 3 per session, highest score first, later turns first on ties.

The rules were written from the tune split only (below).

## (a) Source-read

- `src/capture.ts` `summariseTranscript` (tail slice at the line after "Keep the tail"), `extractFromText`, `extractFromPatterns` (group 1 is the keyword, so the match starts there), `boundToClause` (cuts at the first `, ; :` followed by a space).
- `cmdCaptureCore` `last-session` branch: summary, then `extractFromText`, then dedup against the store and `writeEntry`. The manual `hippo capture --stdin/--file` path is not changed by this slice.

## (b) Dry-run

Synthetic transcript unit tests in `tests/session-extract.test.ts`: "The deploy script must never run migrations, because the replica lags." keeps its subject and its reason; "It must never run migrations." writes nothing; a table row and a fenced code line with "never" write nothing; a session with ten qualifying sentences writes 3.

## Data

- **Corpus:** the frozen SI0 transcript copy used by Z1 and Z3 (135 transcript files, outside the repo). Only aggregate numbers leave the private folder; test fixtures in the repo are synthetic.
- **Split, by session family:** sessions that share any identical human message of 30 or more characters (resumes, forks, repeated briefs; compact summaries and system lines excluded) form one family. A family is held-out when `int(sha256("z0x:" + smallest session id in the family)[:8], 16) % 2 == 1`. Result: 121 families; held-out 73 sessions, tune 62 sessions. A plain per-session split would have put 43 identical human messages on both sides.
- **Arms**, each run on every held-out session:
  - **A0 (old):** `summariseTranscript` then `extractFromText`, as shipped at `09343e8` (1.52.2).
  - **A1 (new, tail):** `extractSessionMemories` on the same tail window (last 20 human messages, last 10 assistant replies). This is the shipping candidate.
  - **A2 (new, whole session):** `extractSessionMemories` on every turn of the session, same cap. This answers the window question.
- **Unit:** one extracted memory text. Store dedup is not applied (every arm sees an empty store).
- **Profile before lock (counts only, no text read on held-out):** A0 wrote 70 memories on held-out (median 0 per session, max 6, 37 of 73 sessions wrote none).

## Labels

- **Pool:** every held-out memory from A0, A1 and A2, exact-text duplicates merged so a text is labelled once and credited to each arm that wrote it. Shuffled with a fixed seed; the labeller never sees which arm wrote a text, or its session.
- **Labeller:** an Opus sub-agent labels the whole pool. It sees only the memory text, because the claim is "useful on its own".
- **Rubric given to the labeller.** A memory is `useful` when all four hold:
  1. **Subject:** it names what it is about (a component, file, tool, service, project, practice or person) so a reader with no session context knows what it refers to.
  2. **Content:** it states a decision, rule, preference, lesson, gotcha, cause or durable fact that could change what a later agent does.
  3. **Durable:** it is not transient status or progress ("the suite is at 52%", "the PR is open"), a one-off instruction for that moment ("run it again"), a question, or a narration of what the agent just did.
  4. **Whole:** it reads as a complete statement, not a fragment, a table row or code.
  Otherwise `not_useful`. The labeller also marks `has_why` (the memory states a reason), reported only.
- **Second labeller:** a Sonnet sub-agent labels a random 100 of the pool (fixed seed; the whole pool if smaller), blind to the Opus labels. Raw agreement and Cohen's kappa are reported.

## Procedure

1. Lock this file.
2. Implement the extractor from the tune-split prototype; the tune split may be read freely.
3. Freeze the extractor in a commit. Only then run A0, A1 and A2 on held-out, build the pool and label it.
4. Score once.

## Metrics (held-out)

- **Useful rate** per arm: labelled useful among that arm's memories, with a 95% Wilson interval.
- **Useful count** per arm, and memories per session (mean, max), and sessions that wrote nothing.
- `has_why` rate among useful memories, per arm (reported).

## Decision rule (locked)

**A1 ships** as the SessionEnd extractor when all hold:

1. A1 wrote at least 15 held-out memories (else: no verdict). The tune split gave 16 memories on 62 sessions, so a larger floor would likely end in no verdict.
2. Label agreement is at least 80% (else: no verdict).
3. A1 useful rate is at least 0.60.
4. A1 useful rate beats A0's by at least 0.25.
5. A1's useful count is at least 0.8 times A0's, so the rate is not bought by writing almost nothing.
6. No session gets more than 3 memories (enforced by the cap; checked).

**Fails** when rule 1 and 2 hold and any of 3 to 5 fails. The result doc is then the deliverable, and the extractor code does not ship.

**Window.** The whole-session window (A2) replaces the tail as the default only when A1 ships and A2 itself clears rules 3 to 5 against A0, its useful rate is no more than 0.05 below A1's, and its useful count is at least A1's. Otherwise the tail window stays and the result says why.

The Wilson lower bound is reported beside each point estimate; the bars are on point estimates. At 15 memories and 0.60 that bound is about 0.36, so a pass near the floor is a weak pass and the result says so.

## Retraction conditions

- A held-out memory, label or transcript line is found to have shaped a rule: retract and re-split on sessions after 2026-09-27.
- Any extractor change after the freeze commit: the held-out score no longer applies.

## Results

In `docs/evals/2026-09-27-z0-session-capture-result.md`.
