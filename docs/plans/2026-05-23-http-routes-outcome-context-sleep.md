# HTTP routes: /v1/outcome + /v1/context + /v1/sleep (Episode B of 3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 3 HTTP routes to `src/server.ts` wrapping the Episode A api exports. Each route follows the established pattern (if-block with method + path, `buildContextWithAuth`, body / query parsing, `sendJson`). v1.11.4 PATCH bump (additive routes, zero existing behavior change).

**Architecture:** Each route is a thin wrapper. `api.outcome` / `api.outcomeForLastRecall` / `api.getContext` / `api.sleep` shipped in Episode A — all already exported, tenant-aware where applicable, with audit emission where applicable. The HTTP routes parse input, validate, build `Context`, call the api, JSON-serialise the result.

**Tech Stack:** Existing HTTP server (`src/server.ts`). No new dependencies. vitest real-HTTP tests against the running `serve()` instance.

**Why this episode exists:** Episode A's api exports unblocked HTTP wrapping; Episode C's Python SDK needs HTTP endpoints to call. Each api function maps to one route.

---

## Research notes (completed in discover)

- `src/server.ts:423` `handleRequest`: every route is a separate `if (method && path)` block. Standard internals: `parseJsonBody(req)` for POST bodies, `query.get('name')` for GET params, `HttpError(400, msg)` for invalid input, `sendJson(res, 200, result)` for the success response, `buildContextWithAuth(req, opts.hippoRoot)` for the Context (handles Bearer auth, sets `ctx.actor` to `'api_key:<id>'` or `'localhost:cli'`).
- `src/server.ts:455-460`: `/v1/*` paths are rate-limited per-IP via the token-bucket `limiter`. New routes inherit this automatically.
- `src/server.ts:436` `/health` and non-`/v1` paths skip the rate limit.
- Existing 10 routes: POST /v1/memories (remember), GET /v1/memories (recall), GET /v1/recall/drill/:id, POST /v1/memories/:id/archive, POST /v1/memories/:id/supersede, POST /v1/memories/:id/promote, DELETE /v1/memories/:id (forget), POST /v1/auth/keys, GET /v1/auth/keys, DELETE /v1/auth/keys/:keyId, GET /v1/audit, POST /v1/connectors/{slack,github}/events.
- `src/server.ts` `serve()` binds loopback-only today. All routes are reachable only from localhost. This is the implicit trust boundary for the 3 new routes.
- Episode A's api.sleep operates on the WHOLE hippoRoot (cross-tenant by design), matching CLI cmdSleep. The api.ts docstring flags this for Episode B: HTTP `/v1/sleep` should either gate to admin role OR rely on loopback-only binding.

---

## Task 1: Branch

`git checkout -b feat/http-routes-outcome-context-sleep` from master tip `668e738`. Confirm clean tree.

---

## Task 2: POST /v1/outcome

**Files:** Modify `src/server.ts`, create `tests/server-outcome-route.test.ts`.

**Contract:**
- Request body: `{"ids": ["mem_a", "mem_b"], "good": true}` OR `{"good": true}` (no ids = last-recall path).
- Validation: `good` is required boolean. `ids` is optional array of non-empty strings (if present, every element must be a non-empty string).
- Response 200: `{"applied": N, "ids": ["mem_a", "mem_b"]}` (ids field present only when last-recall path was used so callers can disambiguate "no recall" from "all skipped").
- Response 400: `good is required boolean` / `ids must be an array of non-empty strings`.

