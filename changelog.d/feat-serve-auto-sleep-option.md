### Added

- **`sleep`, `SleepOpts` and `SleepResult` are exported from the `hippo-memory` root.** An add-on can run the sleep cycle `hippo sleep` runs, minus auto-learn (decay, consolidation, dedupe, graph refresh), in a process of its own, such as a nightly worker, without reaching into internal files.
- **`serve()` takes an `autoSleep` option; `false` stops MCP auto-sleep in that server process.** With `autoSleep: false`, remembers over `/mcp` never start a consolidation run past the config threshold, so the run can live in another process. `POST /v1/sleep` is unaffected. Left unset, `hippo serve` and the stdio MCP server behave exactly as before.
