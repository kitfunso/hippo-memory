### Changed

- **Internal: more caught-error text goes through one helper.** Five more call sites use `errorMessage()`, four config guards use the shared JSON guard, and a CI check stops new hand-spelled error text. No user-visible change.
