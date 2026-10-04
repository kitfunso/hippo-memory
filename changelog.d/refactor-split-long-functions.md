### Changed

- **Five long functions are now split into named stages.** `consolidate`, the MCP `executeTool`, `importVault`, `installJsonHooks` and the HTTP `handleRequest` each call short stage helpers in the same file, and `executeTool` dispatches through a per-tool handler table. Behaviour is unchanged, pinned by new characterization tests of sleep results, MCP tool text, hook settings and HTTP status codes.
