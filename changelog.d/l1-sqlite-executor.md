### Changed

- **`hippo serve` now runs the SQLite work of the five `/v1/predictions` routes on worker threads.** One writer thread and two reader threads start on first use, so a predictions write that waits for the write lock no longer stops the server answering other requests. Statuses, bodies, headers and audit rows are the same. Internal only, no runtime behaviour changes.
