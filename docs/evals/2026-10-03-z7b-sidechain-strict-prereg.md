# Z7b sub-agent lessons the parent loses, with a stricter judge: pre-registration

**Date:** 2026-10-03. **Status:** DRAFT. No Z7b judge call has been made.

## Why a second run

Z7 (`docs/evals/2026-10-03-z7-sidechain-gap-prereg.md`, result `docs/evals/2026-10-03-z7-sidechain-gap-result.md`) found a lost lesson in 31 of 90 sampled sub-agents (`p` 0.344, interval 0.221 to 0.475), but the precision audit confirmed only 6 of 10, so the verdict was INCONCLUSIVE. The four rejections fell in classes the judge prompt already warned against: the lesson can be read back from the file it concerns; the tool's own error states the fix; any capable agent already knows it. Wording alone did not hold the judges to those tests.

Z7b asks the same question with four changes, each aimed at precision:
1. The judge prompt names those classes as exclusions, with generic examples.
2. A separate Opus **filter** call labels every lesson that survives the recheck and removes those in an excluded class. The judges propose, the filter rejects: one model checking another's list is the lever wording lacked.
3. The prompts are calibrated on at least 10 hand-marked lesson-bearing dev sub-agents to a precision of at least 0.75 before the lock, and the script binds the locked prompts to the round that passed.
4. BUILD is judged on the precision-adjusted lower bound, with a precision audit after scoring whatever the verdict.

Everything else (snapshot, eligibility, blocks A, B and C, evidence check, full-session recheck, decoys, gates G1 to G6) is Z7's, reused from `scripts/z7-sidechain-*` and cited, not restated.

## Question and estimand

As Z7: the share `p` of **directly spawned sub-agents, one per prompt template and at most 5 per session, from sessions closed between 2026-09-02 and 2026-10-01 on this box, not judged in Z7**, that hold at least one lesson the parent never kept, after the recheck and the filter. The session cap rises from 3 to 5 (see Power). `p` is a rate over distinct pieces of delegated work.

## Data and draw

**Snapshot.** Z7's, unchanged: `~/hippo-archive/z7-sidechain-2026-10-03/raw/`, manifest SHA-256 `84028a76df0a4c9b16ea4aaffcaed3284f26ef37985c4cd0a7837765496966e0`. Every file read is checked against the manifest. `claude --version` and the `dist/` files are unchanged from Z7 (re-checked 2026-10-03, see Pins).

**Eligibility.** Z7's four rules (its prereg, "Eligibility and draw"): 858 sub-agents in 46 sessions. None comes from a parent session with zero human turns, so automated `claude -p` runs (such as the 2026-09-28 TE5 pilot) contribute nothing; three interactive sessions that worked inside `hippo-archive/` folders stay in, since their sub-agents are delegated work like any other (checked 2026-10-03).

**Dev set.** Z7's 114 judged items (its 24 dev and 90 scored), recomputed from the verified snapshot with Z7's draw code and checked against Z7's `work/draw.json` and Z7's pinned scored list SHA-256 `cb58dd16d537be7ec882c2faa18d82687bf9af3fac917be644592bd5f9c808ac`. They have been read by judges and, for 15 of them, by the orchestrator, so they can only tune, never score.

**Scored set**, exactly:
1. The pool is every eligible sub-agent that is not a dev item and whose (session, template) pair is not a dev item's (template: first 120 task characters, whitespace collapsed). This keeps a near-copy of a dev task out of the scored set. Pool: 697 sub-agents in 34 sessions.
2. Seed: `mulberry32` from the first 8 hex digits of `sha256("z7b-2026-10-03")`.
3. The pool, sorted by (session id, file name), is shuffled with the seed.
4. Walking that order, a sub-agent is taken when its session has fewer than 5 taken and no taken sub-agent of its session shares its template.
5. Every sub-agent taken is scored: 139 from 34 sessions by a dry walk (`scripts/z7b-sidechain-eval.mjs draw` prints the realised figures).

Z7 judged 43 of the 46 eligible sessions, so a session-disjoint draw would leave too few; scored and dev sessions overlap, items and templates do not.

