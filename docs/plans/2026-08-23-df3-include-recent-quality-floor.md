# DF3 — Quality floor on `--include-recent` injection

Status: Draft (episode 01M0Q4BMEZZE2EX0YRHJ102RV6, plan stage)
Roadmap: ROADMAP.md Part VI, DF3 [next, small]
Base: origin/master 45b03c6 (v1.34.0)

## Problem

The UserPromptSubmit hook runs `hippo context --pinned-only --include-recent 5`.
The `includeRecent` branch (src/api.ts:2456-2491) sorts local+global entries by
`created` desc, slices N, and admits every one of them. The only upstream filter
is scope/project isolation (`ambientAdmitEntry`, api.ts:191, applied at 2407).
There is no quality predicate at all, so a low-information memory goes from
"stored" to "read on every prompt" with nothing in between.

## Root cause

The `includeRecent` selection path has no admission predicate. This is its own
root, at the read/admission boundary — not a symptom of a producer bug. It is
the one surface every hippo user reads on every prompt, and it admits from
**every** producer: capture, auto-learn, manual `hippo remember`, imports.

## Measured scope (this reshaped the plan — read before reviewing)

The roadmap's DF3 entry asserted this floor is "the amplifier that turned DF2's
fragments into per-prompt noise". **That premise is false**, measured against
the real live entries at plan time:

| Case (real content from the live store) | `isContentWorthStoring` | `auditMemory` | Filtered by DF3? |
|---|---|---|---|
| Fragment 1 — "got entries), plus one documented exception in the list-sync validator, …" | `true` | none | **No** |
| Fragment 2 — "fetches a quote → blank price" | `true` | none | **No** |
| Auto-learn — "fixed signals" | `false` | warning: no specific details | Yes |
| Auto-learn — "globe view on by default" | `false` | warning: no specific details | Yes |
| Clean control (git-email memory) | `true` | none | No (correct) |

Reproduce:
```bash
node --input-type=module -e "import {isContentWorthStoring} from './dist/audit.js'; \
console.log(isContentWorthStoring('fetches a quote → blank price'))"   # true
```

Why the fragments pass: `capture.ts:174` **already** calls
`isContentWorthStoring` on every extracted item, so anything in the store via
capture passed this exact gate at write time. `isFragment` (audit.ts:56-60)
only catches text starting `to `/`for `/`and ` under 50 chars.

**Consequence, and this is the honest deliverable boundary:**

- DF3 fixes the **vague / no-specificity / version-bump / too-short class** —
  the class DF4's 44 flagged auto-learn entries belong to.
- DF3 **cannot** fix mid-sentence fragments. They are indistinguishable from
  good content at the read surface. That is DF2's job at the producer
  (boundary-aware truncation, so the fragment never exists).

This strengthens the Part VI pattern note rather than weakening it: the
fragment class *must* be fixed at the producer because no read-side predicate
can detect it.

## Design

One change, at the one choke point. All three `includeRecent` callers
(`cli.ts:5915`, `server.ts:1160`, MCP) route through `api.getContext`, and
inside it there is exactly one block that consumes `includeRecent` — nested in
the `if (pinnedOnly)` branch (api.ts:2445-2491). Precise coverage claim:
patching that block covers every caller *that has any effect today*. Note a
pre-existing quirk this plan does not change: `includeRecent > 0` with
`pinnedOnly: false` is silently ignored, because no non-pinned path reads the
value. Backlogged separately, out of scope here.

In the `includeRecent` block (src/api.ts:2456-2491), insert a quality filter
**before** the `.slice(0, includeRecent)`:

```ts
.filter(({ entry }) => isContentWorthStoring(entry.content))
.slice(0, includeRecent)
```

Three properties, each deliberate:

1. **Filter before slice.** The caller asked for N recent *useful* entries. A
   post-slice filter would silently return fewer (N minus junk); a pre-slice
   filter backfills past the junk to N qualifying entries.
2. **Skip, never delete.** This is a read-path admission decision only. No
   store mutation, no audit row, nothing becomes unrecoverable.
3. **Reuse the shared definition.** `isContentWorthStoring` (audit.ts:117) is
   already the repo's junk predicate for write admission — its only other
   caller is capture's write gate (capture.ts:174). It shares its underlying
   predicates (`isFragment`, `isVersionBump`, `hasNoSpecificity`,
   `substantiveWordCount`) with `auditMemory`, which is the separate function
   the `hippo audit` CLI and the sleep quality phase call. (An earlier draft
   of this plan and of the commit message described `isContentWorthStoring`
   itself as "the sleep audit's" gate — inaccurate, corrected here: the sleep
   phase calls `auditMemories`, api.ts:2969.) Adding a third, DF3-only
   definition of junk would be the actual anti-pattern.

`api.ts` already imports from `./audit.js` (line 60), so this adds no new
module dependency and crosses no boundary.

**Pinned entries DO need the `entry.pinned ||` bypass — corrected after a
cross-model (codex) review finding.** This plan went back and forth on the
clause, so the reasoning is recorded in full:

- Draft 1 carried `entry.pinned ||`, justified as "necessary or pinned entries
  vanish". Round-1 plan critic correctly showed that justification was wrong:
  the pinned block (api.ts:2493-2524) is a separate loop that admits pinned
  entries unconditionally, deduping on `selectedIds`, so a pinned entry
  dropped from the recent listing is re-added there.
