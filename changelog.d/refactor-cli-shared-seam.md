### Changed
- The 36 helpers that two or more CLI verbs share moved from `src/cli.ts` to `src/cli/shared.ts`, and the `sleep` verb moved to `src/cli/sleep.ts`, which `main()` loads only when sleep runs. A verb can now move into its own file without importing `cli.ts`. Output, flags and exit codes are unchanged, pinned by a new sleep golden test and the existing recall golden test.
