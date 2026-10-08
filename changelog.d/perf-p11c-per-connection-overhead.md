### Changed

- **A new connection no longer scans the whole archive for leftover mirror files.** It reads the archive's highest row id, which is one index seek, and runs the scan only on a store's first connection in the process, when a row was archived since, or while an earlier clean-up of a mirror file failed.
- **`openStore` makes the four mirror folders on a store's first open in the process, where it made them on every open.** A writer still makes its own folder if one is missing, now owner-only (0700) like the folders made at open; this includes `trace/`, which was made with the process default mode.
