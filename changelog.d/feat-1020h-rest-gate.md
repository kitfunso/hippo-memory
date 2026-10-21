### Changed

- **`POST /v1/memories` always runs the salience gate.** A repeat or a text too short to keep answers 200 with `{ "skipped": ... }` and stores nothing. Send `"force": true` to store a text anyway. See `docs/UPGRADING-3.0.md`.
