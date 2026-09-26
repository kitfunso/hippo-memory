### Added

- **Scope grants let a member API key read a restricted scope it is entitled to.** `hippo auth grant <key_id> <scope>` and `hippo auth ungrant <key_id> <scope>` add or remove one grant (admin only, same tenant, restricted scopes only, each one audited). A member key with a grant can name that scope over HTTP and MCP; without one it still gets 403. Schema v47 adds the `api_key_scope_grants` table.

### Security

- **Derived memories keep the scope of their sources.** Consolidation merges, DAG summaries and profiles, extracted facts, auto-promoted traces and supersede successors used to land with no scope, so text from a private channel reached every caller through default recall. They now carry the source's restricted scope, and a derived memory is never built from two different restricted scopes or from restricted and unrestricted sources together. Rows written before this release keep their old scope.
- **Project brief refresh no longer quotes private memories.** A brief has no scope and every key can list it, so receipts in a restricted scope are left out of the digest.
- **A private scope written in mixed case (`Slack:Private:C1`) is now hidden everywhere.** The SQL recall filter already hid it but the JS filter used by MCP recall did not, so it reached callers with no scope. Grants on revoked keys are refused.
