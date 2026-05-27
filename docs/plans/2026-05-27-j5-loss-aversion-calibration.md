# Plan: J5 loss-aversion calibration (v1.13.5)

**Episode:** 01KSN2YNS4NBTP50GPAV1J00XS
**Status:** Draft v2 (revised after plan-eng-critic round 1 FAIL score 62)
**Roadmap entry:** `ROADMAP-RESEARCH.md` L558 — J5 Loss-aversion calibration [next]

## Round-1 critic fold-in

- **HIGH (per-call env read in hot loops):** v1 plan read `process.env.HIPPO_LOSS_AVERSION_RATIO` inside `calculateStrength`, which is called per-entry in the recall ranking loop (api.ts:2088/2120/2141/2150, consolidate.ts:144/571, search.ts:463/1002 per critic). A 1000-memory recall would hit `process.env` thousands of times. **Fix (option D / lazy module-cache):** read once on first call, memoize for process lifetime, expose `_resetLossAversionRatioCacheForTests()` to allow test env-toggling. Lazy (not eager at module-load) preserves the existing per-call env pattern (`HIPPO_AUTODEBIAS` is per-call but only ONCE per recall, not per-entry).
- **MED (test enumeration omits negative-only invariant):** added 3 explicit cases to assert env var does NOT affect `positive`, `critical`, or `neutral` multipliers.
- **MED (env validation policy underspecified):** explicit policy below; tests cover each case.
- **LOW (CHANGELOG migration text not drafted):** exact CHANGELOG copy below.
- **LOW (cross-pipeline invariance):** stated explicitly in Scope §pipeline-invariance.

## Scope

Per the roadmap entry (Lovallo-Kahneman TFAS empirics: losses ~2x larger than equivalent gains):

