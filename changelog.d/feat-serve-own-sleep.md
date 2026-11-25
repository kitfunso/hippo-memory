### Added

- **`serve({ sleep })`: a server whose store is not hippo.db can run POST /v1/sleep its own way.** One runs at a time; a second call gets 503 with Retry-After 30. Unset, the route answers 501 on such a store, as before.
