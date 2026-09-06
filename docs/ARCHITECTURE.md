# Architecture Notes

Detail moved out of source comments during the 2026-08-30 comment-density
cleanup (rule: `~/.claude/rules/coding-standards.md`). Each heading traces
back to a specific compressed comment in the file named.

## 2026-08-30 — src/memory.ts

### Timestamp canonical form (near `MemoryEntry`, ~line 30)
Canonical form is UTC `toISOString()`. Sort order for chronological
ordering is a byte comparison on this string (F4, v1.6.5), which only
holds if every stored timestamp is canonical. Legacy rows rebuilt from
markdown can carry a non-canonical offset, e.g. `2026-05-06T05:55:49-04:00`
instead of the UTC equivalent — byte-sorting such a row against a
canonical one gives the wrong order. Importers should normalize on write;
rebuild-from-drifted-markdown producing non-canonical offsets is a known
limitation, not yet fixed at the source.

### `bm25_score` (on `MemoryEntry`, ~line 115)
Populated only when ALL of: the query is non-empty, FTS5 is available
(`fts5_available=1`), and the FTS5 join returned at least one row for the
entry. `undefined` on every other path: empty query, FTS5 unavailable,
LIKE fallback, full-store fallback, `readEntry`, `loadAllEntries`, manual
upsert, and `deserializeEntry` from markdown. SQLite FTS5 `bm25()` is
negative and ascending (more negative = better match) — not comparable to
the JS BM25 implementation in `search.ts`. Provenance/rank metadata only.

### Emotional multipliers (near `EMOTIONAL_MULTIPLIERS`, ~line 150)
Calibrated in J5 against Lovallo & Kahneman's loss-aversion finding
(losses weighted ~2x gains). Positive valence: 1.3 -> 1.0. Negative
valence: 1.5 -> 2.0. Critical stays 2.0 (J5 did not touch it — it is a
ranking signal shared with `consolidate.ts`, `salience.ts`, and
`ambient.ts`, and changing it here would have moved those too). Neutral
stays 1.0. Runtime-tunable via `HIPPO_LOSS_AVERSION_RATIO`.

### `LOSS_AVERSION_RATIO_MIN` (~line 180)
Floor is 0.5, derived from the v1.13.4 shipped default: at 0.5 the
effective negative multiplier is `2.0 * 0.5 = 1.0`, i.e. 1.5x weaker than
that default. Below 0.5 the caller is asking for less loss-aversion than
any shipped version ever had — outside the range this code has been
tuned or tested against.

### Recall-boost ablation anchor (`calculateStrength`, decay-exponent branch)
With recall-boost ablated, decay anchors at `created` instead of
`last_retrieved`. Reasoning: `last_retrieved` is mutated by retrieval
events from prior, unflagged runs; anchoring there would let strengthening
picked up before the ablation flag was set leak into this arm's rankings.
On a fresh store the two timestamps are identical at write time, so the
identity holds from creation. Prior-run `half_life` increments are not
retroactively reconstructed — the ablation only controls the anchor going
forward, not past accumulated strength.

## 2026-08-30 — src/importers.ts

### K1 vault importer design (top of the vault-importer section)
Mirrors the connector pattern used by `src/connectors/slack|github`, not
the single-file importers above it in this file. Each note becomes one
`kind='raw'` row with provenance in tags (`source:vault` + `vault:<name>`),
an `artifactRef` cursor key, and a content-hash tag. A changed file APPENDS
a new raw row after `archiveRaw` of the old one; a deleted file
`archiveRaw`s the orphaned row. The importer never calls `supersede` on a
raw row — supersede yields `kind='distilled'`, which both loses
raw-append-only protection and escapes the `kind='raw'` deletion rescan.
All raw deletions route through `archiveRaw`, the only trigger-legit path.

### `ImportOptions.name` / vault name collision (field doc + `importVault` guard)
Vault name is the identity key for the destructive deletion-sync. Earlier
code defaulted it to the folder basename; two unrelated vaults sharing a
basename (e.g. `work/notes` and `personal/notes`) collided on the same
`vault:<name>:*` prefix, so importing the second loaded the first's rows
and the deletion-sync archived them. Fix: require an explicit name,
`importVault` throws if unset.

### Privacy footgun guard (`importVault`, scope validation)
Hippo's recall filter only default-denies scopes shaped
`<source>:private:*` (`isPrivateScope` / `PRIVATE_SCOPE_RE` in scope.ts).
A bare `private` (or `private:<x>`) first segment is NOT recognized as
private, so notes a user believed were private would still be returned to
no-scope recall callers. The guard rejects that alias and points at the
source-prefixed form (`vault:private:<name>`) instead of silently storing
public-visible "private" notes. It reuses `isPrivateScope` itself as the
source of truth so the two can't drift.

