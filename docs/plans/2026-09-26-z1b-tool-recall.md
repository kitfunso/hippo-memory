# Z1b: recall against the failing command, plus the Z1 latency fix

Roadmap Part XV, Z1 second arm. Prereg: `docs/evals/2026-09-26-z1b-tool-recall-prereg.md`.

## Steps

1. **Lock the prereg** (commit it before any Z1b score).
2. **Latency fix** (ships whatever the verdict):
   - `src/auth.ts`: `DUMMY_HASH` becomes a precomputed `scrypt$<salt>$<hash>` literal. The miss path still runs one scrypt per verify, so the timing test holds.
   - `src/store.ts`: an internal loader that takes an open `DatabaseSyncLike` and runs the same SQL as `loadRecallSearchEntries`; the exported function keeps its signature and calls it.
   - `src/api.ts` prompt path: open each store once, no `initStore`, reuse the connection for candidates.
   - `src/prompt-recall.ts`: `promptRecallFtsQuery` picks the K rarest terms by `fts5vocab` document count (K = 8), first-K fallback when the vocab table is not available.
   - Measure with `scripts/z1-latency.mjs` before and after.
3. **Replay:** extend `scripts/z1-replay.mjs` with the Z1b arm, the per-interval token accounting, the dataset audit counts, and a judge-item export to a path outside the repo.
4. **Run:** selftest, A0/A1 reproduction, grid on tune, final on held-out, judge once.
5. **If all gates pass:** `capture-error` emits a `PostToolUseFailure` `additionalContext` block behind a flag, off by default, excluding auto-captured memories; latency measured on that hook. Otherwise no hook code.
6. **Result doc** and ROADMAP Z1 update.

## Critic revisions (round 1, these win over the steps above)

- **Vocab source.** No migration. On the prompt path, per open store connection, `CREATE VIRTUAL TABLE IF NOT EXISTS temp.<name> USING fts5vocab(main, 'memories_fts', 'row')` (a temp table lives only on that connection), then one `SELECT term, doc ... WHERE term IN (...)`. The SQL lives in `src/store.ts`; `src/prompt-recall.ts` stays pure and takes a `docCount(term)` lookup. Terms with doc count 0 are dropped (they match nothing). Any throw (FTS off, vocab missing) falls back to the first 8 terms.
- **Per store.** Rarest terms are picked per connection: local and global get their own query string.
- **Connections.** Each store opens once in its own `try/finally`, so a failure in the global store cannot leak the local connection.
- **Dummy hash.** The literal keeps the 16-byte salt and 32-byte hash of `hashKey`'s format; a test asserts its shape so the miss path's scrypt cost stays that of a real key.
- **Tests.** Real DB, synthetic fixtures: the internal loader returns what `loadRecallSearchEntries` returns; rarest-K picks the lowest doc counts, drops zero counts, and falls back without FTS; prompt recall still admits a relevant memory and skips an irrelevant one. If Z1b passes, the flag-gated `capture-error` block gets its own tests (off by default emits nothing; on emits the block and never the memory it just captured).
- **Reproduction check.** The replay never touches the FTS pre-select: it scores every as-of candidate (Z1 prereg, "one deviation"). So the latency fix cannot move A0 or A1; the check must reproduce exactly (A0 0.055 over 182 events, A1's Z1-result numbers). Any change means the replay edit broke something, and it is fixed before the grid runs.
- **Judge run once.** Both arms face the same pass of the same judge, and the gate reads their difference; a second pass would add cost and a choice of which run counts.

## Grill (self)

- **Weakest premise:** that the judge is a fair stand-in for "helps". It is one Sonnet pass with a locked prompt and a blind control; it can be wrong, but both arms face the same judge, and T minus C is what the gate reads.
- **Circularity:** the overlap gate is near-certain to pass by construction; the prereg says so and adds the judge before any number exists.
- **Leak via fresh lessons:** a lesson the agent wrote minutes before the failure is legitimate recall, but it inflates the arm if the failure it describes is the same one. Counted and reported.
- **Median tokens:** Z1b adds tokens only on failure intervals, so its median can match A1's while the mean grows; the 1.10 mean bound caps that.
- **Latency on the failure hook:** `capture-error` already loads every entry for its repeat check; if its p95 is over 0.28 s before recall, the within-10% fallback applies and the result says the hook itself is slow.
