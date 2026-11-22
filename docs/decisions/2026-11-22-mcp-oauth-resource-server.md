# MCP OAuth: hippo is the protected resource, never the authorization server

Date: 2026-11-22
Status: accepted
Links: docs/decisions/2026-10-03-auth-resolver-seam.md

## Context
A client that follows the MCP authorization spec (revision 2026-07-28) expects an MCP server to act as an OAuth 2.1 resource server. It must serve OAuth 2.0 Protected Resource Metadata (RFC 9728), and it tells a client where to get a token by naming that document in a `WWW-Authenticate` challenge on a 401. Before this change `POST /mcp` answered a 401 with no header and no document existed, so a client could not find the operator's authorization server, even where an add-on `authResolver` already vouched for non-`hk_` tokens.

## Constraints and evidence
- The spec lets the authorization server be "a separate entity", and hippo stays local by default and hosts nothing for anyone.
- The 2026-10-03 seam keeps identity protocols out of core: token checks sit behind `authResolver`, and the README lists SSO as commercial. `check-open-core` bans the SSO terms in `src`.
- `hippo serve` passes no `authResolver` (`src/surface/cli/serve.ts`), so the CLI alone can never accept an OAuth token. Only an embedder of `serve()` can.
- RFC 9728 section 3.3: a client discards a document whose `resource` is not the identifier it built the URL from. A root document for a `.../mcp` resource would fail that check.
- The `hk_` keys and the local key are tokens hippo minted, so they meet the spec's "or otherwise verify that they are the intended recipient" clause. Routing at `auth.ts` does not change.

## Decision
- `ServeOptions.oauth` (`resource`, `authorizationServers`, optional `scopes`) makes `/mcp` a protected resource. It lives on `ServeOptions` only: no env var and no `hippo serve` flag, and boot refuses it without an `authResolver`.
- Core serves the RFC 9728 document at `/.well-known/oauth-protected-resource` plus the resource path, through `publicJsonBodies`, so it needs no `HOST_ROUTES` row and exists only when the setting is on. The root path stays 404.
- A 401 on `POST /mcp` carries `Bearer resource_metadata="<url>"`, plus `scope` when scopes are set, plus `error="invalid_token"` only when a Bearer token came (RFC 6750 section 3.1). A 429 and the resolver's 503 carry none.
- `/mcp/stream` and `/v1` keep a bare 401. A document fetched from a challenge there names the /mcp resource, which is a different resource for that URL (RFC 9728 section 3.3), so a strict client would discard it.
- The audience rule stays in the add-on: the `AuthResolver` TSDoc says that with `oauth` set it accepts only tokens whose audience includes `oauth.resource`. Core cannot check it.
- A loopback http resource or authorization server is for development only. The spec says authorization server endpoints MUST use HTTPS.
- The 403 `insufficient_scope` challenge (a SHOULD in the spec) is a non-goal.

## Alternatives considered
- Hippo as its own authorization server (token endpoint, consent, client registration): hosts identity, breaks local by default and the open-core line.
- A JWT or JWKS verifier in core: hippo would learn an identity protocol, which the 2026-10-03 seam rules out.
- An env var or `hippo serve` flags: the CLI has no resolver, so the flags could never work there.
- A root document at `/.well-known/oauth-protected-resource`: fails the RFC 9728 section 3.3 check for a `.../mcp` resource.
- A challenge on `/v1` 401s: points at the /mcp resource from a different resource.

## Consequences
- An operator who wants MCP clients to sign in sets `oauth` and writes an `authResolver` that checks tokens against their authorization server. Hippo issues nothing.
- Under the planned enterprise wiring, turning on `mcpResource` makes every SSO client of `/v1` use tokens whose audience is the MCP URL, so a token with the old API audience gets a 401 on `/v1` too, because the resolver cannot see the route. That wiring's boot refusal says the same, and before it pins the rule it confirms each target IdP (Entra included) can issue that audience.
- No CORS header exists in `src`, so a browser-based MCP client cannot read the document. Native clients can.
- Core still answers MCP `initialize` with an older protocol version, and `GET /mcp` is 404 where the 2026 spec says SHOULD 405. Discovery happens at the HTTP level, so OAuth works.

## Reconsider when
- Core verifies tokens itself.
- The resolver learns the request's resource. The alternative then is an optional `ResolvedBearer.audience` the resolver reports, which core compares with `oauth.resource` on `/mcp` only: core checks the spec's MUST itself, `/v1` is untouched, and the type only grows.
