# Export `strengthBucket` from the package entry

Episode 01M1RJ36AP2NMXTVEHWPW7XP4X (devrl loop hippoloop-20260904T205515Z, batch 01M1Q38K). Backlog A3 item 5.

## Problem

CHANGELOG 1.26.3 (`CHANGELOG.md:387`) announces "New additive export `strengthBucket` from
`src/dedupe.ts` ... No other API surface changes", a public-surface statement. The package has one
entry (`package.json` `exports: { ".": "./dist/index.js" }`, built from `src/index.ts`) and
`src/index.ts` re-exports nothing from `dedupe.js`. A consumer writing
`import { strengthBucket } from 'hippo-memory'` gets `undefined` at runtime and a type error from
`dist/index.d.ts`.

Red probe in this worktree (built dist, Node package self-reference):

```
node --input-type=module -e "import('hippo-memory').then(m => console.log(typeof m.strengthBucket))"
-> undefined   (91 keys exported, none from dedupe.js)
```

## Root cause

The 1.26.3 episode added the function and its unit pin (`tests/dedupe-survivor-determinism.test.ts:25`
imports it from `../src/dedupe.js`) but never touched the entry, and no test in the repo imports through
`src/index.ts` at all, so the entry surface has no guard. The fix is at the entry, which is the root:
the announcement is the contract and the entry is the only place a package consumer can reach.

## Sweep: every CHANGELOG bullet that announces an export, checked against `src/index.ts`

| CHANGELOG line | symbol | in entry? | verdict |
|---|---|---|---|
| 387 | `strengthBucket` | no | **fix here**: the bullet claims the API surface ("No other API surface changes") |
| 3342 | `loadRecallSearchEntries` | yes | already re-exported as the bullet says |
| 355 | `pathBoostMultiplier`, `PATH_BOOST_WEIGHT` | no | module-level shared helper "in src/path-context.ts"; no surface claim; out of scope |
| 48 | `sanitizeLogMessage` | no | internal guard "exported from capture.ts"; no surface claim; out of scope |
| 1471 | `pickShortestPathTag` | n/a | `ui/src/engine/tagPalette.ts`, not the package |
| 1972 | `EdgeCounts` | n/a | `scene.ts` (ui), not the package |
| 2763 | three exports on `src/api.ts` | n/a | module-level; `api.ts` is not re-exported from the entry (plan-eng round 1) |

`deduplicateStore`, `DedupPair`, `DedupResult` stay internal: `api.sleep` is the public path to dedupe
(`src/api.ts:80` imports it), and nothing announced them.

## Changes

### 1. `src/index.ts` (after the `consolidate.js` re-export, line 39)

```ts
// Announced public in CHANGELOG 1.26.3 but never re-exported; the dedupe survivor order stays internal.
export { strengthBucket } from './dedupe.js';
```

One symbol. `dist/index.d.ts` follows from `declaration: true`, so the type-check half of the
acceptance is the same edit.

### 2. `tests/public-entry-exports.test.ts` (new)

No store, no DB. Two cases:

1. **Entry source.** `import * as entry from '../src/index.js'` and
   `import { strengthBucket } from '../src/dedupe.js'`; `entry.strengthBucket` is the same function
   object (`toBe`) and `entry.strengthBucket(1) === 100`. Red today: `entry.strengthBucket` is
   `undefined`.
2. **Built package by name.** Spawn `process.execPath --input-type=module -e` with `cwd` = repo root;
   the child prints `JSON.stringify({ url: import.meta.resolve('hippo-memory'), type: typeof m.strengthBucket, one: m.strengthBucket?.(1) })`.
   Assert the resolved URL is `<repo root>/dist/index.js` (realpath both sides, so the self-reference
   hit THIS checkout and not a global install), `type === 'function'`, `one === 100`, and that
   `dist/index.d.ts` declares the re-export (the type-check half of the acceptance; plan-eng round 1
   med). Red today: `type` is `undefined` (probe above) and the `.d.ts` has no `dedupe.js` line.
   The child inherits `process.env` (it touches no store, so `HIPPO_HOME` is irrelevant here).

Sad paths enumerated up front (lesson from PR #162's review loop):
- `dist/` absent: the child exits non-zero and the test FAILS with the child's stderr plus a
  "run `npm run build` first" hint. Never a skip. CI builds before vitest (`ci.yml:40` then `:46`)
  and `npm test` runs `pretest` build; `tests/cli-dag.test.ts` already depends on dist the same way.
- Self-reference resolving elsewhere: the URL assertion catches it.
- Windows paths: compare with `fileURLToPath` + `realpathSync` + `path.resolve` on both sides.
- Child stdout noise: Node prints the SQLite ExperimentalWarning on stderr, not stdout; the test parses
  the LAST stdout line as JSON.

### 3. `CHANGELOG.md`

New `## 1.38.1 - 2026-09-05` heading (absent in this worktree; #158, #160, #161 and #162 each add the
same heading, merged into one at the batch gate, the known rebase step). Bullet under `### Fixed`:
`strengthBucket` is now actually exported from the package entry, as 1.26.3 announced; new entry-level
test.

No version bump (rides 1.38.1). No README change: the README has no programmatic API listing to update.

## Acceptance

- `node ./node_modules/vitest/vitest.mjs run tests/public-entry-exports.test.ts` red on both cases
  before change 1, green after.
- `npm run build` then the red probe above prints `function`.
- `tests/dedupe-survivor-determinism.test.ts` unchanged and green.

## Non-goals

- A mechanism tying CHANGELOG export announcements to the entry (speculative; the entry test is the
  smallest guard that bites for this class).
- Exporting the rest of `dedupe.ts` or `compare.ts` (`compareEntryIdentity`): unannounced, unrequested.
