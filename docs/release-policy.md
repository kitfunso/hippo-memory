# Release Policy

Conventions for shipping hippo-memory. Surfaces the discipline decisions that
the in-repo critic chain (`/dev-framework-rl`) reads at release time. Not a
sub of `ROADMAP.md` (which owns scope), `TODOS.md` (which owns open work), or
`CHANGELOG.md` (which owns the per-ship record).

## Critic chain iteration threshold (codex / independent-review)

**Heuristic:** when a critic round produces ONLY P2/LOW issues for two
consecutive rounds (or one round if the previous round was a clear PASS),
the next move is "ship with Known Limitations" rather than re-iterating.

**Rationale.** In a session-bounded release cycle, the marginal value of a
sixth critic round is usually zero: rounds 1-3 catch real correctness bugs
(wrong sequencing, contract drift, security holes); rounds 4-5 catch taste
and asymptotic edge cases; rounds 6+ converge on style preferences the
critic could have written regardless of the diff. The threshold formalises
when to stop chasing the asymptote.

**When NOT to apply.** Override the heuristic and keep iterating when:

- Any critic round flags a NEW CRIT or HIGH (a real correctness, security,
  or data-integrity issue). Iteration continues until those are zero.
- The same defect class recurs across rounds (e.g. rounds 3 + 4 + 5 each
  catch a different instance of the same root cause). The recurrence is
  a STOP signal in itself: fix the root cause before shipping.
- A critic reports zero tool calls (it produced a verdict from the prompt
  text without reading the diff). That verdict is invalid; re-launch the
  critic.

**Operational form.** When applying the heuristic, the ship-stage entry
in CHANGELOG / commit body should list the deferred P2/LOW items explicitly
under "Known limitations" and link to the follow-up patch ticket (or, if
small, the next minor version). The discipline is documented-and-deferred,
not silently-skipped.

**Provenance.** Derived from observed convergence patterns across the
hippo-memory v1.13.0-v1.13.5 ship cycle (May 26-27, 2026), where:

- J1 anchoring detector (v1.13.2): 6 codex rounds. R1-R3 caught real bugs
  (sessionId drift, Unicode regex, FNV vs SHA-256 hash). R4-R6 caught
  documented hash-collision edges. Shipped at R6 with Known Limitations.
- J3.2 watching variant (v1.13.4): 3 codex rounds. R1 caught silent-no-
  class-match, R2-R3 P2 catches folded. Shipped clean.
- J5 loss-aversion calibration (v1.13.5): 2 codex rounds. R1 P1 caught
  insufficient HIGH fix (any ratio<0.025 still hit deletion threshold);
  fixed via 0.5 floor. R2 P2-A (api.recall pipeline divergence pre-
  existing J5) documented as Known Limitation. R2 P2-B (vacuous behavioral
  fixture) folded.

## Manifest version lockstep (pre-publish guard)

Eight sites carry the release version:

- `package.json` (root)
- `package-lock.json`, `.version` and `.packages[""].version`
- `openclaw.plugin.json` (root)
- `extensions/openclaw-plugin/package.json`
- `extensions/openclaw-plugin/openclaw.plugin.json`
- `server.json` (the MCP registry entry)
- `src/version.ts` (`PACKAGE_VERSION`)

Bump them with one command in the release PR:

    npm version <x.y.z> --no-git-tag-version

npm writes `package.json` and the lockfile, then runs the `version` script:
`scripts/sync-version.mjs` copies the version to the other five sites and
`scripts/check-manifest-versions.mjs` confirms all eight. Pass
`--no-git-tag-version` because the tag is cut at publish, from the squash
commit on master. Never edit the sites by hand.

`scripts/check-manifest-versions.mjs` also runs in `prepublishOnly`, so a
drifted site still blocks the publish. Adding a new lockstep manifest?
Append it to `LOCKSTEP_MANIFESTS` in the check and to `JSON_MANIFESTS` in
the sync script; the check fails `npm version` until both agree.
Independent packages (`ui/`, `extensions/claude-code-plugin/`) that own
their release cadence are intentionally excluded.

Provenance: 3 manifest drifts in 7 days (v1.12.11 publish slip, v1.12.12
bundle fix, v1.13.1 nested manifest drift) before this check existed.

## Em-dash discipline (pre-publish guard)

`scripts/check-em-dashes-in-release-notes.mjs` scans the CHANGELOG.md
entry for the version about to be published and rejects on em-dash
(U+2014). Historical entries from before the discipline are not in
scope; only the section matching the current `package.json` version
gets scanned.

Why scoped: backporting em-dash purity to v0.x-v1.13.x CHANGELOG
entries is a separate doc-clean-up task, not a release blocker.

## Test suite (pre-publish guard)

`prepublishOnly` ends with `node scripts/check-tests-pass.mjs`, which runs `vitest run` through
node and vitest's own bin (no npm shim, no `pretest` rebuild). It runs after `build:all` so the
CLI-spawning tests see the fresh `dist/`. Extra arguments pass through to vitest, so
`node scripts/check-tests-pass.mjs tests/foo.test.ts` gates on one file; `--outputFile` and
`--output-file` are the arguments it rejects, because vitest treats them as the same option and the
gate reserves vitest's JSON report for itself.
That run leaves out the four slow token-eval harness tests (`EVAL_TESTS` in `vitest.config.ts`); `npm-publish.yml` runs them through `token-eval.yml` on the tagged commit and stops if one fails.

