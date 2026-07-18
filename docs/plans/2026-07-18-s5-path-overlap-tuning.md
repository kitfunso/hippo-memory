# S5 path-overlap tuning: helper isolation + measured normalization fix

**Status: Draft (not yet engineering-reviewed)**
**Episode:** 01KXTBPRV5R3KJVTPMPPG9M8TT (dev-framework-rl)
**Base:** origin/master `564c9719` (v1.26.3)
**Roadmap item:** TODOS.md "Memory scope isolation post-ship tail" item 5 (deferred-by-design from the v39 plan; codex P2-16/P3-20: "the boost lives in generic search code shared with recall; isolate + measure separately").

## Problem

`pathOverlapScore` (src/path-context.ts:29-37) normalizes by the **memory's** path-tag count:

```ts
return matches / memoryPathTags.length;
```

Two defects, one refactor debt:

1. **Genericity is rewarded, specificity punished.** A memory carrying a single
   generic path tag (e.g. `path:skf_s`, auto-attached when remembering from the
   home directory) scores `1/1 = 1.0` from ANY cwd under home and receives the
   full 1.3x boost everywhere. A memory with 4 specific tags queried from a
   sibling project scores `2/4 = 0.5` (1.15x). The boost exists to reward
   *locality*; under this normalization a location-free memory outboosts a
   location-specific one from every foreign directory. Named in the v39 plan
   ("bare `path:skf_s` scores 1.0 everywhere under home").
2. **Duplicated boost logic.** Both call sites re-implement
   filter-tags -> score -> `1.0 + score * 0.3`:
   `hybridSearch` (src/search.ts:597-600) and sync `search`
   (src/search.ts:1155-1158). The 0.3 weight is a magic number at both.
3. **Measurement blindness.** The tier-1 micro-eval cannot see ANY of this:
   `benchmarks/micro/run.py:104` runs every `remember` and `recall` with
   `cwd = the fixture's temp HIPPO_HOME`, so all memories in a fixture carry
   identical auto path tags and the boost is uniform across candidates —
   it cancels in ranking. "Measure under the tier-1 micro-eval" is currently
   vacuous for this code path.

## Goals (falsifiable acceptance)

1. **T1 — helper isolation, behavior-frozen.** One exported helper computes the
   path boost; both search.ts call sites use it; zero behavior drift (existing
   unit tests unchanged and green; micro-eval 11/11 identical pre/post).
2. **T2 — make the measurement real.**
   a. Micro harness gains an additive per-item `cwd_subdir` knob so a fixture
      can write memories from different directories and query from a chosen
      one — the cross-cwd defect case becomes constructible in tier 1.
   b. New fixture `benchmarks/micro/fixtures/path_boost.json` (mechanic
      `path-boost`) authored from DESIRED semantics (locality wins), not from
      any candidate's implementation: with base scores held comparable, a
      cwd-local memory must outrank a home-root generic memory from that cwd.
      Expected: FAILS (or exposes the inversion) under status-quo scoring —
      the red run is the measurement.
   c. `run.py` HIPPO_BIN Windows fallback (bundled from the loop backlog:
      `C:/Users/skf_s/hippo/.devrl-backlog.md` Candidates, filed from episode
      01KXPDKZ friction as B-sized "bundle into a future hardening pass" —
      this run.py-touching episode is that pass; same file):
      when the default `hippo` binary is unspawnable (WinError 2 cmd-shim
      class), fall back to `node <repo-root>/bin/hippo.js`. Acceptance from
      the backlog: fresh clone + built dist -> `python benchmarks/micro/run.py`
      works on Windows with no env override. No behavior change when
      `HIPPO_BIN` is set or `hippo` spawns.
3. **T3 — evidence-gated normalization fix (pre-registered decision rule, see
   below).** Either ship the winning candidate with tests updated to the new
   contract, or ship T1+T2 only with a documented no-change decision.
   Either way: `docs/evals/2026-07-18-s5-path-overlap-result.md` records
   baseline, candidates, and the decision.

