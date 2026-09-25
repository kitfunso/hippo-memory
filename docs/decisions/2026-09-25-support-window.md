# Support window: 12 months per stable minor, one promotion a quarter

Date: 2026-09-25
Status: accepted
Links: ROADMAP.md EV3; docs/release-policy.md "Support window"; SECURITY.md; PR #241

## Context
EV3 asks for a written support window: each `stable` minor supported for 12 months. Taken
as written, that promise has no ceiling, and a backport had no way to reach npm.

## Constraints and evidence
- Provenance: Keith's go on 2026-09-25 ("Okay, go"). Claude chose the cap under that
  delegation. Merging PR #241 is Keith's confirmation; closing it reverses the call.
- Cadence: 170 versions in six months, 38 in the last 90 days (release-policy.md, "Why").
  Uncapped, every minor promoted to `stable` adds a line to maintain for a year.
- npm 11 refuses to publish a version below `latest` without `--tag` (npm
  `lib/commands/publish.js`), and `npm-publish.yml` passed none, so no backport could ship.
- `stable` has never been set, so no existing promise changes.

## Decision
Each minor promoted to `stable` is supported for 12 months from its promotion, and at most
one promotion happens per calendar quarter, so at most five lines are live at once. Only
security and data-loss fixes are backported, as patch releases the workflow publishes under
`maint-<x.y>`. Moving `stable` to a patch of the line it already points at is not a promotion.

## Alternatives considered
- The roadmap text with no cap: a weekly promotion would mean 52 live lines.
- Current and previous `stable` only: breaks the roadmap's 12 months.
- Backports published from a laptop: no provenance, which is what EV3 exists to fix.

## Consequences
- A company on `stable` moves to a newer line once a year; hippo maintains at most five.
- Each backport is a patch release, a GitHub release (not marked latest) and an SBOM.
- Moving `stable` needs an npm login; the workflow never does it.

## Reconsider when
- Backports start piling up across lines, or a customer contract asks for another window.
