### Fixed

- **Capture failures now exit 1 after restoring stdio.** A missing store, no stdin, or a missing or absent `--file` used to exit mid-command and leave the log tee in place.

### Changed

- **The inline reindex size check counts rows in SQL instead of loading every id.** A write after an embedding model change no longer reads the whole id list just to compare it with the cap.