## Non-goals (hard out-of-scope)

- `extractPathTags` / write-time tag attachment (cli.ts:765 + E2/capture/learn
  sites): changes stored data; overlaps the eval-gated BM25 path-tag item.
- BM25/FTS corpus path-token handling (separate eval-gated TODOS item).
- `physicsSearch` gains no path boost (pre-existing asymmetry, noted only).
- The 1.3x boost cap / weight value stays: only the normalization inside the
  helper is tunable this episode.
- No public-API surface change: `path-context.js` is not exported from
  src/index.ts; `pathOverlapScore` stays exported from the module for
  back-compat (existing tests import it).

## Design

### T1 — helper (src/path-context.ts)

```ts
export const PATH_BOOST_WEIGHT = 0.3;

/** Multiplier applied to a composite recall score for path locality.
 *  Filters the memory's tags to path:* itself so call sites cannot drift. */
export function pathBoostMultiplier(memoryTags: string[], currentPathTags: string[]): number {
  const memPathTags = memoryTags.filter(t => t.startsWith('path:'));
  return 1.0 + pathOverlapScore(memPathTags, currentPathTags) * PATH_BOOST_WEIGHT;
}
```

Call sites (critic-corrected): the **hybridSearch** site must CAPTURE the value
because `pathBoost` feeds the `ScoreBreakdown` object (search.ts:661-665,
consumed by `hippo explain`/trace rendering at cli.ts:2150):

```ts
const pathBoost = pathBoostMultiplier(entries[i].tags, currentPathTags);
compositeScore *= pathBoost;
```

The **sync** site (search.ts:1155-1158) has no downstream consumer of
`pathBoostSync` and collapses to a true one-liner.

### T2a — run.py `cwd_subdir` knob (additive)

`remembers` object form and `queries` gain optional `"cwd_subdir": "proj-alpha/src"`.
`run_hippo` gains an optional `cwd` parameter defaulting to `hippo_home`; the
harness creates `home/<subdir>` (mkdir -p, sanitized: reject absolute paths and
`..`) and passes it. No existing fixture uses the knob -> zero change to the
11 existing fixtures' behavior.

### T2b — HIPPO_BIN fallback (run.py)

At module init: if `HIPPO_BIN` env is unset AND `shutil.which("hippo")` returns
None or the resolved default is a Windows `.cmd`/`.bat` shim (unspawnable
without shell, which the harness deliberately never uses — BatBadBut class),
fall back to `["node", str(<repo-root>/"bin"/"hippo.js")]` when that file
exists. Print one line stating the chosen binary. Env override always wins.

