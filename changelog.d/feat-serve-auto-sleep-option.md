### Added

- **`sleep`, `SleepOpts` and `SleepResult` are exported from the `hippo-memory` root.** An add-on can run the full sleep cycle (decay, consolidation, dedupe, graph refresh) in a process of its own, such as a nightly worker, without reaching into internal files.
- **`serve()` takes an `autoSleep` option; `false` stops MCP auto-sleep in that server process.** Remembers over `/mcp` no longer start a consolidation run past the config threshold, so the run can live in another process. Left unset, `hippo serve` and the stdio MCP server behave exactly as before.
