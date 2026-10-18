### Fixed

- **A bad pidfile, health body, compaction row or git call now costs one warning, not a crash or a silent null.** A pidfile holding JSON null is treated as no server, a failed pidfile unlink logs its error code, one compaction record with unreadable items is skipped by name while the others still load, a stdin read error keeps its cause in the log, a git failure other than "not a repository" is logged once, and the dashboard answers 500 (and logs) for a static file that exists but cannot be read.
- **`hippo` verbs that need a store stop by throwing instead of calling `process.exit`.** The message and exit code 1 are the same.
