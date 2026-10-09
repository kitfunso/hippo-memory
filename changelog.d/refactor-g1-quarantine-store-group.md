### Changed

- **Internal: the three quarantine routes run through a store group.** `GET /v1/quarantine` and the approve and reject routes read and write through an optional `quarantine` group on the store port, so a server on another store can answer them. No behaviour changes on hippo.db.
