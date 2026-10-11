### Fixed

- **An MCP context without a role now fails closed.** Only stdio, which passes no context, runs as the local operator; any other context runs as its own role, and one that omits it runs as a member with no host-admin rights. `McpContext.role` is now required, so a typed transport cannot forget it.
- **`hippo_context` no longer reads the server's git state for a remote caller.** Over HTTP-MCP a caller who is not a host admin gets rows by strength instead of a query built from the server's working tree, and never the server's launch folder as its project. `hippo_learn` stays refused for those callers.
- **`POST /v1/auth/keys` checks the caller before it reads the body.** An unauthenticated mint now gets 401 at once instead of costing a body read; the check runs again right before the mint, so an auth resolver's gate still sees no wait.
- **Internal:** the `/v1/outcome` ids-cap and `/v1/sleep` comments now say what really guards each route (auth first; the host-admin check).
