### Tests

- **A test run no longer leaves scratch folders in the system temp dir.** `vitest.config.ts` points `TMPDIR`, `TEMP` and `TMP` at one folder per run, and the real-store guard deletes it at the end of a clean run, next to the isolated homes. Many test files make a scratch folder with `mkdtemp(tmpdir())` and never delete it; one Windows box had collected 4,738 of them (2.3 GB). The guard now prints a warning when it cannot delete a folder, where it used to say nothing.
