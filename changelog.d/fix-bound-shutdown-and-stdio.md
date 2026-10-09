### Fixed

- **`hippo serve` now always exits after a crash or a SIGTERM / SIGINT.** A store thread stuck in a long statement could keep a stopped server alive for ever, so a supervisor never restarted it. Shutdown now has a time limit: 10 s past the request drain window (15 s by default). At the limit the server logs one error line and ends with a failure exit.
- **A `hippo mcp` request over stdio now has the same deadline as an HTTP request.** A call that never finished left the client waiting with no reply. After 120 s (or `HIPPO_REQUEST_DEADLINE_MS`, where 0 turns it off) the client gets one JSON-RPC error with code -32001 that names the call, and a reply that arrives later is dropped.
