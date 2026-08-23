# DF2 — Capture extractor: keyword-preserving, clause-bounded capture

Status: Draft rev 3 (episode 01M0QG886DY90D7VVYTH6MKVET, plan stage)
Roadmap: ROADMAP.md Part VI, DF2 [next]
Base: origin/master 06adc90 (v1.35.0)

**Every claim below carries a measured BEFORE and a measured AFTER.** Rev 1
and rev 2 were each rejected for a claim measured only against the unpatched
build; the post-state is now simulated and executed for the whole corpus.

## The roadmap's stated cause is false (measured)

Part VI blames hard-slicing before extraction (`capture.ts` ~424-434).
Executed: the live fragment reproduces byte-identically from untruncated
source, and identically under `.slice(0,500)` and `.slice(0,120)`.
Truncation is not involved. The roadmap entry needs the same premise
correction DF3's did.

## Root cause: one mechanism, two symptoms

All 16 patterns are a keyword alternation followed by a fixed-width capture
**that begins after the keyword**:
`/(?:never|always|must(?:\s+not)?|…)\s+(.{5,200})/i`.
`extractFromPatterns` (capture.ts:98-116) takes `match[1]` and accepts on
length alone.

**Symptom 1 — the capture counts characters, so it overruns the clause.**
**Symptom 2 — the keyword is discarded, so prohibitions inflect positive.**

## Design (two changes; measured corpus below)

### T1 — capture FROM the keyword, not after it

Fixes Symptom 2: `never` / `must not` / `do not ever` survive into stored
content, so a prohibition still reads as one.

### T2 — bound the capture to the clause instead of 200 characters

Stop at `,`/`;`/`:` + whitespace, or at a sentence terminator **that is
followed by whitespace or end-of-string**.

The whitespace requirement is load-bearing and was found by simulating the
post-state: a bare `[.!?]` split truncates on periods *inside tokens*.
Measured — `"You must never commit the .env file to the repository."` bounded
on bare `.` yields `"must never commit the"`, which then FAILS the write gate
and is silently dropped. Hippo memories are full of `.env`, `capture.ts`,
`v1.35.0`. With the whitespace requirement it yields the full clause.

The 200-char ceiling is RETAINED as an upper bound: the capture is
clause-bounded **or** 200 characters, whichever comes first. Without it, a
long span containing no clause terminator would grow past the 500-char
ceiling in `extractFromPatterns` and the whole match would be **dropped**,
where today it is truncated at 200 and stored — a silent behaviour change on
abbreviation- or code-heavy prose. Round-3 critic finding; folded.

Trailing cleanup extends `cleanExtract` to drop an unmatched trailing `)`
left by clause-bounding. **Algorithm, stated to avoid a naive
implementation:** count `(` and `)` in the captured string and strip trailing
`)` only while closes exceed opens — never strip a trailing `)` that balances
an opening one (measured: `"never got entries)"` → `"never got entries"`,
while a balanced `"always run the suite (twice)"` is left intact).

## Measured corpus — BEFORE and AFTER, with the write-gate verdict

`isContentWorthStoring` run on the actual post-fix string, not assumed:

| Case | Stored TODAY | Stored AFTER | gate |
|---|---|---|---|
| "Never use --no-verify on git commits in this project." | `"use --no-verify on git commits in th…"` **(inverted)** | `"Never use --no-verify on git commits…"` | pass |
| "You must never commit the .env file to the repository." | `"never commit the .env file to the re…"` | `"must never commit the .env file to t…"` | pass |
| "We should always run the suite twice locally before merging…" | `"run the suite twice locally before m…"` | `"always run the suite twice locally b…"` | pass |
| "Never edit capture.ts and audit.ts in the same commit…" | `"edit capture.ts and audit.ts in the …"` | `"Never edit capture.ts and audit.ts i…"` | pass |
| "…(two had never got entries), plus one documented exception." | `"got entries), plus one documented ex…"` **(fragment)** | `"never got entries"` | **fail → not stored** |
| "I have never seen this test fail on master before, so it is…" | `"seen this test fail on master before"` | `"never seen this test fail on master …"` | pass |
| "Never force push to main." | **NONE** | `"Never force push to main"` | pass |

