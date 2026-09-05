# Plan: bearer-lockdown test covers the full route table

Episode 01M1S3GMRFSR1BG8E4TTCC28QZ (A3 item 7, batch 01M1S1M74R8RW419AK3W17FB7X). Source: feat/aml-deploy security review, advisory #6.

## Problem

`tests/server-bearer-lockdown.test.ts` pins a 401 on 12 hand-picked routes. `src/server.ts` `handleRequest` has 64 route sites: `GET /health` (public), two `PUBLIC_ROUTES` entries (Slack and GitHub webhooks, HMAC-authed), and 61 routes that must carry `buildContextWithAuth` or `requireAuth`. A new `/v1` route added without the auth call passes CI today.

## Root cause

The route table is an ordered if-chain in three shapes, so nothing in the code enumerates routes and the test's list is a hand copy that drifted as entity routes (predictions, decisions, incidents, processes, policies, skills, project briefs, customer notes, graph, context, outcome, sleep, sessions assemble, recall drill) were added.

| Shape | Count | Example |
|---|---|---|
| literal | 34 (incl. `GET /health`) | `if (method === 'GET' && path === '/v1/graph')` |
| matchPath | 7 | `const idMatch = matchPath('/v1/memories/:id', path);` then `if (method === 'DELETE' && idMatch)` |
| regex | 23 | `const decisionByIdMatch = path.match(/^\/v1\/decisions\/(\d+)$/);` then `if (method === 'GET' && decisionByIdMatch)` |

Counts measured at c130d7a with `grep -c "path === '/"`, `grep -c "= matchPath('"` and `grep -c 'path\.match(/\^'` on `src/server.ts` (34 + 7 + 23 = 64). The test re-derives them at runtime; nothing hard-codes these numbers.

## Options

- **A. Refactor `server.ts` into a route table array.** Rejected: 3,400-line ordered chain (`/v1/predictions/stats` must match before `/v1/predictions/:id`), high blast radius for a coverage item.
- **B. Test derives the route set from the `server.ts` source and asserts its own request table covers it exactly.** Chosen. `tests/audit-ops-*-lockstep.test.ts` already read `src/server.ts` source the same way.
- **C. Hit every derived route with an empty body, no table.** Rejected: most handlers (30 of the 44 sampled by an auth-order pass; the remaining regex-shape handlers follow the same pattern) validate the body or query before `buildContextWithAuth` (cheap-reject by design, see the cap comment near `POST /v1/outcome`), so an invalid request returns 400, never reaching the 401.

## Changes

### 1. `tests/server-bearer-lockdown.test.ts` (rewrite in place, same file name)

- `routesFromServerSource(text: string): Set<string>` returns `'METHOD /pattern'` keys from the three shapes. Regex routes: unescape `\/` and replace `(\d+)` with `:id`. matchPath and regex shapes take the method from the `if (method === 'X' && <name>Match)` line that follows the match assignment.
- Raw-shape guard: count the occurrences of `path === '/`, `matchPath('`, and `path.match(/^\/` inside `handleRequest` and assert the count equals the number of parsed keys. A fourth route shape then fails loudly instead of vanishing from the derived set.
- `publicRoutesFromServerSource(text)` parses the `PUBLIC_ROUTES` `Set([...])` literal; the test asserts it equals exactly `POST /v1/connectors/slack/events` and `POST /v1/connectors/github/events`, so a new public route is a deliberate test edit.
- `AUTHED_ROUTES: ReadonlyArray<{ method; pattern; query?; body? }>` lists every non-public route with a request shape that passes pre-auth validation. Request path is `pattern` with each `:param` replaced by `1` (regex routes need digits; `ID_SEGMENT_RE` accepts `1`) plus `query`.
- Completeness test: the set of `AUTHED_ROUTES` keys equals `derived - public - 'GET /health'`. On failure the message lists missing and extra keys.
- The two existing `it.each` blocks (missing header, bad token) stay and run over `AUTHED_ROUTES`. Failure message includes the response body so a 400 (wrong request shape) is diagnosable from CI output.
- `process.env.HIPPO_V1_RPS = '0'` is set before `serve()` and deleted in `afterEach`. `serve()` only builds a limiter when the value is finite and greater than zero, so `'0'` disables limiting entirely. Without it the default limiter (20 rps, burst 40) would 429 the roughly 122 `/v1` requests the expanded file sends. Vitest runs each file in its own fork, so the env edit does not leak to other files.
- `HIPPO_REQUIRE_AUTH=1` stays.

### 2. `src/server.ts`

No code change. The comment above `PUBLIC_ROUTES` already says new unauth routes need a test entry; it stays.

### 3. `CHANGELOG.md`

New `## 1.38.2 - unreleased` heading above 1.38.1 with a `### Tests` bullet describing the source-derived completeness check. The heading form has no precedent inside CHANGELOG.md; it is this batch's convention (PR #164 adds the identical heading) and the batch deploy gate replaces `unreleased` with the date when the version is bumped. The rebase script `resolve-changelog.py` merges the two sections.

### 4. `TODOS.md`

No entry exists for this item. Nothing to update.

## Verification

1. Red first: run the new completeness test against the old 12-entry list. It must fail and name the missing routes.
2. Green: `node ./node_modules/vitest/vitest.mjs run tests/server-bearer-lockdown.test.ts` passes (61 routes x 2 + completeness + public-set + shape-guard tests). `npm run build`, `npx tsc --noEmit`, `npx oxlint` clean.
3. Mutation A (scratch, reverted): add `if (method === 'GET' && path === '/v1/zzz') { sendJson(res, 200, {}); return; }` to `handleRequest`. The completeness test must fail naming `GET /v1/zzz`.
4. Mutation B (scratch, reverted): delete the `buildContextWithAuth` call from one handler, for example `GET /v1/decisions`. Both 401 tests for that route must fail.
5. Full suite once before the PR (known flakes: `tests/session-end-snapshot-close.test.ts`, vitest worker IPC exit 1 with 0 failures).

## Risks

- Source parsing is coupled to the three shapes. The raw-shape guard turns a new shape into a red test with a clear message.
- A handler that tightens validation later breaks its lockdown row with a 400. The failure message carries the body, and the fix is a one-line table edit.
- `POST /v1/sleep` checks `isLoopback` before `buildContextWithAuth`, so a non-loopback caller sees 403 first. The test binds 127.0.0.1, so the loopback check passes and the 401 is reached. If the server ever moves that check after auth, the row still passes.
- No behavior change in the server, so no runtime risk.
