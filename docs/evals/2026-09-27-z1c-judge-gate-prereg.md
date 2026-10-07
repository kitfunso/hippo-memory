# Z1c failure recall, judge-gated: pre-registration

**Date:** 2026-09-27. **Status:** LOCKED by the commit that adds this file. No fresh-window event has been scored or judged before the lock. Run before the lock: a count of transcript files and timestamps in the fresh window (no replay, no scores).

Roadmap: Part XV, Z1, third arm. Earlier arms: Z1 [prereg](2026-09-26-z1-prompt-recall-prereg.md) / [result](2026-09-26-z1-prompt-recall-result.md), Z1b [prereg](2026-09-26-z1b-tool-recall-prereg.md) / [result](2026-09-26-z1b-tool-recall-result.md).

## Question

Z1b recalled memories against a failing Bash command and its error. It failed its locked gates on a lexical scorer that is circular for this arm and on a median-token rule that no additive block can meet. An exploratory blind judge on the Z1b held-out split found the recalled memories helped on 14 of 33 failures, against 0 of 33 for what today's hook had in context. That split has now been seen. Z1c asks the same question on data nobody has looked at, with the judge as the primary gate: on a fresh transcript window, do the memories recalled against a failure help with that failure more often than what today's hook injects, at a bounded mean token cost?

## What is fixed from Z1b (no tuning on the fresh window)

- **Mechanism:** the Z1b tool-failure block exactly as in the Z1b prereg ("The Z1b block"): non-routine Bash failures only, query = command with a leading `cd ... &&` stripped plus the error text (first 4,000 characters), candidates as-of and unpinned and not superseded and above the quality floor, minus `auto-captured` memories, gate `gatePromptRecall`, 1,500-token budget, TE2-style skip on the block's own state. Replay code: `scripts/z1-replay.mjs --arm z1b`, unchanged in behaviour for these arms.
- **Configuration:** jaccard, threshold 0.08, minShared 2, maxItems 3. This is the Z1b exploratory configuration. It tied for the best tune-split overlap with the lowest mean tokens among the tied configurations, and was chosen on tune numbers only. It was then run once on the Z1b held-out split, which is why that split is retired and this window is new.
- **Arms:** A1 (today's per-prompt hook, pinned plus 5 newest, as in Z1) and Z1c (A1 plus the tool-failure block). A0 is not run.
- **Recall stays local.** The block is lexical recall inside the hook process. No model call in the hook. The judge below is the eval's scorer only.

## Fresh window (data, private, read-only)

- **Source:** the Claude Code session transcripts on the author's box, top-level session files per project directory (the SI0 corpus layout; sub-agent transcripts are not included).
- **Cutoff:** 2026-09-27 00:00 Europe/London (2026-09-26T23:00:00Z). The Z1 and Z1b corpus was frozen before it.
- **What is scored:** only events, hook prompts and tokens whose transcript line is timestamped at or after the cutoff. Sessions are long-lived here (most active sessions started days before the cutoff), so a session that started earlier is replayed from its start to rebuild context state (`C(t)`, first-error signatures, TE2 skip state), and nothing before the cutoff is scored. For a fail-then-pass event, both the failure and the success must be at or after the cutoff; a repeat counts when the repeat line is.
- **Excluded sessions:** any file whose text contains `z1c`, case-insensitive, anywhere in its content (a full-text scan, independent of the file's path or `cwd`; these are the sessions that build or run this eval, whose failures would be about the eval's own tooling and memories); any session whose `cwd` has an `eval-runs` path segment (TE5 harness runs, synthetic tasks); any session whose `cwd` is inside the eval's scratch directory.
- **Collection:** `scripts/z1c-eval.mjs` copies qualifying files read-only into a scratch directory outside the repo. Store copies are taken at the same time with SQLite `VACUUM INTO` from read-only connections: the global store and every project store a scored session's `cwd` resolves to (nearest ancestor `.hippo`, not the home directory). Hippo itself is never run against a live store. The as-of rule is unchanged (a memory is visible at `t` only when `created < t`).
- **Nothing from the window is committed.** The result doc reports aggregates only.

## Eligible events

Signal events as in SI0 and Z1b (a repeat of a non-routine Bash error signature; the first success of a command signature that failed earlier), compaction-reset context, scored inside the window, where Z1c added at least one memory to `C(t)` that A1's `C(t)` lacks. **Minimum: 30 eligible events** (twice Z1b's 15, because the judge is now the primary gate). Under 30 when the window is scored is not a verdict: the run stops before any judging and reports counts only.

