### Changed

- **A busy hippo.db now rejects with `StoreBusyError`, not the driver's SQLite error.** The store adapter turns the busy codes into the port's own error, with the driver's error as its `cause`, so the api, the CLI and `serve()` know busy by that one class. A busy request still answers 503 and the CLI still prints the busy message.
- **The store-kit session rows name their fields in camelCase.** `TaskSnapshot`, `SessionEvent`, `SnapshotInput` and `SessionEventInput` use `nextStep`, `sessionId`, `eventType`, `createdAt` and `updatedAt`. The HTTP replies, the CLI's `--json` and the markdown mirrors keep their snake_case keys, and tests pin both HTTP replies and the CLI's continuity JSON.
- **`ConflictResolution` carries the time of the resolve.** Both stores write that one time as the conflict's `updated_at` and as a rejection tombstone's `rejectedAt`, where each used its own clock before.
