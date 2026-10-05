### Fixed

- **Sleep's graph refresh writes only what changed, in short steps.** It used to delete a tenant's graph and write it all again in one transaction, 2.1 to 3.0 s for 5,000 entities, long enough for a server write to answer 503. An unchanged graph now writes nothing, and a changed one commits in steps of about a tenth of a second. A run that is killed keeps the steps it finished, and the next run does the rest.

### Changed

- **Graph entities and relations keep their id and creation time across sleeps.** A renamed entity is updated in place, so the relations pointing at it stay. Graph reads list the newest first, so a new entity or relation now comes ahead of unchanged ones; before, every refresh gave every row a fresh creation time.
