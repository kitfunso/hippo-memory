### Added

- **`serve({ oauth })` makes `/mcp` an OAuth 2.1 protected resource.** Hippo serves the RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp` and names it in the `WWW-Authenticate` header of a `POST /mcp` 401, so an MCP client can find your authorization server. It issues no tokens: your `authResolver` checks them, and `hk_` keys keep working. Off by default.
