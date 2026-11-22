# Roles from IdP group claims: a viewer role and one mapping rule

Date: 2026-11-22
Status: accepted

## Context
Core knew two roles, admin and member. A resolver role other than admin became member, so a person who should only read could write. Each add-on mapped IdP groups to a role on its own, to admin or member only.

## Decision
- The ladder is viewer, editor, admin. The stored name of the editor stays `member`, so key rows, `--role`, `Actor` and every add-on keep working. `RoleLevel` ('viewer', 'editor', 'admin') names what a route needs; `Role` ('viewer', 'member', 'admin') names what a caller holds.
- Core owns the rule: `roleFromGroups(claim, groups, fallback)` from `hippo-memory/server`. Each resolver keeps its group lists in its own config and calls it. A server-wide group list could not hold per-provider groups, and it would bring raw claims into core, which drops them today.
- The rule: a lone string is one group; an array keeps its string entries; any other shape matches no group; the highest match wins; groups compare exactly. A claim that matches no group gives the fallback, or a refusal when the fallback is null, so a deployment can turn away callers in no mapped group without scanning the claim twice. A claim over 1024 entries is also refused, checked before any entry is read. No refusal text holds the claim or a role. A resolver returns null, logs the reason and never logs the claim.
- Map a team-admin IdP group to editor, never admin, until team admin (EV6) ships: admin covers the whole tenant.
- Route auth 'caller' splits into 'viewer' and 'editor'. A viewer on an editor row gets 403 `VIEWER_REFUSAL`; admin rows keep their text.
- `DELETE /v1/auth/keys/:keyId` is a viewer row. `authRevoke` lets a resolver caller below admin revoke only the keys it minted, so a person demoted to viewer can still revoke the member key it minted as an editor. That key keeps its role until it is revoked or expires.
- An add-on route takes `level`, default 'editor'. A default of 'viewer' would open hook and telemetry writes. Mark a route 'viewer' only when it writes nothing.
- The exported write helpers (the `*ForCaller` functions and `captureSessionTexts`) trust the add-on route level: a route marked 'viewer' must write nothing.
- Both surfaces fail closed through one helper, `roleOrViewer` in `src/base/scope/role.ts`: 'admin' and 'member' stay, and every other value, a missing role included, reads as 'viewer'. Viewer sits below member, so the old rule "anything but admin is member" would now fail open. On HTTP, `sanitiseResolved` calls it, so a resolver role such as 'owner', 'Viewer' or 'editor' is refused every write except revoking a key it minted itself, and the first one logs a fixed warn line that leaves out the value. On MCP, `mcpRole` calls it, so a context with an unknown or no role is refused the write tools. A stdio tool call does pass a context: the CLI composition root (`src/surface/cli/api-context.ts`) sets role 'admin' with `hostAdmin`. Only a frame that is not `tools/call` passes none.
- The MCP write tools (`WRITE_TOOLS`) refuse a viewer before the read-only check.
- `canWrite(role)` allows only 'member' and 'admin'. The editor guard, self-mint and the MCP refusal all call it.
- `scopeReaderOf` and `storeActorOf` map a viewer to a member, so a store port takes admin or member only (`GraphViewQuery.reader` is a `StoreActor`). `ScopeReader` also decides by-id write rights, and this is safe because every by-id write sits behind an editor row or the MCP write-tool refusal. A new by-id write surface must take the editor level.
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
- Entra leaves the groups claim out above 200 groups (overage), so the fallback applies. A deployment that uses viewer passes fallback 'viewer', or an intended viewer can write; a null fallback refuses those users.
- A person demoted in the IdP keeps self-minted member keys until they are revoked or expire. A demoted viewer can revoke the keys it minted itself, and an add-on revokes them through the exported `authRevoke` when the IdP deprovisions the person.
- A resolver role outside admin, member and viewer now reads as viewer; it read as member before. Widening `Actor.role` breaks an exhaustive switch over it at compile time.
- An older core turns a resolver 'viewer' into a member, so an add-on that depends on viewer pins the core minor that ships this.
- `Actor.role`, `ResolvedBearer.role`, `McpCaller.role` and `ScopeActor.role` gain 'viewer'. `ScopeActor` also reaches store-kit and the store port `GraphRead.reader`.

## Follow-ups
- The write check lives in three surface adapters: the route table, the MCP `writeRefusal` and `authCreateSelf`. It does not live in the api module's write helpers, so a new surface must call `canWrite` itself.

## Reconsider when
- Viewer keys ship, or team admin (EV6) needs a fourth level.
- The exported write helpers need to refuse a role that fails `canWrite` themselves.
