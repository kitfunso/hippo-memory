### Changed

- **The agent memory sync checks each note against the rows that could hold it.** It used to load the text of every live memory outside its own imports before the first note; it now asks the full-text index for the rows that share a note's words, and falls back to a word match when the index is behind. What it skips as a duplicate is unchanged.
