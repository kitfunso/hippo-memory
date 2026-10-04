### Changed

- **`src/mcp/server.ts` is split into modules under `src/mcp/`.** Tool definitions, the recall, write and admin tool handlers, request handling, per-process state, output formatting and the stdio transport each live in their own file, and `server.ts` stays the entry point and re-exports the same names. MCP tool names, schemas, output text and the stdio auto-start are unchanged.
