### Fixed

- **A caught error keeps its class, cause and errno in the log.** No `catch` in `src` swallows an error it did not name: a best-effort probe goes through one named helper, and a failed `res.end()` is logged once per request. A stored JSON column or a pidfile that does not parse is read through a shape check, not a cast.

### Changed

- **A no-query context read pages the strongest rows its budget can pay for, not up to 2000 per store.** At 10,000 memories in each of two stores it reads about 700 rows instead of about 4,100, and the churn pass reads good-outcome times from a time range instead of a tenant's whole audit history. The graph viewer's layout looks at the nodes near each node, not every pair, so a 500-node graph needs about 17 times fewer pair visits.
