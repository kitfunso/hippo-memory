### Tests

- **The token-eval harness tests run in their own workflow, off the per-PR suite.** The 11 `tests/token-eval*` files test the research harness (a stand-in for Claude Code, real git, the hooks and the ledger), not what a user runs, and took about a quarter of the Windows test time. `npm test`, the CI shards and the pre-publish gate now skip them; `npm run test:eval` runs them, and `token-eval.yml` runs it on Linux and Windows on every push to master and on PRs that touch the harness.
