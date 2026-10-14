### Changed

- **Internal:** the store is now built once, at the CLI, the server, stdio MCP and the sleep child, and handed down in the request context as `StoreContext`. `src/api` and `src/connectors` no longer build a store, and `scripts/check-layers.mjs` fails CI on a new runtime import of the SQLite adapter from `src/api`, `src/connectors` or `src/mcp`. The public `Context` and every published entry keep their shape.
