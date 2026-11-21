### Added

- **`serve()` takes a `projectWriteGate` that can refuse a write under a caller's project.** It is asked before `remember()` stores a row from POST /v1/memories or MCP `hippo_remember`, after the project name passes the usual check. A string answer refuses with 403 and that text. Add-on routes call `admitProjectWrite` from `hippo-memory/server`. `hippo-memory/project-identity` now exports `assertCallerProject`.
