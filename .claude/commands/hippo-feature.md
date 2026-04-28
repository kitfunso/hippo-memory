---
description: Build one hippo feature from RESEARCH.md using the micro-eval TDD loop
---

You are entering **hippo-feature mode** to build a new memory mechanic from `RESEARCH.md`. Follow the eval pyramid strictly. Skipping tiers wastes hours of LoCoMo time.

## The eval pyramid (non-negotiable)

| Tier | Harness | Time | When |
|------|---------|------|------|
| 1 | `benchmarks/micro/run.py` | ~30s | Every code change |
| 2 | `benchmarks/locomo/run.py --conversations 1 --sample 10 --score-mode evidence` | ~5-10 min | Before opening a PR |
| 3 | LoCoMo full | ~85 min evidence / ~6h judge | Release gate only |

If a feature shows no Tier 1 signal, do not proceed to Tier 2. If Tier 2 shows a regression, do not run Tier 3.

## The loop

### 0. Pick the feature

If `$ARGUMENTS` names a feature (e.g. `acc-evc`, `vmpfc-value`, `dlpfc-goals`, `vlpfc-gate`, `pineal-salience-v2`), use it. Otherwise read the PFC priority table in `RESEARCH.md` (lines ~459-466) and propose the top three by effort × benchmark delta. Wait for user confirmation.

### 1. RED — Write the failing micro fixture FIRST

- Drop a fixture at `benchmarks/micro/fixtures/<feature>.json` with shape:
  ```json
  {
    "name": "<feature>-<aspect>",
    "mechanic": "<feature>",
    "description": "<one sentence: what behaviour this proves>",
    "remembers": [...],
    "queries": [{"q": "...", "must_contain_any": [...], "top_k": N}]
  }
  ```
- The fixture must encode behaviour the *current* system **cannot** satisfy. If it passes on main today, the fixture is wrong — make it harder.
- Run `python benchmarks/micro/run.py --filter <feature>` and confirm it fails.
- Save the failing baseline: `python benchmarks/micro/run.py --out benchmarks/micro/results/baseline-<feature>.json`.

### 2. PLAN — Outside voice on non-trivial features

Per global CLAUDE.md outside-voice rule: if the feature touches schema, retrieval ranking, or storage (i.e. anything in the PFC priority table), run `/plan-eng-review` on the implementation plan **before** writing code. Skip only for one-line tweaks.

### 3. GREEN — Minimum implementation

- Smallest diff that makes the fixture pass.
- No new abstractions, no speculative config flags, no "while I'm here" cleanups.
- After each change, `python benchmarks/micro/run.py --filter <feature>` until it passes.

### 4. REGRESSION CHECK — Run all micro fixtures

- `python benchmarks/micro/run.py` — every existing fixture must still pass.
- If any fixture regresses, revert and reconsider. Do not "improve" the regressed fixture to make it pass.

### 5. TIER 2 SMOKE — Stratified LoCoMo subsample

```powershell
$env:HIPPO_BIN='node C:/Users/skf_s/hippo/bin/hippo.js'
python benchmarks/locomo/run.py `
  --data benchmarks/locomo/data/locomo10.json `
  --output-dir benchmarks/locomo/results `
  --output-name hippo-smoke-<feature> `
  --conversations 1 --sample 10 `
  --score-mode evidence
```

- Compare `mean_score` to the most recent smoke baseline.
- Required: non-negative delta on the affected categories. Variance dominates absolute scores at N=50, so trust the *direction*, not the level.
- If delta is negative, return to step 3.

### 6. COMMIT

- One logical commit per feature: code + fixture + result baseline.
- Reference the RESEARCH.md section in the commit body (e.g. `RESEARCH.md §4.3 ACC EVC-adaptive recall`).
- Never use `--no-verify`.

### 7. STOP — Do not run Tier 3

Full LoCoMo only on explicit user request (release gate). Even with a green Tier 2, do not run the 5-8 hour LoCoMo full unless the user asks.

## Hard rules

- **Fixture before code.** No implementation commit without the fixture committed first (or in the same commit).
- **One feature at a time.** Don't bundle ACC + vmPFC into one branch even if RESEARCH.md groups them.
- **Real DB for tests** (project memory rule). No mocks where the real SQLite store is feasible.
- **Power models — DO NOT TOUCH** (project memory rule, applies cross-repo to skf_s).
- **Salience gate** — the v1 60% lexical-overlap gate destroyed LoCoMo from 0.28 to 0.02. Any salience work must be default-off and prove a positive delta on Tier 2 before being enabled.

## Pre-flight checks (run before step 1)

- `git branch` — am I on the right branch? (global CLAUDE.md rule)
- `python benchmarks/micro/run.py` — baseline must currently be 1.00 pass rate
- `node bin/hippo.js --version` — record the starting version for the commit

---

Task / feature: $ARGUMENTS

If `$ARGUMENTS` is empty, list the top three features from `RESEARCH.md` PFC priority table and ask which to build.
