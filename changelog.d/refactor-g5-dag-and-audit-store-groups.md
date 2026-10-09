### Changed

- **Session assembly and recall drill read through a store group.** `GET /v1/sessions/:id/assemble` and `GET /v1/recall/drill/:id` now read through the optional `dagReads` group of the store port, so a store other than hippo.db can serve them. Internal: replies, CLI output and SQL are unchanged.
