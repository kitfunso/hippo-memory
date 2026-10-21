### Changed

- **Each composition root now builds the outside services and puts them in the Context, and the api no longer builds them itself.** The CLI, the stdio and HTTP MCP hosts, the server, the webhooks, the dashboard, the sleep child and the vault importer each set `ctx.infra`. The published entries fill it in when the caller leaves it out. A Context that reaches the api with no infra fails at once, with a message that names the fix.
- **The reranker registry is built once per root, not when the module loads.** The rerankers a recall names come from `ctx.infra.reranker`.
- **`src/index.ts` now re-exports named functions from `src/entry/` barrels.** The published names and signatures do not change. In `api/hippo-memory.api.txt`, `consolidate`, `createMemory` and `sleep` now show as re-exports.
- **`hippo doctor` and `hippo support-bundle` moved to `src/surface/cli/`.** Only the three package entries are still root files: `index.ts`, `server.ts` and `cli.ts`.

### Added

- **`hybridSearch`, `physicsSearch` and the search options take an optional `cwd`, which sets the path-tag boost.** The published entries still default to `process.cwd()`. `Machine` has an optional `cwd`, and `InfraPorts` has optional `reranker` and `transcriptCalls` members.