### Self-store no-op guard (`importVault`, must run first)
If the vault folder IS the Hippo store (or lives inside it), there are no
real vault notes, only the store's own markdown mirror files. Letting
`collectMarkdownFiles` return `[]` for this case is unsafe: an empty scan
is indistinguishable from "every note was deleted", so deletion-sync would
archive every live `vault:<name>:*` row — and raw-archive's content
redaction makes that loss IRREVERSIBLE. The only safe reading of "import
the store into itself" is "do nothing", so this guard runs before the
existing-rows load and the deletion-sync pass, not folded into the walk.

### Self-import prevention (`collectMarkdownFiles`, `realpathOrResolve`)
`collectMarkdownFiles` skips dot-directories and the canonicalized store
path while walking, so re-importing a vault that CONTAINS the store never
ingests its own markdown mirror files — without this, `hippo import
--vault .` right after `hippo init` in that same folder would self-import
its mirror rows and grow on every run. The comparison canonicalizes via
`fs.realpathSync.native` (dereferences symlinks/junctions, normalizes
Windows case) rather than `path.resolve`, because `path.resolve` does
neither: an aliased store path (junction, or a case-variant on Windows)
previously slipped past a `path.resolve`-based guard and triggered the
mass-archive above. `realpathOrResolve` falls back to `path.resolve` only
when the path doesn't exist yet, since an uninitialized store or a typo'd
vault path can't be a live self-store — a non-existent vault folder just
fails later in the walk (`readdirSync`) before deletion-sync runs.

## 2026-08-30 — src/shared.ts

### `HybridSearchOptions.recallScope` (field doc)
Consumed by `searchBothHybrid` only. Absent (`undefined`) is the only
unfiltered mode: both stores load via `loadSearchEntries` unchanged
(background pipelines / eval callers). Present switches the internal loads
to `loadRecallSearchEntries` (SQL scope predicate) plus a recall-scope JS
post-filter, with three distinct shapes:
- `{}` — default-deny (`unknown:legacy` + `<source>:private:*` excluded)
- `{ requested: 'X' }` — exact match on scope X (`api.recall` semantics)
- `{ requested: 'X', additive: true }` — default-admitted set PLUS scope X
  (CLI `--scope` semantics; see `recall-scope.ts` `passesCliRecallScopeFilter`)

Object form is deliberate, not incidental: the sibling `scope` option on the
same interface already gives `null` a distinct meaning (boost-neutral), so a
flat `string | null` for `recallScope` would overload `null` with
contradictory semantics. Do not pass an empty object casually from
non-recall paths — `{}` is the default-deny mode, not a no-op.

### `searchWindow = entryFilter ? 5000 : undefined` (`searchBothHybrid`)
When an admission filter (`entryFilter`) is active, the per-store candidate
cap is lifted from the default 200 to 5000, because excluded rows matching
the query could otherwise fill the window before any admitted row is even
loaded. Only ambient-context query mode sets `entryFilter`, and that path is
interactive (never the per-turn pinned-only hook), so ranking the full match
set is acceptable there. 5000 = 25x the default 200-row window: large enough
that exclusion crowding is a non-issue on real stores, bounded so a common
query term on a 100k-row store cannot stall an interactive call by ranking
every match.

### `autoShare` tenant scoping (JSDoc + `globalEntries` read)
`options.tenantId` is opt-in. When provided, the LOCAL-entries read is
scoped to that tenant; when undefined, the local read is host-wide. The
GLOBAL-entries read is always unioned across tenants — the global root IS
the cross-tenant aggregate by design, so per-tenant filtering there would
defeat the purpose. The only intentional unscoped internal caller (as of
v1.12.1) is `api.sleep` (`src/api.ts:2041`), which omits `tenantId` because
`sleep` is host-wide by intent; see `src/api.ts:2073-2077` for the
cross-tenant dedup rationale at that call site.

## 2026-08-30 — ui/src/engine/scene.ts, ui/src/state/filterState.ts

### `filterActive` disambiguation (`scene.ts` `setFiltered`, `filterState.ts` `isFilterActive`)
Both files independently need to tell "no filter is active" apart from "a
filter is active and matched zero rows" — the same bug, found in the same
review pass, fixed in both places:
- `filterActive=false` -> no filter; show all (`visibleIds` ignored).
- `filterActive=true` + empty set -> filter matched zero; hide all.
- `filterActive=true` + populated set -> show only ids in the set.

