### Changed

- **`hippo recall` and `hippo explain` now rank and record through `retrieve()`, the entry HTTP and MCP already use.** The CLI kept its own copy of the recall steps (rank, audit, strengthen, trace, stats, token ledger), so a fix to one surface could miss another. Its ranker is now a named option of the shared entry, and output is unchanged: every recall golden matches byte for byte.
- **A `hippo recall` whose audit rows cannot be written no longer strengthens, traces or counts that recall.** It still prints its result and logs `audit write failed`. Before, the CLI wrote each audit row on its own and carried on, so a refused row left a half-recorded recall; HTTP and MCP already recorded all or nothing.
- **A failed token ledger write on `hippo recall` is now logged.** It was silent unless the store was busy.

### Tests

- **A CI check keeps recall ranking and recording out of `src/cli/`.** `scripts/check-cli-recall-writes.mjs` fails when a CLI file names the ranking core or a recall writer, so the surfaces cannot drift apart again.
