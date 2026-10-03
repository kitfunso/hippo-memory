### Security

- **Context recall and CLI recall no longer write query text into the audit log.** Both stored the first 200 characters of the query; they now store `query_hash` and `query_length` like every other recall path, through one shared `auditQueryFields` helper in `src/audit.ts`. Rows written before this release keep their text; nothing rewrites them.
