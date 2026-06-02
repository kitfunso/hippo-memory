# E3.1 cross-object `references` precision — verify result (DESCRIPTIVE)

- Date: 2026-06-02
- Episode: 01KT4934PMMFKS7YW37P88V9PW (/dev-framework-rl, backend)
- Feature: a Pass 3 in `hippo graph extract` emitting `references` edges when one
  consolidated object's text contains another extracted entity's name.
- Harness: `benchmarks/e3-cross-object/precision.mjs` (direct lib calls on an isolated
  temp store; seeds genuine references + decoys; classifies each emitted edge by
  construction).

This is verify-stage evidence characterising the heuristic. The plan's **disposition rule**
keyed ship behaviour to this number.

## Result

| metric | value |
|---|---|
| entities | 15 |
| `references` edges emitted | 9 |
| intended true references seeded | 8 |
| true positives | 8 |
| false positives | 1 |
| **precision** | **0.889** |
| **recall** | **1.000** |

The single false positive is the **deliberately-seeded generic-word trap**: a customer
literally named `Core`, matched by the prose "we refactored the **core** scheduler module".
Every genuine reference (decision→policy, decision→customer, decision→project,
project_brief→policy, and a 2-target decision) was found.

## Disposition

precision 0.889 ≥ 0.70 and recall is non-trivial (1.0 on this set) → per the plan's
disposition rule the feature ships **always-on** as part of `graph extract`. The number is
reported as-is; it is not spun, and the one false positive is shown, not hidden.

## Known limitations (honest)

1. **Generic-word entity names.** A short, generic-but-unique name (a customer `Core`, a
   repo `core`) matches common prose → false edges. The ambiguity guard only drops names
   shared by >1 entity, not generic-but-unique ones; the `MIN_REF_NAME_LEN` (4) is the only
   defence (so `Core` at 4 chars passes). This is the dominant precision failure mode; a
   stopword list is a possible follow-up.
2. **Leftmost-first regex alternation** (not longest-match): an entity whose name is a word
   prefix of a longer entity's name shadows the longer one (`postgres` shadows
   `postgres pro`). Recall-only (never a false edge).
3. **Word-boundary (`\b`) misses non-word-char names** (`@scope/pkg`, `.env`): `\b` only
   fires between a word and non-word char, so such targets silently never match. Recall-only.
4. **Decisions are source-only** (never targets): you reference a policy/customer/project by
   name; a decision's prose name is referenced via `supersedes`, not name-mention. This also
   prevents a decision's own name (== its text) from whole-string self-matching and
   shadowing embedded targets.
5. **Supersedes-pair skip:** a version pair already related by `supersedes` (e.g.
   `Adopt X (managed)` superseding `Adopt X`) is NOT also given a `references` edge — that
   name containment is a version artifact, not a cross-reference.
6. **`MAX_TARGET_NAMES` (5000)** caps the matched-name index; on a >cap store the truncation
   is surfaced via `ExtractResult.truncated` (`'references-targets'`), not silent.

## Runtime evidence (verify gate)

- `tests/graph-cross-object.test.ts`: **12/12 pass** (real SQLite) — references edge,
  self-skip, word-boundary, min/max name len, ambiguity, per-source cap, idempotence,
  forgotten-source-no-throw, supersedes-skip, tenant isolation, project_brief-as-source.
- `tests/graph-extract.test.ts`: 7/7 pass (no regression; `relations`/`references` counts).
- All `graph-*` tests: 66+ pass. `scripts/check-graph-writes.mjs`: green (no raw graph writes).
- CLI: `graph extract` now prints `N relations (M supersedes, K references)`.
