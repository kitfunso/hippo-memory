### Changed

- **`saveDecision` now answers a lost supersede race with 409 Conflict, not 400 Bad Request.** When another writer supersedes the same decision between the preflight check and the update, `POST /v1/decisions` returns HTTP 409 and the API throws `ConflictError`, like the other save paths. Clients that retried only on 400 should retry on 409.
- **`GET /v1/predictions` with no `status` and no `class` now lists closed predictions too.** `status=all` used to return only open rows when no class was given. `hippo predict list` had the same gap and now shows every prediction in every class.
- **`HIPPO_REQUIRE_SERVER` is on only for `1` or `true`.** Any other non-empty value, such as `0` or `false`, used to turn it on.

### Fixed

- **`MCP_SSE_HEARTBEAT_MS`, `MCP_SSE_MAX_AGE_SEC` and `HIPPO_LLM_RERANKER_TIMEOUT_MS` ignore zero and negative values.** The caller's default applies instead of a negative timer.
- **`HIPPO_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `HIPPO_MODEL_CACHE` and `TYPESAFE_API_KEY` are trimmed in one place.** A blank value reads as unset everywhere.
- **A memory queued twice for a dormant move binds one value per placeholder.** node:sqlite bound the missing values as NULL, so nothing broke, but a strict driver would throw.
- **`hippo serve --host ::1` now writes `http://[::1]:<port>` and the CLI finds it.** The server URL lacked brackets, so it did not parse, and the pidfile check compared `[::1]` against `::1`, so an IPv6 loopback server was never detected.
- **A busy 503 from the server logs at warn, not error.** It is back-pressure the client retries, not a server fault.
- Dead code and stale comments left by the long-function splits: the `--dry-run` value guard in `hippo invalidate`, an unused flag and variable in `hippo hook`, the unused max velocity in `hippo status`, a duplicate L2 tenant partition in `buildEntityProfiles`, two extra config loads per `getContext` call, and docs that sat above the wrong function or named old line numbers.
