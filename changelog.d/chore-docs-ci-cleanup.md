### Changed

- **CI checks every PR with lint, the publish gates, the dashboard and the Python SDK.** One Ubuntu vitest job used to run; the rest ran only on a maintainer's machine or at publish time. Lint is a ratchet: it fails when any oxlint rule's count rises above `.oxlint-baseline.json`, so the 512 older hits do not block a PR. The Python tests fail when `hippo serve` does not start, instead of skipping and reading as green. The dashboard's test files run one at a time, so its timing budgets get the runner's cores to themselves.
- **`npm version <x> --no-git-tag-version` sets all seven version fields.** `package.json`, both lockfile root fields, three plugin manifests and `src/version.ts` were edited by hand at each release. npm writes the first three, and the `version` script now syncs the other four and checks all seven.
- **The package types against Node 22.** `@types/node` moves to the 22 line to match the engines floor, and the hand-written `node:sqlite` declarations are gone.
- **The unused SSO stubs and sleep-result redactor are removed.** `src/sso.ts` only threw `NotImplementedError`, and `src/sleep-redact.ts` had no caller because `/v1/sleep` only answers on loopback. Neither was exported from the package.

### Fixed

- **The Claude Code plugin's error capture stores errors.** Its script read `$ARGUMENTS`, which Claude Code never sets for hooks, so it saved nothing. It now reads the failure JSON on stdin, skips interrupts and saves the tool name and error as an error memory. A payload that is not a JSON object, `null` included, prints one line to stderr and saves nothing.
- **The Claude Code plugin runs the same hooks as `hippo hook install`.** Session end now writes the sleep log that the next session start prints, and the plugin gains the pinned-rule inject on each prompt, the snapshot before compaction and the resume after it. The plugin is now 0.5.0.

### Documentation

- **The 1.7.2 note on library recall is corrected.** `src/index.ts` has never exported `recall()`. The default-deny path is `api.recall()`, which `hippo serve` calls; MCP applies the same rule. Exporting the facade waits for 1.46.0.
- **Test counts and version lines no longer go stale.** The README, `llms.txt` and the site said 926 tests (the suite runs about 3,600) and "zero mocks". They now share one figure, 3,500+, the site build fails when they disagree, and ROADMAP points at the top CHANGELOG entry instead of a version number.
- **Decision records share `docs/decisions/`; the grant folders and mockups moved under `docs/`.** Every link to the old paths is updated. The published package is unchanged.
- **AGENTS.md names two test conventions.** Name a test file after the behaviour it pins, and seed stores through the store helpers.
- **`docs/plans/cuts.md` records what the review follow-ups deferred or cut, and why.**
