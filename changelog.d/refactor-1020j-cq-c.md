### Fixed

- **memoryStore refuses a raw-row forget with the same error class as hippo.db.** The in-memory store from `hippo-memory/store-kit` threw a plain `Error` where hippo.db throws `RawAppendOnlyError`, so the CLI and dashboard checks for that class missed it. Both stores now throw `RawAppendOnlyError` with the message `raw is append-only`.

### Changed

- **Both store adapters take each shared rule from one module.** Token surfaces, prediction class resolution, the session-end handoff, the status tally, goal, card, key and continuity checks, typed-object audit rows, row windows and the full-text phrase rule now live once in `src/store/rules`, so the SQLite and in-memory stores cannot drift apart on them.