**Stopping rule.** The window is checked by counts only (eligible events, hook prompts), never by any judge or overlap number. It is scored exactly once, at the first check with at least 30 eligible events. The scoring command writes a marker keyed to this prereg's cutoff in a fixed location under the operator's home directory (not in the chosen output directory) and refuses to score again while it exists, whatever output directory is passed. The marker is written before the first scored judge batch is sent, so a VOID after judging also blocks a rerun; any rerun needs a committed amendment to this prereg first.

## Judge (primary gate, locked)

- **Items per eligible event,** each shown as a failed command (first 500 characters), its error (first 1,500) and a few notes (each at most 600 characters):
  - **T:** the memories of the most recent Z1c block before the event, up to maxItems.
  - **C (control, today's hook):** the same number of the newest distinct memories A1 put in context in that session since the last compaction before the failure. An empty control is scored NO without judging, because today's hook showed nothing.
  - **P (placebo, judge validity):** event i's T memories shown with the failure of another eligible event, chosen by a seeded derangement that prefers an event from a different session.
- **Blinding:** all items are shuffled together with seed 20260927 and carry only an item id. No arm label, no event id, no session. The key sits in a separate private file the judges never see.
- **Two judges, independent:** Sonnet (`claude -p --model sonnet`) and Opus (`claude -p --model opus`), on the subscription, with `--safe-mode` (no CLAUDE.md, hooks, skills or plugins), no tools, no MCP, no session persistence, a one-line system prompt, run from an empty scratch directory. Items go in batches of 20; each judge labels every item once. A batch with missing or malformed labels is re-asked once; if labels are still missing the run is VOID.
- **Isolation check before judging:** each judge, invoked exactly as above, is asked to list every markdown heading in its context other than the message. If any heading from the operator's user-level or home-level `CLAUDE.md` comes back, the run is VOID before any item is judged. (A probe before this lock showed that without `--safe-mode` the operator's CLAUDE.md does reach a `claude -p` judge.)
- **Prompt, verbatim (unchanged from Z1b):** "For each item you get a failed shell command, its error output, and a few notes from a memory store. Answer HELPS if at least one note contains specific information that would help an engineer fix or avoid this exact failure: its cause, a fix, the right command or flag, a path or naming rule, or a known gotcha that applies. Answer NO if the notes are only on the same topic, generic, or unrelated. Output one line per item: `<item id> HELPS` or `<item id> NO`."
- **Label of an item:** HELPS only when both judges say HELPS (strict consensus). Each judge's own rates and Cohen's kappa between them are reported beside it, not gated.

## Decision rule (locked)

**Validity (else VOID, not FAIL):** every item labelled by both judges, and the placebo P consensus HELPS rate at most 0.10. A judge that calls mismatched notes helpful is not measuring help.

Z1c **passes** only if all of these hold:
1. **Judge:** at least 30 eligible events; T's consensus HELPS rate at least 0.30; T minus C at least 0.15; and an exact one-sided sign test on the discordant events (T HELPS and C NO, against C HELPS and T NO) gives p below 0.05.
2. **Tokens:** mean tokens per hook prompt under Z1c at most 1.20 times A1's, over at least 200 hook prompts in the window. Tokens per hook prompt are as in Z1b (the A1 block at that prompt plus every Z1c block emitted before the next prompt). An interval opened by a prompt before the cutoff is not scored. The median and p90 are reported, not gated: an additive block always lifts a median that sits on a jump (Z1b result). **Provenance of 1.20:** set after the Z1b exploratory run measured 1.14 on the seen split, so it is not blind to that number; it is set as cost, not fit: about one extra memory bullet per hook prompt on average.
3. **Latency:** measured only if 1 and 2 pass, because it needs the hook code this prereg does not ship. The failure hook with recall (the `capture-error` path plus the block, FTS pre-select as in the Z1 prompt path) has a p95 under 0.28 s at 10,000 memories on this box. If the same hook without recall is already at 0.28 s or more, it must be within 10% of that instead.

Overlap (the SI0 lexical scorer) is reported for both arms and not gated: the Z1b query and the scored error text share words by construction.

