### Changed

- **The elapsed-time guard now scans the dashboard tests too.** `tests/elapsed-time-upper-bounds.test.ts` reads `ui/src/**/*.test.ts(x)` as well as `tests/`, so a wall-clock upper bound in a UI test fails the root suite.
- **The UI CI job runs its tests the normal way.** No UI test asserts a time budget, so the unused `UI_PERF_BUDGET_SCALE` variable and the forced serial run are gone from `ci.yml`.
