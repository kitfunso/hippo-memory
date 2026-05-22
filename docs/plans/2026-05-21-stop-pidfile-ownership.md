# Plan: stop() pidfile-ownership guard

**Episode:** 01KS69V6C4P07YWE5FXM6FSN4M (`/dev-framework-rl`)
**Date:** 2026-05-21
**Type:** bug fix (library-internal server lifecycle)
**Branch:** `fix/stop-pidfile-ownership` off `master`

## Context

v1.10.0 (2026-05-21) shipped server/lifecycle hardening (H1, L3, H3, M3, H2, A3).
The v0.37.0 server-hardening section of `TODOS.md` now has every item closed
except one, codex-flagged 2026-05-21 and deliberately deferred from v1.10.0:

> `stop()` can unlink a newer server's pidfile. `serve()`'s `stop()` calls
> `removePidfile` unconditionally. If server A is shutting down while server B
> has already started and rewritten the pidfile, A's stop deletes B's pidfile
> and orphans the live B.

## Problem

`serve()`'s `stop()` (`src/server.ts:1496`) calls `removePidfile(opts.hippoRoot)`,
which unconditionally `unlinkSync`s `${hippoRoot}/server.pid`. It never checks
whether the pidfile on disk still describes *this* server.

## Root cause

`removePidfile` (`src/server-detect.ts:183`) is identity-blind: it deletes
whatever pidfile is present. The pidfile is shared mutable state keyed by
`hippoRoot`; any server on that root can be its writer. `stop()` assumes the
pidfile it deletes is its own, which holds only if no other server rewrote it
in between.

## The race

1. Server A starts on `hippoRoot`, writes the pidfile `(pid_A, started_at_A)`.
2. Server B starts on the same `hippoRoot` (different port). B's H3
   `detectServer` guard probes A's `/health`; if A is momentarily busy and
   misses the 300 ms probe window, `detectServer` treats the timeout as
   ambiguous, keeps A's pidfile, and returns `null`, so B proceeds.
3. B's `listen()` on its own port succeeds; B's `writePidfile` overwrites the
   pidfile, which now describes B.
4. A later shuts down. A's `stop()` calls `removePidfile`, which **deletes B's
   pidfile**. B is live but orphaned: `detectServer` returns `null` for it, the
   CLI thin-client can no longer route to it, and the H3 guard will not see it.

The step 2-3 window is not exotic: any same-root multi-port server pair plus one
transient `/health` miss reaches it. A pidfile written before the H3 guard
existed (pre-v1.10.0) reaches it with no race at all.

## Fix

Add an identity-checked removal to `src/server-detect.ts`:

```ts
/**
 * Remove the pidfile only if it still describes the caller's own server.
 * Reads + parses the pidfile and unlinks it ONLY when both `pid` and
 * `started_at` match `owner`. A pidfile rewritten by a newer server is left
 * intact, so a shutting-down older server cannot orphan the newer one.
 *
 * Best-effort and never throws: a missing, unreadable, or malformed pidfile
 * is "not provably mine" and left alone (detectServer unlinks a malformed
 * pidfile on its next probe). Returns true iff a matching pidfile was removed.
 *
 * Residual TOCTOU: the pidfile could be rewritten between the read and the
 * unlink. The window is microseconds and the shape is the same read-check-
 * unlink detectServer already uses; it narrows the bug from an unbounded
 * window to a negligible one.
 */
export function removePidfileIfOwned(
  hippoRoot: string,
  owner: { pid: number; startedAt: string },
): boolean
```

`removePidfile` is kept: unconditional removal is still a legitimate primitive
and `tests/server-detect.test.ts` exercises it directly.

## Scope

- **Primary:** `serve()`'s `stop()` (`src/server.ts:1496`) — the `TODOS.md` item.
- **Sibling, same bug, included:** `src/cli.ts:272`, inside
  `runViaServerIfAvailable`'s stale-pidfile self-heal, also calls
  `removePidfile` unconditionally. The CLI already holds `info` (the
  `ServerInfo` from `detectServer` at line 259) — the exact identity to check
  against. Same bug class, same one-line fix with the same helper, so per the
  "fix all instances in one pass" rule it is in scope. This is one coherent
  fix, not the unrelated "hardening sweep" the episode scope ruled out.

## Files changed

