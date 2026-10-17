### Security

- **On/off settings accept only `1`, `true`, `on`, `0`, `false` and `off`.** Any other spelling takes the setting's safe side, so `HIPPO_REQUIRE_AUTH=true` no longer reads as off, and `hippo serve` refuses to boot on an unknown value.
- **Every route body field has a type and a length cap.** A value over its cap is a 400 that names the field and the cap.
- **A member key can only write memories under its own owner.** Another owner is a 403 unless the caller is an admin.
- **`serve()` claims the store's pidfile before it binds.** Two servers started together on one store now fail with "already running" for one of them, and a pidfile held by another user's live process is no longer deleted.
- **The in-flight key check no longer holds the raw bearer token.** It is keyed on a SHA-256 digest.

### Changed

- **3.0 break: secret-shaped text is redacted for every caller.** `hippo remember`, `POST /v1/memories`, the MCP remember tool and the importers no longer store a typed secret as sent.
- **3.0 break: `HIPPO_TRUSTED_PROXIES=*` stops `hippo serve`.** List the proxy's addresses or CIDRs.
- **3.0 break: a keyless local caller is always a member.** `HIPPO_KEYLESS_LOCAL_ROLE` and the `keylessLocalRole` serve option are gone; mint an admin key.
- **3.0 break: `runWatched` takes no `shell` option.** Use `runWatchedLine` for a shell line.
