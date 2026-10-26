### Changed

- **A hippo.db open takes a grant only the SQLite adapter mints, and each request hands its store session and abort signal on explicitly: `AddonRoute.loop` is gone and `Context.signal` is new.** See `docs/UPGRADING-3.0.md`.
