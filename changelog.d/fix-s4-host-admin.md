### Security

- **A tenant's admin key can no longer act on other tenants.** Before, any API-key admin could read another tenant's audit log (`GET /v1/audit?tenant=`) and start host-wide `POST /v1/sleep`. Both now need a host admin: the CLI, stdio MCP, a keyless loopback caller, or an admin key of the server's own tenant (`HIPPO_TENANT`, else `default`). An admin key of any other tenant gets 403 there and keeps full access to its own tenant. Single-tenant installs see no change.
- **`hippo_learn` over HTTP MCP needs a host admin.** It reads the server's git history and writes memories, so a member key or another tenant's admin key now gets a permission error. Stdio MCP and the CLI are unchanged.
- **MCP auto-sleep starts only from the host tenant's writes.** Consolidation runs across every tenant, so a `hippo_remember` from another tenant no longer triggers it.
