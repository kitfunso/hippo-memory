# Delivery ledger store hash: the path the hook took, read by its two rules

Date: 2026-10-10
Status: accepted
Links: PR #766; `scripts/z10-reconstruct.mjs` (`reconstruct`); `docs/evals/2026-10-10-z10-exit-check-result.md`, "Review fixes after the scored run" item 5, Limits and Out; commits `ead586f5`, `6b9205b4`, `a82bc723`

## Context
Each delivery ledger row stores `store_hash`, and the Z10 reader notes a row whose hash is not its store's as `foreign-store` and drops it.
That catches a store copied to another place, whose rows still carry the old hash (control N7).
On macOS CI every row read as foreign, so every negative control failed.

## Constraints and evidence
- The hook writes `blockHash(path.resolve(root))` (`src/cli/hook-runtime.ts:102`). So the hash names the path the hook took to the store, and one store can carry several hashes.
- A project store's root is its resolved project folder plus `.hippo`, with `.hippo` itself not resolved (`src/store/open.ts:20-21`, `src/core/project-identity.ts:184-191`).
- When the project has no store, the hook writes to the global store, whose root is `HIPPO_HOME` as given, never resolved (`src/api/ledger-db.ts:16-21`, `src/core/project-identity.ts:248-254`).
- On macOS the temp folder `/var` is a link to `/private/var`.

## Decision
The reader computes the hash by the hook's two rules. When the store is the global store, the reader hashes `HIPPO_HOME` as given. Otherwise it hashes the resolved parent folder plus the store folder's name.
It decides which store is global from `HIPPO_HOME` (or `--global`), even under `--no-global`.
R26 to R28 drive the real hook through linked folders, and each fails under the rule it replaced.

## Alternatives considered
- **The path as given:** failed every macOS control, because the hook resolves the project folder.
- **The full realpath:** broke a global store behind a linked `HIPPO_HOME`, because the hook does not resolve that path (R27 fails under it).
- **Accept any of several hashes** (the second codex review's suggestion): this still misses rows written through other aliases, and it moves the M7 mutant's target.

## Consequences
- A project whose `.hippo` is a link to the global store writes rows under the project path. The reader sees a global store and reads them as foreign. If every row of the session came that way, the read is `indeterminate`. If only some did, the class comes from the rows kept and can understate the delivery, never overstate it.
- A future reader of `store_hash` must copy these two rules too, or it will misread linked stores the same way.

## Reconsider when
- The writer hashes the store's resolved path, one hash per store. Every reader then needs only the full realpath. That change touches a ledger field, so it waits on an explicit yes.
