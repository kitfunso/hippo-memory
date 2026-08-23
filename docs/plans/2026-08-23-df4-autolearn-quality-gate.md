# DF4: git auto-learn admits no-information commit subjects

Episode `01M0QZDC5DY34QZHQMB3R92ES8`. Roadmap Part VI, last open item.

## Problem

`hippo learn` (and the MCP `learn` tool) parse recent git subjects and store
each match as a memory with no quality predicate. Bare subjects land in the
store and `hippo audit` then flags them: measured on the live store today,
**37 issues over 1473 memories, 36 of them the "no specific details" class** -
`"mobile responsive polish"`, `"sort row truncation and toggle crowding"`,
`"fixed signals"`. The roadmap recorded 44 at v1.33.0; the drop is decay and
consolidation, not a fix.

Same shape as DF1-DF3, and the binding Part VI note names it: **the verifier
exists only downstream (audit) while the producer ingests unconditionally.**

## What discovery changed about the roadmap's fix shape

**1. The "merge subject+body" option is eliminated by measurement.** The
roadmap offers "either merge subject+body before the check or skip".
`fetchGitLog` pulls `--pretty=format:%s` - subjects only - so merging bodies
means changing the fetch. Measured across 4 repos and 1053 commits:

| Repo | commits | subject passes | subject+body passes | rescued by body |
|---|---|---|---|---|
| quantamental | 762 | 733 | 733 | **0** |
| mure | 123 | 123 | 123 | **0** |
| hippo | 120 | 102 | 102 | **0** |
| shiny | 48 | 48 | 48 | **0** |

Every subject the gate rejects is still rejected with its body appended.
Merging buys nothing here and costs a fetch-format change. **Skip it.**

**2. The cleanup is BLOCKED and is out of scope.** The roadmap routes the
existing rows "through AT3's quarantine once it ships"; AT3 is `[planned]`,
4-6d. Hard-delete is barred by the never-delete-when-weakening-suffices rule,
and `hippo audit --fix` only removes `error` severity - these are `warning`.
So the roadmap's success criterion *"audit issue count drops to single digits
after cleanup"* **cannot be met by this episode and is not claimed.** This
episode stops new junk; the 36 existing rows wait for AT3.

## Design

`extractLessons` is exported from `src/index.ts` - a **public API surface**, so
compat binds (coding standards: published surfaces keep compat). It also does
one job well: parse a git log into candidate lesson strings. Filtering inside
it would both break that contract and silently change what external callers
get.

So parsing and **admission** are separated:

- **New export, `partitionLessons(lessons: string[])`** in `src/autolearn.ts`,
  returning `{ kept, dropped }` by `isContentWorthStoring`. Purely additive.
- **Both write paths call it** - `cli.ts:6298` (`learnFromRepo`) and
  `mcp/server.ts:1172` (MCP `learn`). This is ONE shared helper used twice,
  not the same guard pasted at N call-sites; the guard lives in one place.
- **The drop count is REPORTED, never silent.** Both sites already surface
  `added / skipped / rejected`; `low-information` joins them. An absent
  memory raises no error, so the count is the only way a user sees the gate
  working - the DF2 ship-gate lesson applied forward.

`extractLessons` itself is unchanged.

### Anti-coupling test (the grill's objection, addressed)

This makes autolearn the **fourth** consumer of `isContentWorthStoring`, after
the capture write gate, the DF3 include-recent floor, and `auditMemory`.
Yesterday's v1.36.0 ship gate found that widening that same predicate silently
changed behaviour for a consumer nobody re-swept.

So autolearn gets a test that pins its OWN admission behaviour against fixed
inputs - the six roadmap-named junk subjects out, three detail-carrying
subjects in. If a future change to the shared predicate moves autolearn's
boundary, that test fails HERE rather than quietly altering what git
auto-learn ingests.

## Tasks

- **T1** `partitionLessons` + unit tests (`tests/autolearn.test.ts`).
- **T2** Wire both call sites; add the `low-information` count to both summary
  lines. Do not change `added`/`skipped`/`rejected` semantics.
- **T3** Anti-coupling pin test + a call-site test proving junk subjects do
  not reach the store and detailed ones do.

## Success criteria (falsifiable)

1. `extractLessons` signature, return type and behaviour unchanged; the
   existing `tests/autolearn.test.ts` passes untouched.
2. Running `hippo learn` over a repo whose subjects are the six roadmap-named
   junk strings stores **none** of them and reports the count.
3. A commit subject carrying a path, number or flag still stores.
4. Both call sites gated - proven by a test per site, not by inspection.
5. Full suite green.

## Explicitly NOT in scope

- Cleanup of the 36 existing flagged rows (blocked on AT3).
- Any change to `isContentWorthStoring` itself.
- `captureError`'s command-failure memories - a different producer, not the
  DF4 class.
