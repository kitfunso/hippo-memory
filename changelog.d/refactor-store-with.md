### Added

- **`StoreWith` and `ContextWith` types are exported for store implementers.** `hippo-memory/store-kit` now exports `StoreWith<G>`, `ContextWith<G>` and `narrowStore`, so a handler can take a store the gate has already proved holds its groups.
