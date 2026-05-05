# v1.6.4 — Error distinguishability + path matcher hardening

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address two of the deferred items from the v1.6.2 senior review and the v1.6.3 codex round. Both are caller-debuggability fixes — no behaviour change for happy paths, more useful errors for the rest.

1. **`drillDown` HTTP collapses 4 distinct error cases into one 404.** Pre-v1.6.4: unknown id, wrong tenant, scope-blocked, and "this is a leaf, not a summary" all return `{status: 404, body: 'No drillable summary at this id'}`. Caller can't tell why. Tenant + scope cases are intentionally indistinguishable from "not found" (probing defence). The leaf case isn't sensitive — should be a 422 with a clear message.

2. **HTTP path matcher slash handling on `:id` segments.** Senior review flagged that path-template `/v1/sessions/:id/assemble` and `/v1/recall/drill/:id` use a simple `/` split, so an id containing `/` (URL-encoded as `%2F`, decoded by Node's URL parser) silently 404s. Two fixes options: (a) document the allowed charset and reject ids containing `/` with 400; (b) accept `%2F`-encoded ids by walking the raw path. (a) is simpler and matches the real-world id shapes Hippo emits (no slashes ever).

**Architecture.**
- `drillDown` (`api.ts`) returns `null` for four distinct cases. Add an optional `reason: 'not_found' | 'wrong_tenant' | 'scope_blocked' | 'not_drillable'` discriminator that callers can use to render better errors. Internal-only — JS callers can choose to surface it; HTTP route maps `not_drillable` to 422 and the other three to 404.
- HTTP `matchPath` (`server.ts`) — add an explicit charset check on `:id` captures: reject `id` containing `/` or unescaped chars not in `[A-Za-z0-9_:.-]` with 400. Document the allowed charset.

**Out of scope.** CLI fresh-tail refactor (own plan, own session). Hardcoded `score: 0.5` re-rank semantics. `localeCompare` micro-perf. `loadFreshRawMemories` tenant-wide deprecation. None of these block consumer adoption.

**Pre-conditions.**
- v1.6.3 master is `7f3754b`, CI green, 1320 tests passing.
- `drillDown` already passes through `api.ts` lines ~640-690.
- `matchPath` lives in `server.ts` near the route block.

---

### Task 1: `drillDown` reason discriminator

**Files:**
- Modify: `src/api.ts` — add `DrillDownFailure` shape + return discriminated result
- Modify: `src/server.ts` — map `not_drillable` to 422
- Modify: `src/cli.ts`, `src/mcp/server.ts` — surface the reason in error text
- Create: `tests/dag-drill-down-errors.test.ts`

**Approach.** Change `drillDown`'s return from `DrillDownResult | null` to `DrillDownResult | DrillDownFailure`, where `DrillDownFailure = { ok: false; reason: 'not_found' | 'wrong_tenant' | 'scope_blocked' | 'not_drillable' }`. JS callers gain a discriminator; HTTP maps reason to status. CLI + MCP render a clearer message.

**Backward compat.** This is a public API shape change. Existing callers receiving `null` will need a tweak — either a `result === null || result.ok === false` check, or just `'ok' in result === false`. To avoid breaking, expose both paths: keep the `null` return for the common pattern, add a new `drillDownExplain(...)` function that returns the discriminated shape. HTTP/CLI/MCP use `drillDownExplain` internally, JS callers can pick.

**Reconsidered.** Simpler: extend `DrillDownResult` to ALWAYS return a non-null object, with an optional `failure?: { reason: string }` field on it. When failure is set, `summary` and `children` are omitted. Cleaner one-shape API, no migration.

Cleanest: keep the existing `DrillDownResult | null` for the JS API (backwards compat), add an OPTIONAL second arg `{ explain?: boolean }` that — when true — returns `DrillDownResult | { failure: 'reason' }` instead of null. HTTP path passes `explain: true` to get the reason for status mapping.

**Step 1: Single discriminated return type. NO overloads.**

Both reviewers flagged my original overload pattern as brittle and the cross-tenant probe as an info-leak. Revised:

```ts
export interface DrillDownFailure {
  failure: 'not_found' | 'scope_blocked' | 'not_drillable';
}
export type DrillDownOutcome = DrillDownResult | DrillDownFailure;

export function drillDown(ctx: Context, summaryId: string, opts: DrillDownOpts = {}): DrillDownOutcome {
  const summary = readEntry(ctx.hippoRoot, summaryId, ctx.tenantId);
  // v1.6.4 review consolidated revision: NO unscoped cross-tenant probe.
  // wrong-tenant collapses into not_found. The earlier draft probed via
  // `readEntry(ctx.hippoRoot, summaryId)` (no tenant) to discriminate
  // wrong-tenant — that exposed cross-tenant existence. Reviewer correctly
  // flagged it as a real info-leak. Always return not_found here.
  if (!summary) return { failure: 'not_found' };
  if ((summary.dag_level ?? 0) < 2) return { failure: 'not_drillable' };
  if (!passesScopeFilterForRecall(summary.scope ?? null, undefined)) {
    return { failure: 'scope_blocked' };
  }
  // ...rest unchanged, returns DrillDownResult
}
```

**Three failure cases mapping to status codes:**
- `not_found` → 404 (covers genuinely-missing AND wrong-tenant; intentional collapse)
- `not_drillable` → 422 (leaf id; topology leak acceptable for authorised tenant)
- `scope_blocked` → 404 (don't leak scope grants)

**Migration of existing callers.** CLI / MCP / HTTP / 1 JS test consumer all check `'failure' in result` instead of `result === null`. The `null` return goes away entirely — single shape, simpler types. Internal callers list:
- `src/cli.ts` cmdDrillDown
- `src/mcp/server.ts` hippo_drill case
- `src/server.ts` /v1/recall/drill/:id route
- `tests/dag-drill-down.test.ts` (asserts null)

Charset/length validation in Task 2 is a separate concern.

**Acknowledged trade-off (`not_drillable` info-leak).** A probing authorised caller can enumerate ids and learn which are leaves vs summaries. Reviewer flagged this as P1; my prior draft punted to "acceptable". Honest answer: it's a topology leak bounded by tenant access. Distinguishing leaf-vs-summary is data the caller already has access to (they could just `readEntry` and check `dag_level`). The 422 doesn't add information beyond what `recall` + `drill` already expose. Documented; no `HIPPO_EXPLAIN_ERRORS` env gate.

**Step 2: HTTP route maps.**

```ts
const result = drillDown(ctx, drillMatch.id!, { ...opts, explain: true });
if ('failure' in result) {
  if (result.failure === 'not_drillable') {
    throw new HttpError(422, 'Id is a leaf row, not a level-2+ summary; nothing to drill into');
  }
  throw new HttpError(404, 'No drillable summary at this id');
}
sendJson(res, 200, result);
```

**Step 3: CLI + MCP render reason.**

CLI prints `Error: Id is a leaf row, not a level-2+ summary` instead of generic `No drillable summary at id=...`. MCP returns the same string in the tool response.

**Step 4: Tests.**

`tests/dag-drill-down-errors.test.ts`:
1. `drillDown` with `explain:true` on unknown id returns `{failure:'not_found'}`.
2. Same on a leaf id returns `{failure:'not_drillable'}`.
3. Same on a private summary (no scope grant) returns `{failure:'scope_blocked'}`.
4. Same on cross-tenant id returns `{failure:'not_found'}` (intentionally collapsed).
5. HTTP 404 for unknown id.
6. HTTP 422 for leaf id.
7. HTTP 404 for cross-tenant id (info-leak guard).
8. CLI prints reason in error message.

---

### Task 2: HTTP `:id` charset validation

**Files:**
- Modify: `src/server.ts` — `matchPath` adds charset check; new helper `validateIdSegment`
- Modify: existing routes that use `:id` — add `validateIdSegment` call

**Approach.** Hippo emits ids in the shape `mem_<hex>`, `sum_<hex>`, `sess-<alnum>`, etc. None contain `/`. URL-encoded slashes (`%2F`) decode to `/` after Node's URL parser; if a caller smuggles one, the path-split happens on the decoded string and the route silently 404s.

Simplest fix: add an `validateIdSegment(id, allowedChars = /^[A-Za-z0-9_:.\-]+$/)` helper. Routes that use `:id` call it after `matchPath` and throw 400 on violation.

**Step 1: Pre-match raw-pathname slash check.** Both reviewers flagged P0 that `matchPath` splits BEFORE my validator runs — a request to `/v1/recall/drill/foo%2Fbar` decodes to `/v1/recall/drill/foo/bar` BEFORE matching, segment count mismatches, route 404s without ever reaching the validator. Fix: a top-of-handler raw-URL check that rejects encoded slashes before path parsing.

```ts
// In handleRequest, before any matchPath calls:
const rawPath = req.url ?? '/';
if (/%2[Ff]/.test(rawPath)) {
  throw new HttpError(400, 'URL-encoded slash (%2F) not allowed in path segments');
}
```

The `req.url` raw value preserves percent-encoded sequences. We test BEFORE Node's URL parser decodes. Now the existing route table works as documented and `validateIdSegment` (Step 2) catches everything else.

**Step 2: Post-match charset helper.**

```ts
const ID_SEGMENT_RE = /^[A-Za-z0-9_:.\-]+$/;
function validateIdSegment(id: string, fieldName: string): void {
  if (id.length === 0) throw new HttpError(400, `${fieldName} is required`);
  if (id.length > 256) throw new HttpError(400, `${fieldName} exceeds 256-character cap`);
  if (!ID_SEGMENT_RE.test(id)) {
    throw new HttpError(400, `${fieldName} contains invalid characters; allowed: A-Z a-z 0-9 _ : . -`);
  }
}
```

**Charset audit step (P1 from review).** Before coding, grep id-emitting code paths to verify the whitelist `[A-Za-z0-9_:.-]` covers every production id format:

```bash
grep -rn "generateId\|\\bgenerateMemoryId\\b\\|\\bsum_\\|\\bmem_\\|\\bsess[-_]" src/
```

Hippo-emitted ids: `mem_<hex>` ✓, `sum_<hex>` ✓, `sess-<id>` ✓, `B01ABCD` (Slack bot ids) ✓. Github connector `artifact_ref` (`github://owner/repo/issue/N`) IS NOT a path segment — it's a body field. The whitelist is sufficient. Confirm by audit; if anything new turns up, extend before shipping.

**Step 3: Apply to existing `:id` routes.**

`/v1/memories/:id`, `/v1/memories/:id/archive`, `/v1/memories/:id/supersede`, `/v1/memories/:id/promote`, `/v1/recall/drill/:id`, `/v1/sessions/:id/assemble`. All call `validateIdSegment(matchedId, '<field>')` immediately after `matchPath`.

**Pre-flight grep for in-tree 422/404 handlers (P1 from review).** Before shipping:

```bash
grep -rn "status === 4\|status === 422\|status === 404\|response.status" src/cli src/mcp tests/
```

If any internal consumer treats 404 specifically and would miss the new 422, update + add a regression test. Likely zero in-tree consumers since drillDown is consumed via the JS API, not via HTTP from inside the repo.

**Step 4: Tests.**

`tests/http-id-validation.test.ts`:
1. Drill route 400 on `id` containing raw `/` in body — though raw `/` in URL won't reach here because matchPath segment-splits first. Verify by route, not assertion.
2. Drill route 400 on URL-encoded `%2F` (caught by pre-match raw-path check)
3. Drill route 400 on lowercase `%2f` (case-insensitive regex)
4. Drill route 400 on space, semicolon, ampersand (caught by `validateIdSegment`)
5. Drill route 200 on a valid id with allowed chars
6. Sessions assemble route 400 on invalid id (charset)
7. Memories route 400 on invalid id (charset)
8. **Length cap boundaries (P2 from review):** 256-char id → 200 OK; 257-char id → 400.
9. **Empty-id boundary:** does matchPath capture an empty segment? Verify behaviour and assert.
10. **422 body assertion:** drill on a leaf id returns 422 with body containing "leaf row"; regression guard against someone "fixing" the message back to a generic "Not Found".

---

### Task 3: Documentation + ship

CHANGELOG entry with the four reasons drillDown now distinguishes (plus the deliberate collapse of wrong-tenant into not-found for info-leak), the new HTTP 422 status code, and the charset cap. README "What's new in v1.6.4" — terse.

Bump 5 manifests + lockfile + version.ts to 1.6.4. Patch (no breaking changes — error codes get more specific but existing 404 → 422 transition is allowed by every HTTP client I'm aware of).

**Verification.**
- `npx vitest run` → 1335+ passing
- `node scripts/ci-seed-provenance.mjs` → exit 0
- CI green on master after push

---

## Risk register

- **Information leak via `not_drillable`.** The 422 leaks "this id exists, just isn't a summary". A probing attacker could enumerate ids and learn which are leaves. Mitigation: the same id resolved as `not_found` for cross-tenant or scope-blocked; only authorised tenants in valid scopes see `not_drillable`. Trade-off: caller debuggability for authorised callers > probing surface for the same authorised caller.
- **Charset whitelist too restrictive.** Future id formats (e.g. UUIDs with `+` if base64-encoded) might need additional chars. Mitigation: regex is one-line to update.
- **Existing tests using `id` shapes.** Hippo's `mem_<hex>`, `sum_<hex>`, `sess-<id>` all match the whitelist. Github connector ids (`github://owner/repo/issue/N`) use `://` — the `:` is in the whitelist, but `/` isn't. Github ids are scope-internal, never URL path segments. Confirm none of the routes accept github-style artifact_refs as path ids.
