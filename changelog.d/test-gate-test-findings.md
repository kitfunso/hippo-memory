### Changed

- **The slow token-eval tests now run on every push to `master` and `next/2.0`, and on any pull request that touches `bin/`.** A core change can no longer skip them.
- **Four session and hook tests wait through the shared `tests/_helpers/wait-for.ts`.** Teardown in the tenant isolation tests no longer swallows errors, and the coverage provider has tests for its edge cases.
