# Z1: recall against the prompt, gated

Roadmap Part XV, Z1. Prereg: `docs/evals/2026-09-26-z1-prompt-recall-prereg.md`.

## Problem

The `UserPromptSubmit` hook runs `hippo context --pinned-only --include-recent 5` and never reads the prompt. It injects the five newest memories whatever was asked. SI0 measured the effect: in-context memories share a median 0.057 token overlap with the work.

## Change

1. **`src/prompt-recall.ts` (new, pure).** `contentTokens(text)`: `tokenize` from `src/search.ts`, keep tokens longer than 2 chars that are not stop words (export `STOP_WORDS` from `src/audit.ts`), distinct. `gatePromptRecall(promptText, candidates, opts)`: truncates the prompt to 4,000 chars, scores each candidate by `jaccard` or `cosine` over content-token sets, keeps `score >= threshold && shared >= minShared`, sorts by score desc then id, returns the top `maxItems` with their scores. Also `promptRecallFtsQuery(promptText)`: the prompt's content tokens as an FTS pre-select query (capped at 32 terms).
2. **Config (`src/config.ts`).** `pinnedInject.promptRecall: { enabled, metric, threshold, minShared, maxItems, candidateLimit }`. Defaults come from the tuned configuration; `enabled` is true only if the prereg's three gates pass. Merge like the existing `pinnedInject` keys.
3. **`api.getContext` (`src/api.ts`).** New `ContextOpts.prompt?: string`. In the pinned-only branch, when `prompt` is non-empty and `promptRecall.enabled`: skip recent-N; load candidates with `loadSearchEntries(root, ftsQuery, candidateLimit, tenantId)` for local and global, filter them with the same `admit` plus the quality floor and not pinned, run the gate, admit the survivors within the budget left after the pin reserve. Mark them `category: 'prompt-recall'`-style so the CLI can render them apart (a new field `promptRecall?: boolean` on `ContextResultEntry`). No prompt, flag off, or any other caller: unchanged. Read-only, no trace, same as today.
4. **`cmdContext` (`src/cli.ts`).** Parse `payload.prompt` next to `session_id` and pass it as `opts.prompt`. In the `additional-context` branch, render the static block (snapshot, handoff, events, pins) exactly as today with the TE2 skip on surface `hook`, and the prompt-recall entries as a second `## Project Memory` section that is always sent when non-empty, recorded on a new ledger surface `hook_recall` (`TokenSurface` union and `TOKEN_SURFACES` in `src/token-ledger.ts`; no schema change). If the static block is skipped and the recall section is non-empty, emit only the recall section.
5. **No hook command change.** `hooks.ts` already pipes the payload to stdin.

## Critic revisions (round 1, these win over the items above)

- **Heading.** The recall section renders under its own heading, `## Prompt-Relevant Memory (N entries, T tokens)`, with T the sum of its own entries' tokens. `printContextMarkdown` gains an optional `heading` in its opts; the default keeps today's `Project Memory` text byte for byte. The static block keeps its own heading and total.
- **Config.** Flat keys on `pinnedInject` (`promptRecall`, `promptRecallMetric`, `promptRecallThreshold`, `promptRecallMinShared`, `promptRecallMaxItems`, `promptRecallCandidates`), so the existing one-level merge keeps every default under a partial override. Invalid values fall back to the default at the read site.
- **Loader.** Candidates come from `loadRecallSearchEntries(root, q, candidates, tenantId, undefined, 'exact', false)`: default-deny scope and superseded rows are filtered in SQL before the LIMIT, as recall does. Cross-project rows can still take window slots in the global store; `promptRecallCandidates` (default 100) bounds that and the latency bench measures its cost.
- **Empty prompt tokens.** No content tokens means no FTS call at all. Metrics return 0 on an empty set.
- **Connections.** Two extra opens per store are accepted for now; the latency gate decides. A shared connection is the fix if p95 misses.

## Eval tooling (aggregates only, no corpus text in the repo)

- `scripts/z1-replay.mjs`: implements the prereg arms A0, A1, Z1 over the frozen corpus and store copies, tune/held-out split, grid, pick rule, and prints aggregate JSON.
- `scripts/z1-latency.mjs`: the prereg latency bench against `dist/cli.js`.

## Tests (real DB, synthetic fixtures)

- `tests/prompt-recall.test.ts`: gate unit tests (threshold, minShared, maxItems, both metrics, truncation, stop words, empty prompt).
- `tests/pinned-inject.test.ts` / new `tests/context-prompt-recall.test.ts`: with a prompt and the flag on, a relevant memory is injected and a fresh irrelevant one is not; nothing clears the gate means pins only; flag off or no prompt means today's recent-5 output byte for byte.
- CLI: stdin payload with `prompt` goes through `hippo context --pinned-only --format additional-context`; the static block is skipped on the second identical call while a relevant recall section still emits; the ledger has a `hook_recall` row.

## Grill (self)

- **Weakest premise:** that error-text overlap is the right yardstick for a prompt-time recall. It is the only yardstick SI0 used and the task mandates it. Its weakness: the prompt is written before the error exists, so even perfect prompt recall may not raise it much. Answer: report it straight; a flat result is the finding.
- **Median tokens gate:** today's median per prompt may be near zero because TE2 skips unchanged blocks. Z1 then has to inject nothing on at least half the prompts. The pick rule enforces that on the tune split; it is the gate the task set, not one we bend.
- **Max-over-set bias:** a bigger `C(t)` scores higher by chance. The report includes median context size per arm, and the compaction-reset variant is primary.
- **Replay-hook gap:** FTS pre-select (limit 100 per store) could drop a candidate the replay keeps. Stated in the result; `candidateLimit` is config.
- **Long prompts:** pasted logs up to 94k chars. The 4,000-char cap bounds both latency and dilution; cosine is in the grid because Jaccard punishes long prompts.
- **Out of scope:** the author's box hook runs hippo without stdin, so it gets no Z1 until it passes the payload.
