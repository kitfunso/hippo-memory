# Ancestor walk-up store discovery

Episode 01M1S8SZH6KZA9FPC9KY92XX5Y. TODOS.md:23. Batch 01M1S1M74R8RW419AK3W17FB7X (version bump to 1.38.2 happens at the batch gate).

## Problem

`getHippoRoot(cwd)` (src/store.ts:297) is `path.join(cwd, '.hippo')`. The CLI computes it once at module load (src/cli.ts:8773) and every command that needs a store passes it to `requireInit` (49 sites), which exits with `No .hippo directory found. Run hippo init first.` So `hippo recall` from `<proj>/src/` fails even though `<proj>/.hippo` exists. git does not behave this way, and the S5 fixture design crashed on it.

## What already exists

`src/project-identity.ts` already walks ancestors for scope isolation: `resolveProjectIdentity` climbs from cwd, stops when it reaches the home directory (home is never a project, so `~/.hippo` is never picked up by the walk), caps the climb at `MAX_WALK_DEPTH = 64`, stops at the filesystem root, only accepts a `.hippo` that is a directory, and takes `homeDir` / `stopDir` test seams. `store.ts` already imports this module. The MCP server (src/mcp/server.ts:63 `findHippoRoot`) has its own copy of the walk that runs to the filesystem root with no home bound and then falls back to `getGlobalRoot()`; when cwd is under home and `HIPPO_HOME` points elsewhere, that copy returns `~/.hippo` instead of the configured global store.

## Changes

1. **src/project-identity.ts.** Extract the marker loop from `resolveProjectIdentity` into a private `walkProjectMarkers(start, home, stopDir)` returning `{ hippoRoot, gitRoot, reachedHome }`. `resolveProjectIdentity` keeps its exact behaviour and cache. Add and export

   ```ts
   /** Nearest ancestor store (`<dir>/.hippo`) from cwd upward, or null. Home ends the walk unchecked, like resolveProjectIdentity. */
   export function findHippoStoreDir(cwd?: string, opts?: ResolveProjectIdentityOpts): string | null
   ```

   which returns `path.join(hippoRoot, '.hippo')` or `null`. No caching (called once per CLI process).

2. **src/store.ts.** `getHippoRoot(cwd = process.cwd(), opts?: ResolveProjectIdentityOpts)` returns `findHippoStoreDir(cwd, opts) ?? path.join(cwd, '.hippo')`. The fallback keeps every no-store case byte-identical to today: `hippo init` in a fresh directory still creates `<cwd>/.hippo`, and `requireInit` still fails in a directory with no store anywhere up to home.

3. **src/cli.ts `requireInit`.** Message becomes `No hippo store at <hippoRoot> (searched <cwd> and its parents up to your home directory). Run hippo init first.` It names the store path the CLI settled on and the real `process.cwd()` separately, so it stays honest when the walk found a bare `.hippo` directory with no `hippo.db` (plan review round 2 note). Keep the function signature; add a unit case: bare `<proj>/.hippo` directory, cwd `<proj>/src`, `getHippoRoot` returns `<proj>/.hippo` and `isInitialized` is false.

4. **src/mcp/server.ts `findHippoRoot`.** Becomes `export function findHippoRoot(cwd: string = process.cwd(), opts?: ResolveProjectIdentityOpts): string | null` returning `findHippoStoreDir(cwd, opts) ?? (fs.existsSync(getGlobalRoot()) ? getGlobalRoot() : null)`. The existing caller at line 493 keeps calling it with no arguments; the parameters are the test seam (same shape as `resolveProjectIdentity`). Two semantic changes, both stated in the CHANGELOG: the walk now ends at the home directory instead of the filesystem root (so `HIPPO_HOME` wins over `~/.hippo` when cwd is under home), and a `.hippo` marker must be a directory (the old loop used `existsSync`, so a stray file named `.hippo` on an ancestor used to be returned as a store and then failed to open).

5. **Tests: new `tests/store-root-walkup.test.ts`** (real filesystem in a `mkdtemp` sandbox, `homeDir` + `stopDir` seams, style of tests/project-identity.test.ts):
   - `getHippoRoot(<proj>/src/deep)` returns `<proj>/.hippo` when `<proj>/.hippo` is a directory.
   - Stop bound: `.hippo` above `stopDir` is not found; `getHippoRoot` falls back to `<cwd>/.hippo`.
   - Home bound: a `.hippo` inside `homeDir` is never returned from a child of home.
   - A stray FILE named `.hippo` on an ancestor is ignored.
   - No marker anywhere: returns `<cwd>/.hippo` (unchanged behaviour).
   - CLI end to end (execFileSync of `dist/cli.js` like tests/recall-trace-wiring.test.ts): `init --no-hooks --no-schedule --no-learn` in `<proj>`, `remember` from `<proj>`, then `recall` with `cwd: <proj>/src` finds the memory and writes NO `<proj>/src/.hippo`. Uses `HIPPO_HOME` pointed inside the sandbox so the global store never leaks. This is the acceptance case verbatim.
   - `init` from `<proj>/src` after `<proj>` is initialised prints `Already initialized at <proj>/.hippo` and creates no nested store.
   - MCP regression (the must-fix from plan review round 1): sandbox `home/.hippo` directory, `home/work` with no markers, `HIPPO_HOME` set to an existing `sandbox/global-store` for the duration of the test (saved and restored). `findHippoRoot(home/work, { homeDir: home })` returns `sandbox/global-store`, never `home/.hippo`. `homeDir` alone bounds these cases because the whole layout sits inside a fresh `mkdtemp` sandbox whose `home` ends the walk; `stopDir` is threaded through the same `opts` object but not needed here. Second case: `HIPPO_HOME` pointed at a missing directory and no ancestor store returns `null` (the fallback only returns an existing global root). Third case: `home/proj/.hippo` directory with cwd `home/proj/src` returns `home/proj/.hippo`. The test imports `findHippoRoot` from `../src/mcp/server.js`; tests/v039-mcp-tenant-isolation.test.ts already imports that module, so import-time side effects are known safe.
   - `resolveProjectIdentity` tests stay green unchanged (the refactor must not move behaviour).

