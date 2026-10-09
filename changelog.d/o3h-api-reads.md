### Changed

- Internal: the token and failure summaries and the dormant list, restore, forget and check no longer open hippo.db from the API modules; store modules open it, and a restore still commits on a single handle and write scope.