**Step 1: Failing tests** (real HTTP, real DB):
- `POST /v1/outcome with ids` -> 200, `applied` matches number of valid ids.
- `POST /v1/outcome without ids uses last-recall` -> seed memories, run GET /v1/memories?q=... to populate last_retrieval_ids, then POST /v1/outcome -> applied matches.
- `POST /v1/outcome without ids and no last recall` -> 200, `applied: 0`, `ids: []`.
- `POST /v1/outcome with missing good` -> 400.
- `POST /v1/outcome with non-boolean good` -> 400.
- `POST /v1/outcome with ids: "not-an-array"` -> 400.
- `POST /v1/outcome emits one audit_log row per applied id` (op='outcome', actor matches Bearer's actor).
- `POST /v1/outcome with cross-tenant id returns applied:0 and writes ZERO audit_log rows` (per the documented "silently skipped" behavior in api.outcome; seed memory under tenant_b, call route with tenant_a Bearer + that id).

**Step 2: Implementation sketch:**

```typescript
// POST /v1/outcome
if (method === 'POST' && path === '/v1/outcome') {
  const body = await parseJsonBody(req);
  const good = body['good'];
  if (typeof good !== 'boolean') {
    throw new HttpError(400, 'good is required (boolean)');
  }
  const idsRaw = body['ids'];
  let ids: string[] | undefined;
  if (idsRaw !== undefined) {
    if (!Array.isArray(idsRaw)) {
      throw new HttpError(400, 'ids must be an array of non-empty strings');
    }
    for (const id of idsRaw) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new HttpError(400, 'ids must be an array of non-empty strings');
      }
    }
    ids = idsRaw;
  }
  const ctx = buildContextWithAuth(req, opts.hippoRoot);
  if (ids !== undefined) {
    const { applied } = outcome(ctx, ids, good);
    sendJson(res, 200, { applied });
  } else {
    const result = outcomeForLastRecall(ctx, good);
    sendJson(res, 200, result); // { applied, ids }
  }
  return;
}
```

**Step 3: Commit** `feat(server): POST /v1/outcome wrapping api.outcome + outcomeForLastRecall`.

---

## Task 3: GET /v1/context

**Files:** Modify `src/server.ts`, create `tests/server-context-route.test.ts`.

**Contract:**
- Request: query params. All optional: `q` (string), `budget` (positive number, default 1500), `limit` (positive number), `pinned_only` ('1' / 'true'), `scope` (string), `include_recent` (non-negative number).
- Response 200: `ContextResult` JSON: `{entries: [...], tokens: N, activeSnapshot?: {...}, sessionHandoff?: {...}, recentEvents?: [...]}`. No `rendered` / `format` / `framing` fields (those are CLI-only — see Episode A T5 scope narrow).
- Response 400: invalid budget / limit / include_recent / scope length.

**Step 1: Failing tests** (real HTTP, real DB):
- `GET /v1/context with seed memories` -> 200, `entries.length > 0`, `tokens` populated.
- `GET /v1/context?budget=50` -> 200, `tokens <= 50`.
- `GET /v1/context?q=foo` -> 200, entries match query.
- `GET /v1/context?pinned_only=1` -> 200, only pinned entries.
- `GET /v1/context with activeSnapshot seeded` -> 200, `activeSnapshot` populated.
- `GET /v1/context?budget=0` -> 200, `entries: []` (short-circuit).
- `GET /v1/context?budget=-1` -> 400.
- Tenant scoping: tenant_a Bearer never sees tenant_b memories.
- `GET /v1/context emits one 'recall' audit row when query triggers hybrid search` (matches api.getContext audit behavior; pinned_only + '*' fallback paths emit zero — same as cmdContext).

**Step 2: Implementation sketch:**

```typescript
// GET /v1/context
if (method === 'GET' && path === '/v1/context') {
  const q = query.get('q') ?? undefined;
  const budgetRaw = query.get('budget');
  let budget: number | undefined;
  if (budgetRaw !== null) {
    budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || budget < 0) {
      throw new HttpError(400, 'budget must be a non-negative number');
    }
  }
  const limitRaw = query.get('limit');
  let limit: number | undefined;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new HttpError(400, 'limit must be a positive number');
    }
  }
  const pinnedOnlyRaw = query.get('pinned_only');
  const pinnedOnly = pinnedOnlyRaw === '1' || pinnedOnlyRaw === 'true';
  const scopeRaw = query.get('scope');
  if (scopeRaw !== null && scopeRaw.length > 256) {
    throw new HttpError(400, 'scope exceeds 256-character cap');
  }
  const scope = scopeRaw === null ? undefined : scopeRaw;
  const includeRecentRaw = query.get('include_recent');
  let includeRecent: number | undefined;
  if (includeRecentRaw !== null) {
    includeRecent = Number(includeRecentRaw);
    if (!Number.isFinite(includeRecent) || includeRecent < 0) {
      throw new HttpError(400, 'include_recent must be a non-negative number');
    }
  }
  const ctx = buildContextWithAuth(req, opts.hippoRoot);
  const result = await getContext(ctx, {
    q,
    budget,
    limit,
    pinnedOnly,
    scope,
    includeRecent,
  });
  sendJson(res, 200, result);
  return;
}
```

**Step 3: Commit** `feat(server): GET /v1/context wrapping api.getContext`.

---

## Task 4: POST /v1/sleep

**Files:** Modify `src/server.ts`, create `tests/server-sleep-route.test.ts`.

**Contract:**
- Request body: `{"dry_run"?: boolean, "no_share"?: boolean}` (both optional, default false).
- Response 200: `SleepResult` JSON: `{active, removed, mergedEpisodic, newSemantic, dryRun, deduped?, audit?, shared?, ambient?, details?}`.
- Response 400: non-boolean dry_run / no_share.

**Tenant scope decision (per Episode A follow-ups TODOS.md):** api.sleep operates HOST-WIDE (cross-tenant), matching the CLI's cmdSleep. The HTTP route MUST not silently allow a tenant-A Bearer to dedupe / delete tenant-B's rows. **Chosen approach: loopback-only enforcement + explicit docstring.** Rationale:
- `serve()` already binds loopback-only today, so the route is unreachable from outside the host machine.
- Adding an `admin` role check requires schema work (auth.ts API key role field) that doesn't exist yet — out of scope for v1.11.4.
- The route docstring + CHANGELOG entry explicitly call out the host-wide semantic so future non-loopback deployments tighten before exposing.
- Tracked in `TODOS.md` for a future minor (v1.12.0?) once non-loopback serving lands.

**Step 1: Failing tests** (real HTTP, real DB):
- `POST /v1/sleep with empty body` -> 200, SleepResult with zero counters on empty store.
- `POST /v1/sleep {"dry_run": true}` -> 200, `dryRun: true`, no deduped/audit/shared/ambient fields populated.
- `POST /v1/sleep with seeded memories` -> 200, full pipeline ran.
- `POST /v1/sleep {"no_share": true}` -> 200, `shared` undefined regardless of autoShareOnSleep config.
- `POST /v1/sleep with non-boolean dry_run` -> 400.
- `POST /v1/sleep with tenant_b Bearer dedupes / deletes tenant_a memories` (positive test asserting the documented host-wide semantic is intentional; seed near-duplicate memories under both tenants, call /v1/sleep with tenant_b Bearer, verify a tenant_a near-duplicate was removed). This test is the explicit breaking-change marker for the future per-tenant sleep migration tracked in TODOS.md.
- `POST /v1/sleep from non-loopback origin -> 403` (defensive per-request guard; see Step 2 below).

**Step 2: Implementation sketch:**

```typescript
// POST /v1/sleep — host-wide consolidation. serve() refuses non-loopback
// hosts at boot (server.ts:1426-1431) so the host-wide semantic is safe at
// steady state. The per-request loopback assertion below makes this
// structurally fail-closed: if a future A5 v2 change relaxes the boot guard,
// /v1/sleep stays loopback-only without a code change.
if (method === 'POST' && path === '/v1/sleep') {
  const remote = req.socket.remoteAddress ?? '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopback) {
    throw new HttpError(403, '/v1/sleep is loopback-only (host-wide consolidation; see CHANGELOG v1.11.4)');
  }
  const body = await parseJsonBody(req);
  const dryRunRaw = body['dry_run'];
  if (dryRunRaw !== undefined && typeof dryRunRaw !== 'boolean') {
    throw new HttpError(400, 'dry_run must be a boolean');
  }
  const noShareRaw = body['no_share'];
  if (noShareRaw !== undefined && typeof noShareRaw !== 'boolean') {
    throw new HttpError(400, 'no_share must be a boolean');
  }
  const ctx = buildContextWithAuth(req, opts.hippoRoot);
  const result = await sleep(ctx, {
    dryRun: dryRunRaw === true,
    noShare: noShareRaw === true,
  });
  sendJson(res, 200, result);
  return;
}
```

The defensive per-request guard is belt-and-suspenders: serve() already refuses non-loopback at boot, but the 3-line check above makes the host-wide semantic fail-closed regardless of any future serve() boot-config change.

**Step 3:** Update `src/api.ts` `sleep` JSDoc to reflect that the loopback-only enforcement is now the explicit guard (instead of "MUST gate before going live"). The TODOS.md entry stays — non-loopback bind is still the long-term concern.

**Step 4: Commit** `feat(server): POST /v1/sleep wrapping api.sleep (loopback-only guard documented)`.

---

## Task 5: Imports + route registration

**Files:** `src/server.ts` imports.

Add to the existing api.js import (currently imports remember, recall, etc.):
- `outcome`
- `outcomeForLastRecall`
- `getContext`
- `sleep`

The route blocks slot into `handleRequest` in handler order. Convention: insert grouped near related routes (outcome near /v1/memories, context near /v1/recall, sleep near /v1/audit or at the end before connectors).

This is bundled into Tasks 2/3/4's commits, no separate commit.

---

## Task 6: CHANGELOG + version bump

CHANGELOG entry (1.11.4, prepended above 1.11.3):

```markdown
## 1.11.4 (2026-05-23): HTTP routes for outcome / context / sleep

Three new HTTP routes added to `src/server.ts`, wrapping the api exports shipped in v1.11.3. Each route is loopback-only (the same trust boundary the rest of the v1 surface already uses).

- **POST /v1/outcome** — apply a positive / negative outcome to memory ids. Body: `{"ids"?: string[], "good": boolean}`. If `ids` omitted, falls back to the last-recall path (`api.outcomeForLastRecall`); returned shape is `{applied, ids}` in that case so callers can disambiguate "no recent recall" from "all ids skipped". Each applied id writes one audit_log row (op='outcome', actor from Bearer).
- **GET /v1/context** — assemble a budget-bounded context bundle. Query params: q?, budget?, limit?, pinned_only?, scope?, include_recent?. Returns ContextResult JSON (entries + tokens + activeSnapshot + sessionHandoff + recentEvents). No server-side rendering; clients render. Tenant-scoped via the Bearer.
- **POST /v1/sleep** — run the storage consolidation pipeline. Body: `{"dry_run"?: boolean, "no_share"?: boolean}`. Returns SleepResult JSON. **Host-wide semantic** (operates on the whole hippoRoot, not per-tenant), matching CLI `hippo sleep`. Loopback-only enforcement via `serve()`'s bind; before non-loopback serving lands, a tenant-A Bearer cannot reach this route from off-host. TODOS.md tracks the per-tenant scoping follow-up for the day non-loopback serving lands.

All three routes inherit the existing `/v1/*` per-IP token-bucket rate limit (`HIPPO_V1_RPS`, default 20 rps with 2x burst; `src/rate-limit.ts`). Operators sweeping sleep / context at high frequency will see 429s once the bucket drains.

Unlocks the v0.1.0 Python SDK (`pip install hippo-memory`, Episode C) which thin-wraps these HTTP routes.

### Shipped

- Three new routes in `src/server.ts` following the established if-block pattern (`buildContextWithAuth` + body / query validation + `sendJson` + `HttpError(400)` for invalid input).
- Imports for the 4 Episode A api exports (outcome, outcomeForLastRecall, getContext, sleep) added to the api.js import.

### Tests

Three new test files: `server-outcome-route` (7 real-HTTP cases), `server-context-route` (~9 real-HTTP cases), `server-sleep-route` (5 real-HTTP cases). Each spawns a real `serve()` instance against an isolated tmp HIPPO_HOME and exercises the route via `http.request`. Full suite green.

### Out of scope

- Per-tenant sleep scoping for /v1/sleep (tracked in TODOS.md "Episode A follow-ups"; needs non-loopback serving + admin-role gate).
- `POST /v1/sleep` does not emit `audit_log` rows for dedup / audit-delete phases (matches api.sleep parity). Tracked in TODOS.md "Episode A follow-ups" under "audit_log on consolidation phases" — addressed in a future minor, not this PATCH release.
- Render helpers in api.ts for shared markdown/json/additional-context output (Python SDK consumers render client-side for v0.1; tracked in TODOS.md).
- `ContextResult.entries` returned by GET /v1/context exposes the full `MemoryEntry` surface (not the CLI's projected json subset). Python SDK consumers in Episode C will receive richer payloads than `hippo context --format json`. Documented in TODOS.md.
```

Version pins (6 manifests): package.json, package-lock.json (2 sites), src/version.ts, openclaw.plugin.json, extensions/openclaw-plugin/{openclaw.plugin.json, package.json} — all 1.11.3 -> 1.11.4.

**Commit** `docs+chore: CHANGELOG + version bump 1.11.3 -> 1.11.4`.

---

## Verify

- `npm test` — exit=0 with all existing tests passing + new server-route tests passing.
- `npx tsc --noEmit` — clean.
- Manual smoke:
  - `node dist/src/cli.js serve` in a tmp HIPPO_HOME; in another shell, `curl -X POST http://localhost:3737/v1/outcome -H 'Authorization: Bearer ...' -d '{"good":true}'` -> JSON response.
  - Same shape smokes for /v1/context (GET with query) and /v1/sleep (POST with dry_run).

---

## Review

- `/self-review` on diff.
- `independent-review-critic`: brief on route correctness, input validation (HTTP 400 paths), tenant scoping (does buildContextWithAuth correctly set ctx.tenantId? Are all api calls tenant-scoped by api.ts already?), loopback-only enforcement claim for /v1/sleep (no admin-role check in this PR — flag as known limitation).

---

## Ship + Deploy

- `/ship-check`, `ship-readiness-critic`.
- PR `feat/http-routes-outcome-context-sleep`, title `feat(server): POST /v1/outcome + GET /v1/context + POST /v1/sleep (v1.11.4)`.
- Human-final-gate.
- npm publish 1.11.4, tag v1.11.4, GitHub Release.

---

## Success criteria

- [ ] `src/server.ts` exposes POST /v1/outcome, GET /v1/context, POST /v1/sleep.
- [ ] Each route correctly maps to the Episode A api function and returns the documented JSON shape.
- [ ] Input validation throws HttpError(400) for all documented invalid cases.
- [ ] Tenant scoping via buildContextWithAuth's ctx.tenantId is preserved through to the api layer.
- [ ] /v1/sleep loopback-only guard is documented in route comment + CHANGELOG.
- [ ] Full suite green, exit=0.
- [ ] 3 new test files: server-outcome-route, server-context-route, server-sleep-route.
- [ ] CHANGELOG 1.11.4 entry present.
- [ ] Version 1.11.4 across all 6 manifests.
- [ ] PR merged, npm published.

---

## Out of scope (Episode C)

- Python SDK at `python/` subdir, pip install hippo-memory, async httpx client wrapping these 3 routes + the existing 10. Plus pydantic v2 models, real-server tests, 3 example scripts, PyPI publish workflow.
- Per-tenant /v1/sleep gating (tracked in TODOS.md as Episode B's own carry-forward).
- Shared rendering helpers in api.ts (Episode B follow-up if Python SDK consumers want server-rendered markdown).
