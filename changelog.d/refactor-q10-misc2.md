### Changed

- **`loadConfig` and the `GET /v1/memories` handler are split into smaller helpers, with no change in behaviour.** Each is now 53 lines or fewer, and both entries are gone from `.size-baseline.json`. New tests pin the config warnings and fallbacks, and which bad recall query param is reported first.
