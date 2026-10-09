### Fixed

- **A hostile compaction summary can no longer stall the PostCompact hook.** Three patterns that read the "Memories for hippo" list took time that grew with the square of the input: a summary of repeated unclosed `<analysis>` tags, a line of tabs, or a list item padded with spaces could hold the hook for a minute. Each is now read in one pass, and ordinary summaries give the same items as before.
