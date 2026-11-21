### Added

- **The GitHub connector works with GitHub Enterprise Server.** Set `GITHUB_ENTERPRISE_URL=https://<host>`, using the host name the server is configured with, and `hippo github backfill` calls `https://<host>/api/v3`. A GHES memory carries the host in its ref, `repo:` tag, scope and backfill cursor, so once the variable is set, a GHES repo never shares a key with a github.com repo of the same name. github.com refs do not change. With the variable set, the webhook parks a delivery from any other server in the `host_mismatch` bucket, logs a warning, and `hippo github dlq replay` refuses that row until the hosts match. A store that takes both github.com and GHES hooks must keep the variable unset or split to two servers.
- **Upgrading GHES webhooks.** GHES webhooks keep working unchanged while `GITHUB_ENTERPRISE_URL` is unset, and the first GHES delivery in a process logs one warning that its keys carry no host. Once you set it, new rows carry the host in their scope and `repo:` tag, and older rows keep the bare form. Grant member keys the host form too (`hippo auth grant <key_id> github:private:<host>/<owner/name>`), query both scopes, and set the variable before you replay any `host_mismatch` row. Deleting a GHES comment still archives the copy stored before you set it.

### Security

- **Backfill keeps the token on the configured server.** A next-page link to another origin stops the backfill with an error instead of sending the token there.