**If 1 and 2 pass:** build the failure hook behind a flag, off by default, measure 3, and ship behind the flag only if 3 passes. Default-on needs TE5. **If either fails, or the run is VOID:** no hook code; the result doc ships.

## One command

`node scripts/z1c-eval.mjs --out <scratch dir>` collects the window, takes the store copies, runs the replay, and, when at least 30 eligible events exist, runs both judges and prints the verdict as aggregates. Under 30 it prints counts and stops. `--dry-run <n>` runs the whole pipeline on the first n eligible events to prove the wiring and prints counts and parse checks only, never a rate; its labels are discarded and the real run judges every item afresh.

## Checks before the scored run

- The replay's Z1b numbers on the frozen corpus are unchanged by this change (Z1b held-out final at the strictest grid point reproduces its result doc).
- Dataset audit, counts only: files collected and excluded (by reason), hook prompts and non-routine Bash failures in the window, memories created within 10 minutes before the failure they were recalled for.

## Amendment 1 (2026-09-27, before any fresh-window event was replayed or judged)

Found by the count-only dry run; no gate, threshold, prompt or window changed.

- **Exclusion scan.** The literal full-text `z1c` scan excluded 121 of 205 transcript files, because base64 thinking signatures and image data contain those three characters by chance. The scan now drops the `signature` and `data` string fields before matching and matches `z1c` as a whole token (case-insensitive, word boundaries). Paths and names such as `z1c-eval` or `feat/z1c-judge-gate` still match. At amendment time the window held 2 kept sessions and 0 eligible events.
- **Label parsing.** Sonnet answers the locked prompt by echoing each item's `### Item N` header with the label on the next line. The parser now accepts that form and `Item N: LABEL` as well as `N LABEL`. The prompt text is unchanged. Wiring was proven on 5 events from the retired Z1b held-out export (12 items, both judges labelled every item, no retries); no rate was computed.
- **Transport retries.** An Opus call in the dry run exited with an API safeguard error and no output. A judge or probe call that exits non-zero is re-sent, up to 3 attempts, before its output is read; this is separate from the single re-ask for missing labels. The isolation check now fails, before the marker, on a failed or empty probe, and compares heading text without the `#` marks.
- **Isolation probe wording.** The original probe ("list every heading in your context") drew the Opus safeguard refusal on every attempt. It now asks the judge to copy the headings of any project instruction files (such as a CLAUDE.md) loaded for it. Checked both ways: with `--safe-mode` both judges answer NONE; without it both return headings from the operator's CLAUDE.md, which would VOID the run.
- **Gate arithmetic.** Rates are compared as integer counts (for example `100 * (T - C) >= 15 * n`), so an exact boundary is not lost to floating-point rounding. Each judge's own rates, the replay aggregates and the raw labels are written beside the verdict.
- **Expected date.** The frozen corpus produced 68 eligible events under this configuration over about 25.5 days (about 2.7 a day). At that rate the window reaches 30 around 2026-10-08. The count is checked then, counts only.

## Amendment 2 (2026-10-03, before any fresh-window event was judged; no marker exists)

Found by a count-only dry run (`--dry-run 3`); no gate, threshold, prompt, judge or window start changed.

- **Headless sessions excluded.** The `eval-runs` path rule missed the 2026-09-28 TE5 pilot, which ran under `hippo-archive/te5-pilot/runs/...`: 80 of the 111 kept files were its scripted `claude -p` sessions, and 21 more held `claude -p` entries (scripted runs, and copies of interactive sessions later resumed headless). Any transcript with an entry whose `entrypoint` is `sdk-cli` is now excluded, wherever it ran, and counted as `headless`, after the staleness check so the count is the window's. Only `cli` and `sdk-cli` appear in the local transcripts. The `eval-runs` rule stays.
- **Counts after the change** (window 2026-09-26T23:00Z to 2026-10-03, 154 hours): 10 files kept, 101 headless, 5 non-routine Bash failures, 15 hook prompts, 0 eligible events. Before it: 111 kept, 21 failures, 0 eligible.
- **Expected date withdrawn.** The 2.7 a day rate came from a corpus that had not been checked for headless runs. At 0 eligible in 6.4 days the window will not reach 30 on organic use; it is checked by counts only, and scored only if it does.

## NOT DONE

- Whether the agent behaves differently. TE5 is the paired test.
- Failures of tools other than Bash.
- The hook implementation and its latency, until gates 1 and 2 pass.
