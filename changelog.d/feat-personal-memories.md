### Added

- **Personal memories on a shared server.** Send `personal: true` on `POST /v1/memories` or to the MCP `hippo_remember` tool, and the server stores the row in `personal:private:<owner>`, with origin `''` so it shows in every project. The owner comes only from the caller's sign-in or from the owner of a key that person minted. Only that person can recall, change or delete the row. Another person and an admin key get no recall hit, a 403 when they name the scope, and a 404 by id, the same reply as a missing id. A key an admin minted has no owner, so a personal write with it gets 400. A client that sends a `personal:` scope itself gets 400, and so does a scope grant on one.
- **`serve()` takes a `rateLimits` option, and each person gets their own request bucket.** `perCaller` charges after auth, keyed on the tenant and the key's owner, or on the key id for a key with no owner. So a team behind one proxy no longer shares one address bucket. `perAddress` replaces `HIPPO_V1_RPS` when set, and `'off'` turns the address bucket off. A bad spec stops `serve()` at boot. The SSE heartbeat, `/health` and the keyless loopback path are never charged. A person over budget gets one warn line a minute, naming the tenant, the person and the request id.
- **Failed sign-ins now cost the address they come from.** Each address has a failed-auth bucket: 20 a second, burst 40, changed by `rateLimits.failedAuthPerAddress`. Every 401 charges it. Once it is empty, a key that is not already cached gets 429 before scrypt runs, so wrong secrets on a known key id can no longer burn CPU. A key that is already cached still passes.

### Changed

- **Every 429 now carries `Retry-After`.** The address and person buckets send the seconds one token takes to refill. The open-stream cap sends 60.
- **Personal rows stay with their owner through share, graph, conflicts and capture.** Share and promote refuse a personal row with 400, and sleep's auto-share skips it. `GET /v1/graph` drops entities that come from rows the caller cannot read. Sleep never pairs a personal row in a conflict outside its own scope. `hippo_conflicts`, `hippo_resolve` and the dashboard's resolve treat a conflict that holds someone else's personal row as missing. Session capture no longer skips a team copy because a personal or connector-private row holds the same words.
- **Reject leaves other people's personal rows alone.** `api.reject` and `hippo reject` remove every row holding the rejected text except another person's personal rows, live or dormant. The CLI has no owner, so it skips every personal row. Rejecting a personal row by id is a 400 that tells you to use forget, since a tombstone covers the whole tenant. A reject by value still writes a tombstone for the whole tenant.

### Fixed

- **A clock stepped back no longer drains a rate-limit bucket.** The limiter read the backward step as a negative refill and refused that client for as long as the step.
