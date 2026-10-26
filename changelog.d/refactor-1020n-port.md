### Changed

- **3.0 break: a store built on `hippo-memory/store-kit` may leave the feature groups unset.** Recall, remember and context run on the required groups; `OPTIONAL_GROUPS` lists the rest, and each HTTP route, MCP tool and CLI verb that needs one checks for it once at start and answers 501 `store_not_ported` without it. `bumpRemembered` moves from `lessonWrites` onto the store, and the compaction and failure callers on `hippo-memory/server` take a context whose store holds their groups.
