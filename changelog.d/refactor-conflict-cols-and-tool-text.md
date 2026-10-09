### Fixed

- The `hippo_outcome` tool description, in the MCP server and the OpenClaw plugin, no longer states half-life changes (+5 days, -3 days) that the model does not make.

### Changed

- **Internal:** `memory_conflicts` reads in `src/store/conflicts.ts` share one column list, and the recall and context tool descriptions read their defaults from the code constants.
