### Fixed

- **The Codex wrapper CODEX_HOME test no longer fails at random during temp-dir cleanup.** It stopped waiting when the captured memory appeared, but the detached session-end worker kept writing its log after that and recreated a folder inside the temp dir while cleanup removed it (ENOTEMPTY on CI). The test now waits for the worker's last log line. No source file changed.
