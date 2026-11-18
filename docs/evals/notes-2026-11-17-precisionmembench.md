# Dated notes, 2026-11-17: PrecisionMemBench through its own external-provider harness

Post hoc and secondary, like lanes F and D (prereg Amendment 6, dated notes 30 and 31). No registered result changes.

**Why.** PrecisionMemBench (arXiv 2605.11325) scores the belief ids a memory returns: 77 single-turn cases and 12 session turns over a 35-belief seed. A case passes only if every required id is in and every prohibited id is out. There is no answer model and no judge. The README publishes rows for Tenure and twelve comparison configurations (Tenure, Open Knowledge Format, AtomicMemory, Supermemory, YourMemory, a vector baseline, Gbrain, Hindsight, Zep, AgentMemory, Cognee, Mem0, A-MEM). A provider joins by a thin HTTP wrapper and one `providers.config.json` entry. Keith (17 Nov): every public benchmark runs in its published setup.

**Published rows.** Two sets. The README at `61a712a1` holds rows made after the adapter fix of 16 Sep ("Send all scopes to providers & exclude open questions (#18)"); this lane runs that harness, so those rows are the comparison. The paper (arXiv v4, 29 Jul) and the HF leaderboard (`tenurehq/precisionmembench` at `bf1a508a`, saved to `~/hippo-bench/datasets/precisionmembench/`) hold the older rows; they are listed, not compared. Every README cell regenerates from its committed report in `test-results/baseline/` through `pmb_hippo.py score` (the score file prints them).

**What changes.**
1. Code. `precisionmembench/pmb_hippo.py` runs `tenurehq/precisionMemBench` at `61a712a1` from a checkout beside the results (`results-r2/precisionmembench/harness`), so the clone in `~/hippo-bench/vendor/precisionMemBench` stays pristine. Both are checked against 13 pinned blobs. The checkout's `providers.config.json` is the pinned file plus one `hippo` entry: `seedDelayMs` 200 (the shortest a shipped entry uses), `beliefToText` `canonical_name_aliases` (every shipped entry), `supportsUpdate` false (as mem0 and zep). Dependencies come from the pinned `package-lock.json` (`npm ci`).
2. Commands. The README's two: `ava src/retrieval.external.eval.test.ts --timeout 10m` with `RESEED=true`, then `ava src/session-retrieval.external.eval.test.ts --timeout 10m` on the seeded state.
3. Provider. The contract's three calls over one hippo-mem0-server on a scratch data dir (never `~/.hippo`). `/add` stores the harness's text as one memory and keeps `metadata.beliefId` by the memory's id. `/search` returns hippo's top `limit` (20, `DEFAULT_BUDGET.maxBeliefs`) as belief ids, the first hit of each belief, as the mem0 wrapper does. `scope` is not used, as the mem0 and zep wrappers do not use it. `/reset` deletes every user's store. Each call is logged to `provider.jsonl`.
4. Windows. `baseAdapter.ts` resolves `new URL(".", import.meta.url).pathname`, which is `/C:/...` on Windows, so node reads `C:\C:\...` and fails. `winpath.mjs`, preloaded through `NODE_OPTIONS` on Windows only, drops that one leading slash before `path.resolve`; the harness then reads the file it reads on POSIX. No harness file changes.
5. Arm `hippo-emb`, server flags of dated notes 5. The run stops if hippo logs a search on BM25 alone.
6. Score. The harness's own reports, copied to `results-r2/precisionmembench/<arm>/`. Active passes are out of 43 (the paper: "43 active, 25 structural, and 9 trivially empty cases").

**Deviations that stay.**
- Embedder. Where the harness picked an embedder (mem0, the vector baseline) it used mxbai-embed-large; hippo uses its own `all-MiniLM-L6-v2`, as each product in the table uses its own.
- Dates. The harness sends no dates, so hippo dates each belief by the wall clock at seeding.
- Latency and ingestion times are this box's, under another session's load.

**Order.** `run --smoke` (single-turn cases below only, after a full seed), then `run`, then `score`.
Smoke items, excluded: `happy-stack-repository-layer`, `canonical-name-match-mara`, `cap-stress-kitchen-sink-exceeds-twelve`, `recency-tiebreak-reinforcement` and `relation-does-not-appear-as-entity`. They are single-turn cases 0, 19, 38, 57 and 76.

**Tests.** `tests/test_precisionmembench.py`. They fail if the pin or the hippo entry moves, if the smoke cases stop being the fixture's cases 0, 19, 38, 57 and 76, or if the provider stops returning each belief id once or stops resetting every user.

**Read before this note.** At `61a712a1`: `README.md`, `SUBMITTING.md`, `providers.config.json`, `src/adapters/baseAdapter.ts`, `universalSessionAdapter.ts`, both external eval tests, `src/utils/buildRetrievalReport.ts`, the mem0, supermemory, hindsight, zep, yourmemory and atomicmemory wrappers. The paper's Evaluation section and Tables 1, 3, 4 and 5 (arXiv v4 PDF, read 17 Nov).
