# Auth resolver seam: route by token shape, resolver admins stay in their tenant

Date: 2026-10-03
Status: accepted
Links: https://github.com/kitfunso/hippo-memory/pull/352

## Context
Paid add-ons (OIDC SSO first) need to vouch for bearer tokens that are not hippo API keys, without hippo learning any identity protocol. `serve()` takes an `authResolver` for this. The core's `admin` role on an API key is host-wide: it reads any tenant's audit log, runs host-wide sleep, and mints admin keys.

## Constraints and evidence
- First cut asked the resolver about every token, API keys included. The final ship review showed plaintext `hk_` keys would reach plugin code (an introspecting or logging add-on leaks them) and a resolver could override a key's identity.
- With `role: 'admin'` from a customer's IdP, a resolver user read another tenant's audit log. After that was gated, codex reproduced a second path: the resolver admin minted an admin API key with `{}` and the key read another tenant's events.
- Splitting `admin` into tenant and host roles needs a key-table migration on live stores, so it is out of scope here.

## Decision
- Route by the public `hk_` prefix: an `hk_` token only ever reaches API-key validation, any other token only the resolver.
- The core tags resolver identities. They are tenant admins at most: cross-tenant audit and host-wide sleep are 403, and `authCreate` never issues a key that outranks its minter, so they mint member keys only.
- A resolver throw or missed deadline (5 s default) is a 503, which a stream heartbeat skips; only a 4xx closes a stream as revoked.

## Alternatives considered
- Resolver first, null falls through to API keys: leaks keys to plugins and lets a plugin override a key.
- Resolver after API keys fail: still hands every mistyped or revoked key to the plugin.
- Refuse key minting to resolver users entirely: blocks SSO users from making CLI keys for no gain over member-only.
- Persist a tenant-only flag on keys: needs a migration; member-only gives the same guarantee today.

## Consequences
- Plugins never see hippo keys, and no resolver answer can widen a caller's reach beyond its tenant.
- Member keys minted by SSO users outlive IdP deprovisioning; the add-on or an admin must revoke them.
- A resolver outage degrades to 503s, not mass revocation.

## Reconsider when
- The core splits tenant admin from host admin; then resolver admins could mint tenant-admin keys.
