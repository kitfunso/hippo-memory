# Separating the stored confidence tier from the derived age-out

Episode `01M1YEMBWTZ4P2NA952MJTKDYX`. Base `914284e`.

## The defect

`resolveConfidence` (`src/memory.ts:447`) answers one question with two facts fused
into it:

```ts
export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
  if (entry.pinned || entry.confidence === 'verified') return entry.confidence;
  const daysSince = (now.getTime() - new Date(entry.last_retrieved).getTime()) / 86_400_000;
  if (daysSince > 30) return 'stale';
  return entry.confidence;
}
```

The stored tier says why we believe a memory: `verified`, `observed`, `inferred`, or
`stale` when a human rejected it through `hippo invalidate` or a decision supersede.
The derived age-out says nobody has touched the row in 30 days. The function returns
one `ConfidenceLevel` for both, so an aged-out `observed` row and a deliberately
rejected row come back identical and the stored tier is unrecoverable at the call
site.

Ten sites call it. Nine of them display or report, and one of those nine is already correct:

| Site | Surface | What it shows today |
| --- | --- | --- |
| `cli.ts:1964` | `hippo recall --why` JSON | `confidence` = collapsed |
| `cli.ts:2078` | `hippo recall` human | `[stale]` with a warning glyph |
| `cli.ts:2254` | `hippo explain --json` | `confidence` = collapsed |
| `cli.ts:2618` | `hippo trace` human + JSON | `Confidence: stale`, `confidence` = collapsed |
| `cli.ts:3523` | `hippo status` | four tier buckets, aged-out rows counted as Stale |
| `cli.ts:3742` | `hippo inspect` | correct already: `observed (effective: stale)` |
| `cli.ts:6132` | context render | `[stale]` with a warning glyph |
| `dashboard.ts:94` | dashboard JSON, then `ui/` | `confidence` and `by_confidence` = collapsed |
| `mcp/server.ts:210` | MCP `formatMemories` | `[stale]` |

Command names checked against the dispatch table during execution: `cli.ts:2254`
is `cmdExplain`, `cli.ts:2618` is `cmdTrace`. Plain `hippo recall --json` emits no
`confidence` field at all, so it is not on the list.

The tenth, `replay.ts:105`, filters rather than displays and genuinely wants the
collapsed answer: a rejected row and an aged-out row are both unfit to rehearse. It
stays as it is. So eight sites change.

`> 30` appears exactly once in `src/`, at `src/memory.ts:453`, so there is no second
copy of the threshold to keep in step.

Measured 2026-09-07 on the two live stores: 5 of 530 rows in `~/hippo/.hippo` differ
between stored and displayed tier, and 0 of 1896 in `~/.hippo`, because the prompt
hook recalls often enough to keep `last_retrieved` fresh. Small live footprint, so
this is reporting correctness, not an outage.

Execution found the mechanism behind that number. `markRetrieved`
(`src/search.ts:1254`) resets `last_retrieved` on every row a retrieval returns, and
`hippo context` renders the refreshed copy, so a row surfaced by the prompt hook can
never display as aged out. The surfaces where the age-out is actually visible are the
ones that read without retrieving: `hippo status`, `hippo trace`, `hippo inspect`, the
dashboard, and the `--why` / `explain --json` analysis paths, which report the
pre-refresh entry. `hippo recall`'s human line does show it, because the row it prints
is still the aged one. That does not shrink the change: the retrieval surfaces stop
being accidentally correct (right only because a write ran first) and become correct
by construction.

## What this change is not

`ConfidenceLevel` itself conflates a tier with a state, and the clean fix removes
`'stale'` from the union and gives invalidation its own stored state. That is a
breaking change to a type exported from `src/index.ts` plus a migration of the 807
live rows holding the literal. It needs sign-off and is not taken here. It stays
filed in `TODOS.md`.

## The change

### 1. One predicate, two facets (`src/memory.ts`)

Extract the age-out test so the 30-day threshold lives in exactly one place, then
express both consumers in terms of it.

```ts
function isAgedOut(entry: MemoryEntry, now: Date): boolean {
  if (entry.pinned || entry.confidence === 'verified') return false;
  return (now.getTime() - new Date(entry.last_retrieved).getTime()) / 86_400_000 > 30;
}

export interface ConfidenceFacets {
  tier: ConfidenceLevel;
  agedOut: boolean;
}

export function confidenceFacets(entry: MemoryEntry, now: Date = evalNow()): ConfidenceFacets {
  return { tier: entry.confidence, agedOut: isAgedOut(entry, now) };
}

export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
  return isAgedOut(entry, now) ? 'stale' : entry.confidence;
}
```

