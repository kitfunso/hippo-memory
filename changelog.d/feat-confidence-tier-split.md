### Fixed

- **Invalidating or superseding a memory again no longer halves its half-life again.** A re-scan of git history or a repeated `hippo invalidate` with the same pattern used to compound the half-life down to 1 day. Each cause now halves it once and repeating the act changes nothing more.
- **Rebuilding a store from its markdown mirror skips a file whose confidence is not verified, observed, inferred or stale.** The warning names the file, the row and the value, and the other files still load. Before, the unknown value went into the store as the memory's confidence. Fix or remove the line, then delete `hippo.db` to rebuild.
