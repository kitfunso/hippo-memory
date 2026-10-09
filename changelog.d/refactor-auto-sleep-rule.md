### Changed

- **Internal: the auto-sleep rule lives in `src/api/auto-sleep.ts`.** The MCP remember tool and the session-close hook now call one module for when a write starts a sleep. No behaviour change.
