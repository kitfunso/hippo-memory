### Changed

- **Internal:** The core memory model now names its aged-out threshold, retrieval half-life gain and error-tag half-life factor, the SQL strength rule reuses the shared fallback half-life, and the default tenant has one constant (`DEFAULT_TENANT_ID`); comments in `src/core/memory.ts` are cut to the house rule. No behaviour change.
