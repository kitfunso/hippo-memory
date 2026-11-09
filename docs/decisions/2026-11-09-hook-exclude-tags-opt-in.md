# The prompt hook's tag exclusion ships opt-in, with no default list

Date: 2026-11-09
Status: accepted
Links: `changelog.d/feat-hook-exclude-tags.md`; `docs/plans/2026-11-09-hook-exclude-tags-plan.html`; `docs/evals/2026-11-08-z0-round3-lesson-reach.md`

## Context
The prompt hook block (`hippo context --pinned-only --include-recent 5 --format additional-context`) fills its recent and prompt-recall slots from every row in the store. In Z0 round 3, past-task summaries (`session-digest`), copies of Claude Code's own notes (`claude-code-memory`) and captured tool errors were most of A2's block text, and only 1% of its entries were a user's rule.

## Evidence
- Lesson reach read (`docs/evals/2026-11-08-z0-round3-lesson-reach.md`): over 162 A2 first applies, summaries and copied notes were 89% of the block text.
- Offline replay on copies of round 3's A2 pre-session stores, 81 sessions in the 35 final-read runs, no model calls. With no list, 63 of 76 renders matched round 3's recorded block exactly. With `["session-digest","claude-code-memory","auto-captured"]`, the memory sections fell from 512 to 113 tokens a session on average (78% less). At Opus 5.5 prices that is about $0.004 of a $0.26 session, about 1.5%.
- Round 3's cost read gives no cost win to build on: A2/A1 cost ratio 1.006 [0.964, 1.049], and cost per resolved task $0.365 for A2 against $0.368 for A1.

## Decision
- `pinnedInject.excludeTags` is a list in `.hippo/config.json`, default `[]`. An empty or absent list leaves every block byte-identical to before.
- The list applies on pinned-only reads only: the prompt hook, the server prompt-hook route and `hippo session-rules`. Recall and plain context do not change.
- Excluded rows never use up a window. Prompt recall cuts them in SQL before its 100-row limit. Pins and the recent rows go through the admission rule, and the store pages past the window until it has enough kept rows.
- The key is optional in the published `HippoConfig`, so a config built in code before the key existed still works.
- No default list. Z0 stage 4 allows a default change only after a Z0 arm shows a cost win, and the replay's 1.5% is inside round 3's cost interval.

## Consequences
- Derived rows keep their source tags, so a `session-digest` entry also drops DAG summaries and extracted facts built from digests.
- The delivery ledger logs a row the list removes as an admission or scope refusal.
- Tool failures carry `auto-captured`; a lesson a person saves with `--error` carries only `error`. A list meant to drop tool noise names `auto-captured`, never `error`.
- A Z0 arm can now run with the list. Whether a smaller block changes the pass rate or the turn count is not measured.