1. `src/server-detect.ts` — add `removePidfileIfOwned`; keep `removePidfile`.
2. `src/server.ts` — `stop()` calls `removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt })`; import: drop `removePidfile`, add `removePidfileIfOwned`.
3. `src/cli.ts` — line 272 calls `removePidfileIfOwned(hippoRoot, { pid: info.pid, startedAt: info.started_at })`; import: drop `removePidfile`, add `removePidfileIfOwned`.
4. `tests/server-detect.test.ts` — unit tests for `removePidfileIfOwned`.
5. `tests/server-lifecycle.test.ts` — integration test: `stop()` leaves a foreign pidfile intact.
6. `CHANGELOG.md`, `package.json`, `package-lock.json` — version bump at ship.
7. `TODOS.md` — mark the v0.37.0 `stop()` item `[x]`.

## Steps

### Step 1 — `removePidfileIfOwned` helper
Add the function to `src/server-detect.ts` as specified.
**Success:** `npm run build` clean; `removePidfileIfOwned` exported.

### Step 2 — wire `stop()`
`src/server.ts` `stop()`: replace `removePidfile(opts.hippoRoot)` with
`removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt })`. Update
the `server-detect.js` import (drop `removePidfile`, add `removePidfileIfOwned`).
**Success:** `npm run build` clean (no unused-import error).

### Step 3 — wire `cli.ts:272`
`src/cli.ts` line 272: replace `removePidfile(hippoRoot)` with
`removePidfileIfOwned(hippoRoot, { pid: info.pid, startedAt: info.started_at })`.
Update the `server-detect.js` import (drop `removePidfile`, add `removePidfileIfOwned`).
**Success:** `npm run build` clean.

### Step 4 — unit tests (`tests/server-detect.test.ts`)
Cases: (a) pid (the test process's own `process.pid`) + started_at match ->
returns true, file gone; (b) pid matches, started_at differs -> false, file
present; (c) started_at matches, pid differs -> false, file present; (d) no
pidfile -> false, no throw; (e) malformed pidfile -> false, file left, no throw.
**Success:** the 5 new tests pass.

### Step 5 — integration test (`tests/server-lifecycle.test.ts`)
Start server A (`port: 0`); overwrite `server.pid` with a forged foreign
identity (different pid + started_at); call `A.stop()`; assert the forged
pidfile still exists with its forged content. Confirm the existing "stop()
removes the pidfile" test still passes (own pidfile IS removed). The forged pid
value is arbitrary: `removePidfileIfOwned` is a pure read-compare-unlink and
never probes process liveness.
**Success:** new test passes; pre-existing `stop()` lifecycle tests still green.

### Step 6 — full suite
**Success:** `npm run build && npm test` — full suite green, 0 failures.

## Edge cases

- **Malformed / unreadable pidfile:** not provably ours -> left alone.
  `detectServer` already unlinks malformed pidfiles on its next probe, so it
  does not leak.
- **Missing pidfile:** `stop()` is idempotent and may run after the pidfile is
  already gone -> `removePidfileIfOwned` returns false, no throw.
- **Same-process two-server case (tests):** same `pid`, different `started_at`
  -> `started_at` discriminates. `(pid, started_at)` is the same identity tuple
  `detectServer`'s H1 liveness probe already relies on.
- **Residual TOCTOU:** accepted, commented, consistent with `detectServer`.

## Version / semver

**PATCH -> 1.10.1**: an internal lifecycle bug fix, behavior-preserving for
every existing caller (`stop()` on a still-own pidfile is unchanged; only the
foreign-pidfile case changes, and that case was the bug). `removePidfileIfOwned`
is a new symbol in `server-detect.ts`. Confirmed not a public-API change:
`package.json` declares `main`/`exports` as `./dist/index.js`, but the repo has
no `src/index.ts` and therefore no public barrel; consumers enter via
`bin/hippo.js` -> `dist/cli.js`. `server-detect.ts` is an internal-only module,
so the new symbol cannot reach the public `exports` surface, which makes PATCH
correct, not MINOR. Final version set at ship.

## Out of scope

- The other A3 follow-up (`hippo forget --archive` HTTP route) — separate `TODOS.md` item.
- A general flock / lockfile rewrite of pidfile ownership — over-engineered for
  this bug (rejected in brainstorm).
- Refactoring `detectServer`'s inline read+parse into a shared `readPidfile`
  helper — `detectServer` is not broken; the ~4-line duplication does not
  justify touching working code.
