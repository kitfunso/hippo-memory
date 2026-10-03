### Added

- `serve()` accepts an optional `authResolver` that vouches for external bearer tokens before API-key validation; its answer is sanitised by the core (reserved subjects, empty tenant, and unknown roles are rejected or downgraded). The server is importable as `hippo-memory/server`.
- `listAuditEventsAfter` reads the audit log by id cursor, ascending, with an optional tenant filter. The audit and database open/close functions are exported from the main entry.
