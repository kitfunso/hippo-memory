# Roles from IdP group claims: a viewer role and one mapping rule

Date: 2026-11-22
Status: accepted

## Context
Core knew two roles, admin and member. A resolver role other than admin became member, so a person who should only read could write. Each add-on mapped IdP groups to a role on its own, to admin or member only.

## Decision
- The ladder is viewer, editor, admin. The stored name of the editor stays `member`, so key rows, `--role`, `Actor` and every add-on keep working. `RoleLevel` ('viewer', 'editor', 'admin') names what a route needs; `Role` ('viewer', 'member', 'admin') names what a caller holds.
- Core owns the rule: `roleFromGroups(claim, groups, fallback)` from `hippo-memory/server`. Each resolver keeps its group lists in its own config and calls it. A server-wide group list could not hold per-provider groups, and it would bring raw claims into core, which drops them today.
- The rule: a lone string is one group; an array keeps its string entries; any other shape gives the fallback; the highest match wins; groups compare exactly. The one refusal is a claim over 1024 entries, checked before any entry is read. The refusal text never holds the claim. A resolver returns null, logs the reason and never logs the claim.
- Route auth 'caller' splits into 'viewer' and 'editor'. A viewer on an editor row gets 403 `VIEWER_REFUSAL`; admin rows keep their text.
- `DELETE /v1/auth/keys/:keyId` stays an editor row. A revoke only lowers access, but one method rule with no exception set is simpler to keep true.
- An add-on route takes `level`, default 'editor'. A default of 'viewer' would open hook and telemetry writes. Mark a route 'viewer' only when it writes nothing.
- The exported write helpers (the `*ForCaller` functions and `captureSessionTexts`) trust the add-on route level: a route marked 'viewer' must write nothing.
- The MCP write tools (`WRITE_TOOLS`) refuse a viewer before the read-only check. `mcpRole` maps an unknown role to 'member' first, as `mcpActor` did before, so a roleless context still runs as a member. On HTTP, `canWrite` fails closed for a role outside the ladder.
- `canWrite(role)` allows only 'member' and 'admin'. The editor guard, self-mint and the MCP refusal all call it.
- `scopeReaderOf` maps a viewer to a member. `ScopeReader` also decides by-id write rights, and this is safe because every by-id write sits behind an editor row or the MCP write-tool refusal. A new by-id write surface must take the editor level.
- Keys stay member or admin. Three readers turn an unknown key role into member, so viewer keys need a binary floor and the owner's yes. Self-mint refuses a viewer.
- The role rides the request trail line, set once in `buildContextWithAuth`. Raw groups never enter core.

## Alternatives considered
- A `ServeOptions.roleGroups`: one mapping per server, and raw claims in core.
- Renaming `member` to `editor`: key rows, the CLI flag and every add-on say member.
- An `Actor.viewer` flag: a coercion site such as the MCP role mapping would fail open.
- An optional `write` flag on a route row: it defaults open.
- Forcing `readOnly` for a viewer: that is the store switch of `HIPPO_READ_ONLY`.

## Consequences
- A viewer's reads still write recall bookkeeping rows, since that code sits in the recall layer.
- Entra leaves the groups claim out above 200 groups (overage), so the fallback applies. A deployment that uses viewer passes fallback 'viewer', or an intended viewer can write.
- A person demoted in the IdP keeps self-minted member keys until they expire.
- An older core turns a resolver 'viewer' into a member, so an add-on that depends on viewer pins the core minor that ships this.
- `Actor.role`, `ResolvedBearer.role`, `McpCaller.role` and `ScopeActor.role` gain 'viewer'. `ScopeActor` also reaches store-kit and the store port `GraphRead.reader`.

## Reconsider when
- Viewer keys ship, or team admin (EV6) needs a fourth level.
- The exported write helpers need to refuse a role that fails `canWrite` themselves.
