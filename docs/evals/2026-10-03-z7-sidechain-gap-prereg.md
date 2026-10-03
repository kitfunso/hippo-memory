# Z7 sub-agent lessons that the parent's capture misses: pre-registration

**Date:** 2026-10-03. **Status:** DRAFT. It locks at the commit that sets this line to PRE-REG-LOCKED, after the dev rounds below and before any scored call.

## Question

ROADMAP Part XV, Z7, test first: "replay a sample from the SI0-style archive. Count the errors, corrections and file-level facts found inside sub-agents that are missing from the parent's capture and the parent's reply. If few survive the SI4 write contract, drop Z7."

On this box's real sessions, how often does a sub-agent transcript hold a durable lesson that the parent session never kept: not in its capture, not in anything it said, not in anything it saved by hand? If that share is small, Z7 is dropped. If it is large, the Z7 build (session-end capture also reads `subagents/`) goes ahead, and the secondary rows say whether the build can read reports alone and whether today's rule-based extractor can collect the lessons.

## Why capture misses them today (source-read, master `28ca777`)

- `src/capture.ts:595`: `isNonHumanUserLine` treats any line with `isSidechain: true` as non-human. Sub-agent transcripts live in a separate file, `<session>/subagents/agent-<id>.jsonl` (and `subagents/workflows/<run>/` for workflow agents), which nothing in `src/` opens.
- `src/capture.ts:607-622`: a user line that carries a `tool_result` block is dropped, so a foreground sub-agent's final report, which returns to the parent as the Agent tool's result, never reaches extraction.
- A background sub-agent's report returns later as a `<task-notification>` user line. That prefix is not in `CLAUDE_CODE_COMMAND_PREFIXES` (`src/capture.ts:583`), so the notification counts as a user message: its first 500 characters can reach extraction if it is among the last 20 user turns (`summariseSessionTurns`, `src/capture.ts:709-728`). This eval measures that path as shipped; it does not fix it.
- Extraction is `extractFromText(maskEmails(redactSecretsStrict(summary)))` (`src/capture.ts:934`): regex cues for decision, rule, error and preference sentences.

## Data

**Source.** The Claude Code transcripts on this box, `~/.claude/projects/C--Users-skf-s/`. The frozen SI0 archive (`hippo-archive/transcripts-since-2026-09-01/`) copied parent transcripts only, without `subagents/`, so it cannot be used. On 2026-10-03 the live folder held 1,490 top-level sub-agent transcripts and 128 workflow ones across 55 parent sessions, written 2026-09-02 to 2026-10-03 (`scripts/z7-sidechain-eval.mjs profile` regenerates every count in this section from the snapshot).

**Snapshot.** Claude Code deletes transcripts after 30 days, so on 2026-10-03, before the plan review, every session folder holding a `subagents/` folder was copied with its parent transcript to `C:/Users/skf_s/hippo-archive/z7-sidechain-2026-10-03/raw/`: 3,292 files, 4.49 GB, with a SHA-256 per file in `manifest.json` (manifest SHA-256 `84028a76df0a4c9b16ea4aaffcaed3284f26ef37985c4cd0a7837765496966e0`). Every later step reads the snapshot only, and the script checks each file it opens against the manifest. The snapshot stays outside every git work tree because the transcripts hold private work on other projects.

**Earlier attempt.** Episode 01M3KRD3C6 planned a Z7 eval on 2026-09-28 (plan review passed at round 4) and stalled before any script or snapshot existed. This design is smaller: `claude -p` judges instead of Agent-based miners, judges and recheckers. It keeps that plan's findings about the transcript format and its full-session recheck, cited where they apply below.

