### Changed

- **Auto-share and churn checks read only the rows that can matter.** At the default share bar, `autoShare` reads rows with a transferable tag, a never-share tag or source, three or more retrievals, a pin or a negative valence; churn reads only the project's current rows.
- **The dashboard checks one vector, not the whole vector table, on a detail read.** The snapshot build reads only its tenant's vector ids.
- **Duplicate cleanup after a conflict streams the tenant instead of loading it.**
- **Schema v56 adds list indexes.** The seven object tables gain `(tenant_id, status, created_at DESC, id DESC)` indexes, and `memories` gains `(source, tenant_id, created, id)`, so status pages and per-source reads skip the sort.
- **`hippo session end` no longer adds a process exit listener per session in a long-lived host.**
