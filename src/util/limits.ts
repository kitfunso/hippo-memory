// Cap for id-shaped request fields (ids, tenant, session, scope, class): far above real values, small enough to bound logs and indexes.
export const MAX_ID_LEN = 256;

// Page size every list surface (CLI, HTTP, store) falls back to when the caller names none.
export const DEFAULT_LIST_LIMIT = 100;
