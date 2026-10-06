### Added

- **`serve()` takes a `rateLimits` option, and each person gets their own request bucket.** `perCaller` charges after auth, keyed on the tenant and the key's owner, or on the key id for a key with no owner. So a team behind one proxy no longer shares one address bucket. `perAddress` replaces `HIPPO_V1_RPS` when set, and `'off'` turns the address bucket off. A bad spec stops `serve()` at boot. The SSE heartbeat, `/health` and the keyless loopback path are never charged. A person over budget gets one warn line a minute, naming the tenant, the person and the request id.
- **Failed sign-ins now cost the address they come from.** Each address has a failed-auth bucket: 20 a second, burst 40, changed by `rateLimits.failedAuthPerAddress`. Every 401 charges it. Once it is empty, a key that is not already cached gets 429 before scrypt runs, so wrong secrets on a known key id can no longer burn CPU. A key that is already cached still passes.

### Changed

- **Every 429 now carries `Retry-After`.** The address and person buckets send the seconds one token takes to refill. The open-stream cap sends 60.

### Fixed

- **A clock stepped back no longer drains a rate-limit bucket.** The limiter read the backward step as a negative refill and refused that client for as long as the step.