6. **CHANGELOG.md** under `## 1.38.2 - unreleased`, section `### Changed`: the CLI now finds the nearest ancestor `.hippo` (bounded at the home directory and the filesystem root), `hippo init` from inside an initialised project reports the existing store instead of creating a nested one, and the MCP server shares the same bounded walk (so `HIPPO_HOME` wins over `~/.hippo` when cwd is under home, and a stray file named `.hippo` on an ancestor is no longer treated as a store). Path tags are unchanged: they still derive from the working directory.

7. **TODOS.md:23** marked RESOLVED with the episode id, one line.

## Explicit non-changes

- Every `extractPathTags(process.cwd())` site in cli.ts (15) stays. Tags derive from cwd, as today; a write from `<proj>/src/` still gets `path:src`. The backlog acceptance phrase "tag still from the discovered root" is read as "derivation unchanged".
- No env opt-in. The bound at home plus the directory-only marker makes the walk safe by default.
- No version bump (batch gate), no public API change (`getHippoRoot` is not exported from src/index.ts).

## Risks

- A test that calls `getHippoRoot(tmpDir)` before `init` while some ancestor of `os.tmpdir()` holds a `.hippo` directory would now resolve upward. On Windows `os.tmpdir()` is under HOME (`C:/Users/<user>/AppData/Local/Temp`), so tests without a `stopDir` seam walk three or four real directories before the home bound ends the walk. Re-runnable check, expected to print nothing:

  ```js
  // save as check.mjs anywhere, run: node check.mjs (prints nothing, exit 0 = clean)
  import { existsSync } from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  let dir = os.tmpdir(); const home = os.homedir(); const hits = [];
  while (dir !== home) { if (existsSync(path.join(dir, '.hippo'))) hits.push(dir); const p = path.dirname(dir); if (p === dir) break; dir = p; }
  if (hits.length) { console.log(hits.join('\n')); process.exit(1); }
  ```

  It walks from `os.tmpdir()` up to but not including `os.homedir()`, the same bound the real walk uses, and prints every ancestor holding `.hippo`. Printed nothing on this box on 2026-09-05. The new test file runs the same walk in a `beforeAll` and fails loudly instead of letting the suite resolve upward silently.
- `hippo init` inside an initialised project no longer creates a nested store. Intended, called out in the CHANGELOG.
- MCP bound change: a `.hippo` above home is unreachable from under home now. That directory would have to be outside the user's home tree, which no supported layout produces.

## Verification

- `node ./node_modules/vitest/vitest.mjs run tests/store-root-walkup.test.ts tests/project-identity.test.ts tests/context-scope-isolation.test.ts tests/recall-trace-wiring.test.ts tests/pre-compact-e2e.test.ts tests/v039-mcp-tenant-isolation.test.ts tests/mcp-stdio.test.ts tests/server-mcp-http.test.ts tests/server-mcp-tenant.test.ts`, then the full suite. The MCP server tests that inject `hippoRoot` do not exercise `findHippoRoot`; the new test file does.
- `npx tsc --noEmit`, `npm run lint`.
- Mutation: revert `getHippoRoot` to the strict join; the end-to-end CLI test and the nested-subdir unit test must fail. Revert `findHippoRoot` to the old unbounded loop; the HIPPO_HOME-wins test must fail. Drop the temp-root stop; the temp-root unit test must fail (and on a Windows dev box the full suite's pre-compact-e2e X3 case fails again).

## Found during review

- Reviewer (history): the found branch of `getHippoRoot` returned a realpath'd store while the no-store fallback kept the raw cwd, so a project reached through a symlink or junction registered twice in the workspace registry (first `hippo init` raw, re-run realpath'd). The fallback now realpath's cwd too; a junction test pins one spelling before and after init.
- Codex: the test sandbox root is realpath'd (macOS spells `os.tmpdir()` through `/var`) and the "no `.hippo` above the temp root" preflight is gone, since the walk itself stops at the temp root.
- Reviewer (standards): the `findHippoStoreDir` JSDoc was trimmed to two lines; the rationale lives here.

## Found during verify

The first full-suite run failed `tests/pre-compact-e2e.test.ts` X3 (`compact-resume` printed a snapshot where none should exist). Cause: that test re-points HOME/USERPROFILE at a sandbox, so the child's home bound moved, and the walk from `%TEMP%/hippo-precompact-uninit-project-*` climbed through the real `C:/Users/<user>` and found the developer's real `~/.hippo`; `pre-compact` wrote two `sess-uninit` snapshot rows into that live store (deleted afterwards). Fix at root: the store walk also ends at `os.tmpdir()`, unchecked, and compares start and bounds in the same realpath'd form (code review round 2: macOS spells `os.tmpdir()` through the `/var` symlink while `process.cwd()` is physical, so a plain-resolved comparison would leave the stop dead there). The home bound alone is env-derived and cannot protect a sandbox on Windows, where the temp root sits inside home. CI (Linux, `/tmp`) never saw this because `/tmp` has no `.hippo` ancestor.
