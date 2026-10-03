### Changed

- **Broke the 10-module import cycle between `store` and `search`.** `tokenize` moved to `src/tokenize.ts`, `markRetrieved` to `src/memory.ts`, `RECALL_DEFAULT_DENY_SCOPES` to `src/recall-scope.ts` and `assertTenantId` to `src/tenant.ts`, so `search` loads without `store`. The package entry still exports `tokenize` and `markRetrieved`; deep imports of the moved names from `dist/search.js` or `dist/store.js` must point at the new modules.