The old gate compared `visibleIds.size > 0`, which collapsed the first two
cases into the same "show all" behavior — a filter that legitimately
matched nothing silently fell back to showing everything, a silent
UI/engine state divergence. Never reintroduce a bare `size > 0` check on a
filtered-id set; always carry a separate `filterActive` boolean.

### `sharedTagEdges` leak on unmount (`scene.ts` `dispose()`)
`populate()` already disposes `sharedTagEdges` geometry+material between
rebuilds, but `dispose()` (the unmount/HMR teardown path) was found not to
dispose them at all — a real leak, bounded by `HARD_EDGE_CAP` (2000)
`LineBasicMaterial` + `BufferGeometry` pairs per dashboard unmount cycle.
Fixed by including `sharedTagEdges` in the `dispose()` loop alongside
`tendrils` and `conflictLines`.

### `FADING_STRENGTH_THRESHOLD` cross-file mismatch (`filterState.ts`)
BE uses 0.1 in two places (`src/dashboard.ts:95`, `src/mcp/server.ts:736`).
`src/cli.ts:2541` uses 0.2 instead — a known, not-yet-fixed inconsistency
between the CLI's fading definition and everywhere else (frontend included,
via this constant). Align `src/cli.ts:2541` to 0.1 to close the gap.

## 2026-08-30 — src/ablation.ts

### Eval-only ablation flag reference (module header)
`src/ablation.ts` flags are EVAL-ONLY (the "lifecycle, ablated" paper
protocol) — no config-file equivalent, undocumented in user-facing help,
semantics may change with experiment design. Production behavior with all
flags unset is byte-identical to before this module existed.

- `HIPPO_ABLATE_DECAY` — time-decay term := 1 in `calculateStrength`.
- `HIPPO_ABLATE_RECALL_BOOST` — full recall-strengthening ablation:
  `markRetrieved` returns entries unmutated (ids still available so `hippo
  outcome` attribution keeps working); persisting callers (CLI recall, api
  context, MCP recall/context, consolidation replay) skip their writeEntry
  loops; retrieval-count read boost := 1; decay anchors at `created` instead
  of `last_retrieved` (blocks prior-run clock resets leaking in); physics
  `computeMass` ignores the count and `physicsSearch` recomputes loaded
  masses live under ablated rules (persisted masses embed recall history in
  their frozen strength component); replay rehearsal is silenced entirely.
- `HIPPO_ABLATE_OUTCOME` — both outcome channels neutral (= SLOW + FAST
  together); also silences replay's outcome reward bias (`replayPriority`).
  NOT gated: the opt-in `recall --value-aware` rerank — ablated arms must not
  pass that flag.
- `HIPPO_ABLATE_OUTCOME_SLOW` — `rewardFactor` := 1 (no half-life modulation).
- `HIPPO_ABLATE_OUTCOME_FAST` — `hybridSearch` outcomeBoost := 1.
- `HIPPO_FAKE_NOW` — injected `now` for strength computation and retrieval
  stamping. Must round-trip byte-identical through `Date.toISOString()`
  (rejects junk, locale dates, and rolled-over dates like `2026-02-31`);
  anything that doesn't round-trip falls back to the real clock.

CAVEAT (`HIPPO_ABLATE_RECALL_BOOST`): half_life increments persisted by
prior unflagged runs are not reconstructed — ablation arms must run on FRESH
stores, per the experiment protocol.

### Decay-ablation hidden coupling (load-bearing for experiment analysis)
Ablating decay has two intrinsic co-effects because the unified strength
formula routes other mechanisms through the decay term (prereg amendment
A1 treats the decay-off arm as "decay + its dependents off"):
1. Read-side strengthening flattens: `raw = retrievalBoost * emotionalMult
   >= 1`, and the [0,1] clamp caps it at 1.0 — the recall boost can only
   offset decay, never exceed baseline (write-side still runs).
2. Outcome-slow goes inert: `rewardFactor` only acts by scaling the
   effective half-life inside the decay exponent; with decay := 1 there is
   no exponent left to modulate. This is decay-rate modulation by design, so
   "no decay" necessarily means "no slow channel" (outcome-fast in
   `hybridSearch` is unaffected).

Env caching follows the house pattern (`getLossAversionRatio` in
`memory.ts`): read once per process, with a test-only reset helper.
