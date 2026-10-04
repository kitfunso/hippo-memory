### Fixed

- **A held write lock no longer freezes `hippo serve`.** A request now waits at most 250 ms for the SQLite write lock, then gets a 503 with `Retry-After: 1`, so one long write elsewhere cannot stall every other request. The CLI and hooks keep their longer waits, and a `hippo remember` routed through the server retries the 503 for about 5 s, so it still rides out a sleep or consolidate run. Forget, archive and promote do not retry, because their 503 can follow a change that already committed.
- **`hippo serve` drains before it stops.** On shutdown it stops accepting, ends open streams, gives running requests up to 5 s (`shutdownDrainMs`) to finish, then closes the rest, and exits 1 when shutdown fails.
- **5xx log lines carry the error class and stack.** The client body is unchanged: the generic message plus the request id.
- **The stdio MCP server answers a malformed frame with a JSON-RPC `-32700` parse error** instead of dropping it silently. After an uncaught exception or unhandled rejection it logs the stack and exits 1, so the client restarts it instead of talking to a process in an unknown state.
- **Silent failures now log.** The LLM reranker checks the HTTP status and warns once per process when it falls back to the input order, as the Jev and CLEF rerankers do. FTS index write and delete failures, token-ledger write failures and an FTS search that falls back to LIKE for a reason other than query syntax each warn once.
- **A corrupt `workspaces.json` is moved aside** to `workspaces.json.corrupt-<timestamp>` with a warning, so the next registration cannot erase the entries in it.
- **Every git subprocess has a timeout,** and the auto-detected context query no longer picks up words from git warnings on stderr.
