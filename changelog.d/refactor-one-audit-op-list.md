### Changed

- **The list of audit ops now lives in one place, `AUDIT_OPS` in `src/audit.ts`.** The `AuditOp` type, `hippo audit list --op` and `GET /v1/audit?op=` all read it, so a new op can no longer be added to one list and forgotten in another. This changes no behaviour: the same 57 ops are accepted, in the same order in the CLI's error message.
