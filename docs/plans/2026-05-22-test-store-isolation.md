# Test-run global-store isolation (the `_real-store-guard` false positive)

Status: SHIPPED v1.11.0 — dev-framework-rl episode 01KS7YXVV6FPBX3A2TP5SX98ED
Roadmap: v0.40 batch — unblocks E3's ship gate (episode 01KS7NX422KF1WMZ3RR7JZPZS8)

Revision 1 folds in the plan-eng-critic review: a strict `teardown()` order so
the temp-dir cleanup can never throw and re-fail the run, plus two wording
corrections (vitest 1.6's default pool is `threads`, not `forks`).

## Context

E3 (the `/v1` rate limiter) ship-FAILED on a "test-isolation leak": `npm test`
exited non-zero with `tests/_real-store-guard.ts` reporting that the run mutated
the developer's real global hippo store `~/.hippo`. All 1581 tests passed — only
the guard's `globalSetup` teardown failed the run.

## Problem

`tests/_real-store-guard.ts` is a vitest `globalSetup`. Its `setup()` snapshots
two real hippo stores — `process.cwd()/.hippo` and the global store resolved by
`globalStoreRoot()` (`HIPPO_HOME`, then `XDG_DATA_HOME/hippo`, then `~/.hippo`) —
and its `teardown()` fails the run if either is mutated.

In a normal `npm test` neither `HIPPO_HOME` nor `XDG_DATA_HOME` is set, so the
guard watches the developer's real `~/.hippo`. But `~/.hippo` is mutated
continuously by the developer's own Claude Code hooks. `~/.claude/settings.json`
wires the `UserPromptSubmit` hook to `hippo context --pinned-only
--include-recent 5`. `hippo context` recalls memories and **strengthens** them —
it writes `last_retrieved` and `retrieval_count` on every recalled memory and
rebuilds `hippo.db` and `index.json`. Any prompt the developer submits while
`npm test` is running mutates `~/.hippo` mid-run, and the guard's teardown then
blames the tests.

Evidence: the 15 memory `.md` files written to `~/.hippo` at 12:41:41 local —
the "leak" the E3 ship-readiness critic caught — every one carries
`last_retrieved: 2026-05-22T11:41:41.670Z` (= 12:41:41 BST). That is one
`hippo context` recall batch, not a test. Two controlled `npm test` runs — one
serial with an isolated `HIPPO_HOME`, one parallel at real conditions, both
instrumented to watch the real `~/.hippo` — exited clean with no guard error and
no per-file leak markers: the guard only fires when a prompt lands during the
run. The six `hippo-daily-*` scheduled tasks (last ran 06:15) and git hooks
(none — `.git/hooks` holds only inert `.sample` files) were ruled out.

The guard's intent is correct — catch a test that writes a real hippo store —
but watching the developer's live, **shared** `~/.hippo` is racy: any concurrent
writer (the dev's own hooks, another session, a scheduled task) trips it. No
test actually leaks.

## The fix

Isolate the global store for the entire test run. With `HIPPO_HOME` pointed at a
fresh per-run temp dir, every hippo store resolution — in the guard, in every
test worker, and in any child process that inherits the environment — resolves
to that temp dir. The guard watches the temp dir; the developer's hooks still
write the real `~/.hippo`, which the guard no longer watches. A genuine test
leak still mutates the run-level temp store and is still caught — the guard is
isolated, not disabled.

### `vitest.config.ts`

At config module scope — which runs in the main vitest process, before
`globalSetup` runs and before any test worker is spawned:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the global hippo store for the whole test run. Without this every
// store resolution falls through to the developer's real ~/.hippo, which the
// developer's own Claude Code UserPromptSubmit hook (`hippo context`) mutates
// mid-run — a false positive in tests/_real-store-guard.ts.
const isolatedHippoHome = mkdtempSync(join(tmpdir(), 'hippo-test-home-'));
process.env.HIPPO_HOME = isolatedHippoHome;
```

and, inside `defineConfig`'s `test` block, `env: { HIPPO_HOME: isolatedHippoHome }`.

- `process.env.HIPPO_HOME = ...` covers the main process, where `globalSetup`
  (`_real-store-guard.ts`) runs. The guard resolves `globalStoreRoot()` at
  module load — which happens when `globalSetup` imports it, after the config
  module has already set the variable.
- `test.env.HIPPO_HOME` is vitest's documented mechanism for injecting
  `process.env` into each test worker. vitest also spawns every worker (the
  default `threads` pool, or `forks`) with `env: { ...process.env,
  ...config.env }` and re-applies `config.env` inside each worker, so the
  worker value is covered both ways; setting `test.env` explicitly keeps the
  isolation robust regardless of pool.
- A companion variable `HIPPO_TEST_TMP_HOME`, set to the same temp path, marks
  the directory as the test run's own. `tests/_real-store-guard.ts`'s
  `teardown()` removes exactly that path, so the cleanup can never target a
  real store.
- The existing `setupFiles: ['tests/_leak-attribution.ts']` line (temporary
  investigation instrumentation) is removed and the file deleted.

### `tests/_real-store-guard.ts`

- The watched global store is now the isolated temp dir — the guard already
  resolves it via `globalStoreRoot()`, which reads `HIPPO_HOME`. No watch-logic
  change is needed for it to watch the right place.
- `teardown()` follows a strict four-step order: (1) compute the leak verdict;
  (2) capture the names of any changed files into the error-message text; (3) on
  a clean run, remove the isolated temp dir — the removal is wrapped `try/catch`
  with `rmSync(dir, { recursive: true, force: true, maxRetries: 3 })` and any
  failure is swallowed, never thrown, because vitest turns a `globalSetup`
  teardown throw into `process.exitCode = 1`, so a stray Windows `EBUSY` (a child
  still holding the dir open) would otherwise re-introduce the exact intermittent
  non-zero exit this episode fixes; (4) on a detected leak, skip removal (leave
  the temp dir for inspection) and throw with the captured file names. The temp
  dir is otherwise reclaimed by the OS temp sweep.
- The file header comment is updated: the guard now isolates the test run's
  global store and asserts no test leaks into it, rather than "snapshotting the
  developer's real stores." The filename is kept (renaming churns the
  `globalSetup` reference for no behavioural gain).
- The local-store watch (`process.cwd()/.hippo`) is unchanged — see Risks.

### `tests/shared.test.ts`

The `getGlobalRoot` test currently calls `getGlobalRoot()` with the ambient
environment and asserts the result contains `os.homedir()` and `.hippo`. With
the run-level `HIPPO_HOME` pointed at a temp dir, the `.hippo` assertion fails —
it is the one test the isolation breaks. It is rewritten hermetic: save and
restore `HIPPO_HOME`/`XDG_DATA_HOME` in `beforeEach`/`afterEach` (the idiom the
sibling `promoteToGlobal` block in the same file already uses) and test each
branch deliberately — the `~/.hippo` fallback when neither var is set, the
`HIPPO_HOME` branch, and the `XDG_DATA_HOME/hippo` branch. This makes the test
correct and complete rather than dependent on ambient state.

### `CHANGELOG.md`

The `## 1.11.0` entry's Tests section states "Full suite: 217 files, 1581 tests,
green" — written against the E3 verify run that in fact exited non-zero on the
false positive. Correct it to the real post-fix run numbers, and add a Shipped
bullet for this harness fix.

## Tests

- `tests/shared.test.ts` — the rewritten hermetic `getGlobalRoot` block (three
  branch cases: fallback, `HIPPO_HOME`, `XDG_DATA_HOME`).
- No new store-leak test file is added: the `_real-store-guard` `globalSetup`
  **is** the test-leak assertion, and it now runs against the isolated store on
  every `npm test`. The fix is verified by the run exiting 0 (below).

## Verification

- `npm run build` clean.
- `npm test` exits 0 — full suite, real DB / real server.
- A second `npm test` run with a `hippo context` deliberately fired against the
  real `~/.hippo` mid-run still exits 0 — proving the guard no longer
  false-positives on a concurrent external write.
- After the run the isolated temp dir is gone and the real `~/.hippo` is
  untouched (file count unchanged from before the run).

## Risks

- **Local-store residual.** The guard still watches `process.cwd()/.hippo` (the
  repo-local store — 358 files, gitignored). There is no environment override
  for the local store the way `HIPPO_HOME` redirects the global one, so the same
  false-positive class technically remains for it: a `hippo` command run with
  the repo as its cwd during `npm test` would trip it. This is materially
  lower-risk than the global case — the developer's `UserPromptSubmit` hook
  touches the global store, not a repo-local one (the repo-local store's newest
  writes are 09:36, the daily `hippo-daily-hippo` task at 06:15, both outside
  test windows) — and the watch has genuine value: it catches a test that
  spawns the CLI without isolating the child cwd. Kept, residual documented.
- **A test that deletes `HIPPO_HOME`.** A test doing `delete
  process.env.HIPPO_HOME` and then resolving the global store would reach
  `~/.hippo` again, unwatched (the guard fixes its watched path once at
  `setup()`). Only `shared.test.ts`'s `getGlobalRoot` block manipulates
  `HIPPO_HOME`, and it restores it; no test deletes it permanently. Accepted.
- **Temp-dir lifecycle.** `teardown()` removes the per-run temp dir on a clean
  run; on a detected leak it is left for inspection and the OS temp sweep
  reclaims it.

## Files

- `vitest.config.ts` — isolated `HIPPO_HOME` at config scope + `test.env`;
  remove the `_leak-attribution.ts` `setupFiles` line.
- `tests/_real-store-guard.ts` — `teardown()` removes the isolated temp dir;
  header comment updated.
- `tests/shared.test.ts` — hermetic `getGlobalRoot` block.
- `tests/_leak-attribution.ts` — deleted (investigation instrumentation).
- `CHANGELOG.md` — correct the v1.11.0 Tests line; add the Shipped bullet.
- `docs/plans/2026-05-22-test-store-isolation.md` — this plan.
