# Tests

Run one file: `npx vitest run tests/store/memory-columns.test.ts`. Never run the bare suite on a small box.

## What vitest.config.ts isolates

`isolateTestEnvironment()` runs once at module load, before any worker starts. A test never touches your real data.

- `HOME`, `USERPROFILE`, `APPDATA` and `HIPPO_HOME` point at fresh temp folders, so `hippo init` cannot import your own agent memories.
- `TMP`, `TEMP` and `TMPDIR` point at one run folder. `tests/_real-store-guard.ts` fails the run if a real `.hippo` changed, then removes the folder.
- The agent-home variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR` and the rest) and every name in `scripts/lib/test-env-scrub.mjs` are blanked. A real key would bill you.
- `HIPPO_SKIP_SCHEDULE=1` keeps tests away from `schtasks` and `crontab`.

## Projects

The file name picks the project and its timeout: `*.test.ts` is `unit` (5 s), `*.process.test.ts` and `*.server.test.ts` start a child, the server or a worker (30 s), `*.slow.test.ts` gets 180 s. Three projects need `npm run build` first: `process`, `server` and `slow-dist`, the slow tests that load dist (`SLOW_ON_DIST` in `vitest.config.ts`). `scripts/checks/check-test-env.mjs` fails a name that does not match.

## Make a store

- `makeRoot(label)` in `tests/_helpers/make-root.ts` gives a migrated store root in a temp folder, removed after the file. `makeStore(label)` gives a project folder with `.hippo` inside. `openStoreAt(root)` opens it.
- `initTestStore(root)` copies the run's migrated template instead of migrating again.
- `sessionPerTest()` gives each test one set of store handles, as one CLI command has.

## Helpers most tests use

- `runCliAs` (`run-cli-as.ts`) runs `hippo <args>` in this process with a child's cwd, env and stdin.
- `waitFor` (`wait-for.ts`) polls for a condition and names it in the timeout error.
- `count-statements.ts` counts SQL statements, so a test pins growth without a clock.
- `partialFake<Real>()({ ... })` (`partial-fake.ts`) types a partial store, port or context against the real type. Use it, not `as never`.
- `stubExit()` (`process-stubs.ts`) makes `process.exit` return.

## Order events with a signal, never a pause

A test that needs event A before event B waits for a signal that A happened: a promise a spy resolves, or a latch. No `setTimeout` to order events, and no timing upper bounds (`tests/scripts/elapsed-time-upper-bounds.test.ts`).

## Process tests

A `*.process.test.ts` spawns `node dist/...` through `tests/_helpers/spawn-hippo.ts`, so it needs a fresh build. Children get the isolated env above. Coverage does not count their lines.

## Rule tests that scan the tree

`tests/scripts/*` read the source and test trees and fail on a shape: elapsed-time bounds, floating promises, caught-error logs, row casts, fallback sites, em dashes, long lines, comment history, test env names, store-port use, test-only exports. They import no changed file, so run all of them after any edit under `src` or `tests`.
