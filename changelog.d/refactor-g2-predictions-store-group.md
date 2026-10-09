### Changed

- **The five `/v1/predictions` routes run on a new optional `predictions` store group.** A served store that has the group answers them; one without it answers 501 after auth. The baserate arithmetic is one pure function, `predictionBaserateOf`, that any store calls on its own rows. A prediction's mirror memory now goes in through the tenant-checked entry write, which refuses an id another tenant holds; mirror ids are random, so no caller reaches that. Internal only, no runtime behaviour changes.
