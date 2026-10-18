### Changed

- **All 30 `config.json` keys are now checked, and a malformed value warns once and reads as its default.** Twenty keys (such as `autoSleep`, `embeddings`, `mmr`, `search`, `pinnedInject`, `salience` and `physics`) used to take whatever the file held; a wrong type now logs one `config.json's "<key>" must be ...` line and the default applies, as the ten checked keys already did. `decayBasis` also warns now instead of falling back silently. A warning for a bad field names it, for example `"pilot.holdoutRateBp"` where it said `"pilot"`.
