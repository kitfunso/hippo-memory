### Fixed

- **A local embedding package installed while hippo runs is now seen without a restart.** The local embedder remembered a "not installed" answer for the life of the process, so `embed` kept returning an empty vector after you installed the package. It now asks again once every 5 minutes (the same window a failed model load waits), and a "installed" answer stays cached. The public `isEmbeddingAvailable()` export had the same cache and now resolves the package on every call, so a long-lived host sees an install at once; each call costs one package resolve.

### Changed

- **The sleep child's end is one value inside the server.** `POST /v1/sleep` and the auto-sleep return the same HTTP codes and the same error text in every case, the deadline first included. A reply that is not a sleep result and a child that closes with no reply now have tests.
