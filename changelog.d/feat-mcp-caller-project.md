### Added

- **MCP over HTTP on a shared store carries the caller's project.** A client sends `X-Hippo-Project` and an optional comma-separated `X-Hippo-Project-Aliases`, each name percent-encoded. `hippo_remember` stamps that project on the row. Recall, assemble, drill, context and conflicts show only that project's rows and user-global ones, including the embedding and overflow summary paths. `hippo_outcome` rates only the recall made under that project, even when two repos share one key. A header sent twice, aliases with no project, a bad name or a bad percent escape gets 400. Other stores ignore both headers.
- **Every `/mcp` reply carries `X-Hippo-Project-Scoped: 1`,** errors included, so a client can tell this server reads the project headers. `hippo-memory/project-identity` exports the header name as `MCP_PROJECT_SCOPED_HEADER` and the alias cap as `MAX_PROJECT_ALIASES`; `hippo_peers` is now off on a shared store (see Changed).

### Changed

- **MCP tools on a shared store refuse a caller with no project.** Every tool returns an `isError` reply that names the header, except `hippo_predict_baserate`. `hippo_learn`, `hippo_share`, `hippo_resolve` and `hippo_peers` are off on a shared store, since they read the server's git history, copy into its global store, tombstone across every project, or list the server's own global store instead of the repos that share this one. Stdio MCP is unchanged.
- **`hippo_context` on a shared store now answers a caller that names its project.** It returns that project's rows with no query, since the server's git state belongs to no caller. Before, it always refused on a shared store.
