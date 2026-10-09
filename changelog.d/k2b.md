### Changed

- **Internal: more caught-error text goes through one helper.** Five more call sites use `errorMessage()`, four config guards use the shared JSON guard, and a CI check stops new hand-spelled error text. No user-visible change.

### Fixed

- **A failure that throws something other than an Error now reports that value.** Sleep, the CLI verbs and the rerankers used to print `undefined` or `unknown error` for it.