`resolveConfidence` keeps its exact behaviour for all four input shapes: pinned and
verified return the stored value because `isAgedOut` is false for them, an old row
returns `'stale'`, a fresh row returns the stored value. It stays exported, because
`replay.ts` wants it and `src/index.ts` publishes it.

The field is named `agedOut`, not `stale` as the TODO entry proposed, because
`'stale'` is simultaneously a tier value and the name of the derived state, which is
the whole defect. A boolean called `stale` sitting beside `tier: 'stale'` would
reproduce the ambiguity in the fix.

### 2. Display sites

Compact labels (`cli.ts:2078`, `cli.ts:6132`, `mcp/server.ts:210`) render
`[observed]` or `[observed, aged]`. The existing warning glyph rule widens from
"collapsed value is stale or inferred" to "tier is stale or inferred, or the row is
aged out", which covers exactly the same rows as today plus none.

`hippo status` (`cli.ts:3523`) buckets by stored tier and prints one more line:

```
  Verified:        N
  Observed:        N
  Inferred:        N
  Stale:           N                              <- rejected rows only
  Aged out:        N  (excludes pinned, verified) <- not retrieved in 30 days
```

The parenthetical is load-bearing. `agedOut` carries the same pinned and verified
exemption `resolveConfidence` has always had, so the count is of rows that aged out
*for trust purposes*, not of rows that are simply old. The alternative, a pure age
predicate with the exemption moved back out to the callers, was rejected: it makes
all eight display sites re-implement the policy that this change exists to hold in
one place. The label says what the number is instead.

The new counter gets its own variable rather than a fifth key in the `byConfidence`
record at `cli.ts:3506`, which is initialised with exactly the four tier keys.

`hippo inspect` (`cli.ts:3742`) is left alone. It already prints both facets and it
is the only site here that a rewrite could regress: the suffix at `cli.ts:3747` is
conditional on `effectiveConfidence !== entry.confidence`, so a row that is both
rejected and aged out prints no suffix today, while the same line driven off
`agedOut` would newly print `stale (effective: stale)`. It holds no second copy of
the threshold, so leaving it costs nothing.

JSON surfaces (`cli.ts:1964`, `cli.ts:2254`, `cli.ts:2618`) change `confidence` to
the stored tier and add `aged_out`. This is a user-visible change to CLI JSON, taken
deliberately: `recall --why` reporting `confidence: "stale"` for a row whose stored
tier is `observed` is the defect in the title. The pair is lossless, since the old
value is `aged_out ? 'stale' : confidence`.

Nothing consumes these shapes: `extensions/openclaw-plugin/index.ts` shells only
`conflicts --json`, MCP never parses CLI output, and the python SDK talks HTTP to
`src/api.ts`, which never calls `resolveConfidence` and so already returns the stored
tier. `hippo context --format json` already emits `confidence: r.entry.confidence` at
`cli.ts:6040`, so this change makes the CLI agree with itself rather than breaking a
contract.

`context --format json` deliberately does NOT gain `aged_out`. The plan first added it
there on the reasoning that omitting it would leave one surface silently missing the
signal. Review round 1 falsified that: `src/api.ts:2820` replaces every returned entry
with its `markRetrieved` copy, and the one path that skips the refresh is `pinnedOnly`,
whose rows `isAgedOut` exempts anyway. The field could only ever be `false` there. A
field that always reports "not aged" is worse than no field, so it was removed and the
test that covered it, which asserted `false` and therefore passed for any implementation,
was replaced by one that pins the absence.

That leaves a real semantics question, not taken here: `aged_out` means "aged out at the
moment of retrieval, before this command refreshed the row". `recall --why` and
`explain --json` report the pre-refresh entry and so can say `true`; `context` reports the
post-refresh entry and so cannot. Whether a retrieval surface should report pre- or
post-retrieval state is a fork on the highest-traffic path in the product. It is filed in
`TODOS.md`, not decided in a display-layer change.

`dashboard.ts` does the same for its per-memory `confidence` and its
`by_confidence` buckets, and adds a per-memory `aged_out` plus an `aged_out` count in
stats. The shape is internal: `src/dashboard.ts` is not exported from
`src/index.ts` and its only consumer is `ui/` in this repo, so it is changed rather
than shimmed.