**Dataset checks** (audit rule 19; the first draft quoted the live folder, these are the snapshot's figures from `profile`):
- Size: 55 sessions, 1,493 sub-agent transcripts, every one with a `.meta.json`, and 128 workflow transcripts.
- Order: 412 sub-agent transcripts have a timestamp earlier than the line before it, almost all on attachment, compaction-summary and `isMeta` lines, which replay old timestamps. Skipping those, 37 do. Nothing in the eval depends on timestamp order: files are read in line order, and the cutoff uses the parent's latest timestamp.
- Spread: assistant text per sub-agent is 0 to 34,293 characters (median 3,156); 6 have none. 565 of 1,493 have at least one tool result marked as an error.
- Templates: 549 transcripts fall in 135 groups whose first 120 task characters, whitespace collapsed, are identical (benchmark answerers, blind judges, plan critics). One session holds 280 sub-agents; the median session holds 8.
- Damage: no line in the snapshot fails to parse as JSON (the first draft's 98 were counted on the live folder, not the snapshot). The reader still skips and counts bad lines; the self-test includes one.
- Eligibility: 858 sub-agents in 46 sessions are eligible. The draw gives 24 dev items and 90 scored items from 34 sessions.

## Estimand

The share `p` of **directly spawned sub-agents, one per prompt template and at most 3 per session, from sessions closed between 2026-09-02 and 2026-10-01 on this box**, that hold at least one lesson the parent never kept. The template and session caps stop benchmark answerers and one 280-agent session from deciding the result, so `p` is a rate over distinct pieces of delegated work, not over every sub-agent file. It is not multiplied up to a monthly count.

## Eligibility and draw

A sub-agent is eligible when all hold:
1. Its transcript is directly under `<session>/subagents/` (workflow agents excluded: they return to a script, not to the parent's turn).
2. Its `.meta.json` has `spawnDepth` 1, and the parent transcript contains its `toolUseId`.
3. Its parent session's last entry is before 2026-10-02T00:00Z (a live session would be cut mid-way), and the parent is not this episode's session.
4. It has at least 200 characters of assistant text after any fork prefix.

Draw, exactly:
1. Seed: `mulberry32` from the first 8 hex digits of `sha256("z7-2026-10-03")`.
2. Sessions holding an eligible sub-agent, sorted by session id, are shuffled with the seed; the first 12 are **dev**, the rest **scored**.
3. Eligible sub-agents, sorted by (session id, file name), are shuffled with the same generator, continuing its stream.
4. Walking that order, a sub-agent is taken when its session has fewer than 3 taken and no taken sub-agent of its session shares its template (first 120 task characters, whitespace collapsed).
5. Every scored sub-agent taken this way is scored. Dev keeps its first 24 in walk order.

No scored item is read by a person or a judge before the lock.

**Power.** The draw gives 90 scored items from 34 sessions (the draft estimated 90 to 100 from about 38). With session clustering, the 95% interval is roughly 0.20 wide around 0.3. So BUILD needs a point estimate near 0.30 or more, DROP needs one near 0.04 or less, and anything between is INCONCLUSIVE. The script prints the realised n, session count and interval width.

## Reading a sub-agent file

Format findings from the 09-28 plan, re-checked by the script's self-test on synthetic files:
- A **fork** file (`meta.isFork`) opens with a copy of the parent's context, ending in a user entry whose text starts `<fork-boilerplate`. Everything up to and including that entry is skipped, and the task is the text after `</fork-boilerplate>`.
- In any other file, the task is the first user entry that is neither `isMeta` nor `isCompactSummary`.
- After the task, user entries give only their errored tool results. The sub-agent's own compaction summaries, `isMeta` entries (messages from the parent or peers, task notifications) and text blocks inside user entries are skipped.
- A **report** is a turn's last run of text-only assistant entries: the parent receives it. A sub-agent resumed by a message has one report per turn. A file cut off mid tool call has no report for that turn.
- **Own memory writes**: the sub-agent's Bash or PowerShell commands containing `hippo remember`, and its Write or Edit calls to a memory path (defined under C(iii)).

## What the judge sees

- **A. Task**: cut to 3,000 characters.
- **B. Sub-agent work**: its assistant text blocks in order, each report marked `[report]`, with each errored tool result (first 500 characters, at most 20) in place, marked `[error]`. Cut to 40,000 characters by dropping the middle, so the start of the work and the final report survive; the cut count is reported.
- **C. What the parent kept**:
  - (i) every item hippo's shipped capture extracts from the parent transcript (`extractFromText(maskEmails(redactSecretsStrict(summariseTranscript(jsonl))))`, via `dist/capture.js`, as the SessionEnd hook runs it).
  - (ii) for every report of this sub-agent that reached the parent, the parent's assistant text from that arrival up to the next user line that is neither a tool result nor a task notification. A report reached the parent when its first 120 normalised characters (the whole report if shorter) appear in a non-assistant parent entry (a tool result, a task notification or a SendMessage result). Windows are cut to 8,000 characters each and 16,000 in total; the count of cut windows is reported.
  - (iii) every explicit save, by the parent anywhere in the session or by this sub-agent: the text of each Bash or PowerShell command containing `hippo remember`; each Write or Edit to a path with a `memory` folder segment or ending in `MEMORY.md`, `CLAUDE.md` or `AGENTS.md` (not a source file such as `src/memory.ts`); and the "Memories for hippo" section of each compaction summary. Agents on this box store lessons by hand, so a lesson saved that way is kept, not lost.

C is a cheap first filter. The full-session recheck below is what decides absence.

## Judges

Two models, each called once per item through `claude -p` on plan quota (no paid API): `claude-sonnet-5-5` and `claude-opus-5-5`. The call mirrors `scripts/z1c-eval.mjs:273-286`: `--safe-mode --tools "" --no-session-persistence --strict-mcp-config`, a one-line system prompt, the prompt on stdin, a temp working folder, up to 3 transport retries. Before any labelled call, each model passes `isolationOk` (`scripts/z1c-eval.mjs:319-333`): no heading from either `CLAUDE.md` appears in its reply.

Prompt (draft; dev rounds may change it, and the frozen text goes in Amendments before the lock):

> You are labelling one delegated agent's work for a memory study. A memory system wants to keep lessons that would help a coding agent in a later session on the same machine and projects. Block A is the task the parent agent gave a sub-agent. Block B is the sub-agent's own messages, its reports to the parent marked [report], and the errors its tools returned marked [error]. Block C is what the parent session kept: items its memory system captured, the parent's messages after each report arrived, and notes saved by hand.
>
> List every lesson in B that meets all five tests:
> 1. Kind: an error the sub-agent hit and what caused or fixed it; a correction of something believed earlier in the task; or a gotcha, meaning a command, flag, tool, setting or API that behaved in a way the work did not expect.
> 2. Durable: it would change what an agent does in a later session. A result of this task (a score, a count, a finished document) is not a lesson; nor is something any capable agent already knows.
> 3. Not recoverable: an agent could not get it back by reading the file it concerns, that file's git history, or a CLAUDE.md. Where a file is or what it contains is not a lesson.
> 4. Absent: neither A nor C states it or anything that implies it.
> 5. Writable: it fits one self-contained sentence a stranger can read without this thread, with no session, agent or tool ids, hashes or transcript tags.
>
> Reply with JSON only: {"lessons":[{"kind":"error|correction|gotcha","text":"<the sentence>","evidence":"<6 to 30 words copied exactly from B>"}]}. Use an empty list when there is none.

**Evidence check.** The script normalises (lower case, collapsed whitespace, quotes and backticks stripped, the `[report]` and `[error]` marks removed from B first so evidence cannot include them) and keeps a lesson only if its evidence has at least 6 words, appears in B, and does not appear in A. Lessons that fail are counted per judge and dropped.

## Full-session recheck (decides absence)

For every scored sub-agent where both judges keep at least one verified lesson, one `claude-opus-5-5` call per chunk asks, for each of those lessons, whether the parent side states it or anything that implies it. The **parent side** is what the parent itself wrote or saved, in session order: every text block of the parent's own assistant entries, every brief and SendMessage text the parent sent to any agent, the C(i) capture items and the C(iii) saves. Reports from other sub-agents are left out: capture drops them just as it drops this one's, so a lesson two sub-agents found and the parent never repeated is lost twice, not kept. The parent side is chunked at 150,000 characters; every chunk carries all the lessons. A lesson stated in any chunk is **kept**. Reply format: `{"kept":[<lesson index>, ...]}`. A non-gating row reports `p` when other sub-agents' reached reports are added to the parent side.

**Decoy, both ways.** Each recheck call (each chunk of a sub-agent's recheck) carries one decoy lesson in a seeded position: a verified lesson from a scored session whose working project differs from this session's. The working project is the session's most frequent `cwd`, cut to the folder directly under the home folder, with `-wt-*` and `-worktree*` suffixes removed. A seeded coin per sub-agent decides whether the decoy is **planted**: its sentence is inserted, worded as written, as one parent assistant line at a seeded position in one seeded chunk.
- Not planted, the parent cannot have stated it, so the recheck should not keep it (gate G5).
- Planted, the parent side now states it, so the recheck must keep it (gate G6). This catches a recheck that misses statements deep in a long chunk, which would push toward BUILD. The planted line is the lesson's own wording, so G6 tests reading, not paraphrase matching; that limit is stated in the result.

The unit is the sub-agent: as with real lessons, a decoy is kept when any chunk of that sub-agent's recheck keeps it. The decoy's kind differs from all of this sub-agent's lessons where such a decoy exists, so a planted line cannot imply a real lesson. If no session with a different working project has a verified lesson (likely on dev), the decoy comes from any other session and is flagged; if none exists at all, the decoy is skipped and the skip counted. With about 30 to 40 rechecked sub-agents, each gate sees roughly 15 to 20 decoys, so G5 fails at about 3 kept; the counts are printed beside the rates.

After the recheck, a judge's lesson counts only if it was not kept. A sub-agent is **lesson-bearing** when both judges still have at least one such lesson.

## Outcomes

- **Primary**: `p`, the share of scored sub-agents that are lesson-bearing after the recheck. 95% interval by a session-cluster bootstrap (2,000 resamples, seed `z7-boot`). The share before the recheck and the number of lessons the recheck overturned are reported and cannot carry BUILD.
- **Where the lessons sit, no bar**: for each lesson-bearing sub-agent, whether at least one surviving lesson's evidence lies inside a `[report]`. Capture drops the tool result that carries a foreground report (`src/capture.ts:607-622`), so if most lost lessons sit in reports, a Z7 build could read reports alone; if they sit in the work, it must read the whole sub-agent transcript.
- **Secondary, no bar**: `p` for each judge alone; Cohen's kappa between judges on lesson-bearing before the recheck; lessons per sub-agent; the kind mix; `p` by agent type (general-purpose, reviewer, worker, other); share of items with B or a C(ii) window cut; the dev calibration precision.
- **Rule arm, descriptive**: what shipped capture would store if it read the sub-agent transcript, after stripping any fork prefix: `extractFromText(summariseTranscript(...))`. Every line of a sub-agent file is `isSidechain`, so `summariseTranscript` keeps assistant text only (its last 10 turns); the row measures that as is. Items whose `duplicateKey` (`dist/same-text.js`) matches a parent capture item are removed. Report items per sub-agent, and one Opus call per sub-agent with any item labels each on tests 2, 3 and 5; report the share labelled yes. This says whether a Z7 build could reuse today's extractor or needs a distil step; it does not change the verdict.

## Verdict rules

Written before any scored call.

- **BUILD** if the interval's lower bound is at least 0.20: one in five distinct pieces of delegated work holds a durable lesson the parent lost.
- **DROP** if the interval's upper bound is below 0.10, and the upper bound of the **union** share (sub-agents where either judge keeps a verified lesson after the recheck) is also below 0.10. Requiring both judges lowers recall, and DROP strikes Z7 from the roadmap with this result as the reason, so it must hold under the more generous count too.
- **INCONCLUSIVE** otherwise. Z7 stays test-first and the result names what would decide it.

The bars count sub-agents, not lessons, so a few verbose transcripts cannot carry the result.

## Validity gates (any failure makes the run INVALID)

- **G1 isolation**: both judge models pass `isolationOk` before the first labelled call.
- **G2 parse**: at least 95% of labelled calls per judge, and of recheck calls, return parseable JSON after retries.
- **G3 evidence**: per judge, at most 30% of returned lessons fail the evidence check.
- **G4 absence control**: on 30 scored items drawn with the seed, the script re-runs both judges with C replaced by C plus the whole rendered B, errors and report marks included. Every lesson is then stated in C, so the share of the 30 control items where both judges keep at least one lesson passing the evidence check (before any recheck) must be at most 0.10. A judge that still finds "absent" lessons is not reading C.
- **G5 recheck negative control**: the recheck keeps at most 15% of unplanted decoys. A higher rate means the recheck overturns freely, which pushes toward DROP.
- **G6 recheck positive control**: the recheck keeps at least 85% of planted decoys. A lower rate means it misses what the parent said, which pushes toward BUILD.

## Dev rounds and calibration

The 24 dev items may be judged up to 3 times, changing only the prompt wording and the block cuts, to fix parse failures, evidence-copy failures or a judge that ignores C. The recheck runs on dev too, with decoys drawn from other dev sessions, and G5 and G6 are printed for each round. Each change and its reason is recorded under Amendments before the lock. Dev items never enter the scored numbers.

Calibration: after the final dev round, and before reading the judges' agreement figures, the orchestrator takes each dev sub-agent that is lesson-bearing after the recheck and confirms it only if at least one surviving lesson is durable and not recoverable (tests 2 and 3) and is absent from that sub-agent's parent side as the recheck defines it (the script writes it to the archive; this sub-agent's own reports are not in it). The prompt passes when at least 75% of those sub-agents are confirmed. If it fails after the third round, the run stops as INVALID before the lock. If fewer than 4 dev sub-agents are lesson-bearing, calibration is recorded as uninformative and the run goes on, and the precision audit below becomes mandatory. The confirmed share is recorded under Amendments and reported beside `p` as the judge's precision.

**Precision audit, after scoring.** If the verdict is BUILD, or calibration was uninformative, the orchestrator confirms a seeded sample of up to 10 scored lesson-bearing sub-agents (all of them if fewer) by the calibration rule, after the verdict is computed and recorded. The script writes the sample's seed and ids to the archive before the orchestrator opens any of them. BUILD stands only if at least 75% are confirmed; otherwise the verdict becomes INCONCLUSIVE. The audit's count is reported whatever it finds.

## Cost and running

About 200 scored judge calls, 60 control calls, up to 150 recheck calls, up to 100 rule-arm calls and up to 170 dev calls, all on plan quota; concurrency 3. No paid key is set in the judge environment; the script refuses to run if `ANTHROPIC_API_KEY` is set.

## Privacy

The repo gets the script, this file and the result, which reports counts only: no lesson text, transcript text, project names or local paths beyond this archive's. Per-item labels and lesson texts stay in the archive. The script prints counts only; the orchestrator reads transcript text only for the dev calibration. The commit grep (`sk-`, `api_key=`, `password=`) runs on every staged diff.

## Lock

- The scored and control runs refuse unless this file says PRE-REG-LOCKED, it and the script are committed and unchanged at HEAD, and the commit that locked it is on a remote branch.
- Before its first call, the scored run creates `~/.hippo-eval-locks/z7-sidechain-gap.json` with the `wx` flag (lock commit, scored item list SHA-256, time) and refuses if it exists, so deleting outputs cannot buy a second draw of the judges. The control run checks the same marker exists and was made by this lock commit.
- The scored recheck, its decoys and the rule arm run only inside the marker-guarded scored run. Dev runs refuse any scored item id.
- Each scored output file is written once: a later write is accepted only if it is identical, otherwise refused.
- Resume. A scored run cut off part-way (a plan-quota limit, a crash) may be resumed with `scored --resume`, only while `result.json` does not exist and only under a marker made by this lock commit for this item list. A resume re-runs isolation, reuses every cached passing reply, and asks again only the calls that never returned one, so it cannot redraw a judge. A call that ran but still did not parse after 3 tries is a fixed G2 failure and is not asked again. In the scored run, a call that cannot run at all (non-zero exit, empty output, a usage-limit reply) stops the run for a resume rather than counting as a failure. Each resume is logged beside the marker and reported in the result.

## Disclosed limits

- `hippo init` can also wire a PostToolUseFailure hook (`hippo capture-error`), which fires inside sub-agents and stores short raw error lines. This box never installed it, so the eval measures the SessionEnd path alone; on a default install some error lessons would already be kept.
- Workflow and nested sub-agents are left out; the result covers sub-agents a session spawns directly.
- A lesson the parent wrote only into some other file (code, a doc) counts as lost, as in the roadmap's wording.
- The roadmap counts "file-level facts". Following Z9.4 (do not save what the file or git can tell you), this eval counts a fact about a file only when it is a gotcha the file would not reveal. That narrows the count toward DROP.
- Sessions start 2026-09-02 (retention), mostly on this owner's projects; the result speaks for this box's use.

## Amendments

Before the lock, from building the script (no judge call had been made):
1. **Recheck scope.** The recheck runs on every sub-agent where either judge keeps a verified lesson, not only where both do, because the union share in the DROP rule is defined after the recheck. G5 and G6 therefore see more decoys.
2. **Retries.** A judge, recheck or rule-arm call is retried up to 3 times on a failed exit or a reply that does not parse; G2 counts calls that still fail after that. Only passing replies are cached.
3. **Untested gates.** A gate with nothing to measure (for example G5 when no decoy was unplanted) is reported as untested, listed in the result, and does not fail the run.
4. **Files.** The script is four files: `scripts/z7-sidechain-lib.mjs`, `scripts/z7-sidechain-eval.mjs`, `scripts/z7-sidechain-guard.mjs` and `scripts/z7-sidechain-selftest.mjs`, with prompts in `scripts/z7-sidechain-prompts/`. The lock checks all of them.
5. **Non-gating row.** The row with other sub-agents' reports re-asks only the lessons the main recheck did not keep, with its own decoy, which no gate counts.
6. **Resume** (Lock section), added so that a quota limit cannot spend the one scored run.
7. **From the Codex review of the script (four findings, all taken).** (a) Before the marker, the scored run refuses if any script or prompt file differs between the lock commit and HEAD, or if any value under Pins below (the `dist/` files, prompts, manifest, scored item list, `claude --version`) does not match. (b) It recomputes the draw from the verified snapshot and refuses unless it equals `work/draw.json` in full. (c) G2 counts the control calls with each judge's own calls, and G4 is taken only over control items where both calls parsed; if fewer than 27 of the 30 parsed, G4 fails. (d) The precision audit ends with `audit-finalize --confirmed K`, which records the count once and turns a BUILD into INCONCLUSIVE below 0.75; `result.json` stays as the record before the audit. A second Codex review of those fixes added three more, also taken: the lock commit is the commit that set this Status to PRE-REG-LOCKED, not the latest edit to this file; the draw check covers the dev items' mapping too; and `claude --version` must match its pin exactly, not by prefix.

Dev rounds (24 dev items from 9 sessions; dev figures never enter the scored numbers):
8. **Round 1 was the only round.** All 48 judge calls and every recheck call parsed (G2), both judges were under the evidence-failure bar (G3), and the recheck kept 0 of 3 unplanted decoys (G5) and 8 of 8 planted ones (G6). Before the recheck 6 sub-agents had a verified lesson from both judges; the recheck kept 5 lessons, leaving 5 lesson-bearing (7 by either judge). No prompt or cut was changed, so the frozen prompts are the ones committed with the script.
9. **Calibration: 4 of 5 confirmed (0.80), pass.** Four sub-agents held a durable, non-recoverable lesson absent from their parent side. The one rejected was a harness rule whose own error message states the fix, so any agent already has it. Disclosure: the `score` command prints kappa, so the orchestrator saw the dev kappa before marking, against the order in the calibration paragraph above. The scored run is unaffected.
10. **The audit is required only on BUILD**, since calibration was informative.

## Pins

- Script base: master `28ca777`. `src/capture.ts`, `src/same-text.ts` and `src/secret-detect.ts` are unchanged from there to `c2b3840` (1.53.2).
- `dist/` SHA-256: `capture.js` `cb6ad6e10cde1b66e6333ddec74a6129d93cb02ddded9956b2e960bcfa32668b`, `same-text.js` `2e3863a520f0a37b5e560019583f476190219f705fade2525abc51e95b34fb87`, `secret-detect.js` `a4999c5c50583aae9f0eef5ba487de948d3e1a252c673b81bcf9f4cfec495ddd`.
- Snapshot manifest SHA-256 `84028a76df0a4c9b16ea4aaffcaed3284f26ef37985c4cd0a7837765496966e0`; scored item list SHA-256 `cb58dd16d537be7ec882c2faa18d82687bf9af3fac917be644592bd5f9c808ac`.
- `claude --version`: 2.1.288.
- Prompts SHA-256: `judge-prompt.txt` `e76d157b8fd6279744e34098bd05da62129a610596e944b23c59def2e40f693a`, `judge-system.txt` `db6157da9b267006457bf57d6b64f98891c99733ff5ac33e071c5c7b487c22b3`, `recheck-prompt.txt` `1d1a286d8be6272afaf33ad576794a0436696087d8a2e3c4298056841852ec4f`, `rule-arm-prompt.txt` `23073d822273daf4e32e4cf8fc4b0bf40606bc6d7947fa8517777648a30dc199`.
