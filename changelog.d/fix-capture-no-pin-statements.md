### Fixed

- **A plain statement in a later turn no longer pins as your rule.** Since 3.2.0, capture pinned any later statement of 4 or more words with a limiting word such as "not" or "stop", or of 2 or more words that named code. A replay of 27 real sessions pinned 83 rows, among them "Don't worry about it" and "stop, delete everything related to this project". These rows printed under `## Rules from the user` in later sessions. Such a statement is now an unpinned note. It stays out of `hippo context`, sleep merges and sharing to the global store. Only a matching prompt or `hippo recall` brings it back. A later turn pins only with a rule word, or with a preference word that names code or limits a choice. The same replay now pins 6 rows.
- **Secret scrubbing now masks Cloudflare tokens.** Tokens that start with `cfk_`, `cfut_`, `cfat_` or `cfoat_` were stored as typed.

### Added

- **`scripts/capture-replay.mjs`** replays session transcripts through capture in a throwaway store and prints what would pin.

### Known limitations

- A later correction with no rule word, such as "No: run the tests with X, not Y", no longer pins. It reaches a later session only when a prompt matches it, or as a rule when you turn on `capture.followUpRules`.
- A one-off note can still print under `## Prompt-Relevant Memory` when a prompt matches it, marked as a past observation.
- A later turn with a rule word, or a preference such as "Skip the review before you merge this one", can still pin a one-off order. Most of the 6 rows in that replay are not lasting rules.
- Rows that 3.2.0 to 3.3.1 pinned stay pinned until `hippo forget`.
