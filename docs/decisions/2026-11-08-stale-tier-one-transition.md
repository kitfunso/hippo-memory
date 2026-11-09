# Stored `stale` stays a tier, written by one transition that halves once

Date: 2026-11-08
Status: accepted
Links: PR #1178; `src/base/memory/stale-mark.ts`; `tests/scripts/stale-tier-writes.test.ts`

## Context
Invalidation and decision supersede each wrote `confidence: 'stale'` and halved the half-life on every call, so a repeated `hippo invalidate` or a second `decide --supersedes` of one memory compounded it toward 1 day. The aged-out facet was already derived at read time (`isAgedOut` in `src/base/memory/strength.ts`) by earlier work, so the stored tier and the derived facet were already separate.

## Evidence
- A copy of one real global store (22997 rows): 128 stored stale rows; 12 carry `invalidated`, 0 carry `superseded`, 116 carry neither and predate the read-time facet. 7 observed or inferred rows carry `invalidated` without being stale.
- Live CLI runs on base and head: invalidate twice gives 365 -> 182 -> 91 on base and 365 -> 182 -> 182 on head; supersede twice gives the same contrast.
- A first version keyed the once-only rule on the marker tag alone. Review found that `createSuccessor` (`src/base/memory/entry.ts`) copies parent tags onto a fresh verified row, so a replacement never got its first halving. The CLI run after the fix: successor 365 -> 182 -> 182 on head.

## Decision
- `stale` stays a stored tier. Only `markStale` writes it; the tree-scan test fails on any other literal writer in `src`.
- `markStale(entry, marker)` halves only when the row is not already stale under that marker. Each cause (`invalidated`, `superseded`) halves once.
- The markdown bootstrap refuses a file whose tier is not one of the four, with a warning that names the file, instead of storing the unknown value.

## Alternatives considered
- Drop `stale` as a tier and derive it: needs a data migration of 128 rows and changes the stored confidence set. Rejected.
- A column that counts completed reductions: a schema change for a fact the tier and tag already hold. Rejected.
- Strip marker tags in `createSuccessor`: fixes one copy path only; tags can also arrive typed or imported.

## Consequences
- Repeating an act no longer compounds the half-life. A row hit by both causes halves twice.
- The 116 untagged legacy stale rows stay as they are; repairing them is a separate data decision.
- A successor still inherits marker tags, so `halfLifeRecallBonus` gives it no recall bonus. This predates the change.

## Reconsider when
- A third cause of stale appears, or a path resets the tier to non-stale while keeping a halved half-life.
