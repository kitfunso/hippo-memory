# prepublishOnly runs the test suite

Episode 01M1RCX0X21M3MT5J6FQTY4GFW, devrl loop hippoloop-20260904T205515Z, backlog A3 item 4.

## Problem (reproduced)

`package.json:40` on origin/master `90e4344`:

```
"prepublishOnly": "node scripts/check-manifest-versions.mjs && node scripts/check-em-dashes-in-release-notes.mjs && node scripts/check-graph-writes.mjs && npm run build:all"
```

No `vitest run` anywhere in the chain. CI (`.github/workflows/ci.yml:46`) runs `npx vitest run` on
pull requests, but `npm publish` runs from a local checkout that can differ from the merged head,
so a red suite can publish. `gh pr list --search prepublish` shows only the v1.15.0 release PR;
nothing shipped a test gate.

## Root cause

The release gate is `prepublishOnly` itself. Every other release invariant (manifest lockstep,
em dashes, graph writes) lives there; the test suite was never added. Fix at that seam.

## Fix (at root)

### scripts/check-tests-pass.mjs (new, sibling of the three check-* scripts)

- Spawns vitest directly: `spawnSync(process.execPath, [<vitest bin>, 'run', ...extraArgv],
  { stdio: 'inherit' })`, where the bin is resolved from `vitest/package.json` (`bin.vitest`,
  `./vitest.mjs` in 3.2.6) through `createRequire(import.meta.url)`. No `npm` shim, so no
  `shell: true` and no ENOENT on Windows (plan-eng round 1), and no `pretest` rebuild
  (`package.json:30` runs `npm run build` before every `npm test`, redundant right after
  `build:all`). This is the same command CI runs (`.github/workflows/ci.yml:46`).
- Extra argv is appended to the vitest args, so `node scripts/check-tests-pass.mjs
  tests/foo.test.ts` gates on one file. The tests use the same seam with `--root` (below); it
  is a vitest passthrough, not a fake-command hook.
- Exits with the child's exit code (1 when the child died on a signal or failed to spawn).
- On a non-zero exit, prints to stderr: the exit code, a note that a run with zero failed tests
  and exit 1 is the known vitest worker-IPC artifact (`[vitest-worker]: Timeout calling
  "onTaskUpdate"`), the instruction to rerun the failed files alone first, and the escape hatch.
- Escape hatch: `HIPPO_PUBLISH_SKIP_TESTS="<reason>"`. When set to a non-empty string and the
  suite fails, the script prints `WARNING: publishing with a failed test run. Reason: <reason>`
  and exits 0. It never auto-passes on its own reading of the output: the human states the
  reason every time. `npm publish --ignore-scripts` is NOT the hatch because it skips the three
  other guards too.

### package.json

`prepublishOnly` gains `&& node scripts/check-tests-pass.mjs` after `npm run build:all`, so the
CLI-spawning tests see the fresh `dist/`.

### docs/release-policy.md

New section "Test suite (pre-publish guard)" after the em-dash section: what runs, the artifact,
the hatch, and why `--ignore-scripts` is not it.

### CHANGELOG.md

