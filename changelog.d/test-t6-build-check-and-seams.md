### Changed

- **`HIPPO_TEST_DELIVERY_FAULT` and `HIPPO_FORCE_LIKE_PATH` are no longer read.** Both were test switches that a shipped CLI or server picked up from its environment. Tests now set them through an in-process hook, so nothing in the environment can inject a delivery ledger fault or reroute a search.

### Tests

- **One build check for the whole suite.** A vitest global setup stops the run with `dist is older than src/<file>. Run npm run build` when any source file is newer than its build output, so no test that spawns the CLI can pass against old code. The three per-file copies of that check are gone.
- **Token-eval tests run on every pull request that touches `src/`.** They ran only when the harness itself changed, so a src change could break them and show only after merge.
- **The two tests that never ran in CI now run or are gone.** The always-skipped p99 plumbing test is deleted (the CI benchmark `benchmarks/a1/p99-recall.ts` covers it), and the LongMemEval harness test now seeds its own store instead of skipping on every clean checkout.
