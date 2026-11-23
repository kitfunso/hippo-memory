# Pins leave a fixed share of the prompt hook budget to prompt recall

Date: 2026-11-23
Status: accepted
Links: PR #1309; `src/domain/context/select-policy.ts` (`pinsWithinCap`, `promptRecallShareOf`, `sessionRulesBudgetOf`); `src/api/context/context-select.ts` (`orderLikeRecall`); `src/surface/cli/session-rules.ts`

## Context

On a store with many pins, the prompt hook (`hippo context --pinned-only`) filled `pinnedInject.budget` with pins and printed no Prompt-Relevant Memory section. `hippo session-rules` printed every rule. The hook ordered prompt-matched rows by a Jaccard score, so short rows that matched a few words pushed out a long row that matched well.

## Constraints and evidence

- Replay on a copy of the DolphinBench Alex store, 200 prompts, no model calls: prompts with a Prompt-Relevant section went from 0 to 200, and recall's top 3 rows that reach the hook from 0 to 224 of 600.
- Share 0.33 gave 263 of 600, but on a real 14-pin store it dropped 2 pins. Share 0.25 kept all 14.
- At 0.25 the target row of DolphinBench test 001 (244 tokens) does not fit beside the top row in the recall room of about 375 tokens. The hook ranks it 3rd, so the cause is room, not order. At 0.33 it fits.
- The pinned block must stay byte-stable from prompt to prompt. `skipUnchanged` omits it only when its hash matches the last block sent (`src/api/prompt-hook.ts:294`).

## Decision

- When prompt recall is pending, pins get at most `budget - floor(budget * promptRecallShare)` tokens (`pinnedInject.promptRecallShare`, default 0.25). The cap reads only the budget and the share, never what recall used.
- Under the cap, the strongest pins stay, then the newest. A dropped pin gets a `budget` row in the delivery ledger.
- `hippo session-rules` prints the newest rules that fit `pinnedInject.sessionRulesBudget` (default 2,000 tokens) and one line that counts the rest.
- The hook orders the rows its gate clears with `rankBm25`, the ranker of `hippo recall`, and then cuts to `maxItems`.
- A blank prompt counts as a prompt with no matches (`context-plan.ts`, `promptRecallPending`): the same pins, no recent rows. A hook call with no prompt field keeps the recent rows.

## Alternatives considered

- Share 0.33: more recall rows (263 against 224 of 600), but it drops pins on a real store.
- Cap the pins by what recall used on this prompt: the pinned block can change on each prompt, so `skipUnchanged` stops skipping it.
- Keep the Jaccard order: it keeps the short-row bias that hid the long row.
- Key only the share on the prompt field: the pins hold on a blank prompt, but recent rows still enter the pinned block.

## Consequences

- A store whose pins use more than 75% of the budget now loses its weakest pins from the prompt hook. They stay in the store and in `hippo recall`.
- A user who wants more recall room sets `pinnedInject.promptRecallShare` higher.

## Reconsider when

- Pins get their own budget apart from `pinnedInject.budget`.
- A replay on more real stores shows that 0.25 drops pins or that a higher share keeps them all.
