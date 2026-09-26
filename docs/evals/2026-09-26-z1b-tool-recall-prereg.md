# Z1b tool-output recall replay: pre-registration

**Date:** 2026-09-26. **Status:** LOCKED by the commit that adds this file. No Z1b configuration was scored before the lock.

Roadmap: Part XV, Z1, second arm. First arm: [prereg](2026-09-26-z1-prompt-recall-prereg.md), [result](2026-09-26-z1-prompt-recall-result.md) (FAIL on overlap and latency, shipped off).

## Question

Z1 gated the hook's recall on the user's prompt and did not move overlap (held-out 0.0545 against A1's 0.0545). Its result doc gives the reason: the signal events are failing Bash commands, and the prompt shares little vocabulary with the error. Z1b recalls against the failure itself: when a non-routine Bash command fails, recall against the command and its error text and inject what clears the gate next to the tool result. Does that put memories in front of the agent that help with the failure, without growing the tokens injected per prompt?

## Data, events and scorer

Unchanged from the Z1 prereg: the same frozen transcript corpus (135 session files), the same read-only store copies, the same as-of rule (a memory is visible at `t` only when `created < t`), the same SI0 signal events (repeat of a non-routine Bash error signature; first success of a command signature that failed earlier), the same `C(t)` rules (compaction reset primary, session lifetime secondary; fail-then-pass counts only ids that arrived between the failure and the success), the same `textOverlap` scorer against the error text, and the same split (`parseInt(sha256(basename).slice(0, 2), 16)` even means tune).

## Arms

| Arm | What goes into context |
|---|---|
| A0 | What the transcript shows, as in Z1. Reproduction check only. |
| A1 | Today's per-prompt hook, as in Z1. |
| Z1b | A1, plus a tool-failure block after every non-routine Bash failure. |

**The Z1b block**, simulated at each Bash `tool_result` with `is_error`, at that line's timestamp and `cwd`:
- Fires only on non-routine failures: SI0's routine filter as the replay already applies it (`capture-error` has the same rules; its extra `cd`-stripping only affects the query below).
- Query text: the command with a leading `cd ... &&` stripped, a newline, then the error text; first 4,000 characters; tokens by `contentTokens` from `src/prompt-recall.ts`.
- Candidates: as in Z1 (as-of, unpinned, not superseded, quality floor, local store plus global), minus memories tagged `auto-captured`. The live hook would capture the failure it is recalling for; that memory must never be recalled against itself.
- Gate: `gatePromptRecall` with the config under test.
- Budget: the survivors within 1,500 tokens.
- Skip: the block is not re-sent when its memory ids equal the last Z1b block sent in the session since the last compaction; resent after 10 consecutive skips (TE2's rule on its own state).
- Timing: the block enters context after the failure event is recorded, so it counts toward later repeats of that signature and toward the fail-then-pass window that opens at that failure.

## Why overlap alone cannot decide this arm

The Z1b query is built from the error text, and the SI0 score measures overlap with the error text. For a fail-then-pass event it is the same text; for a repeat it shares the 200-character error signature. A high Z1b overlap is therefore expected from construction and says little about whether the memories help. Overlap stays a gate (necessary), and a blind relevance judge is added (the sufficient part). This change is made here, before any Z1b number exists.

## Tokens

Tokens per hook prompt: the A1 block at that prompt plus every Z1b block emitted between that prompt and the next one, `estimateTokens` of the rendered text in the hook's bullet format. Reported: median, mean and p90 per arm, and the share of prompt intervals with a Z1b block.

## Split and tuning (locked)

- Grid: Z1's 40 configurations (metric jaccard at {0.04, 0.06, 0.08, 0.10, 0.12} or cosine at {0.10, 0.15, 0.20, 0.25, 0.30}; minShared {2, 3}; maxItems {3, 5}).
- Pick rule, tune split only: among configurations with median tokens per hook prompt no higher than A1's, mean tokens at most 1.10 times A1's, and at least 10 signal events where Z1b added a memory to `C(t)` that A1 did not have, take the highest primary overlap. Ties go to lower mean tokens, then the higher threshold. If none qualifies, the verdict is FAIL and the held-out split is scored once at the strictest grid point for the record.
- The held-out split is scored once with the picked configuration. The judge runs once, on held-out only.

## Decision rule (held-out, locked)

Z1b passes only if all four hold:
1. **Overlap (Z1's gate, unchanged):** primary overlap at least 0.114 and at least A1 + 0.05, with at least 15 signal events with a context.
2. **Relevance judge (new):** see below. Z1b's HELPS rate at least 0.30, at least 0.15 above the control's, over at least 15 eligible events. Under 15 eligible events is a FAIL, not a no-verdict.
3. **Tokens:** median tokens per hook prompt no higher than A1's, and mean at most 1.10 times A1's.
4. **Latency:** measured only if gates 1 to 3 pass. The failure hook with recall has a p95 under 0.28 s at 10,000 memories; if the same hook without recall is already at 0.28 s or more on this box, it must be within 10% of that instead.

**If all pass:** the hook output ships behind a flag, off by default; default-on is a follow-up that needs its own held-out win. **If any fail:** no Z1b hook code ships; the result doc and the latency fix below ship.

## Relevance judge (locked)

- **Eligible events:** held-out signal events (compaction-reset variant) where Z1b added at least one memory to `C(t)` that A1's `C(t)` lacks.
- **Item T:** the memories of the most recent Z1b block before the event, up to maxItems.
- **Item C (control):** the same number of the newest distinct memories A1 put in context in that session since the last compaction before the failure. An empty control is scored NO without judging.
- **Failure shown:** the failing command (first 500 characters) and its error (first 1,500 characters). Each memory at most 600 characters.
- Items are written to a private file outside the repo, shuffled with seed 20260926, with no arm label. One Sonnet sub-agent judges every item once. Nothing from the items is committed.
- **Prompt, verbatim:** "For each item you get a failed shell command, its error output, and a few notes from a memory store. Answer HELPS if at least one note contains specific information that would help an engineer fix or avoid this exact failure: its cause, a fix, the right command or flag, a path or naming rule, or a known gotcha that applies. Answer NO if the notes are only on the same topic, generic, or unrelated. Output one line per item: `<item id> HELPS` or `<item id> NO`."

## Latency fix (engineering, not gated)

The task also asks for the Z1 prompt path's extra 80 to 100 ms at 10,000 memories to be removed. Profiled before this prereg, on `scripts/z1-latency.mjs`'s store:
- The FTS pre-select ranks every matching row by BM25: 17 ms for the short prompt's 13 terms, 40 ms for the long prompt's 30.
- The prompt path opens each store twice more than the static path, plus a store-init cycle: about 20 ms.
- Both arms pay 22 ms at start-up for a scrypt hash computed at module load in `src/auth.ts`.

The fix: a precomputed constant for that hash; one DB connection per store on the prompt path; and the FTS query built from the 8 rarest prompt terms by FTS vocabulary document count (fewer rows to rank; 8 is a latency bound, not tuned). `scripts/z1-latency.mjs` is reported before and after, with the Z1 minus A1 delta, since the start-up fix lowers both.

## Checks before any Z1b number

- Selftest of the extended replay on synthetic data, counts only.
- A0 and A1 reproduce the Z1 prereg's numbers (A0 lifetime 0.055 over 182 events; A1 as in the Z1 result).
- Dataset audit, reported as counts: non-routine Bash failures per split, memories tagged `auto-captured` in the store copies, and the number of Z1b-recalled memories created within 10 minutes before the failure they were recalled for.

## NOT DONE

- Whether the agent behaves differently. TE5 is the paired test.
- Failures of tools other than Bash. SI0's events are Bash only.