The UI filter DOES need a change, which review round 1 caught. `filterState.ts:178`
filters on `m.confidence` against the same four values, so before this change an aged-out
`observed` row arrived as `"stale"` and the stale checkbox caught it. After the change it
arrives as `"observed"` and nothing reaches it, so the dashboard silently loses the
ability to isolate cold memories. Age-out is a separate axis from the tier, so it gets its
own toggle, `agedOutOnly`, cloned from the `fadingOnly` boolean that already sits beside
it (state field, `isFilterActive` branch, one line in `deriveVisibleIds`, one checkbox).
`Stats.aged_out` is rendered in `StatsPanel` next to the at-risk count rather than left as
a required field nothing reads. `Memory.aged_out` is required, not optional:
`src/dashboard.ts:124` is its only producer and always sets it, so optional would only
have let a stale bundle against a new server render "not aged" in silence. The seven test
fixtures are updated.

`by_confidence` has no UI consumer at all. But the detail panel does: `LivingMap.tsx:182` renders
`["Confidence", memory.confidence]`, so after the change an aged-out `observed` row
reads "observed" there with no age signal anywhere in the panel, because `age_days`
is age since created, not since retrieval. Adding the field to `ui/src/types.ts`
without rendering it would be an information loss, so the panel renders
`observed (aged out)`.

### 3. Tests

New file `tests/confidence-display-facets.test.ts`, 15 cases over real stores, plus
one fixture added to the context-render snapshot file.

Facet cases: an aged-out `observed` row splits into `{ tier: 'observed', agedOut: true }`;
a freshly rejected row gives `{ tier: 'stale', agedOut: false }`, the pair today's
single value cannot express; a row both rejected and old gives both; `resolveConfidence`
is unchanged across six shapes including pinned and verified; the threshold boundary,
where exactly `30 * 86_400_000` ms is not aged out and one millisecond more is; a row
never retrieved since it was created; a pinned row and a verified row untouched for a
year, which is what the `hippo status` label promises.

Surface cases, each on the command that can actually reach the state: `hippo status`
counts an aged-out `observed` row under Observed and Aged out, never Stale;
`recall --why` JSON and `explain --json` report `confidence: "observed"` with
`aged_out: true`; `context --format json` carries no `aged_out` key at all; the dashboard payload
reports the stored tier, `aged_out`, and the `aged_out` stat; `hippo trace` renders
`observed, aged` in both its human and JSON output; `hippo recall`'s human line renders
`[observed, aged]` while `hippo context` reads the same shape as `[observed]`, which
pins the retrieval refresh described above; MCP `formatMemories` renders the stored
tier.

One existing snapshot file needs a fixture, not a re-baseline.
`tests/__snapshots__/cli-context-render-snapshot.test.ts.snap` locks eight
`printContextMarkdown` outputs, and every fixture in it carries
`last_retrieved: 2026-05-22` under a fake now of `2026-05-23`, so no aged-out row is
snapshotted anywhere. One aged-out fixture is added. The eight existing snapshots came
through byte-identical.

Mutants run, each killed by a different case: `isAgedOut` always false (12 cases plus
the snapshot); the label dropping its `, aged` suffix (3 plus the snapshot); the
threshold flipped to `>= 30` (1); `warn` dropping its `agedOut` term (the snapshot's
glyph only); the pinned and verified exemption removed (2); `resolveConfidence` no
longer collapsing (1). Three more after review round 1: the trace column padding back at
10 (1); `aged_out` re-added to `context --format json` (1); the `agedOutOnly` line
dropped from `deriveVisibleIds` (3 of the new UI cases).

Review round 1 also caught an alignment break the first test set could not see, because
it asserted `toContain('observed, aged')` on the whole output. `hippo trace` prints
`Confidence: ${conf.padEnd(10)}`, which assumed a value of 10 characters or fewer;
`observed, aged` is 14 and pushed the `Pinned:` column left. The padding is now 14 and
the test compares the index of `Pinned:` between a long label and a short one, which is
the property that was actually wanted.

## Success criteria

- `hippo status` on a store holding one aged-out `observed` row and one rejected row shows Observed 1, Stale 1, Aged out 1.
- The eight changed display sites call `confidenceFacets`. `resolveConfidence` keeps exactly two callers in `src/`: `replay.ts:105`, which wants the collapsed answer, and `hippo inspect`, which is already correct and is not touched.
- Full suite green, `ui/` build green, `ui/` suite green, and the eight existing context-render snapshots byte-identical.
- Every `aged_out` the code emits can be `true` on the surface that emits it. No surface reports a field it can only ever answer `false` to.
- The dashboard can still isolate cold memories after the tier stops standing in for them.
- `resolveConfidence`'s own behaviour is bit-identical, pinned by case 4. Already checked ahead of the plan across 40 generated input shapes, including the exact 30-day boundary, a future `last_retrieved` and a malformed one: 0 mismatches.
