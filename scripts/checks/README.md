# CI gates

One line per gate. Each runs from the repo root as `node scripts/checks/<name>`.

- `check-agent-inventory.mjs`: an agent named in the docs must be in docs/integrations/agent-inventory.json, without an overclaim.
- `check-caught-error-logs.mjs`: log calls and hook side-log writes inside catch blocks and error listeners per file may fall, never rise.
- `check-comment-history.mjs`: a src comment line carrying a ticket code, version tag, date or plan path fails, as does a one-word comment line.
- `check-dist-imports.mjs`: a script, benchmark, eval or test imports only dist files and names the build still makes.
- `check-dts-diff.mjs`: api/hippo-memory.api.txt lists the published exports; `--write` updates it, `--check` verifies it.
- `check-em-dashes-in-release-notes.mjs`: the CHANGELOG.md entry of the version to publish holds no em dash.
- `check-error-text.mjs`: hand-spelled caught-error text per file may fall, never rise; use errorMessage().
- `check-expiring-keys-floor.mjs`: each store floor constant names a release that ships its schema.
- `check-floating-api.mjs`: src and tests never drop the Promise of an api write function.
- `check-floating-promises.mjs`: a promise call in src or tests is awaited or handled; in tests a `void` marks one started on purpose.
- `check-graph-writes.mjs`: only the two graph writers in src/store/sqlite/graph write the graph tables.
- `check-lint-ratchet.mjs`: oxlint hits per rule may fall, never rise.
- `check-long-lines.mjs`: no src line over 120 characters beyond the baseline.
- `check-manifest-versions.mjs`: every JSON manifest declares the version about to be published.
- `check-migration-line.mjs`: each migration version is the previous plus one, except the gaps listed for next/3.0.
- `check-open-core.mjs`: a change adds no commercial-only file or identifier to the MIT repo.
- `check-openclaw-dist.mjs`: each `.ts` openclaw.extensions entry has a compiled dist twin Node imports as ESM.
- `check-request-path-timing.mjs`: request-path work at 10,000 memories per store stays inside its statement, row and store ceilings.
- `check-roadmap.mjs`: ROADMAP.md holds unique initiative ids, valid references and local anchors.
- `check-row-casts.mjs`: src and tests cast no SQLite read to a row shape nothing proves.
- `check-sqlite-loads.mjs`: src names node:sqlite only in its two loaders.
- `check-store-port.mjs`: the store port keeps its shape rules that no lint rule can follow across files.
- `check-test-env.mjs`: a vi.stubEnv survives to its test, and no test leaves a secret env var set.
- `check-test-only-exports.mjs`: a src export that only a test names is removed or used.
- `check-test-stores.mjs`: a test builds a store through the shared helpers, not by hand.
- `check-tests-pass.mjs`: the test suite passes before `npm publish`.
- `check-token-drift.mjs`: legacy dark-observatory hex codes appear only in the token sources.
