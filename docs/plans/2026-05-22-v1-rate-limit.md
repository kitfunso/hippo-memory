# Request-level rate limit on /v1/* (E3)

Status: PLANNED — dev-framework-rl episode 01KS7NX422KF1WMZ3RR7JZPZS8
Roadmap: v0.40.0 security follow-ups — "Request-level rate limit on /v1/*"

Revision 2 addresses the plan-eng critic's three must-fix items (initial bucket
state, limiter lifecycle vs testability, hard memory cap) plus the
malformed-path and idle-default notes.

## Context

v0.39 reduced the auth-timing leak in `validateApiKey`, but `src/auth.ts:85-86`
records the residual: the DB lookup can still leak via cache effects, and the
stated v0.40 follow-up is a request-level rate limit on `/v1/*` to bound
api-key-id enumeration. There is no inbound rate limiting today.

## Problem

`handleRequest` (`src/server.ts:422`) routes every request with no per-client
throttle. An attacker can hammer `/v1/auth/keys` or any authenticated `/v1/`
route as fast as the network allows, enumerating the 24-char base32 `key_id`
space against the timing/cache side channel `auth.ts` describes. `HIPPO_V1_RPS`
is named in `TODOS.md` but unimplemented.

## The fix

### New module `src/rate-limit.ts`

A per-key token-bucket limiter, dependency-free and unit-testable in isolation:

- `createRateLimiter({ ratePerSec, burst, idleEvictMs, maxKeys })` returns a
  limiter with `check(key: string, now?: number): boolean`.
- State: `Map<string, { tokens: number; last: number }>`.
- **Initial state.** On the first `check` for an unseen key the bucket is
  created FULL: `{ tokens: burst, last: now }`. A fresh client therefore always
  passes its first request; a bucket only ever denies after sustained traffic
  drains it.
- **Refill and consume.** `check` first refills:
  `tokens = min(burst, tokens + (now - last)/1000 * ratePerSec)`, sets
  `last = now`, then if `tokens >= 1` decrements by 1 and returns `true`,
  otherwise returns `false` without decrementing.
- `now` is injectable for deterministic tests (mirrors the `now` parameter of
  `parseRateLimit` in `connectors/github/ratelimit.ts`).
- **Memory bound — two independent mechanisms:**
  1. *Idle sweep.* Throttled to run at most once per `idleEvictMs` (default
     60000), it drops entries whose `last` is older than `idleEvictMs`. The
     sweep is O(map size) but amortised to once per window, never per request,
     so the hot path stays O(1).
  2. *Hard cap.* `maxKeys` (default 10000) bounds the Map absolutely. `check`
     re-inserts the touched key (`delete` then `set`) so Map iteration order is
     least-recently-used; when a new key would exceed `maxKeys`, the LRU entry
     (`map.keys().next().value`) is evicted first. This holds the Map flat even
     under IPv6 source-address rotation, which the time-throttled sweep alone
     cannot — an attacker with a /64 has 2^64 source addresses and could insert
     one entry per address within a single sweep window.

### Wiring in `server.ts`

- The limiter is built **inside `serve()`** at boot, reading the environment
  exactly where `HIPPO_PORT` is read (`server.ts:1406`):
  `ratePerSec = Number(process.env.HIPPO_V1_RPS ?? 20)`, `burst = ratePerSec * 2`.
  A non-positive or non-finite `HIPPO_V1_RPS` yields no limiter (the opt-out
  knob). Building it inside `serve()` rather than at module scope is what lets a
  test set `HIPPO_V1_RPS` before calling `serve()` and get a deterministic rate.
- `serve()` passes the limiter (or `undefined`) into `handleRequest`, which
  gains a trailing `limiter?: RateLimiter` parameter. `handleRequest` is invoked
  from exactly one place, the `createServer` callback, so this is a
  single-call-site change.
- In `handleRequest`, after `parseRequest` and the `/health` early-return:

  ```ts
  if (limiter && path.startsWith('/v1/')) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.check(ip)) {
      throw new HttpError(429, 'rate limit exceeded');
    }
  }
  ```

- `throw new HttpError(429, ...)` needs no new error-handling code: the existing
  `createServer` catch (`server.ts:1448`) already maps an `HttpError` to
  `sendError(res, err.status, err.message)`.
- `/health` is not a `/v1/` path, so the liveness probe is never throttled.
  `/mcp/stream` is likewise not `/v1/` and is out of scope — the v0.40 TODO
  scopes the limit to `/v1/*`.
- **Malformed paths are not throttled.** `handleRequest`'s first statement is
  `rejectEncodedSlash(req.url)` (`server.ts:430`), which throws `HttpError(400)`
  for a `%2F`-bearing path before `parseRequest` and before the limiter runs.
  This is intentional: the enumeration threat is well-formed `/v1/` requests
  (which are throttled), and a `%2F` 400 is rejected with only a string check,
  no DB or auth work, so it is not a meaningful enumeration or DoS vector.

### Why `path.startsWith('/v1/')` is acceptable here

`server.ts:50` warns against `path.startsWith` for *auth* gating, where a miss
is a silent auth bypass. For rate limiting the failure mode is inverted: a
`startsWith` miss means "not throttled", which for a non-`/v1/` path is correct
and harmless. The limit is a DoS / enumeration bound, not an auth boundary.

## Tests

- New `tests/rate-limit.test.ts` (unit, deterministic via injected `now`):
  first request passes (full initial bucket), burst allowance, steady-state
  refill, denial when exhausted, recovery after idle, per-key independence,
  idle-bucket eviction, `maxKeys` LRU eviction under many distinct keys, and
  `ratePerSec <= 0` producing no limiter.
- One integration case in `tests/server-lifecycle.test.ts` (real server): with
  `HIPPO_V1_RPS` set low before `serve()`, a burst of `/v1/` requests beyond
  `burst` receives `429`s while `/health` is never throttled.

## Verification

- `npm run build` clean.
- `npm test` full suite green.

## Risks

- A shared egress IP (NAT, corporate proxy) pools many clients into one bucket.
  Accepted: the default 20 rps / 40 burst is generous for legitimate `/v1/` use,
  and `HIPPO_V1_RPS` lets an operator raise or disable it. Per-IP is the right
  granularity for the enumeration threat; a per-key limit would not bound an
  attacker probing many `key_id`s.
- IPv6 source-address rotation is bounded by the hard `maxKeys` cap, not by the
  time-throttled idle sweep alone. Under rotation the limiter degrades to LRU
  eviction: the attacker's churn evicts its own older buckets, and a legitimate
  client evicted mid-attack simply gets a fresh full bucket on its next request
  — fail-open for that client, never a crash or an unbounded Map. Truly
  defeating rotation needs per-subnet bucketing, which is out of scope here.
- `req.socket.remoteAddress` can be undefined; it collapses to a single
  `'unknown'` bucket (the same idiom `server.ts:289` already uses). Acceptable.

## Files

- `src/rate-limit.ts` — new token-bucket limiter.
- `src/server.ts` — limiter built in `serve()`, threaded into `handleRequest`
  via a new trailing parameter, and checked for `/v1/` paths.
- `tests/rate-limit.test.ts` — new unit tests.
- `tests/server-lifecycle.test.ts` — one integration case.
- `CHANGELOG.md` — folded into the accumulating v1.11.0 entry (v0.40 batch).
- `TODOS.md` — tick the v0.40 "Request-level rate limit on /v1/*" item.
- `docs/plans/2026-05-22-v1-rate-limit.md` — this plan.