- Draft 2 therefore dropped the clause.
- **Codex then found the case both of those missed:** the two loops share one
  budget (`usedP` / `effBudget`). Without the bypass, a heuristic-failing
  pinned entry is dropped from the recent slice, an unpinned entry backfills
  into its slot and spends that budget, and when the pinned block finally runs
  it hits `usedP + r.tokens > effBudget` and `continue`s — the pin is omitted
  entirely. The pinned block is only a safety net when budget is not already
  spent. Under pressure it is not.
- The clause is restored. Test 3b constructs the budget pressure explicitly
  (pinned junk entry newest, three clean 18-token entries, `includeRecent: 3`,
  `budget: 55`) and is red without the bypass, green with it.

Lesson recorded for the roadmap: "a later loop re-adds it" is not sufficient
reasoning whenever the two loops draw on a shared budget.

## Locale correctness (added after the codex review)

`substantiveWordCount` split on `/\s+/` only, so a CJK sentence — which has no
whitespace word boundaries — scored as one "word" and failed the `< 2` check.
Measured: `isContentWorthStoring('データベース接続がタイムアウトしたときは再試行の間隔を二倍にする')`
returned `false`. Applying the floor at the read surface would therefore have
hidden Japanese/Chinese memories from injection.

Fixed in `substantiveWordCount`: CJK characters are counted as substantive
units (~2 chars per word) separately from the latin word split, with CJK runs
stripped before that split so nothing double-counts. The change is **strictly
more permissive** — it can only admit content previously rejected, never
reject something previously admitted — which is why it is safe to make in a
predicate shared with capture's write gate. It also fixes a pre-existing
silent data-loss bug: `capture.ts:174` has been dropping CJK content at write
time. Verified unchanged on every latin fixture (junk still junk, clean still
clean, version-bumps still rejected, the documented fragment case still
passes).

## Non-goals (explicit)

- **Not strengthening `isFragment` / the shared heuristic.** An earlier draft
  justified this with "it feeds the sleep audit's hard-delete path" — **that
  was false and is corrected here.** Verified at api.ts:2969-2977: the sleep
  audit deletes only issues with `severity === 'error'`, and `isFragment`
  yields `severity: 'warning'` (audit.ts:88-90), so it never reaches
  `deleteEntry`. Only `too short` and `isVersionBump` are error-severity.
  The real reason to leave it alone: `isFragment` is also a term in
  `isContentWorthStoring`, which is capture's **write** gate
  (capture.ts:174). Widening it silently rejects more content at write time —
  under-storing good memories, a failure mode that is invisible (nothing is
  logged for a memory that never existed) and strictly worse than the junk it
  would prevent. Fragment detection belongs to DF2's producer fix
  (boundary-aware truncation, which removes the fragment at its source
  instead of guessing at its shape).
- **No config knob.** No user has asked for raw-recent; a toggle is
  speculative surface area (Simplicity First). The floor is the behavior.
- **No skipped-count telemetry** on `ContextResult`. Additive but unrequested;
  `hippo audit` already reports store-wide junk counts.
- **No cleanup of existing junk.** Read-path only. DF4 owns the producer fix
  and the one-time cleanup routes through AT3's quarantine.

## Tests (real DB, per project convention)

1. **Red-under-old (roadmap acceptance, verbatim):** store seeded with one junk
   entry (real text `"fixed signals"`) + four clean recent writes,
   `includeRecent: 5` → the four clean inject, the junk does not. Fails under
   current code.
2. **Filter-before-slice:** 8 recent entries alternating clean/junk,
   `includeRecent: 5` → exactly 5 clean entries returned (backfilled past the
   junk), not 5-minus-junk.
3. **Pinned unaffected:** a pinned entry whose content fails the heuristic
   still injects — explicit user intent wins.
4. **Measured-limitation pin (documents the boundary):** the real live fragment
   text is NOT filtered. Locks the honest scope so a future reader does not
   assume DF3 covers fragments; will need updating only if DF2 changes the
   shared heuristic.
5. **`includeRecent: 0` / absent:** byte-identical behavior to today.
6. **All-recent-junk:** recent path contributes nothing, no crash, pinned
   entries still returned.
7. **CLI end-to-end:** `hippo context --pinned-only --include-recent 5` against
   a seeded store excludes the junk.

## Acceptance (roadmap DF3, verbatim)

- "A store seeded with one junk and four clean recent writes injects only the
  clean four" → test 1.
- "Pinned injection unchanged" → test 3, plus the untouched pinned block.

## Risks / grill findings

- **False positives on genuinely short-but-useful memories.** The heuristic
  requires ≥10 chars, ≥2 substantive words, and specificity only under 40
  chars. The clean control passed. Risk accepted: this is the same gate that
  already governs what capture is allowed to store, so a memory it rejects at
  read time is one capture would have refused to write.
- **Behavior change for existing users** (some recent entries stop appearing).
  Intended, and it is the point; the changelog states it and `hippo audit`
  shows what qualifies as junk.
- **The heuristic is content-only, not usage-aware.** A strength/retrieval-count
  gate is the sophisticated alternative and is LC3-reranker territory; using
  the existing shared predicate keeps one definition of junk today.
