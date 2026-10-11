### Fixed
- **`runWatched` keeps a bounded stderr:** it returns the last 64 KiB of a command's stderr instead of all of it, while the terminal still streams everything.
- **`hippo graph view --open` reports a launcher that will not start:** it logs a warning and exits non-zero instead of staying silent.
