### Changed

- **The typed-object routes no longer run SQLite on the server thread.** The 38 `/v1` routes for decisions, incidents, processes, policies, skills, project briefs and customer notes now do their store work on the store worker threads, so a slow object query no longer stalls other requests. No API change: same status codes, bodies and audit rows.
