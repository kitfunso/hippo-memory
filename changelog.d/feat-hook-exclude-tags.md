### Added

- **`pinnedInject.excludeTags` leaves tagged rows out of the hook block.** `{"pinnedInject":{"excludeTags":["session-digest"]}}` in `.hippo/config.json` drops every row carrying a listed tag from the pinned-only reads: pins, the recent-N backfill, prompt recall and `hippo session-rules`. Prompt recall cuts them in SQL before its candidate limit, so a kept match is not crowded out. The list is empty by default and the block stays byte-identical until you set it.
