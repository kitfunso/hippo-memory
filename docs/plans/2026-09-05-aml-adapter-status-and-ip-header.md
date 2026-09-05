# AML adapter: pin status pass-through and the forwarded client-IP header

Episode 01M1S688Z5SHGAR9GNA7FEXJPQ. Backlog A3 item 8 (Fable advisory 2026-08-25).

## Problem

`tests/aml-adapter.test.ts` boots a real hippo server plus the real adapter
process and covers happy paths, isolation, auth and validation. It never pins
two release-safety behaviours of `deploy/aml/adapter/adapter.mjs`:

1. A hippo non-200 that is not a 401 surfaces through the adapter with the
   same status and hippo's error body. Today `handleAdd` / `handleSearch` do
   `sendJson(res, status, hippoErrorBody(hippoBody))`; a regression that
   mapped every upstream outcome to 200 would pass the suite.
2. The adapter forwards the inbound `cf-connecting-ip` header to hippo as
   `cf-connecting-ip`, and forwards no other client-address header. Production
   (`deploy/aml/docker-compose.yml`) sets `HIPPO_CLIENT_IP_HEADER=cf-connecting-ip`,
   so hippo's `/v1` rate limiter keys per real client only if this holds. A
   regression that dropped the header, or read `x-forwarded-for` instead,
   would pass the suite.

## Facts read from source

- `adapter.mjs` `clientIpOf` reads only `cf-connecting-ip`; `callHippo` sets
  `cf-connecting-ip` on the upstream request only when that value is a
  non-empty string. Non-200 upstream statuses are returned verbatim with
  `hippoErrorBody` (`{error}` from hippo when present).
- `src/server.ts:567` `clientIpForRateLimit` reads `process.env.HIPPO_CLIENT_IP_HEADER`
  **per request** (not at boot) and falls back to `req.socket.remoteAddress`.
- `src/server.ts:751-756`: the limiter runs on every `/v1/*` path before auth
  and throws `HttpError(429, 'rate limit exceeded')`.
- `src/server.ts:3351-3355`: `HIPPO_V1_RPS` is read at `serve()` boot; burst is
  `rps * 2`. `HIPPO_V1_RPS=0.5` gives burst 1: a fresh key admits exactly one
  request, then refills at 0.5 tokens/s (2 s per token).
- `createRateLimiter` (`src/rate-limit.ts`) seeds an unseen key with a full
  bucket, so the first request on any new key always passes.

## Design: a second real server pair, no mocks

Add a second `describe` block to `tests/aml-adapter.test.ts` that boots its
own hippo (`serve` in-process, `HIPPO_REQUIRE_AUTH=1`) and its own adapter
child process, with the production limiter env:

```
HIPPO_CLIENT_IP_HEADER=cf-connecting-ip   (production compose value)
HIPPO_V1_RPS=0.5                          (burst 1: one request per fresh key)
```

The existing `beforeAll` spawn block becomes a top-level `spawnAdapter(hippoPort)`
helper returning `{ process, baseUrl }` plus a `stopAdapter`, used by both
describes (rule 8: hoist, do not clone). Store root and api-key creation follow
the existing block exactly.

Both env vars are set in the second describe's `beforeAll` and restored in its
`afterAll`. `HIPPO_CLIENT_IP_HEADER` is read per request, so it must not be
set while the first describe's tests run; vitest runs describe blocks in file
order and hooks run with their own describe, so the first block is finished
before the second `beforeAll` executes. The plan states this so a future
reorder does not silently change the first block's limiter key.

### Test 1: hippo non-200 passes through with its status and body

Two `POST /search` requests fired concurrently (`Promise.all`) with the same
`cf-connecting-ip: 203.0.113.10` and a valid Bearer. Exactly one lands in a
full bucket, the other in an empty one. Assert the sorted status list is
`[200, 429]` and the 429 body is `{ error: 'rate limit exceeded' }` (hippo's
message, proving `hippoErrorBody` forwards the upstream text). Concurrency
removes the timing dependence: the outcome is the same whether the two
requests are 1 ms or 1.9 s apart, and a 2 s gap between two `Promise.all`
requests would itself be a test-host failure worth seeing.

Mutation this must catch: `sendJson(res, 200, ...)` on the non-200 branch, or
`if (status !== 200 && status !== 429)`.

### Test 2: only cf-connecting-ip reaches hippo's limiter key

Part (i), forwarded: three concurrent `POST /search` with distinct
`cf-connecting-ip` values `198.51.100.1/2/3`. Each is a fresh key, so all three
are 200. A dropped header would collapse them into the adapter's socket bucket
and yield `[200, 429, 429]`.

Part (ii), not forwarded: two concurrent `POST /search` with distinct
`x-forwarded-for` and distinct `x-real-ip` values and **no** `cf-connecting-ip`.
Both land in the socket-address bucket (`127.0.0.1`), so the sorted statuses
are `[200, 429]`. An adapter that read either header as the client IP (or
that forwarded them and hippo were misconfigured to read them) would yield
`[200, 200]`.

Ordering constraint inside the describe: part (ii) is the only place a
`/v1` request reaches this hippo without `cf-connecting-ip`, and it runs after
part (i), so the socket bucket is still full when it starts. `/health` probes
are not rate limited and do not consume it.

Mutations this must catch: `clientIpOf` returning `undefined` always; `clientIpOf`
reading `x-forwarded-for`; `callHippo` not setting the header.

## Changes

1. `tests/aml-adapter.test.ts`: hoist `spawnAdapter` / `stopAdapter`; add
   `describe('rate-limit key forwarding and status pass-through')` with its own
   `beforeAll` / `afterAll` and the two tests above. Env save/restore for both
   variables. No change to the 13 existing tests' assertions.
2. `CHANGELOG.md`: one bullet under `## 1.38.2 - unreleased` / `### Tests`.
3. No change to `adapter.mjs`, `src/`, version, or deploy files.

## Verification

- `node ./node_modules/vitest/vitest.mjs run tests/aml-adapter.test.ts`: 15 pass.
- Mutation runs (each reverted after): (a) adapter non-200 branch forced to 200,
  (b) `clientIpOf` returns `undefined`, (c) `clientIpOf` reads `x-forwarded-for`.
  Each must fail at least one new test and none of the existing 13.
- `tsc --noEmit` and oxlint clean on the test file.

## Out of scope

- Simulating a hippo 5xx. Reaching a real 5xx from a healthy hippo needs a
  fault injector; the 429 is a real non-200 from the real server and exercises
  the same adapter branch. Noted for the follow-up if a stub upstream is ever
  accepted in this file.
- Any adapter behaviour change.
