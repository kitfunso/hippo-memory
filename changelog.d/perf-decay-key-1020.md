### Changed

- **Context reads past the cap no longer rank the whole tenant.** hippo.db moves to schema 60, which builds one index on the first open; `loadContextCandidates` reads the pinned rows and the rows within two half-lives of decay through it and returns the same rows in the same order, and a tenant with too few such rows is ranked as before.
