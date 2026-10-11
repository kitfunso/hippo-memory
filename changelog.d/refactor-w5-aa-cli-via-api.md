### Changed

- **Internal:** CLI commands now read and write memory state through `src/api` operations instead of importing `src/store` or `src/db`. Runtime store imports in `src/cli` fell from 53 to 4, and the CLI no longer resolves the tenant per verb: dispatch resolves it once and passes it down.
- **Internal:** The session-end work (handoff write, snapshot close, re-read booking) and the compact-resume read moved from the hook verb into `src/api/session-end.ts`.
- **Internal:** `scripts/check-layers.mjs` now fails a runtime import from `src/cli` or `src/cli.ts` into `src/store` or `src/db` unless `.cli-store-allowlist.json` lists it with a reason. An entry that no longer matches an import also fails.
- **Internal:** `getHippoRoot` and `isInitialized` moved from `src/store/open.ts` to `src/core/project-identity.ts`; both are path checks that never open the database.
