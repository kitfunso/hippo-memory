### Changed

- **Policies and customer notes use the shared typed-object save, close, load and list.** Internal refactor: each type now describes its columns and audit keys as data for `src/objects/lifecycle.ts`. Function names, signatures, error text, stored rows, mirror memories and audit rows are unchanged. One ordering change for direct SDK callers: `loadPolicies` with an unknown `status` now throws before the store is opened, as `loadCustomerNotes` already did (the HTTP route and the CLI check the status first, so their replies are unchanged).
