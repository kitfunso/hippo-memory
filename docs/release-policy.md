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

`scripts/check-manifest-versions.mjs` runs in `prepublishOnly` and
asserts that 4 lockstep manifests match `package.json` version:

- `package.json` (root)
- `openclaw.plugin.json` (root)
- `extensions/openclaw-plugin/package.json`
- `extensions/openclaw-plugin/openclaw.plugin.json`

Adding a new lockstep manifest? Append to `LOCKSTEP_MANIFESTS` in the
script. Independent packages (`ui/`, `extensions/claude-code-plugin/`)
that own their release cadence are intentionally excluded.

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

## Test isolation patterns

Tests that mutate `process.env.HIPPO_LOSS_AVERSION_RATIO` (or any other
lazy-cached env var) must call the corresponding `_resetCacheForTests()`
hook in BOTH `beforeEach` AND `afterEach`. The canonical pattern lives
in `tests/emotional-multipliers-j5.test.ts`. Skipping the reset hook
makes test order significant (the cache holds a stale read from a
previous test); skipping the `afterEach` reset leaks state into the
NEXT test file that doesn't touch the env var.