**Mirror the in-repo precedent, don't invent:** `benchmarks/locomo/
hippo_subproc.py` already implements exactly this class (batch-shim refusal,
BatBadBut; shipped in the tag-loss episode, 13 tests). T2b mirrors its
detection logic (with a comment pointing there) rather than introducing a
second convention; micro/ stays standalone (no cross-benchmark import).

### T2c — fixture path_boost.json (authored from desired semantics)

Memories with controlled lexical overlap against the probe query (shared-token
audit per docs/evals/AUTHORING.md — discriminating tokens are opaque markers,
no sentinel leakage into noise):

- `LOCAL`: remembered with `cwd_subdir: "proj-nova/lib"` (specific tags).
- `GENERIC`: remembered at home root (auto tags only — the bare-generic case).
- `FOREIGN`: remembered with `cwd_subdir: "proj-vega/lib"` (distractor).

**The discriminating query runs from LOCAL's OWN cwd** (`cwd_subdir:
"proj-nova/lib"`), with GENERIC given a *slight* lexical edge over LOCAL
(e.g. one extra query-term occurrence). Tag arithmetic (platform-robust):
LOCAL's tags exactly match the query cwd -> overlap 1.0 under EVERY candidate
(exact match preserved by C0/C1/C2). GENERIC's tags are a strict subset of the
query cwd's tags -> 1.0 under C0 (tie with LOCAL: the defect — genericity gets
the max boost, so its lexical edge wins top-1 = RED) but ~1/3..1/2 under C1/C2
(LOCAL's 1.3x vs GENERIC's ~1.1x overcomes the small lexical edge = GREEN).
The required lexical-edge band is bounded by the WINDOWS differential (the
tighter side: GENERIC keeps 2 surviving tag segments there, boosting it to
~1.15x under C1/C2, vs ~1.10x on Linux) — so author the content ratio in
(1.0, ~1.13), NOT the Linux-only ~1.18 (critic-corrected: a ratio in
[1.13, 1.18) would be green on Linux CI but red on Windows post-fix).
Controlled by content authoring; the fixture asserts top-1 membership, never
scores.

Platform note: the temp home's auto tags differ by OS (Windows
`[path:skf_s, path:hippo-micro-x]`; Linux `/tmp` -> `[path:hippo-micro-x]`
since `tmp` is noise-filtered) — the subset relationship above holds on both,
so the fixture is platform-robust. Subdir names must avoid the
`extractPathTags` noise list and be >= 2 chars (`lib` ok; `src` ok; `dist`/
`build` are noise — avoid).

A secondary query from a third cwd (`cwd_subdir: "proj-rho"`) asserts GENERIC
does not outrank the topically-better FOREIGN match there (regression guard on
the same defect from a non-matching cwd). Exact contents tuned during execute;
the boost/base-score arithmetic behind the band is verified in the eval doc,
not hand-waved.

### T3 — candidates + pre-registered decision rule

Candidates (normalization inside `pathOverlapScore` only):

- **C0** status quo: `matches / |memPathTags|`.
- **C1** Jaccard: `matches / |mem ∪ cur|`.
- **C2** `matches / max(|mem|, |cur|)`.

Both C1/C2 kill the bare-generic-1.0 defect (a 1-tag generic memory from a
3-tag cwd scores 1/3 under C1 (union 3), 1/3 under C2 (max 3)); exact small-set
matches keep 1.0 under C2, and under C1 exact matches also keep 1.0 (union =
intersection). C2 is the default pick if both pass measurement (simpler
mental model: "fraction of the more specific side that matches").

**Decision rule (pre-registered, before any measurement run):** ship a
candidate iff ALL of:
1. `path_boost` fixture: candidate passes every query; status quo demonstrably
   fails (or inverts) at least one — the red-vs-green pair is the evidence;
2. all 11 existing fixtures remain green under the candidate
   (micro-eval non-regression, run with the HIPPO_BIN fallback per T2b);
3. full vitest suite green with unit tests updated to the new contract, the
   old defect case pinned to its fixed value, and the change called out in
   CHANGELOG.

If no candidate satisfies all three -> ship T1+T2 only; the eval doc records
the negative result and TODOS.md keeps a narrowed follow-up.

## Amendment 1 (2026-07-18, post-execute-blocker; re-gated with plan-eng-critic)

**Verified blocker.** The original T2c design is unimplementable: hippo's local
store root is strictly cwd-derived with no ancestor walk-up
(`getHippoRoot(cwd) = cwd/.hippo`, src/store.ts:255-257) and every CLI command
hard-exits without an initialized store at exactly that root
(`requireInit`, src/cli.ts:285-290). A `cwd_subdir` remember/query therefore
crashes ("No .hippo directory found"). Corollary (executor-proven, orchestrator-
verified): with queries locked to the fixture home, every constructible
memory's tag set M satisfies Q ⊆ M, forcing C0 = C1 = C2 = |Q|/|M| — the
candidates are observationally equivalent, so no home-cwd-only fixture can
discriminate them. Evidence: trajectories/01KXTBPRV5R3KJVTPMPPG9M8TT/
red-run-path-boost.txt.

**Revised T2c (v2) — ride the real cross-project model.** The defect's actual
habitat is the GLOBAL store (generic-tagged home-root memories polluting
project recalls cross-project). The fixture now uses exactly that mechanism,
E2E-prechecked green on this box before re-dispatch (init-per-subdir; subdir
remember carries the predicted 4-segment tags; `hippo promote <id>` copies to
the $HIPPO_HOME-scoped per-fixture global store preserving tags; a foreign
project's recall sees the global copy):

- Harness delta (run.py, additive): (1) `_resolve_item_cwd` auto-inits a
  created `cwd_subdir` store (idempotent: skip when `.hippo/hippo.db` exists;
  same `--no-learn --no-hooks --no-schedule` flags as the home init); (2) new
  action type `{"type": "promote", "remember_index": N}` running
  `hippo promote <id>` FROM THE SAME cwd as the referenced remember (harness
  tracks each remember's cwd; error if the id was not captured, mirroring
  supersede).
- **Fixture v3 (supersedes v2's --equal-sources design; forced by two
  score-verified prechecks per the round-2 critic's must-fixes):**
  - Round-2 CRIT confirmed: `localBump` 1.2x (config.ts:128, shared.ts:276)
    breaks any local-vs-global comparison. Deeper, found by the mandated
    score precheck: **promoted global copies carry NO embedding** — they
    score `bm25-only` (base = raw/termCount) while local rows score hybrid
    (cosine-weighted), a measured ~5.4x structural base deficit
    (explain evidence: local base 0.8979 vs global 0.1654). No content
    authoring can bridge that; `--equal-sources` alone was insufficient.
    (Product finding filed as a TODOS follow-up at ship: global/promoted
    memories systematically under-ranked vs local rows in hybrid mode.)
  - v3 makes ALL competitors symmetric global bm25-only rows: LOCAL
    (remembered in `proj-nova/lib`), GENERIC (home), FOREIGN
    (`proj-vega/lib`) are each PROMOTED to the per-fixture global store, and
    LOCAL's local-store copy is then FORGOTTEN. query1 from `proj-nova/lib`
    (competitors: 3 global rows, same scoring mode, localBump moot — no
    `--equal-sources` needed); query2 from `proj-rho` unchanged.
  - Harness deltas (all additive): auto-init on `cwd_subdir` creation; action
    `{"type": "promote", "remember_index": N}`; action
    `{"type": "forget", "remember_index": N}` — both actions run from the
    referenced remember's tracked cwd (forget only sees that cwd's local
    store — verified live).
  - Round-3 critic constraints (MEDs, binding on execute): (a) actions run in
    declared order, so the fixture MUST order every promote before the forget
    (forget hard-deletes the local id; a later promote of it would crash the
    whole run) — and both new actions raise a fixture-naming RuntimeError on
    an uncaptured id (mirroring the supersede precedent) instead of passing
    None to the CLI; (b) C2 green must be MEASURED via the real fixture runs,
    never shipped on the arithmetic prediction alone; (c) competitor contents
    must stay under 200 chars and diverge early (cross-store dedup keys on
    `content.slice(0,200)`, shared.ts:287).
- **Pre-dispatch evidence (round-2 must-fix, satisfied before this round-3
  re-gate; identity verified by marker, home at %TEMP% root = real fixture
  depth):** locked contents LOCAL "what is the reindex cadence for the
  vector store, weekly zephyrline notes kept here indeed also" / GENERIC
  "what is the reindex cadence for the vector store, monthly gravemark
  manifests policy notes here" / FOREIGN "basalt export manifests are
  rotated nightly basaltro; export manifests archived". Measured under C0:
  GENERIC 0.2737282201552896 > LOCAL 0.2468671207643772 (both x1.300 path
  boost — the subset defect live; GENERIC tags = exactly
  [path:skf_s, path:hippo-s5-pre6]) -> query1 RED, composite ratio 1.1088
  inside the (1.0, 1.13) band; query2 FOREIGN 0.6383 vs GENERIC 0.0395
  green, non-vacuous. Predicted C2: 1.1088 x 1.15/1.3 = 0.981 (Windows,
  LOCAL wins) / x 1.1/1.3 = 0.938 (Linux) — green both, deterministic corpus
  (fixture stores contain only the three rows).
- **Depth caveat (documented, acceptable):** the C0 RED evidence requires the
  fixture home to contribute <=2 meaningful path segments (true for standard
  %TEMP% and /tmp; verified live that a deeper home inflates GENERIC's tag
  count and turns query1 green under C0). The SHIPPED fixture asserts the
  desired-semantics GREEN under the fixed normalization, which holds at any
  depth — only the historical red-run capture is depth-sensitive.
- LOCAL appearing twice (local + promoted global copy) is harmless: the top-1
  assertion is content-based and both copies carry the LOCAL marker.

**Product-gap follow-up (file in TODOS at ship, out of scope here):** no
ancestor walk-up in local-store resolution — `hippo remember` from a
subdirectory of an initialized project errors instead of finding the project
root's store (unlike git). Real-usage UX gap independent of this episode.

**Incident note.** The first measurement executor's direct probe ran
`hippo init` + `remember` at the worktree root, creating a live store whose
junk memory leaked into the session's cross-project context hook. Cleaned
(store deleted; junk verified nowhere else; `.hippo/` gitignored). Follow-on
brief rule: probes writing hippo memories use a scratch HIPPO_HOME AND a
scratch cwd.

## Test plan

- Unit (tests/path-context.test.ts, extended): `pathBoostMultiplier` bounds
  (1.0..1.3), non-path tags ignored, empty sets neutral (1.0); defect-case pin
  (bare generic tag): 1.3x under C0 — flipped to the fixed value iff T3 ships.
- Harness (new tests or inline validation): `cwd_subdir` sanitization (absolute
  and `..` rejected), fallback selection logic (env-set wins; node fallback
  chosen when default unspawnable) — covered by running the micro-eval itself
  on Windows with no env override (T2b acceptance) since run.py has no test
  suite of its own.
- Micro-eval: 11 existing fixtures green pre/post T1 (identical results);
  `path_boost` red under C0 captured BEFORE any T3 change (red-run evidence
  discipline), green under the shipped candidate if T3 fires.
- Full suite: `npm test` green; `npm run build:all` green (release gate).

## Version / release

Patch bump 1.26.3 -> 1.26.4 (bugfix of a v39-named defect + eval infra; no API
surface change). 5 lockstep manifests: package.json, openclaw.plugin.json,
extensions/openclaw-plugin/package.json, extensions/openclaw-plugin/
openclaw.plugin.json, src/version.ts (PACKAGE_VERSION). `git fetch` + re-check
origin/master version immediately before the bump (concurrent-merge guard).

## Risks

- **Ranking shift on real stores** if T3 ships. The changed region is EVERY
  `|memPathTags| < |currentPathTags|` pair, not only generic-tagged memories
  (review-stage correction; the original framing here was materially too
  narrow). That includes a legitimate same-project case: a memory written at a
  project root and recalled from deeper cwds of that SAME project softens one
  level earlier than before (old: 1.3/1.3/1.3/1.15/1.0 at depths 0-4; new:
  1.3/1.2/1.15/1.075/1.0 - critic-measured and unit-pinned). ACCEPTED AS
  INTENDED: the subset relation cannot distinguish home-root-vs-project from
  project-root-vs-subdir (path tags carry no project boundary - fixing the
  generic defect without this softening is impossible under tag-set overlap),
  and the gradient strictly improves relative ordering (an exactly-located
  memory now outranks a root-located one instead of tying at 1.3x). Blast
  radius bounded by the 1.3x cap. Mitigation: decision rule requires
  non-regression on all existing fixtures + full suite; the same-project
  gradient is pinned in tests/path-context.test.ts.
- **Fixture flakiness** (base scores not actually near-tied): mitigated by
  tuning contents during execute with probe evidence in the eval doc; the
  fixture asserts top-k membership, not exact scores.
- **run.py fallback misfires** (e.g. picks node path when a working `hippo`
  exists): guarded — fallback only when the default is absent or a shim;
  explicit env always wins; one-line log makes the choice visible.