1. Change `EMOTIONAL_MULTIPLIERS` defaults in `src/memory.ts:126-131`:
   - `positive` (success-tagged): 1.3 → **1.0**
   - `negative` (error-tagged): 1.5 → **2.0**
   - `critical` stays at 2.0 (literal roadmap reading; J5 doesn't address critical; critical retains its ranking-signal use in `consolidate.ts`, `salience.ts`, `ambient.ts` even though it now equals `negative` in this specific multiplier).
   - `neutral` stays at 1.0 (no change).
2. Add `HIPPO_LOSS_AVERSION_RATIO` env var: a non-negative finite numeric scalar applied to the `negative` multiplier at strength-calculation time. Default 1.0 (no scaling). Per-domain tuning hook per roadmap; e.g. `HIPPO_LOSS_AVERSION_RATIO=0.8` softens loss aversion to 1.6x.
3. **Env read is module-level lazy-cached** (NOT per-call). First call to `calculateStrength` triggers a single `process.env.HIPPO_LOSS_AVERSION_RATIO` read; result memoized for the process lifetime. Test isolation via exported `_resetLossAversionRatioCacheForTests()` (mirrors the pattern from `tests/recall-history.test.ts` reset hook). This addresses plan-eng-critic round 1 HIGH on hot-loop overhead.
4. **Env validation policy (explicit):**
   - Valid: any non-negative finite number including `0` (treat `0` as "disable loss aversion entirely; negative multiplier collapses to 0.0"). The user who sets `0` is making a deliberate choice that the type system encodes as a real one.
   - Invalid (silent fallback to 1.0): empty string, non-numeric, negative numbers, `NaN`, `+Infinity`, `-Infinity`. Silent (no warn) because the env var is opt-in and a wrong value should not crash production recall.
5. **Pipeline-invariance:** all three recall pipelines (api.recall, cmdRecall, MCP `hippo_recall`) call `calculateStrength` via the shared `src/memory.ts` export. The ratio applies uniformly across all three. No per-pipeline override.
6. Tests covering (8 cases per critic round-1 expansion):
   - new defaults (positive=1.0, negative=2.0, critical=2.0, neutral=1.0)
   - env var scaling: `HIPPO_LOSS_AVERSION_RATIO=0.5` halves negative multiplier
   - env var off (no env set): defaults to 1.0 ratio
   - env=0: negative multiplier becomes 0.0 (deliberate disable)
   - env invalid (empty, non-numeric, negative, Infinity, NaN): silent fallback to 1.0
   - **negative-only invariant**: env var does NOT affect `positive` multiplier
   - **negative-only invariant**: env var does NOT affect `critical` multiplier
   - **negative-only invariant**: env var does NOT affect `neutral` multiplier
7. CHANGELOG entry under Added/Changed/Migration (text below).
8. 4-manifest bump 1.13.4 → 1.13.5 + npm install.

## CHANGELOG draft (exact copy)

```markdown
## 1.13.5 (2026-05-27): J5 loss-aversion calibration (Track J [next])

### Added

- **`HIPPO_LOSS_AVERSION_RATIO` env var.** Numeric scalar (default 1.0)
  applied to the `negative` (error-tagged) emotional multiplier at
  strength-calculation time. Per-domain tuning hook per ROADMAP-RESEARCH.md
  L555. Valid range: any non-negative finite number. `0` is treated as
  a deliberate "disable loss aversion" (negative multiplier collapses to
  0.0). Invalid values (NaN, Infinity, negative, non-numeric) silently
  fall back to 1.0 — opt-in env vars should not crash production recall.
- **8 new tests** in `tests/emotional-multipliers-j5.test.ts` covering
  defaults, env scaling, env off, env=0, invalid env values, and the
  negative-only invariant (env var does NOT affect positive / critical /
  neutral multipliers).

### Changed

- **`EMOTIONAL_MULTIPLIERS` defaults rebalanced per TFAS empirics**
  (Lovallo-Kahneman 2003: losses ~2x larger than equivalent gains):
  - `positive`: 1.3 → **1.0**
  - `negative`: 1.5 → **2.0**
  - `critical`: unchanged at 2.0 (roadmap is silent on critical; literal
    reading; ranking signal in `consolidate.ts` / `salience.ts` /
    `ambient.ts` is unchanged)
  - `neutral`: unchanged at 1.0
- Module-level lazy cache for `HIPPO_LOSS_AVERSION_RATIO` env read.
  `calculateStrength` reads the env ONCE per process lifetime
  (memoized after first call); reset hook
  `_resetLossAversionRatioCacheForTests` exported for test isolation.

### Migration

A 0.5-point shift on `negative` (1.5 → 2.0) is a 33% boost to
error-tagged memory strength in the recall ranking. Existing memory
stores will see error-tagged memories rise in recall position
post-upgrade.

Recovery path:

- `HIPPO_LOSS_AVERSION_RATIO=0.75`: 2.0 × 0.75 = 1.5, matching v1.13.4.
- `HIPPO_LOSS_AVERSION_RATIO=0.5` (minimum valid): 2.0 × 0.5 = 1.0,
  collapsing error multiplier to neutral baseline.

Values below 0.5 (including 0, negatives, NaN, Infinity, etc.) are
silently rejected and fall back to ratio=1.0 (default). The floor exists
to prevent a silent data-loss vector: at very low ratios, the negative
multiplier becomes small enough that `calculateStrength` can fall below
`DECAY_THRESHOLD = 0.05` in `src/consolidate.ts:146`, which would
permanently delete non-pinned error-tagged memories on the next sleep
cycle. See codex-review-critic round 1 P1 for the analysis.

Ambient state vector (`src/ambient.ts:143`) and physics particle mass
(`src/physics-state.ts:160-225`) both consume the dynamic strength
output, so existing stores will see modest shifts in those derived
values post-upgrade. Set `HIPPO_LOSS_AVERSION_RATIO=0.75` to preserve
v1.13.4 behavior exactly across all three surfaces.

The 30-day retrieval-relevance eval gate from the J5 roadmap entry
defers to natural usage; we cannot validate the calibration in-PR.
```

## Out of scope (deferred)

- **30-day retrieval-relevance eval** per roadmap. Defers to natural usage; success criterion ("error-tagged memories at 30d hold at >baseline; success-tagged memory recall does not regress on tier-1 micro-eval") can only validate after 30 days of post-deploy data.
- **`critical` multiplier review.** Roadmap is silent on critical. Future J5-v2 could revisit if the ratio collapse (critical == negative under new defaults) matters in practice.
- **Per-tenant overrides.** Env var is process-wide. Per-tenant tuning would need a config-table approach (defer to a J5-v3 if requested).
- **Python SDK parity.** No Python-facing change (env var read is server-side).

## Files changed

- `src/memory.ts`: edit `EMOTIONAL_MULTIPLIERS`; add env-var read inside `calculateStrength` (apply to `negative` multiplier only).
- `tests/emotional-multipliers-j5.test.ts` (NEW): 4-6 cases covering defaults + env var.
- `CHANGELOG.md`: 1.13.5 entry.
- `package.json`, `openclaw.plugin.json`, `extensions/openclaw-plugin/*` (2 files), `package-lock.json`: bump 1.13.4 → 1.13.5.

## Risks

1. **Strength-rebalancing across the existing memory store.** A 0.5-point shift on `negative` (1.5 → 2.0) means existing error-tagged memories suddenly score 33% higher on recall. Risk: error-tagged recall flood. Mitigation: env var lets users dial back (`HIPPO_LOSS_AVERSION_RATIO=0.75` recovers v1.13.4 behavior). Document the migration consideration in CHANGELOG.
2. **Critical collapse with negative.** As noted in scope. Acceptable risk per roadmap reading.
3. **Env-var parsing edge cases.** `parseFloat` with `NaN` / `Infinity` / negative input. Test the silent-fallback-to-1.0 path.
4. **Test contamination across files.** Vitest may parallel-run tests that mutate `process.env.HIPPO_LOSS_AVERSION_RATIO`. Use `beforeEach` / `afterEach` to set + delete the env var per test (matches existing pattern in `tests/api-recall-autodebias.test.ts`).

## Success criteria (in-PR)

- `npm run build` clean.
- New test file passes (4-6 cases).
- Full suite continues to pass minus the known flaky `server-concurrency.test.ts` ECONNRESET.
- CLI functional verify: `hippo recall <query>` against a store with error-tagged memories shows higher recall position for those memories than v1.13.4 baseline (proxy for "new defaults are live").

## Success criteria (post-deploy, deferred)

- After 30 days of natural usage: retrieval-relevance of error-tagged memories at 30d holds at >v1.13.4 baseline; success-tagged memory recall does not regress on tier-1 micro-eval. Per roadmap.
