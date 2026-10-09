### Tests

- **The two CLI recall tests that read `src/cli/recall.ts` as text now run the command.** `tests/cli-recall-anchoring.test.ts` and `tests/cli-recall-autodebias-zero-results.test.ts` call `cmdRecall` in process on a real store, through `retrieve` and the CLI ranking core, and assert what it prints: the `anchored_on` line and its place above the results, the JSON hint and interference count, the session id from flag or env, the per-tenant ring, and the planning-fallacy hint on a recall that matches nothing.
