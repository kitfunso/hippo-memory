### Fixed

- **`hippo daily-runner` exits 1 when any workspace step fails.** It printed the failure count and exited 0, so a scheduler saw a clean run. The exit code is now 1 on a failed `learn` or `sleep` in any workspace, and 0 otherwise.
- **`hippo daily-runner` stops a child step that runs past 30 minutes.** One hung workspace used to stall every workspace after it. The step is stopped, counted as a failure and logged with the workspace and the reason; `HIPPO_DAILY_STEP_TIMEOUT_MS` changes the limit.
- **A stored JSON column that will not read now leaves a log line.** Handoff artifacts, constraints and evidence, incident links, audit metadata, dormant snapshots and working-memory metadata still read as empty, as before, but one `warn` names the table, row id and column (never the text). Handoff evidence of the wrong shape reads as none instead of being passed through.
- **`hippo import` warns when its embedding backfill fails.** The failure was dropped. The import still succeeds, and one `warn` gives the number of rows left without a vector and names `hippo embed`.
- **An MCP internal error logs its class and stack**, as a failed HTTP request already did.
- **The MCP stdio server refuses a frame over 1 MB.** A larger `Content-Length`, or a line that passes 1 MB with no newline, is answered with a JSON-RPC parse error and dropped without being buffered; the server keeps running. This is the cap `POST /mcp` already has.
- **`hippo serve` logs a request that is still unanswered after 60 seconds.** One `warn` gives the request id, route and elapsed time. The request is left to finish and its reply is unchanged. The server's request timeout is now set explicitly to Node's own default of 5 minutes.
- **A CLI command that fails under `HIPPO_LOG=debug` prints the error class and stack after the message.** At every other level the output is unchanged.
