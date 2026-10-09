### Changed

- Internal: `hippo doctor`'s database checks, `hippo support-bundle`, the dashboard snapshot service and `hippo audit prune` no longer open hippo.db themselves; the data layer opens it and hands back plain data. No output or behaviour changes.
