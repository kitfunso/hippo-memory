### Fixed

- **`hippo serve` answers recall about four times faster on Windows.** Each request opened and closed its own store connection, and with no other connection open every close checkpointed and deleted the write-ahead log, which the next open rebuilt. The server now holds one connection for its lifetime: a recall GET on a 100-memory store went from about 80 ms to about 20 ms, and the 550-request concurrency test from 46 s to 16 s.
- **A folder under the temp root no longer takes its project name from a `.hippo` or `.git` above that root.** The store lookup already stopped at the temp root, but the project-name lookup did not; on Windows, where the temp root sits inside the home folder, a session with a redirected home folder stamped memories with the real home folder's name.

### Changed

- **CI runs the full test suite on Windows and macOS as well as Linux.** The Windows job used to run only the test files that name `win32`.
