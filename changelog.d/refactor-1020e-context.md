### Changed

- **`POST /v1/outcome` with no ids lands on that client's own last recall.** It used the store's last recall, whichever client made it, so one caller's outcome could mark another caller's results. A client is its bearer token and its address, and a client with no recall gets `{ "applied": 0, "ids": [] }`. The REST outcome no longer links the recall trace; `hippo outcome` still does. See `docs/UPGRADING-3.0.md`.
- **A REST remember can start an automatic sleep, as an MCP remember does.** With `autoSleep.enabled` in `config.json`, a host-tenant write through `POST /v1/memories` or a connector webhook that reaches the threshold starts the background sleep. `serve({ autoSleep: false })` turns it off for every surface. A served store that is not hippo.db starts none, and `stop()` now waits for a running automatic sleep to end, so its child never holds the store after `stop()` returns. `/health` reports `auto_sleeps`, the count this server started.
- **Each server, stdio MCP host and CLI command keeps its own recall state.** The anchoring rings and the ids each client was last shown lived in module globals that every server in a process shared. They now sit on the `Context` (`callers`), so two servers in one process never mix them.
- **`HIPPO_LOSS_AVERSION_RATIO` and the CLEF settings are read where a process starts.** The CLI, `serve()`, the stdio MCP host, the sleep child and `hippo dashboard` read them and pass them down; nothing caches them in a module. The dashboard now scores strength by the ratio too. A library caller passes `{ lossAversionRatio }` to `sqliteStore`. See `docs/UPGRADING-3.0.md`.

### Fixed

- **A process that makes a store forgets the project names it worked out.** A folder's project name was kept for the life of the process, so a long-lived process that had already resolved a git worktree and then ran `hippo init` there handed the main checkout's global rows to the new store.

### Removed

- **The nine reset and probe helpers on `hippo-memory/testing`.** No module keeps the state they reset, so `hippo-memory/testing` holds the eval kit alone. `docs/UPGRADING-3.0.md` names what a test does instead.
