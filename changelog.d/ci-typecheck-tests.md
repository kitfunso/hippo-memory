### Changed

- **CI now type-checks the test files.** The `checks` job runs `npm run typecheck:tests` (`tsc -p tsconfig.tests.json`, which covers `src/` and `tests/` and infers types from the `.mjs` scripts the tests import), so a wrong-shaped call in a test fails the PR. JSDoc on the token-eval scripts gives those imports real types.