Two results in that table are behaviour changes worth naming explicitly,
because rev 2 asserted the opposite of one of them:

1. **Fragments now self-reject.** Clause-bounding makes an overrun capture
   short and vague, and the *existing* write gate then rejects it. The two
   mechanisms compose; no change to the gate is needed.
2. **Short imperatives start being captured.** `"Never force push to main."`
   is uncapturable today and captured after the fix. Cause, measured:
   `hasProperNoun = /[A-Z][a-z]{2,}/` (audit.ts:66) matches the preserved
   sentence-initial `"Never"`, so `hasNoSpecificity` returns false and the
   gate accepts. Rev 2 claimed these would "still return none after this
   fix" — **that claim was false**, caught by the round-2 critic.
   The outcome is desirable (these are genuine rules) but it arrives via a
   case-sensitivity quirk in the gate: the same rule typed lowercase is still
   rejected (`isContentWorthStoring("never force push to main")` → false).
   That quirk is pre-existing, out of scope here, and backlogged.

## Scope limit, stated honestly

T1+T2 make every capture **coherent and correctly signed**. They do **not**
make the extractor judge rule-versus-narrative: "I have never seen this test
fail" still captures, now as `"never seen this test fail on master before"` —
a complete, correctly-signed clause instead of shrapnel with the negation
stripped. That is the honest limit. Precision on rule-detection is a judgment
problem, not a regex problem, and the DF3 episode is the evidence for not
attempting it with heuristics (three attempts to widen a shared text
predicate, three regressions). Backlogged.

## REJECTED designs (both measured, both rejected on evidence)

- **Clause-start anchoring** (rev 1). Would regress genuine captures:
  `"We should always run the suite twice locally"` and `"You must never commit
  the .env file"` are captured today and both would be dropped, because
  ordinary rule phrasing puts the keyword after a subject and modal. Position
  cannot separate `"We always run the suite twice"` (a practice) from `"I have
  never seen this fail"` (narrative).
- **Fixing `PREFERENCE_PATTERNS[0]`'s two-group shape here** (rev 2's T3).
  Real defect — measured: `"Prefer using SQLite instead of Postgres for local
  dev."` stores `"using SQLite"`, because only `match[1]` is ever read, and
  `match[2]` runs to end-of-sentence (`"Postgres for local dev."`). The
  connective is also non-capturing, so a faithful reconstruction needs a new
  capture group. Two critic rounds found rev 2's specification of this
  underdetermined. It is an independent defect in a different pattern set —
  **removed from this plan and backlogged as its own item** rather than
  carried as a third under-specified change.

## Correction found during execute: label keywords must NOT be preserved

T1 as planned said "preserve the keyword". Executing it uniformly surfaced a
distinction the plan had not drawn, and it matters:

- **Semantic keywords carry sign.** `never`, `must not`, `do not ever`,
  `always`. Dropping them inverts the meaning — that is the entire point of
  T1, so they must be preserved.
- **Label keywords carry none.** `decision:`, `rule:`, `error:`,
  `important:`, `the X is`. They only name a category, and the category is
  already recorded in `item.category` / `tags`. Prefixing them onto the
  content is duplication — and it broke two tests in
  `tests/rejection-acceptance.test.ts`, because AT1's rejected-value guard
  digests the **bare** content and a `"decision: "` prefix changes the hash.

Discriminator implemented: a prefix ending in its own colon, or matching
`the <word> is`, is dropped; everything else is preserved. Measured after:
`"Error: the migration silently dropped…"` → `"the migration silently
dropped…"`; `"Never use --no-verify…"` → `"Never use --no-verify…"`;
rejection-acceptance back to 14/14.