No scored item is read by a person or a judge before the lock.

**Power.** A simulation on the realised cap-5 draw (139 items, 34 sessions; session rates spread around the true rate; Z7's session-cluster bootstrap with 2,000 resamples; 200 runs per row; an audit of 12 at judge precision `q`) gave, for the both-judges rate `p` before precision adjustment:

| true `p` | P(DROP) | P(BUILD), q 0.6 | q 0.8 | q 0.9 |
|---|---|---|---|---|
| 0.03 | 0.78 | 0.00 | 0.00 | 0.00 |
| 0.05 | 0.35 | 0.00 | 0.00 | 0.00 |
| 0.10 | 0.01 | 0.01 | 0.01 | 0.02 |
| 0.15 | 0.00 | 0.02 | 0.17 | 0.29 |
| 0.20 | 0.00 | 0.13 | 0.51 | 0.73 |
| 0.25 | 0.00 | 0.21 | 0.75 | 0.94 |

DROP here uses a union about 1.35 times the both-judges rate, as in Z7; the real DROP rule (below) uses the unfiltered union, which is larger, so these DROP rates are an upper bound. Raising the cap past 5 barely moves the interval, because only 34 sessions contribute. The simulation script is kept with the episode, not in the repo; its rows carry about ±0.035 of simulation noise.

## The judges

As Z7 ("Judges"): `claude-sonnet-5-5` and `claude-opus-5-5`, one `claude -p` call each per item on plan quota, `isolationOk` first, same flags and the same one-line system prompt. Prompt (draft; dev rounds may change it, and the frozen text goes in Amendments before the lock):

> You are labelling one delegated agent's work for a memory study. A memory system wants to keep lessons that would help a coding agent in a later session on the same machine and projects. Block A is the task the parent agent gave a sub-agent. Block B is the sub-agent's own messages, its reports to the parent marked [report], and the errors its tools returned marked [error]. Block C is what the parent session kept: items its memory system captured, the parent's messages after each report arrived, and notes saved by hand.
>
> List every lesson in B that meets all six tests. Most sub-agents have none; an empty list is the common answer.
> 1. Kind: an error the sub-agent hit and what caused or fixed it; a correction of something believed earlier in the task; or a gotcha, meaning a command, flag, tool, setting or API that behaved in a way the work did not expect.
> 2. Durable and not common knowledge: it would change what an agent does in a later session. Not a result of this task (a score, a count, a finished document). Not something a capable coding agent already knows, such as standard behaviour of a language, shell, operating system, git or a widely used library.
> 3. Not recoverable: an agent could not get it back by opening the file, script or config it concerns, that file's git history, the project's docs, or a CLAUDE.md. What a script imports, a function's default, how a config file is laid out and where something lives are all recoverable.
> 4. Not self-announcing: if the tool's own error message or output states the cause or the fix (for example "use --force to overwrite", "X is deprecated, use Y"), any agent that hits it learns it then, so it is not a lesson.
> 5. Absent: neither A nor C states it or anything that implies it.
> 6. Writable: it fits one self-contained sentence a stranger can read without this thread, with no session, agent or tool ids, hashes or transcript tags.
>
> Reply with JSON only: {"lessons":[{"kind":"error|correction|gotcha","text":"<the sentence>","evidence":"<6 to 30 words copied exactly from B>"}]}. Use an empty list when there is none.

The examples are generic and were written before any dev round; none is taken from a dev item.

**Evidence check.** As Z7: a lesson stays only if its evidence has at least 6 words, appears in normalised B and not in A.

## Recheck and decoys

As Z7 ("Full-session recheck", "Decoy, both ways"), unchanged and on the judges' verified lessons before any filtering: the recheck runs on every item where either judge keeps a verified lesson, and decoys come from verified lessons. The filter therefore does not shrink the decoy pool or the G5 and G6 counts. Decoy seeds: `z7b-decoy|<id>`.

## The filter (new)

For each item with a lesson that survives the recheck, one `claude-opus-5-5` call sees A, B and the numbered surviving lessons of both judges (Sonnet's first, then Opus's, numbered from 0), and labels each. Prompt (draft, frozen like the judge's):

> You are reviewing candidate lessons another model found in a delegated agent's work, for a memory study. Most candidates fail. Block A is the task, Block B the sub-agent's messages and tool errors, then the candidate lessons, numbered from 0.
>
> Give each candidate exactly one label:
> - "file": an agent could recover it by opening the file, script or config it concerns, its git history, the project's docs or a CLAUDE.md (what code imports or defaults to, how a file is laid out, where something lives).
> - "self": the tool's own error or output states the cause or the fix, so any agent that hits it learns it then.
> - "known": a capable coding agent already knows it (standard behaviour of a language, shell, operating system, git or a widely used library).
> - "result": an outcome of this task (a finding, score, count or decision about this work) rather than something that changes how a later task is done.
> - "keep": none of the above applies.
>
> Reply with JSON only: {"labels":[{"i":<number>,"label":"file|self|known|result|keep"}, ...]} with one entry per candidate.

A lesson labelled anything but `keep` is removed, exactly as a lesson the recheck kept is removed: both are recorded as removal keys on the judge's own lesson index, so no list is renumbered. A filter reply that does not parse after 3 tries leaves that item's lessons in place and counts under G2, so a parse failure pushes toward BUILD and the parse gate bounds it. The filter file records the SHA-256 of the recheck file it was run on, and every figure refuses a mismatched pair.

## Validity gates

As Z7, any failure makes the run INVALID, and a gate with nothing to measure is untested, listed, and does not fail the run:
- **G1** isolation; **G2** parse at least 95% per judge (control calls included), for the recheck, and for the filter; **G3** evidence failures at most 30% per judge; **G4** absence control on 30 seeded scored items (seed `z7b-control`; the judges only, as in Z7); **G5** unplanted decoys kept at most 15%; **G6** planted decoys kept at least 85%.
- **G6 count.** A planted-decoy count under 8 is reported beside the verdict, since Z7 saw 16 and G6 is the gate that guards against a recheck error toward BUILD.

The rule arm and the row adding other sub-agents' reports are dropped: Z7 answered both (0 of 57 extractor items passed; 0.322 against 0.344).

## Outcomes

- **Primary**: `p`, the share of scored sub-agents lesson-bearing (both judges keep a lesson after the recheck and the filter), with a 95% session-cluster bootstrap interval (2,000 resamples, seed `z7b-boot`).
- **Unfiltered**: the same share and the union share after the recheck but before the filter, each with its interval. These carry DROP.
- **Reported, no bar**: the share both judges marked before the recheck; lessons overturned by the recheck; lessons removed by the filter, per label; `p` per judge; kappa before the recheck; where the lessons sit (evidence inside a `[report]`); kinds; `p` by agent type; cut share; the dev calibration precision and false-exclusion share; the audit's filter-check count; and a **strong** row: whether Z7's own rule (lower bound at least 0.20 and audit at least 0.75) would have said BUILD.

## Verdict rules

Written before any Z7b judge call. `lo` and `hi` are the primary interval's bounds, `s` the precision audit's confirmed share.

- **BUILD** if `s` is at least 0.75 and `lo × s` is at least 0.10: after discounting the judges' overcount, at least one in ten distinct delegated tasks holds a durable lesson the parent lost.
- **DROP** if the unfiltered union's upper bound is below 0.10. DROP strikes Z7 from the roadmap, so it must hold before the filter removes anything and when either judge's lesson counts.
- **INCONCLUSIVE** otherwise.

`lo × s` is a precision-discounted bound, not a formal one: `s` comes from 12 items and carries its own error. A judge as loose as Z7's (precision 0.60) passes the 9-of-12 audit at most about one time in five (the chance a 0.6 binomial gives 9 or more of 12 is 0.225), and the simulation puts its BUILD rate at 0.21 even at a true `p` of 0.25.

**Realistic outcomes are BUILD or INCONCLUSIVE.** Z7's union was 0.467 (0.341 to 0.588), so DROP needs the stricter judges to cut the unfiltered union about five-fold; the simulation also gives INCONCLUSIVE about 98% of the time at a true `p` of 0.10. A second INCONCLUSIVE means this sample cannot settle the question: Z7 stays on the roadmap as unmeasured, with no build, and no third run without a new data source (more sessions or a cross-box archive).

**The bar is a change from Z7.** Z7 needed `lo` of at least 0.20 and, on BUILD only, an audit of 0.75. With 34 clusters that bar passes only when the judged share is well above 0.30, which a precise judge is not expected to reach (Z7's own figures put the precision-discounted share near 0.21, a point figure). The new line asks whether the discounted rate is at least one in ten. Below that, a Z7 build (reading `subagents/` at session end plus a distil step, since Z7 showed the shipped extractor finds nothing usable there) is not worth its cost. This line was set from the simulation and the build's cost before any Z7b label existed, **but after Z7's result was known**. A reader should weigh it as a post-hoc change of bar; the strong row keeps Z7's bar in view.

## Calibration (before the lock)

Dev rounds: at most 3. Each round judges, rechecks and filters all 114 dev items (decoys from other dev sessions) and prints G2 to G6 and counts; it never prints kappa or per-judge rates until that round's marks are recorded. Between rounds only the judge and filter prompt wording and the block cuts may change, and each change and its reason goes under Amendments. `judge-system.txt` and `recheck-prompt.txt` stay byte-identical to Z7's throughout, since cached replies are keyed by model and prompt only.

Each judge, recheck and filter command records the SHA-256 of every prompt file it read; the calibration samples are only drawn when those records agree with each other and with the files on disk, so the prompts that pass are the prompts the round actually ran.

After a round, the script draws two seeded samples (seed `z7b-calib-r<k>`; from round 2 on, sub-agents not sampled in an earlier round come first) and writes them to the archive:
- **Precision sample**: 12 lesson-bearing dev sub-agents, with their surviving lessons and parent-side paths. If fewer than 12 are lesson-bearing, every one is taken and the sample is topped up, by the same seed, from dev sub-agents where one judge alone keeps a lesson after the filter (Amendment 1).
- **False-exclusion sample**: 8 dev sub-agents with a lesson the filter removed, with the removed lessons (labels hidden).

The orchestrator writes one mark per sampled id to a marks file: `confirmed`, or `rejected:<class>` with class `file`, `self`, `known`, `result`, `present` (the parent side states it) or `other`. A sub-agent is **confirmed** if at least one listed lesson is durable, in none of the filter classes, and absent from the parent side. Absence is checked by searching the parent-side file for the lesson's key terms and reading each hit in context for a paraphrase (Z7 searched terms only, which can overstate precision).

`calib-record --round k` reads the marks file, refuses unless its ids equal both samples exactly, and records the counts and the SHA-256 of every prompt file used that round. The round **passes** when the precision sample has at least 10 ids and at least 75% are confirmed (9 of 12). A precision sample under 10 ids, after the top-up, fails the round. The false-exclusion share is reported only. If no round passes after the third, the run stops as INVALID before the lock and the result says so.

From round 2 on the samples can include items whose rejections drove an amendment, so the dev precision is optimistic; the scored audit is the figure that counts.

## Precision audit (after scoring, every verdict that has judged items)

A run stopped by G1 before any judge call has nothing to audit.

After `result.json` is written, the script writes a seeded sample (`z7b-audit`) of 12 scored lesson-bearing sub-agents (all of them if fewer) mixed with 4 seeded scored sub-agents that were lesson-bearing for both judges after the recheck and not after the filter (fewer if fewer exist), shuffled, with the same layout and no labels. The orchestrator marks all of them by the calibration rule in a marks file. `audit-finalize` refuses unless the marks cover exactly the sample, then records once: `s` over the 12 lesson-bearing ones, the verdict by the rule above, and, reported only, how many of the 4 filter-removed ones were confirmed.

## Lock

As Z7 ("Lock"), with Z7b's names:
- The scored run refuses unless this file says PRE-REG-LOCKED, it, all seven script files (`scripts/z7-sidechain-{lib,eval,guard,selftest}.mjs`, `scripts/z7b-sidechain-{lib,eval,selftest}.mjs`) and `scripts/z7b-sidechain-prompts/` are committed, clean and unchanged since the commit that set the Status, that commit is on a remote branch, and every pin matches.
- It refuses unless the last calibration record passed and its prompt hashes equal the prompt pins below.
- It recomputes both the Z7 dev set and the Z7b draw from the verified snapshot and refuses unless they equal `work/z7b/draw.json` and the scored list pin.
- It creates `~/.hippo-eval-locks/z7b-sidechain-strict.json` once with the `wx` flag. Dev commands refuse any scored id. Scored outputs are written once. `scored --resume` continues a cut-off run under the same marker, reusing cached replies.

## Cost and running

About 280 scored judge calls, 60 control calls, up to 90 recheck calls and up to 70 filter calls, plus up to 3 dev rounds of about 228 judge, 70 recheck and 50 filter calls. All on plan quota through `claude -p`, concurrency 3; every command that calls `claude` refuses to run if `ANTHROPIC_API_KEY` is set.

## Privacy

As Z7: the repo gets the scripts, this file and a result with counts only. Lesson texts, labels and marks stay in the archive (`work/z7b/`).

## Disclosed limits

- All of Z7's disclosed limits (its prereg, "Disclosed limits"), and two from its decoy section and result: a planted decoy is the lesson's own wording, so G6 tests reading, not paraphrase matching; and the recheck cuts the parent side into 150,000-character chunks at fixed points, so G6 cannot catch a parent statement split across two chunks. Both lean toward BUILD.
- Dev and scored sessions overlap; items and templates do not.
- The orchestrator who marks calibration and the audit also wrote the prompts and read 15 dev items' lessons in Z7. The audit's 4 unlabelled filter-removed items are a partial blind, not a full one.
- The filter sees B but not the files a lesson concerns, so "file" is a judgement of the lesson's nature, not a lookup.

## Amendments

1. **Precision sample top-up (dev round 1, before any mark).** Round 1 left 8 of 114 dev sub-agents lesson-bearing for both judges, and the filter removed none of the 8, so the old rule (fewer than 10 fails the round, read as a filter that removes too much) would have failed the round for the judges' strictness, which is the point of Z7b. The alternatives were worse: rerunning unchanged prompts returns the same cached replies, and loosening them to reach 10 items biases the run toward BUILD. The sample now tops up from sub-agents where one judge alone keeps a lesson. Those lessons are less precise than both-judge ones, so the top-up can only make the round harder to pass. Round 1 dev counts at the time: both judges 10 before the recheck, 8 after it and 8 after the filter; either judge 16 after the recheck and 11 after the filter; filter labels file 3, self 3, known 0, result 1, keep 23; G2, G3, G5 and G6 passed (decoys 0 of 9 unplanted kept, 10 of 10 planted kept).

## Pins

- Script base: master `765d383`. `src/capture.ts`, `src/same-text.ts` and `src/secret-detect.ts` are unchanged since Z7's base `28ca777`.
- `dist/` SHA-256: `capture.js` `cb6ad6e10cde1b66e6333ddec74a6129d93cb02ddded9956b2e960bcfa32668b`, `same-text.js` `2e3863a520f0a37b5e560019583f476190219f705fade2525abc51e95b34fb87`, `secret-detect.js` `a4999c5c50583aae9f0eef5ba487de948d3e1a252c673b81bcf9f4cfec495ddd`.
- Snapshot manifest SHA-256 `84028a76df0a4c9b16ea4aaffcaed3284f26ef37985c4cd0a7837765496966e0`.
- Scored item list: added at the lock as the words "scored item list SHA-256", a space, and the hash in backticks, the form `parsePins` reads.
- `claude --version`: 2.1.288.
- Prompts SHA-256: added at the lock, one bullet per file in the form file name in backticks, a space, hash in backticks (`judge-prompt.txt`, `judge-system.txt`, `recheck-prompt.txt`, `filter-prompt.txt`).
