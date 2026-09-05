# OpenClaw plugin: ship compiled dist and gate publish on it

Episode `01M1Q3NWVY1MNS1V13MDXVNMA5` (loop `hippoloop-20260904T205515Z`, episode 1). Target 1.38.1.

## Problem

Every `openclaw plugins install hippo-memory` from npm fails. Reproduced 2026-09-04 on the
v1.38.0 tarball with `npm run smoke:openclaw-install`:

```
package install requires compiled runtime output for TypeScript entry
./extensions/openclaw-plugin/index.ts: expected ./dist/extensions/openclaw-plugin/index.js, ...
```

OpenClaw resolves a `.ts` extension entry of an installed package to its compiled twin under
`dist/`. Our `build` script (`tsc && tsc -p tsconfig.benchmarks.json`) only compiles `src/` and
`benchmarks/`, so no release since the plugin shipped has ever contained that file.

## Root cause (two halves)

1. `package.json#scripts.build` never compiles `extensions/openclaw-plugin/index.ts`.
2. Nothing gates on it. `scripts/smoke-openclaw-install.mjs` exists and catches the failure,
   but neither `prepublishOnly` nor `.github/workflows/ci.yml` runs it. The class survived ten
   releases (1.28.0 to 1.38.0) with the detector sitting unused in the repo.

An unmerged branch `fix/openclaw-plugin-dist` (2cb9496, 2026-07-30) fixes half 1 only.

## Change

### 1. Build emits the compiled extension (cherry-pick 2cb9496)

- New `tsconfig.extensions.json`: `extends ./tsconfig.json` (same shape as
  `tsconfig.benchmarks.json`), `rootDir ./extensions`, `outDir ./dist/extensions`, declarations
  off, include `extensions/openclaw-plugin/index.ts`.
- **Type fix (plan critic round 1, verified with `tsc --noEmit`):** the extension has never been
  type-checked (root tsconfig excludes it) and fails strict today with 2x TS2322 at `index.ts:56`:
  `let deps: HippoPluginDeps = { execFileSync, spawn, existsSync }` narrows Node's overloaded
  signatures by hand (`stdio: string[]`, `stdio: string`), so no overload matches. Fix at the
  interface, not with a cast: type the option params with Node's own
  `ExecFileSyncOptionsWithStringEncoding` and `SpawnOptions` (type-only imports from
  `child_process`) and the spawn return as `Pick<ChildProcess, 'unref'>`. Call sites and the
  test fakes in `tests/openclaw-plugin.test.ts` are unchanged.
- `build` becomes `tsc && tsc -p tsconfig.benchmarks.json && tsc -p tsconfig.extensions.json`.
- `openclaw.extensions` stays on the `.ts` path so source checkouts keep loading; installed
  packages resolve to `dist/extensions/openclaw-plugin/index.js`. `dist` is already in `files`.
- `index.ts` imports only node builtins (verified by grep), so the compiled file resolves alone.
  The package is `"type": "module"`, so the emitted `.js` is ESM as OpenClaw expects.

### 2. Publish gate (new)

- New `scripts/check-openclaw-dist.mjs`, sibling of `check-manifest-versions.mjs`: read
  `package.json#openclaw.extensions`, for every `.ts` entry assert the compiled twin
  `dist/<path>.js` exists. Derived from the manifest, no hardcoded path, exits 1 with the
  missing path named. About 25 lines.
- `prepublishOnly` becomes
  `check-manifest-versions && check-em-dashes && check-graph-writes && npm run build:all && node scripts/check-openclaw-dist.mjs && npm run smoke:openclaw-install`.
  The check is deterministic and needs no CLI. The smoke is the ground truth and runs the real
  `openclaw plugins install` from a packed tarball; it self-skips when the CLI is absent, which
  is why the check sits in front of it.
- `ci.yml`: add `node scripts/check-openclaw-dist.mjs` right after `npm run build`, so a PR
  that drops the extensions tsc pass goes red before merge.

### 3. Test

- `tests/openclaw-package.test.ts` gains one case: every `openclaw.extensions` `.ts` entry has
  its compiled `dist/` twin. `pretest` runs `npm run build`, so the file exists in the test env
  and the case fails red on master today (the tsc pass is missing) and green after.

### 4. Release

- Bump 1.38.0 to 1.38.1 in the 4 lockstep manifests, `src/version.ts`, and `package-lock.json`
  (`npm version patch --no-git-tag-version` handles package.json + lock; manifests and
  version.ts by hand; `check-manifest-versions.mjs` verifies).
- CHANGELOG 1.38.1 entry under `### Fixed`, no em dashes.
- Loop mode: PR only in-episode; merge + `npm publish` ride the batch deploy gate.

## Non-goals

- No change to the manifest entry path (pointing at `dist/` would break source checkouts and
  OpenClaw already does the resolution).
- `extensions/openclaw-plugin/package.json` carries its own `openclaw.extensions: ["./index.ts"]`.
  The installer reads the ROOT package.json (the failure text names the root path and the smoke
  asserts only the root manifest), so the nested field is inert and gets no dist twin.
- No change to `extensions/pi-extension` (not in `files`, not shipped, different consumer).
- Not adding `vitest run` to `prepublishOnly` (backlog A3 item 4, separate episode).

## Acceptance

1. `npm run build` produces `dist/extensions/openclaw-plugin/index.js` (+ `.js.map`).
2. `npm pack --dry-run` lists `dist/extensions/openclaw-plugin/index.js`.
3. `npm run smoke:openclaw-install` prints `OpenClaw npm install smoke test passed.`
4. `npm run smoke:pack` green.
5. `node scripts/check-openclaw-dist.mjs` exits 0 after build, exits 1 with the path named when
   `dist/extensions` is removed.
6. `npx vitest run tests/openclaw-package.test.ts` green; the new case fails when the extensions
   tsc pass is removed from `build`.
7. `node scripts/check-manifest-versions.mjs` reports all manifests at 1.38.1.

## Risks

- `tsc -p tsconfig.extensions.json` type-checks the extension against `strict: true` for the
  first time; the one existing error is fixed above. Do not loosen strict.
- Sourcemaps reference `../../../extensions/openclaw-plugin/index.ts`, which ships in the
  tarball, so the map resolves.
