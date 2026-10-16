### Changed

- **`consolidate`, `embedMemory`, `embedAll`, `hybridSearch` and `physicsSearch` accept an optional config argument.** A caller that already holds the settings passes them in and skips the config.json read; leaving it out reads the file as before.
