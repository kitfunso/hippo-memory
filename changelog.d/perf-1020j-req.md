### Changed

- **Dashboard memory pages sort a list once per commit and read later pages from it.** The list sits in a TEMP table on the held reader, keyed by the query and the stamp's instant, so paging no longer re-sorts the project; the text filter and the age brush now run as native SQL on the rows that can match, with the JavaScript rules deciding only those rows.
