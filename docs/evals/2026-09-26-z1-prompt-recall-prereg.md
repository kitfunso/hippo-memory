# Z1 prompt recall replay: pre-registration

**Date:** 2026-09-26. **Status:** LOCKED by the commit that adds this file. No Z1 configuration was scored before the lock. Run before the lock: the A0 reproduction check only (below), which touches no Z1 setting.

Roadmap: Part XV, Z1 "Recall against the prompt, gated", and the TE6 cheap first test.

## Question

The `UserPromptSubmit` hook today injects pinned rules plus the five newest memories, whatever was asked (`hippo context --pinned-only --include-recent 5`). The SI0 kill test measured the result: the memories in context had a median token overlap of 0.057 with the error text of the work they were meant to help. Z1 reads the prompt from the hook payload, recalls against it, and injects nothing when nothing clears a relevance gate. Pinned rules stay. Does Z1 raise overlap with the work well above 0.057, without growing the median tokens injected per prompt?

## Data (real, private, read-only)

- **Transcripts:** the frozen SI0 corpus, `hippo-archive/transcripts-since-2026-09-01/` (135 Claude Code session files, outside the repo). Nothing from it is committed; the result reports aggregates only.
- **Stores:** read-only copies, taken 2026-09-26, of the global store (2,216 memories) and of every project store a hook prompt's `cwd` resolves to: seven project stores holding 178 to 723 memories each (3,372 in total). A prompt's local store is the nearest ancestor `.hippo` of its recorded `cwd`; when that is the home directory, the local store is the global one and it is loaded once. The project name for the origin partition comes from `resolveProjectIdentity(cwd)`, as the hook computes it.
- **Not replayable, left out of both arms:** the active-task snapshot, session handoff and session-event lines of the hook block. They are the same for A1 and Z1.
- **Store as of `t`:** a prompt at time `t` sees only memories with `created < t`. Memories deleted or merged since then are gone and cannot be replayed (limit, stated in the result). Pinned and superseded flags are today's (limit).

## Events and the scorer (SI0's, unchanged)

Reused from the SI0 probe (`docs/plans/2026-09-24-si0-automatic-outcomes.md` on `feat/si0-auto-outcomes`, Finding 5), byte for byte where code: the Bash `tool_use`/`tool_result` pairing, the routine-failure filter, the error signature, and the two signal kinds.

