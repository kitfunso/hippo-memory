### Changed

- **Internal: the graph route runs through a store group.** `GET /v1/graph` reads its entities and relations through an optional `graphReads` group on the store port, so a server on another store can answer it. No behaviour changes on hippo.db.
