### Changed

- **All 30 `config.json` keys are now checked, and a malformed value warns once and reads as its default.** Twenty keys (such as `autoSleep`, `embeddings`, `mmr`, `search`, `pinnedInject`, `salience` and `physics`) used to take whatever the file held; a wrong type now logs one `config.json's "<key>" must be ...` line and the default applies, as the ten checked keys already did. `decayBasis` also warns now instead of falling back silently. A warning for a bad field names it, for example `"pilot.holdoutRateBp"` where it said `"pilot"`. A non-boolean `pinnedInject.promptRecall` still reads as off, and an unknown `embeddings.provider` still reaches the provider, which refuses it.

- **`hippo-memory/testing` exports `loadRecallSearchEntries`.** It keeps the nine positional arguments the frozen q3b-ranker-floor benchmark passes; the loader behind it takes an options object, like the rest of src.
