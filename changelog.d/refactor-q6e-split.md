### Changed

- **The HTTP server code is split into modules under `src/server/`.** `src/server.ts` keeps `serve()`, the /v1 route table and the request dispatcher; auth, request plumbing, validation, the MCP transport, shutdown and the route handlers (one file per domain under `src/server/routes/`) moved out unchanged. `hippo-memory/server` exports the same names as before, and server behaviour is unchanged.
