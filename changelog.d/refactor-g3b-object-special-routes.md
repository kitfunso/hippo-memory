### Changed

- **The remaining typed-object routes run through the store group.** Incident open and resolve, the policies as-of read, the skills export and the project-brief refresh reach hippo.db through the `objects` store group, so every object route answers from a served store. Internal: no response, audit row or CLI output changes.
