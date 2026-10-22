### Changed

- **Dashboard memory pages sort a list once per commit and read later pages from it.** The list sits in a TEMP table on the held reader, keyed by the query and the stamp's instant, so paging no longer re-sorts the project; the text filter and the age brush now run as native SQL on the rows that can match, with the JavaScript rules deciding only those rows.
- **A store reopened inside one request asks once whether it holds a memory, for both setup steps.** contextGet in a hook scope now runs 45 statements, not 51, and the request-path gate measures it inside that scope with every ceiling back at 1.3 times the work.
