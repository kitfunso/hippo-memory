### Added

- **`HIPPO_SKIP_SCHEDULE=1` skips the daily run in `hippo init`, `hippo init --scan` and `hippo setup`, as `--no-schedule` does.** It suits scripted and CI installs that should never touch the machine's crontab or Task Scheduler.

### Changed

- **Internal:** the test suite sets `HIPPO_SKIP_SCHEDULE=1` for every test, so no test can reach the real `schtasks` or `crontab`, whatever flags it passes. `tests/scheduler-test-isolation.test.ts` runs `hippo init` with no flags under a preload that logs and refuses every scheduler call, and a control run with the switch cleared shows the preload catches the calls. The test that creates a real Windows scheduled task now runs only on CI.
- **Internal:** tests that asserted almost nothing now check behaviour. `hybridSearch` runs over stored vectors from a local hashed-embedding server; the tests check the 0.6 default blend weight and that MMR re-ranks only the top 100. `isEmbeddingAvailable` is checked true and false under a resolve-faking preload. The pragma-order churners report their writes and errors. The v26 guard test checks the healed schema, and `hippo dag --stats` is checked against a known fixture.
- **Internal:** the coverage provider is now plain JavaScript (`tests/_coverage-provider.mjs`), so its tests run on the Node 22.16 leg too, which cannot load TypeScript.
