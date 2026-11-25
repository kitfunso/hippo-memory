### Fixed

- **The local key keeps its flag on HTTP MCP.** A write that the server's own CLI key makes over `/mcp` now reaches the project write gate with `Actor.localKey` set, and the write screen treats it as the operator's write, as it does on REST. Before, `mcpContextFor` and `mcpActor` dropped the flag, so instruction-like text from the local key into a shared scope was held for review over MCP and kept over REST.
