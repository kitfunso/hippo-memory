### Changed

- **The conflict rule lives in the domain, and a store applies its numbers.** `LoserFate`'s `weaken` case on `hippo-memory/store-kit` now carries `halfLifeFactor` and `minHalfLifeDays` (`0.5` and `1`, as before), so an add-on store weakens a loser exactly as hippo.db does. See `docs/UPGRADING-3.0.md`.
- **`promptHookContext` gives a store that serves `folderFiles` the reach its folder gives it.** An add-on store with its own ledger now books the hook's token rows; a store without `folderFiles` still books none.
- **One module, `src/surface/open-store.ts`, opens the default store for every composition root.** The api and domain layers no longer name SQLite, and `scripts/check-layers.mjs` reads that rule from the `adapter` key in `layers.json`, so a SQLite name or import above the adapter fails the check.
- **`scripts/check-store-port.mjs` allows no folder form above `src/store/sqlite`.** The last one, `loadRecallSearchEntries` in `src/store/search-rows.ts`, moved into the adapter's `folder-forms.ts`; `hippo-memory/folder-search` and `hippo-memory/testing` still export it.
