### Fixed

- **`hippo codex-run` no longer crashes when its background session-end worker cannot start.** A start failure the system reports late (no memory, no process slots, a Node binary replaced mid-session) was an unhandled error, and the session's sleep and capture were lost. The work now runs in the wrapper itself before it exits, as it already did for a failure reported at once.
