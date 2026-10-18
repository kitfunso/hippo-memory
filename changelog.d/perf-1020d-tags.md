### Changed

- **Project lists, merges and repairs read only the rows of the projects they touch.** `hippo projects` counts each project in one grouped query, a merge reads the rows of the two projects it joins, and the user-global repair reads its merged rows and their parents by id; none loads every memory of the tenant any more.
- **Imports and sync down check each text against the rows that could hold it.** A file import and `hippo sync` used to load the text of every memory before the first copy; they now ask the full-text index for the rows that share a text's words, and fall back to a word match when the index is behind. What they skip as a duplicate is unchanged.
