### Changed

- **Tests own their environment, clock and fixtures.** `scripts/lib/test-env-scrub.mjs` lists every secret, endpoint and path variable vitest blanks, and `check-test-env` fails an `env.ts` read missing from it. Process tests are classed by their import graph, the unit project runs without a build, and dashboard reads are pinned one parsed snapshot each.
