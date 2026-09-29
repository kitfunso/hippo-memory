### Fixed

- **`hippo eval --suite` now says when the baseline file is unreadable.** A corrupt `eval-baseline.json` (or the file passed with `--baseline`) was skipped without a word, so the run showed no comparison and no reason why. It now prints one warning line to stderr naming the file, then runs without a baseline as before.

### Changed

- **Removed four unused functions and types, and fixed comments that named callers that do not exist.** `saveConfig`, `deletePhysicsState`, the `SlackInbound` type and the `computePlanningFallacyHint` wrapper had no callers outside their own file or tests, and none of them was exported from the package entry point. `computePlanningFallacyOutput` is the function `api.recall` and `hippo recall` use, and the comments that named the wrapper now name it.
- **Pidfile cleanup in server detection goes through one place.** `detectServer` removes a stale `server.pid` with `removePidfile` instead of eight copies of an empty catch, and the one remaining catch says why ignoring a failed delete is safe.
