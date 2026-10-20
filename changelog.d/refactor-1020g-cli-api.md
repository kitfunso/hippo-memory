### Changed

- **MCP tools cap string arguments at the HTTP routes' limits.** A `hippo_remember` text over the HTTP body cap, or a tag, id, session id, summary id, scope, class tag or `keep` id over 256 characters, now gets the same "exceeds N-character cap" error the HTTP API returns, and nothing is written. A conflict-resolve reason caps at 4096 characters.
- **Internal:** CLI and MCP commands reach business logic through `src/api` only. `scripts/check-layers.mjs` now fails a runtime import from `src/surface/cli` or `src/surface/mcp` into `src/domain` unless `.surface-domain-pending.json` lists the file.
