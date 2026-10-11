### Changed

- **Internal:** no two top-level `src/` folders import each other at runtime any more. `scripts/check-import-cycles.mjs` now fails CI on a folder-level cycle as well as a file-level one, with an allowlist that starts empty. The scope helpers moved to `src/core/active-scope.ts`, the project-fold reader to `src/agent-memories/project-folds.ts`, the error-to-status map to `src/api/error-reply.ts`, the merged-row rules to `src/core`, and the request deadline default to `src/util/request-scope.ts`.
- **Internal:** `MemoryKind` and the kinds `POST /v1/memories` accepts come from one `MEMORY_KINDS` array in `src/core/memory.ts`, and the id-length cap `MAX_ID_LEN` lives in `src/util/limits.ts` instead of the HTTP helpers.