- **Signal events (primary):** a repeat of a non-routine Bash error signature in the same session, and the first success of a command signature that failed earlier in the session.
- **Context `C(t)`:** every memory id the arm put in context since the last `compact_boundary` before the event. For a fail-then-pass event, only ids that arrived between the failure and the success count, as in SI0. For A0, the arm's exposures are everything SI0 counted (every hippo hook block and agent `hippo recall`/`context` result). For A1 and Z1, they are only the per-prompt hook's injections, so the two arms differ in nothing else.
- **Variants:** SI0 published 0.057 from its session-lifetime run (no reset at compaction). The primary here is the compaction-reset context above; the session-lifetime variant is reported beside it, and the A0 reproduction check reads the lifetime variant against 0.057. The median context size per arm is reported too, because a max over a bigger set scores higher for no other reason.
- **Score of an event:** `max over m in C(t) of textOverlap(m.content, errorText)`, with `textOverlap` from `src/search.ts` (token Jaccard). The error text is the failure's output, as in SI0.
- **Overlap (primary metric):** the median score over signal events whose `C(t)` is not empty. This is the statistic SI0 reported as 0.057.
- **Secondary:** the same score over every non-routine Bash error event, not only signals. It has more events and the same scorer.
- **Also reported:** events with a context, and events scoring at least 0.2 (SI0's write bar).

## Arms

Every arm is evaluated at each prompt that fired the `UserPromptSubmit` hook (a user message followed by that hook's attachment).

| Arm | What goes into context at a prompt |
|---|---|
| A0, actual | What the transcript shows was injected (the author's box hook), mapped to ids exactly as SI0 mapped them. Used only to check the replay reproduces SI0. |
| A1, today | The shipped hook, simulated as of `t`: pinned memories plus the 5 newest memories that pass the quality floor (`isContentWorthStoring`), under the 1,500-token budget with pins reserved first. |
| Z1 | Pinned memories as in A1, plus the memories that clear the gate for this prompt. No recent-N. |

**The Z1 gate** (`src/prompt-recall.ts`, the same function the hook calls):
- Prompt text: the first 4,000 characters (fixed, for latency; not tuned).
- Tokens: `tokenize` from `src/search.ts`, keeping tokens longer than 2 characters that are not in the stop-word list of `src/audit.ts`. Distinct tokens only.
- Candidates: unpinned, not superseded, as-of memories that pass the quality floor. The hook pre-selects them with the store's FTS5 index (up to 100 per store, BM25 order, superseded and denied scopes filtered before the limit); the replay scores every as-of candidate instead. That is the one deviation between replay and hook, stated in the result.
- Score: `jaccard = shared / (|M| + |P| - shared)` or `cosine = shared / sqrt(|M| * |P|)` over those token sets.
- A memory is injected when `score >= threshold` and `shared >= minShared`; the top `maxItems` by score (ties by id) go in, within the budget left after pins.

## Tokens (the second gate)

Tokens per hook prompt = what the hook would emit to the model at that prompt, `estimateTokens` (characters / 4) of the rendered text, after each arm's own skip rule. The replay renders each block in the hook's own bullet format (`printContextMarkdown`, observe framing, no strength), with the confidence label fixed at `[observed]` (a few characters of error per bullet, the same in both arms). The skip hash is over that rendered text.
- A1: TE2 as shipped. The block is skipped when it equals the session's last injected block, resent after 10 consecutive skips, and always sent after a compaction.
- Z1: the pinned block follows the same TE2 rule; the prompt-recall section is sent whenever it is not empty and is never skipped.
- A0: the length of the `## Project Memory` block in the attachment, for reference only.

Reported per arm: median and mean tokens per hook prompt, p90, and the share of prompts where Z1 injected no recalled memory.

## Split and tuning (locked)

- **Split:** by transcript file. A file is in **tune** when `parseInt(sha256(basename).slice(0, 2), 16)` is even, else **held-out**.
- **Grid (40 configurations):** metric in {jaccard, cosine}; threshold in {0.04, 0.06, 0.08, 0.10, 0.12} for jaccard and {0.10, 0.15, 0.20, 0.25, 0.30} for cosine; minShared in {2, 3}; maxItems in {3, 5}.
- **Pick rule, tune split only:** among configurations whose median tokens per hook prompt are no higher than A1's and that leave at least 10 signal events with a context, take the highest primary overlap. Ties go to lower mean tokens, then to the higher threshold. If none qualifies, the verdict is FAIL with no held-out run of a tuned config; the held-out split is then scored once at the grid's strictest point for the record.
- The held-out split is scored once, with the picked configuration. No re-tuning after it is seen.

## Decision rule (held-out split, locked)

Z1 **ships as the default** only if all three hold:
1. **Overlap:** Z1's primary overlap is at least 0.114 (twice SI0's 0.057) and at least 0.05 above A1's on the same events. Guard: at least 15 signal events with a context under Z1. If the guard fails, no verdict on the primary; the secondary metric is judged with the same two bars and the result says so.
2. **Tokens:** Z1's median tokens per hook prompt are no higher than A1's.
3. **Latency:** Z1's hook p95 is under 0.28 s in a store of 10,000 memories (below).

If any gate fails, Z1 ships behind `pinnedInject.promptRecall`, off by default, with the result doc, and the PR says so.

## Latency (locked)

`scripts/z1-latency.mjs` seeds a temporary store with 10,000 synthetic memories of about 180 characters plus 5 pins, then runs the built CLI exactly as the hook does (`hippo context --pinned-only --include-recent 5 --format additional-context`, the payload on stdin, a fresh session id per run so the skip never fires). 30 timed runs per arm and prompt, after 3 warm-up runs, for a short prompt (about 135 characters, the corpus median) and a long one (over 4,000 characters). Wall clock includes Node start-up, as the hook pays it. The gate reads Z1's p95 on the short and long prompts.

The 0.28 s figure was measured on the sandbox, not this box. If today's hook (A1) itself has a p95 of 0.28 s or more on this box, the absolute bar cannot separate the arms; the gate then reads "Z1's p95 is within 10% of A1's on the same box", and the result says the absolute bar was not met by either.

## Reproduction check before the lock

A0 must reproduce SI0: a median near 0.057 on signal events with a context, across both splits. If it is off by more than 0.02, fix the replay before the lock, not after.

**Result (run before the lock):** A0 session-lifetime median 0.055 over 182 signal events with a context (196 signal events, 135 transcripts), against SI0's 0.057. Within tolerance, so the replay stands. For reference, A1's median is 796 tokens per hook prompt over 3,288 hook prompts; the token gate is judged against A1 on the held-out split.

## NOT DONE

- Whether any of this changes what the agent does. TE5 (paired A/B) is the claim; this replay is the cheap check.
- Embedding or Jev relevance. A threshold is the first arm, as TE6 proposed; a Jev yes/no judgment is the next arm only if this one fails on overlap.
- In-session dedupe of recalled memories across prompts. The mean tokens show whether it is needed.
- The author's own box hook (`hippo_context_cached.py`) runs hippo without the payload, so it would not get Z1 until it passes stdin through.
