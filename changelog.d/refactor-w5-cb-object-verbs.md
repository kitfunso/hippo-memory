### Fixed

- **`hippo process new` and `hippo process supersede` report a refused save like every other kind.** A save the store refuses (an empty step, a superseded predecessor) now prints the store's message alone and exits 1, as brief, note, policy and skill already did, instead of escaping as an uncaught `Error: ...`.

### Changed

- **Internal:** brief, note, policy, process and skill share one CLI handler set driven by a per-kind descriptor (`src/cli/versioned-verbs.ts`); notes, the entity graph, predictions and incidents moved to their own CLI files.
