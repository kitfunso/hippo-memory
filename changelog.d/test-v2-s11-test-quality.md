### Changed

- **Tests are deterministic where they were probabilistic.** The spool race test now interleaves two replayers through the importer, so it fails on every run of a broken lock instead of by chance. Polling loops and fixed sleeps in the tests use one `waitFor` helper or a fixed clock, symlink skips narrow to EPERM, and the Linux CI jobs set `HIPPO_REQUIRE_SYMLINKS=1` so a missing link privilege fails there instead of skipping. Thirteen copies of the CLI test setup moved to `tests/_helpers/cli-env.ts`.
