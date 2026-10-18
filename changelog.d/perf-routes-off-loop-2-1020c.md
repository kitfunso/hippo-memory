### Changed

- **`Conflicts.resolve` takes the reject fate's reach as data: `{ kind: 'reject', ownScope }` replaces `{ kind: 'reject', inReach }`.** The store removes the rejected value's other copies whose scope `ownScopeTouches(ownScope, scope)` admits, inside the same write, so the `hippo_resolve` MCP tool now runs on the store's worker threads. See `docs/UPGRADING-3.0.md`.