Any non-zero vitest exit refuses the publish, and the gate prints the JSON report's counts so the
log says whether assertions failed or something outside them did. The report covers assertion
results only, so a failing globalSetup teardown, which is how this repo's store-isolation guard
reports a leak, is green in the report and must not publish. There is no skip switch: releases
publish from CI (`npm-publish.yml`), where nothing sets one, and a red suite is fixed before the
tag. The gate used to forgive vitest 3's `[vitest-worker]: Timeout calling "onTaskUpdate"` exit on a
green report and to honour `HIPPO_PUBLISH_SKIP_TESTS`; vitest 5 no longer prints that text, and no
release path set the variable, so both were removed. `npm publish --ignore-scripts` is not an
escape hatch either: it skips the manifest, em-dash and graph-write guards too.

## Test isolation patterns

Tests that mutate `process.env.HIPPO_LOSS_AVERSION_RATIO` (or any other
lazy-cached env var) must call the corresponding `_resetCacheForTests()`
hook in BOTH `beforeEach` AND `afterEach`. The canonical pattern lives
in `tests/emotional-multipliers-j5.test.ts`. Skipping the reset hook
makes test order significant (the cache holds a stale read from a
previous test); skipping the `afterEach` reset leaks state into the
NEXT test file that doesn't touch the env var.

## Publishing, provenance and the stable channel

**Publishing.** Push a `v<x.y.z>` tag on the squash commit on master. `.github/workflows/npm-publish.yml` first runs the whole CI workflow on the tagged commit (every job in `.github/workflows/ci.yml`, with Windows, macOS, the Node floor and coverage) and stops if any job fails; the slow token-eval tests run beside it under the same rule. It then checks that the tag matches `package.json`, runs the `prepublishOnly` gate and publishes with `--provenance`. A tag whose CI failed publishes nothing; re-running the failed jobs in that run publishes it once they pass. The workflow picks the npm dist-tag with `scripts/publish-dist-tag.mjs`, from the registry's current `latest`: a newer version goes to `latest`, an older one (a backport, see "Support window") to `maint-<x.y>`, and a prerelease to `next`. If the registry cannot be read, the publish stops. Do not publish from a laptop: a laptop publish has no provenance. The one-time npm setup is described at the top of the workflow.

**SBOM.** Publishing the GitHub release for a `v<x.y.z>` tag runs `.github/workflows/sbom.yml`. It builds `hippo-memory-<x.y.z>.cdx.json` from that tag's lockfiles with `scripts/sbom.mjs` and attaches it to the release: a CycloneDX list of the runtime packages the tarball ships, the dashboard's bundled ones included. Create the release with a personal token (the web page, `gh` or the API), because a release made with a workflow's `GITHUB_TOKEN` starts no other workflow. For a release that has no SBOM, run the workflow by hand with its `tag` input.

**Two channels.**
- `latest`: every release from master. This is the default `npm install hippo-memory`.
- `stable`: a release that has been on `latest` for at least 7 days with no fix release on top of it. Companies pin this with `npm install hippo-memory@stable`.

To promote a release to `stable`:

    npm dist-tag add hippo-memory@<x.y.z> stable

A security fix may go to `stable` straight away. Record each promotion in the changelog entry of the release it promotes.

**A release on the wrong tag.** A dist-tag is only a pointer, so moving it back loses nothing: `npm dist-tag add hippo-memory@<x.y.z> latest` (or `stable`, or `maint-<x.y>`) with an npm login puts the right release back, and the release that was there by mistake stays installable by its version.

**Why.** An outside review (2026-09-24) counted 170 versions in six months, 38 in the last 90 days, and none with provenance. For a developer, frequent releases look like momentum. For a company's security team they look like risk. Without a verified build and a slower channel, hippo cannot pass their review.

## Support window

**What is supported.** The release on `latest` is supported, and its fixes ship in the next release. Each minor version promoted to `stable` is a supported line for 12 months from its promotion, even after `stable` moves to a newer line. Nothing else is supported. `SECURITY.md` carries the same table for people reporting a vulnerability.

**One promotion a quarter.** Promote at most one release to `stable` in each calendar quarter. Any 12 months overlap five calendar quarters at most, so no more than five lines are supported at once. Moving `stable` to a patch release of the line it already points at, as a backport does, is not a promotion: it uses no quarter's slot and does not restart the 12 months.

**What gets backported.** Security fixes and fixes for bugs that lose data. Everything else waits for the next release from master.

**Backporting a fix.** Merge the fix to master first. Then, for each older supported line that needs it:

1. Branch `release/<x.y>` from the line's last `v<x.y.z>` tag, or check that branch out if an earlier backport made it.
2. Cherry-pick the fix. Its `changelog.d` fragment comes with it; write one if it had none, because `fold` refuses to run without one.
3. Run `npm version <x.y.z+1> --no-git-tag-version`, then `node scripts/changelog-fragments.mjs fold`, and commit.
4. Push a `v<x.y.z+1>` tag on that commit. `npm-publish.yml` publishes it under `maint-<x.y>`, so `latest` stays where it is.
5. Publish a GitHub release for the tag, as for any release, so it gets its SBOM. Untick "Set as the latest release" (in the API, `make_latest: "false"`); GitHub sets it by default, and the backport would then show as the repository's latest release.
6. If `stable` points at this line, move it: `npm dist-tag add hippo-memory@<x.y.z+1> stable`. This needs an npm login; the workflow never moves `stable`.
