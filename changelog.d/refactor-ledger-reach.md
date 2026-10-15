### Changed

- **`hippo recall` on a shared store no longer merges your global store, matching `hippo context`.** A root whose config sets `sharedStore` serves many people, so the global store of the user running the command stays out of its results.
