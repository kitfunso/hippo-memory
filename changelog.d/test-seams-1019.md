### Added

- **`hippo-memory/testing` exports `_resetProjectIdentityCacheForTests` and `_resetLogOnceForTests`.** An add-on test suite can clear the cached project of each folder and the once-only log keys between tests, as hippo's own suite does.
- **`hippo-memory/testing` exports `_readApiKeyVerifyStatsForTests`.** An add-on test suite can count the scrypt runs and store lookups behind its API key checks, to prove a cached key skips both.
