# Session-end snapshot-close test: wait on the worker's own signal (A3 item 13)

Episode `01M1STKYTPFBVWPNDSRZJXYG2V`. Base `d3c77ba`.

## Problem

`tests/session-end-snapshot-close.test.ts` test 1 ("payload session_id is threaded
through to the worker, which closes that session's own active snapshot") fails
intermittently on CI. Run 33985138707 attempt 1: `condition not met within 25553ms`
with no `last error`, while tests 2, 3 and 4 in the same file passed in 1954 ms,
654 ms and 730 ms in the same run. The backlog attributed it to CI load and asked
for the test to wait on an observable signal from the worker, not a wallclock
bound; no skip, no retry wrapper.

## Diagnosis (measured, not inferred)

1. **The poller is a competing writer.** Test 1 waits with
   `waitUntil(() => loadActiveTaskSnapshot(hippoRoot, 'default') === null)` at
   50 ms intervals. Each call runs `initStore` (open + close) and then a second
   open + SELECT + mirror-file write + close (`src/store.ts:313`, `:2522`). Every
   `openHippoDb` (`src/db.ts:2362`) runs `runMigrations`, whose
   `ensureMetaDefaults` issues 7 `INSERT OR IGNORE` and whose `ensureOptionalFts`
   issues an unconditional upsert of `fts5_available` (`src/db.ts:2512-2540`). So
   every poll is two write transactions, about 40 per second, on the same file the
   detached worker is writing.
2. **The worker's failure is invisible.** `cmdSessionEndWorker` (`src/cli.ts:3235`)
   swallows sleep, capture and close errors and reports them only through
   `appendSessionEndCloseLog`, which is a no-op without `--log-file`
   (`src/cli.ts:3283`). Test 1 passes no `--log-file`. When the close fails, the
   poller waits for a state change that will never come, and its own reads never
   throw, hence the empty `last error` in the CI message.
3. **Reproduced locally.** Saved evidence, all in the episode scratchpad:
   - `ep13-baseline.log`: 10 runs of the unchanged test file with `npx vitest run`;
     run 9 failed test 1 at 25452 ms with `condition not met within 25000ms`, the
     other 9 passed.
   - `ep13-repro-stress.log`, `poll-db` mode (the test's idiom plus a log file so the
     worker can speak), 10 runs under 4 CPU stressers: run 8 shows the worker
     logging `snapshot close failed: database is locked` and the poller timing out
     at 25021 ms after 394 polls with no last error, the CI signature exactly; the
     worker logged `sleep failed: database is locked` in 2 runs and the poller's own
     reads threw `database is locked` in 5 runs.
   - `ep13-repro-unstressed.log`, `poll-db`, 5 runs, no stress: 5/5 ok, but the
     worker still logged `sleep failed: database is locked` in run 4. An earlier
     exploratory unstressed batch (not saved) also produced the 25 s timeout.
4. **The log-file wait does not have the problem.** `poll-log` mode (wait for the
   worker's own close line, then read the DB): `ep13-repro-stress.log` 20/20 ok
   under 4 stressers, 650 to 2087 ms; `ep13-repro-unstressed.log` 5/5 ok, 579 to
   1078 ms. No close failure in 25 runs. One post-line read (stressed run 8) threw
   `database is locked` once and succeeded on retry, which is the case
   `loadSnapshotRetrying` exists for (see the fix). The worker's `sleep failed:
   database is locked` line also appears once in `poll-log` (unstressed run 2), with
   no DB poller present: that contention is inside the worker itself, from the
   unawaited `cmdSleep` running alongside capture and close (flagged below).
5. **`busy_timeout` does not cover this path.** Pure `node:sqlite` probe
   `ep13-sqlite-probe.mjs`, output in `ep13-sqlite-probe.log`, mirroring
   `openHippoDb`'s pragmas and the per-open upsert: a 20 Hz open/upsert/close poller
   made a concurrent single autocommit `UPDATE` with `busy_timeout = 5000` fail with
   `database is locked` after 2 ms, 1 time in 10 (the other 9 took 3 to 14 ms).
   SQLite returns BUSY without calling the busy handler on some WAL open and
   checkpoint-on-last-close paths; the exact internal path was not isolated and does
   not need to be for this fix.

Root cause of the flake: the test's own poller makes the process under test fail,
and the test never asks the worker what happened. CI load only raises the collision
probability.

## Fix (at the root of the flake; test file only)

`tests/session-end-snapshot-close.test.ts`:

1. **Test 1** passes `--log-file` and waits with `waitUntil` for the worker's
   close-step line (the idiom tests 3 and 4 already use). The wait matches either
   `closed N active snapshot(s) for session ...` or `snapshot close failed: ...`
   (a shared `closeStepLogged` helper), because the failure line does not contain
   the `active snapshot` substring test 4 waits on and would otherwise still time
   out. Then it asserts the line is `closed 1 active snapshot(s) for session
   sess-end-close-me`. A
   `snapshot close failed: ...` line now fails the test within a second with the
   worker's real error in the assertion message instead of a silent 25 s timeout.
   Then `loadSnapshotRetrying(...)` must be `null`. The retrying read stays because
   `cmdSleep` is called without `await` inside the worker's `try` (`src/cli.ts:3240`),
   so its tail can still touch the DB after the close line is written.
2. **Test 2** adds `--log-file` to its `runHippo(['session-end'], ...)` call (today
   it passes none) and replaces the 1500 ms wallclock sleep with the same wait for
   `closed 0 active snapshot(s) for session sess-b-ending`, then keeps the existing
   survival assertions. The negative becomes "the worker ran and closed nothing"
   rather than "we waited long enough".
3. **Test 4** switches its wait from the `active snapshot` substring to the same
   `closeStepLogged` helper. Mutation A (below) showed the old predicate waiting out
   the full 25 s when the close throws, the same slow-fail as test 1.
4. **`waitUntil` doc comment**: the paragraph describing DB-polling lock errors as
   "expected polling noise" described the symptom of the poller causing the failure.
   Replace it with the rule: wait on the worker's log file, never on the DB. The 25 s
   bound stays; a real wiring bug still has to fail instead of hang.

No `src/` change. No retry wrapper, no skip, no timeout change.

## Out of scope, flagged in TODOS.md

- **Production fragility.** Any hippo process closing its last connection can make a
  concurrent hippo process's statement fail instantly with `database is locked`
  despite `busy_timeout = 5000` (probe in point 5). For session-end that leaves a
  stale active snapshot; the freshness bound in `loadFreshActiveTaskSnapshot` is the
  backstop (`src/cli.ts:3262` comment). A retry inside
  `closeTaskSnapshotsForSession` would be a patch; the fix is to find the BUSY path
  in `openHippoDb`/`closeHippoDb` (per-open migrations and upserts, checkpoint on
  last close) and remove it.
- **Unawaited `cmdSleep`.** `cmdSessionEndWorker` calls the async `cmdSleep` inside
  `try { } catch { }` without `await`, so a rejection escapes the catch and sleep
  runs concurrently with capture and the close.

## Verification

- Red before: CI run 33985138707 attempt 1; local reproducer `poll-db` timeout;
  local loop of the unchanged file (`scratchpad/ep13-baseline.log`).
- Green after: 20 consecutive local runs of
  `npx vitest run tests/session-end-snapshot-close.test.ts`; reproducer `poll-log`
  20 runs under 4 CPU stressers; CI green on the PR run. The acceptance's 20
  consecutive CI runs accrue over later PRs; one episode cannot buy them.
- Mutation A (`ep13-mutation-a.log`, `ep13-mutation-a2.log`): `closeTaskSnapshotsForSession`
  throws in `dist/store.js`. Tests 1 and 2 fail in 2350 ms and 753 ms with
  `snapshot close failed: mutation A: close exploded` in the assertion diff. The
  first run also showed test 4 waiting out 25389 ms on its old `active snapshot`
  predicate; after switching it to `closeStepLogged` it fails in 889 ms.
- Mutation B (`ep13-mutation-b.log`): the close's `WHERE status = 'active'` becomes
  `'never'`. Test 1 fails in 828 ms on the `closed 1` assertion, the diff showing
  the worker's `closed 0 active snapshot(s)` line; the other three pass.
- Green after the edits: `ep13-green-1.log`, `ep13-green-2.log` (4/4, 4.6 s), then
  the 20-run loop `ep13-green-loop.log`.

## Files

`tests/session-end-snapshot-close.test.ts`, `TODOS.md`, `CHANGELOG.md`
(`1.38.3 - unreleased`, Tests), this plan.
