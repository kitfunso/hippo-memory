# Store kit subpath: a second store's contract moves off hippo-memory/server

Date: 2026-10-11
Status: accepted, shipped in 2.0.0
Links: PR #835 (trim `hippo-memory/server`, add `hippo-memory/testing`); PR #841 (`hippo-memory/store-kit`); `docs/UPGRADING-2.0.md`, "Store kit subpath"; `tests/server-subpath-exports.test.ts`, `tests/public-entry-exports.test.ts`

## Context
Before 2.0, `hippo-memory/server` exported about 60 names. Most were not the server add-on API. They were the port types, row types, `sqliteStore` and hippo.db's rule helpers that a second `HippoStore` needs, plus test reset hooks.
A reader of the package could not tell the add-on API from internals, and every internal on that subpath was a semver promise.

## Constraints and evidence
- Add-on stores built outside this repo import these names to apply hippo.db's rules with the same code. Deleting the names would leave them nothing to build on.
- `ServeOpts` takes a `HippoStore`, so the server subpath must still name that type (`src/server.ts`).
- 2.0.0 was the one release where a subpath could change without a further major version.

## Decision
Split the old surface three ways:
- `hippo-memory/server` keeps the server add-on API: `serve`, `authCreate`, `authCreateSelf`, `authRevoke`, the error classes, the caller hook functions and the `HippoStore` type.
- `hippo-memory/store-kit` (`src/entry/store-kit.ts`) holds the contract for a second store: port types, row types, `sqliteStore`, `hasGroup` and the rule helpers.
- `hippo-memory/testing` holds the test reset hooks, with no semver promise beyond the major version.

No name changed and none was deleted; each moved once. Two tests pin both surfaces at runtime and in the built `.d.ts`.

## Alternatives considered
- **Delete the internals:** the smallest surface, but it breaks every add-on store with no replacement.
- **Keep them on `hippo-memory/server`:** no break, but the server API stays unreadable and every internal stays a promise.
- **One subpath per store group:** finer, but an add-on store implements most groups at once, so it would import from many places for no gain.

## Consequences
- An add-on that imported a moved name from `hippo-memory/server` fails to build until its import changes. `docs/UPGRADING-2.0.md` lists each moved name.
- A name added for a second store goes on `store-kit`, never on `server`. The export tests fail if `server` grows.

## Reconsider when
- A second store needs a helper that is not on `store-kit`: add it there, with its test.
- The port settles enough that `store-kit` can drop the rule helpers in favour of port methods.
