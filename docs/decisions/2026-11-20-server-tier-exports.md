# Server tier exports: the worker embed on server, the row rules on store-kit

Date: 2026-11-20
Status: accepted
Links: `changelog.d/feat-server-entry-enterprise.md`; `docs/decisions/2026-10-11-store-kit-subpath.md`; `src/server.ts`; `src/entry/store-kit.ts`; `tests/server/server-tier-entry.process.test.ts`; `tests/server/server-subpath-exports.process.test.ts`

## Context
hippo-enterprise serves hippo from a Postgres store and imports 122 core names. On 3.9.0 two were on no public entry: `embedAll` (only on the unexported `src/entry/eval-scripts.ts`) and `initStore` (only on `hippo-memory/testing`). Its Postgres store must also write and read rows as hippo.db does, which needs helpers that no entry exports, such as `duplicateHash`.

## Constraints and evidence
- `docs/decisions/2026-10-11-store-kit-subpath.md` keeps `server` to the add-on API, and says a helper a second store needs goes on `store-kit` with its test.
- `embedAll` and `folderIndex` are a worker operation that a server process runs, not part of a store's contract.
- The rule `adapter-entrances` (`.dependency-cruiser.cjs`) lets only `src/surface/open-store.ts` and `src/surface/testing-kit.ts` import `src/store/sqlite`, so `initStore` reaches `store-kit` through `open-store.ts`.

## Decision
- `hippo-memory/server` adds the worker embed: `embedAll` and `folderIndex`. This amends the 2026-10-11 record, which listed the add-on API alone.
- `hippo-memory/store-kit` adds `initStore` (with no runtime or session option) and the write and search helpers a store on another database needs to match core rows: `duplicateHash`, `isoInstant`, `sortableStamp`, `partitionCjkTerms`, `cjkIndexTerms`, `interleaveRows`, `splitLikeTerms`, the three window constants, `RECALL_ONLY_TAGS`, `auditRowsRead` and `RawAppendOnlyError`.
- `entryAfterOutcome` takes an optional `now`, so a store scores an outcome at its own clock.
- `folderIndex` moves to `src/surface/folder-index.ts`, so one module builds the embed target for `eval-scripts`, the eval kit and `server`. `server` never imports `eval-scripts.ts`, which builds rerankers at load.
- Each new name has a test against the core result it must match, and sits in the three export gates: the exact-set test, the inline snapshot and `check:dts`.

## Alternatives considered
- **Put the helpers on `server`:** the add-on API stays smaller, but it breaks the 2026-10-11 split.
- **Let the enterprise store copy the helpers:** no new promise here, but the copies drift from core and a row then differs by store.

## Consequences
- Each name is a semver promise. A change to one needs a major version or a new name.
- Left off the entries, on purpose: `DEFAULT_LIST_LIMIT` and `MAX_AUDIT_LIMIT` (`auditRowsRead` holds both), `isRecallOnly`, `CrossTenantIdError`, `fallbackOrigin`, `memoryNotFoundText`, the model-taking forms of `entryAfterOutcome`, `markRetrieved` and `tallyAmbientEntries`, and `rewardFactorSql`.

## Reconsider when
- The term plan of `listSearchRows` moves into one module: it would replace `partitionCjkTerms`, `cjkIndexTerms` and `splitLikeTerms` with one export.
