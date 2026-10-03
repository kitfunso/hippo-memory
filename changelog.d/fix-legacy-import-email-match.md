### Fixed

- **A note with an email address no longer imports twice after an upgrade.** The old Claude Code import kept emails in clear; the new import masks them as `[email]`. The step that hands old rows over to their notes compared the clear text with the masked text, so the two never matched, and the note was imported again beside the old row. The comparison now masks the old row's text first. A store that already holds both copies cleans itself on the next sync: the old row takes the note's key, and the sync keeps the newer, masked copy.