Bullet under a new `## 1.38.1 - 2026-09-05` heading. The heading does not exist in this
worktree; #158, #160 and #161 each add the same heading, so the rebase at the batch gate merges
the bullets under one heading (the known, expected conflict, same as #160 and #161).

## Tests

### Fixtures: tests/fixtures/prepublish-gate/{passing,failing}/*.spec.mjs

Two one-test files plus a shared `tests/fixtures/prepublish-gate/vitest.config.mjs`
(`include: ['**/*.spec.mjs']`). The `.spec.mjs` suffix keeps them out of the main suite, whose
include is `tests/**/*.test.{ts,mjs}` (`vitest.config.ts:21`). Vitest resolves its config by
walking UP from `--root` (`findUp(configFiles, { cwd: root })`, vitest 3.2.6
`dist/chunks/cli-api.*.js:10203`), so without the shared config a fixture run picked up the repo
config and found no files (probed: exit 1 for both dirs). With it, probed in this worktree:
`--root .../passing` exits 0 (1 passed), `--root .../failing` exits 1 (1 failed). Every test
below therefore drives the real spawn path (process.execPath + vitest bin) end to end.

### tests/prepublish-test-gate.test.ts (new; spawns the real script with spawnSync)

1. `node scripts/check-tests-pass.mjs --root <passing>` exits 0.
2. `... --root <failing>` exits 1 and stderr names `HIPPO_PUBLISH_SKIP_TESTS` and the
   worker-IPC artifact.
3. same with `HIPPO_PUBLISH_SKIP_TESTS=reason` exits 0 and stderr contains `WARNING` and the
   reason.
4. `HIPPO_PUBLISH_SKIP_TESTS=""` (empty) does not skip: exits 1.
5. package.json contract: `scripts.prepublishOnly` ends with `node scripts/check-tests-pass.mjs`
   and still contains the three existing checks and `build:all` (red today).

Red-before: cases 1-4 fail today because the script does not exist; case 5 fails on the
package.json string. The nested vitest inherits `HIPPO_HOME` from the outer run's environment,
and the fixtures never touch a store, so the real-store guard is not at risk.

### Blast radius

`tests/cli-version.test.ts`, `tests/openclaw-package.test.ts` (package.json readers), build,
oxlint. One quiet full `npx vitest run` in the worktree to record this box's exit code for the
worker-IPC question (result goes in the verify manifest, not in code).

## Acceptance

- A failing test makes `npm run prepublishOnly` exit non-zero (case 2 proves the script; the
  package.json contract test proves it is wired last in the chain).
- The escape hatch is documented and requires a stated reason; it never masks the failure
  silently.

## Non-goals

- Fixing the vitest worker-IPC artifact (backlog below-bar item; not reproduced at triage).
- Persisting the escape-hatch use anywhere beyond stderr (plan-eng round 1, low): npm's own
  publish log and the human's stated reason are the trail; a file write inside prepublishOnly
  would itself need a home in the tarball or the repo.
- Version bump (rides 1.38.1).

## Review round 2 (codex P1, fe3398a)

Codex (wrapper and GitHub bot) found that `tests/cli-dag.test.ts` and `tests/cli-multihop.test.ts`
execSync a bare `hippo`, which only CI's `npm link` put on PATH; in a clean checkout the gate
fails with command-not-found, and on a dev box it tests the global install (1.38.0 here), not the
checkout. Root fix: both files run `node bin/hippo.js` like `tests/cli-version.test.ts`; a guard
case in `tests/prepublish-test-gate.test.ts` fails on any future bare `hippo` spawn (it matched
7 sites in the old files); the CI `npm link` step is removed as dead. Red first: cli-dag failed
with the global npm dir stripped from PATH; the four CLI and gate files pass with the same PATH
after the change.

## Review round 3 (codex P1 on the delta, plus CI red on fe3398a)

Codex's delta review and CI (2 failed files) found a third bare `hippo` spawn: the benchmark
adapter `benchmarks/sequential-learning/adapters/hippo.mjs` (`hippoExec`), which
`tests/sequential-learning-adapter-contract.test.ts` and `tests/sl-adapter-budget.test.ts` drive
end to end. The round-2 guard scanned only `tests/*.test.*`, so it missed a helper. Fix: the
adapter resolves `bin/hippo.js` from its own `import.meta.url` (the .mjs is not compiled or
copied, per `tsconfig.benchmarks.json`), and the guard now scans `tests/` and `benchmarks/`
recursively for any `.ts/.mjs/.js`. Red first: the contract test failed with the global npm dir
stripped from PATH; the adapter, budget, gate and cli-dag files pass (17 tests) after the change.
`extensions/*` spawn `hippo` by name on purpose (they call the user's installed CLI) and are out
of scope.

## Review round 4 (codex P1 on the ba35764 delta)

Codex: in a fresh checkout `dist/` is gitignored, so `bin/hippo.js` cannot load; `hippoExec` swallows
that (by design, recall with no results exits non-zero) and `init` ignored the null, so
`run.mjs --adapter hippo` exited 0 with a 100% trap-hit rate. Pre-existing swallow, but the change
moved the trigger from "hippo not on PATH" to "repo not built" and left the README stale. Fix at the
one place a missing CLI is distinguishable from a quiet success: `init()` throws when the first exec
returns null, naming `npm run build`. `HIPPO_BENCH_CLI` overrides the CLI file (benchmark another
build; also how the test points at a missing file). README requirement line updated. Red first:
`tests/sl-adapter-cli-missing.test.ts` resolved instead of rejecting before the fix; 17 tests across
the adapter, budget, gate and new file pass after it with the global npm dir stripped from PATH.
