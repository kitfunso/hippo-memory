### Changed

- **`hippo serve` now answers recall, the graph and the quarantine routes from worker threads.** The routes are `GET /v1/memories`, `GET /v1/graph`, `GET /v1/quarantine` and the approve and reject routes under `/v1/quarantine/:id`. Their reads run on reader threads and their writes on the writer thread, so the server thread runs no SQL for them and one that waits for the write lock no longer stops the server answering other requests. The store's first-open setup (the half-life base record, the import of legacy markdown, the mirror folders) now runs once on the writer thread before any reader answers. Statuses, bodies, headers, audit rows and mirror files are the same for a request that finishes inside its deadline. These routes now come under the store queue bound (a 503 with `Retry-After`) and the request deadline (a 504). Legacy markdown that appears in a still empty store after the server has started is imported by the next write, not by a read. Internal otherwise.

### Fixed

- **Hybrid and physics recall keep their vector arm on a store that runs on another thread.** The recall path sent its admission function to the store with the vector query; a function cannot cross to a thread, and the failure was logged as a fall back to BM25. The function now stays on the caller's side.