A second executor finding, also folded: a single combined capture group lets
a colon-terminated keyword's OWN colon read as a clause boundary, truncating
the capture down to just the keyword. Hence two groups per pattern, with
clause-scanning applied only to the content group.

## Accepted limitation: AT1 tombstones predating this change

Raised at review (confidence 75, below the blocking bar) and accepted rather
than fixed. `checkRejectionGuard` digests the exact normalized content
(`rejectionDigest`, sha256 over NFC-lowercased text). This change alters the
captured content shape for RULE items — `"use --no-verify…"` becomes
`"Never use --no-verify…"` — so a tombstone a user created against the
OLD shape will not match the NEW capture, and that value becomes
re-capturable once.

Not fixed here because the alternatives are worse: rewriting stored
tombstones is a data migration over user memory (the exact thing DF4/AT3's
quarantine work exists to do carefully), and digesting content with keywords
stripped would reintroduce the inversion this change removes. AT1 shipped
2026-08-15, eight days before this, so the affected population is small.
Recorded so a re-capture after upgrade reads as known, not mysterious.

## Non-goals

- Not touching `isContentWorthStoring` / `isFragment` (shared with capture's
  write gate; three DF3 regressions).
- Not touching source truncation (measured irrelevant).
- No cleanup of already-stored inverted/fragmented memories (producer only;
  existing rows are DF4/AT3 quarantine territory).

## Tests (real DB, no mocks; `extractFromText` is the exported seam)

Each red-under-old case is confirmed by reverting the fix and observing the
failure — never assumed.

1. **Inversion pin:** `"Never use --no-verify…"` → content contains `never`.
2. **Fragment self-rejects:** the `"(two had never got entries), plus one…"`
   sentence → **no** stored item (clause-bound + existing gate).
3. **Overrun stops at the clause:** `"I have never seen this test fail…, so
   it is probably a flake."` → content excludes `"so it is"`.
4. **Periods inside tokens survive:** `"Never edit capture.ts and audit.ts in
   the same commit without running npm test."` → content contains
   `capture.ts`. Red under a bare-`[.!?]` bound.
5. **Genuine rules keep their keyword** — corpus measured capturable today:
   the `must never commit the .env file` and `should always run the suite
   twice` cases.
6. **DECISION and ERROR sets:** one keyword-preserved case each (`"We decided
   to pin the version…"`, `"The issue was that the reserve loop did not
   dedupe…"`), asserting the new shape is intended for those sets too, not an
   unexamined side effect of a uniform change.
7. **Documented behaviour change:** `"Never force push to main."` → now
   captured. Pins the rev-2 correction so it cannot silently regress.
8. **Pattern-set coverage sweep:** a table-driven case per pattern ARRAY
   (DECISION, RULE, ERROR, PREFERENCE) asserting each one's post-fix shape,
   so the "uniform across all 16" claim is pinned rather than asserted from
   three examples. Round-3 critic finding; folded.
9. **Upper-bound retained:** a long clause-free span still yields a stored
   (truncated) item rather than being dropped — pins the ceiling behaviour
   above.
10. **No-regression:** existing `tests/capture*.test.ts` green.

## Acceptance

- A prohibition is never stored as an instruction (1).
- No stored capture runs past its clause (2, 3).
- Tokens containing periods are not truncated (4).
- Every rule capturable today is still captured, keyword intact (5, 6).
- The short-imperative behaviour change is tested, not discovered (7).
- Existing capture tests unchanged (8).

## Risks

- **Clause-bounding could over-truncate** a rule spanning a comma ("Never
  force push, even on a feature branch"). Guard: test 5's corpus plus the
  8-char floor. If a genuine rule truncates badly, bound on sentence
  terminators only.
- **Stored content shape changes** across all four pattern sets. Intended;
  tests 5 and 6 pin the intended shape per set. No migration — existing rows
  untouched.
