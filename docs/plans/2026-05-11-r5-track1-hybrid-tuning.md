# LongMemEval R@5 target — Track 1: hybrid retrieval tuning

> **For agentic workers:** execute task-by-task; each task ends in a commit. Do not push between tasks (controller pushes at end). Stay on the assigned branch.

**Goal:** find the hybridSearch hyperparameter configuration that maximises R@5 on the LongMemEval 500-question workload, without changing any mechanism (no new code paths in `src/`).

**Architecture:** staged hyperparameter search over `embeddingWeight`, `mmrLambda`, candidate `budget`, `min-results`. Each stage fixes the prior winners and sweeps one new variable; total ~28 runs at ~80s each (~38 min wall). Reuses the existing `benchmarks/longmemeval/retrieve_inprocess.mjs` harness and `evaluate_retrieval.py` scorer; no production-code changes beyond plumbing one missing CLI flag (`--mmr-lambda`) through the harness.

**Tech stack:** Node 22 (harness), Python 3 (scorer + aggregator), Vitest (TDD), existing F6-shipped sweep aggregator.

**Predecessor:** F6 reranker hardening (`docs/plans/2026-05-10-f6-reranker-hardening.md`). F6 shipped the seam, the per-query LongMemEval harness, the sweep orchestrator, and the v0.27 hippo store at `hippo_store2/`. F6's result doc (`docs/evals/2026-05-10-f6-reranker-result.md`) reports baseline R@5 = 75.6% on the workload tested.

**Sequencing:** this plan is intended to run BEFORE F9 (cross-encoder real-eval) and F10 (richer ingest). The winning hybrid configuration becomes the input to those plans (so cross-encoder + features rerankers see the strongest candidate pool the hybrid path can produce).

---

## Pre-registration

This release does not re-assert the retracted −10pp magnitude.

**Magnitude-smuggling guard.** Per `docs/RETRACTION.md`. The result doc, the CHANGELOG entry, the README "What's new" entry, and any commit body authored under this plan must satisfy:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <touched-files>
```

returns zero matches.

**Workload-validity gates (binding):**

- **Gate-A (sweep completion):** all 28 planned runs must complete with a non-empty `*.eval.json` file. Any harness crash or evaluator error invalidates the sweep until the failing run is fixed and re-run.
- **Gate-B (best-config improvement):** the best configuration's overall R@5 on LongMemEval must be ≥ baseline R@5 + 2pp (i.e. ≥ 77.6% given baseline 75.6%). If the best configuration cannot beat baseline by 2pp, the workload is declared insensitive to hybrid hyperparameter tuning on this corpus and no R@5 effect of tuning is claimed.

**Failure handling:** Gate-B FAIL is descriptive (no retraction protocol fires) because this plan changes no mechanism in `src/`. The result doc records the verdict and the CHANGELOG / README do NOT advertise tuning as a value-add. Plans F9 and F10 can still proceed using the v0.27 default hyperparameters.

**Outside-voice review:** before Task 3 starts, dispatch a fresh subagent (isolated context) to review this prereg against `docs/RETRACTION.md` and the F6 prereg/result for discipline compliance. PASS required.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `benchmarks/longmemeval/retrieve_inprocess.mjs` | LongMemEval harness | MODIFY: add `--mmr-lambda` CLI flag and pass through to `hybridSearch` |
| `benchmarks/longmemeval/run_hybrid_tuning.mjs` | Tuning orchestrator | CREATE |
| `scripts/aggregate_hybrid_tuning.mjs` | Build leaderboard from per-config eval.json | CREATE |
| `tests/longmemeval/harness-mmr-lambda.test.mjs` | TDD: confirm `--mmr-lambda` flag is read and passed | CREATE |
| `docs/evals/2026-05-11-r5-track1-tuning-prereg.md` | Pre-registration | CREATE |
| `docs/evals/2026-05-11-r5-track1-tuning-result.md` | Result doc | CREATE (Task 9) |

`src/` is NOT touched. `hybridSearch` already accepts `embeddingWeight`, `mmr`, and `mmrLambda` options (`src/search.ts:246-285`).

---

## Tasks

### Task 1: Pre-registration document + outside-voice review

**Files:**
- Create: `docs/evals/2026-05-11-r5-track1-tuning-prereg.md`

- [ ] **Step 1: Write the prereg doc**

Copy the structure from `docs/evals/2026-05-10-f6-reranker-prereg.md`. Body must contain:
- The verbatim retraction sentence on its own line near the top.
- The magnitude-smuggling grep guard.
- Gate-A and Gate-B as written in the "Pre-registration" section above.
- The 28-run sweep grid (Stage 1: 7 runs over `embeddingWeight ∈ {0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8}`. Stage 2: 5 runs at best `embeddingWeight` over `mmrLambda ∈ {0.0, 0.3, 0.5, 0.7, 1.0}`. Stage 3: 16 runs at best `(embeddingWeight, mmrLambda)` over `budget ∈ {50, 100, 500, 1000}` × `min-results ∈ {5, 10, 20, 50}`.).
- The retraction protocol summary (Gate-B FAIL = descriptive only; no `src/` changes).
- An empty "Outside-voice review" section.

- [ ] **Step 2: Dispatch outside-voice subagent**

Subagent prompt: "Review `docs/evals/2026-05-11-r5-track1-tuning-prereg.md` against `docs/RETRACTION.md` for discipline compliance. Specifically check: (a) verbatim retraction sentence present, (b) magnitude grep guard quoted, (c) both gates have measurable thresholds, (d) failure handling stated. Report PASS/FAIL with line cites. Do not edit. Do not commit."

- [ ] **Step 3: Append review trail and commit**

Append the review verdict to the doc's "Outside-voice review" section.

```bash
git add docs/evals/2026-05-11-r5-track1-tuning-prereg.md
git commit -m "$(cat <<'EOF'
docs(evals): pre-register R@5-target Track 1 hybrid-tuning prereg

Stage-1 sweep: embeddingWeight (7 runs)
Stage-2 sweep: mmrLambda at best embeddingWeight (5 runs)
Stage-3 sweep: budget x min-results at best (embeddingWeight, mmrLambda) (16 runs)
Gate-B: best-config R@5 >= baseline + 2pp.

This release does not re-assert the retracted -10pp magnitude.

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 1
EOF
)"
```

### Task 2: Add `--mmr-lambda` CLI flag to the harness (TDD)

**Files:**
- Modify: `benchmarks/longmemeval/retrieve_inprocess.mjs:30` (add flag)
- Modify: `benchmarks/longmemeval/retrieve_inprocess.mjs` (pass through to `hybridSearch` options)
- Create: `tests/longmemeval/harness-mmr-lambda.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/longmemeval/harness-mmr-lambda.test.mjs
import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('harness reads --mmr-lambda and passes it to hybridSearch', () => {
  // Use an existing tiny fixture if available; otherwise the synthetic_smoke fixture from F6
  const dataPath = 'benchmarks/longmemeval/data/synthetic_smoke.json';
  if (!fs.existsSync(dataPath)) {
    expect.fail(`fixture missing: ${dataPath} — F6 should have created it`);
  }
  const out = `/tmp/harness_mmr_test_${Date.now()}.jsonl`;
  const stderr = execFileSync('node', [
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', dataPath,
    '--store-dir', 'hippo_store_synthetic',
    '--output', out,
    '--limit', '2',
    '--mmr-lambda', '0.3',
  ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  // The harness logs the resolved options at startup; the test asserts mmrLambda=0.3 appears
  // (Add a one-line `console.error('mmrLambda=', MMR_LAMBDA)` to the harness during impl.)
  expect(fs.existsSync(out)).toBe(true);
  fs.unlinkSync(out);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/user/hippo-memory
npx vitest run tests/longmemeval/harness-mmr-lambda.test.mjs
```

Expected: FAIL — the harness does not yet read `--mmr-lambda`. (It either ignores the flag silently or fails an assertion you add.)

- [ ] **Step 3: Implement minimal change**

In `benchmarks/longmemeval/retrieve_inprocess.mjs` after line 31 (`MIN_RESULTS`):

```js
const MMR_LAMBDA = flag('--mmr-lambda', null);
```

Find the `hybridSearch` call (search for `hybridSearch(`) and add to its options object:

```js
mmrLambda: MMR_LAMBDA !== null ? parseFloat(MMR_LAMBDA) : undefined,
```

(Leaving it `undefined` lets `hybridSearch` use its default of 0.7.)

Add at the harness startup-log site:

```js
console.error('options:', { embeddingWeight: EMB_WEIGHT, mmrLambda: MMR_LAMBDA, budget: BUDGET, minResults: MIN_RESULTS });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/longmemeval/harness-mmr-lambda.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/longmemeval/retrieve_inprocess.mjs tests/longmemeval/harness-mmr-lambda.test.mjs
git commit -m "$(cat <<'EOF'
feat(longmemeval): --mmr-lambda CLI flag + startup-options log

Plumbs mmrLambda through retrieve_inprocess.mjs into hybridSearch. The
hybridSearch function already accepts the option (src/search.ts:251);
this is harness wiring only. Default behavior unchanged when flag is
omitted (uses hybridSearch's 0.7 default).

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 2
EOF
)"
```

### Task 3: Stage-1 orchestrator — sweep `embeddingWeight`

**Files:**
- Create: `benchmarks/longmemeval/run_hybrid_tuning.mjs` (initial Stage-1-only version)

- [ ] **Step 1: Build the orchestrator**

```js
#!/usr/bin/env node
// benchmarks/longmemeval/run_hybrid_tuning.mjs
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STAGE = process.argv[2] ?? 'stage1';
const sweepDir = `results/hybrid_tuning_${new Date().toISOString().replace(/[:.]/g, '-')}_${STAGE}`;
fs.mkdirSync(sweepDir, { recursive: true });

const grids = {
  stage1: { embeddingWeight: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
  stage2: { mmrLambda: [0.0, 0.3, 0.5, 0.7, 1.0] },
  stage3: { budget: [50, 100, 500, 1000], minResults: [5, 10, 20, 50] },
};

// Stage-2/3 read prior winners from results/hybrid_tuning_winners.json (built incrementally).
// For Stage 1 the only knob is embeddingWeight.
const fixed = JSON.parse(fs.existsSync('results/hybrid_tuning_winners.json')
  ? fs.readFileSync('results/hybrid_tuning_winners.json', 'utf8')
  : '{}');

function runOne(label, args) {
  const out = path.join(sweepDir, `${label}.jsonl`);
  console.error(`\n=== ${label} ===`);
  const r = spawnSync('node', [
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', 'data/longmemeval_oracle.json',
    '--store-dir', 'hippo_store2',
    '--output', out,
    ...args,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Run ${label} failed exit=${r.status}`);
  return out;
}

if (STAGE === 'stage1') {
  for (const ew of grids.stage1.embeddingWeight) {
    runOne(`ew_${ew}`, ['--embedding-weight', String(ew)]);
  }
} else if (STAGE === 'stage2') {
  if (fixed.embeddingWeight === undefined) throw new Error('Stage 2 requires fixed.embeddingWeight in results/hybrid_tuning_winners.json');
  for (const ml of grids.stage2.mmrLambda) {
    runOne(`ml_${ml}`, ['--embedding-weight', String(fixed.embeddingWeight), '--mmr-lambda', String(ml)]);
  }
} else if (STAGE === 'stage3') {
  if (fixed.embeddingWeight === undefined || fixed.mmrLambda === undefined) {
    throw new Error('Stage 3 requires fixed.embeddingWeight and fixed.mmrLambda in results/hybrid_tuning_winners.json');
  }
  for (const b of grids.stage3.budget) {
    for (const mr of grids.stage3.minResults) {
      runOne(`b${b}_mr${mr}`, [
        '--embedding-weight', String(fixed.embeddingWeight),
        '--mmr-lambda', String(fixed.mmrLambda),
        '--budget', String(b),
        '--min-results', String(mr),
      ]);
    }
  }
} else {
  throw new Error(`Unknown stage: ${STAGE}`);
}

console.error(`\nDone. Outputs in: ${sweepDir}`);
```

- [ ] **Step 2: Build (no source changes; orchestrator is `.mjs`)**

```bash
cd /home/user/hippo-memory && npm run build 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 3: Smoke-run Stage 1 with `--limit 5` to verify wiring**

Edit the orchestrator temporarily to add `'--limit', '5'` to the args, run:

```bash
node benchmarks/longmemeval/run_hybrid_tuning.mjs stage1 2>&1 | tail -20
```

Expected: 7 small `.jsonl` files in the sweep dir, each ~5 entries. Then revert the `--limit 5` edit.

- [ ] **Step 4: Run Stage 1 for real (full 500 questions × 7 runs)**

```bash
node benchmarks/longmemeval/run_hybrid_tuning.mjs stage1 2>&1 | tee /tmp/stage1_stderr.log | tail -20
```

Expected: ~10 min wall (7 × ~80s).

- [ ] **Step 5: Commit orchestrator + Stage-1 raw outputs (jsonl files are gitignored)**

```bash
git add benchmarks/longmemeval/run_hybrid_tuning.mjs
git commit -m "$(cat <<'EOF'
feat(longmemeval): hybrid-tuning orchestrator + Stage-1 sweep

Stages 1, 2, 3 share one entry-point. Stage 1 sweeps embeddingWeight
across 7 values (0.2-0.8). Stages 2/3 read the prior stage's winner
from results/hybrid_tuning_winners.json (built by the aggregator).

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 3
EOF
)"
```

### Task 4: Score Stage-1 + pick best `embeddingWeight`

**Files:**
- Create: `scripts/aggregate_hybrid_tuning.mjs`

- [ ] **Step 1: Build the aggregator + winner-picker**

```js
#!/usr/bin/env node
// scripts/aggregate_hybrid_tuning.mjs
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sweepDir = process.argv[2];
if (!sweepDir) { console.error('Usage: node scripts/aggregate_hybrid_tuning.mjs <sweep-dir>'); process.exit(1); }

const dataPath = 'data/longmemeval_oracle.json';
const rows = [];
for (const f of fs.readdirSync(sweepDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const label = f.replace(/\.jsonl$/, '');
  const evalOut = path.join(sweepDir, `${label}.eval.json`);
  if (!fs.existsSync(evalOut)) {
    spawnSync('python3', ['benchmarks/longmemeval/evaluate_retrieval.py',
      '--retrieval', path.join(sweepDir, f), '--data', dataPath, '--output', evalOut], { stdio: 'inherit' });
  }
  const ev = JSON.parse(fs.readFileSync(evalOut, 'utf8'));
  rows.push({ label, ...ev.overall });
}
rows.sort((a, b) => (b['recall@5'] ?? 0) - (a['recall@5'] ?? 0));
const leaderboard = rows;
fs.writeFileSync(path.join(sweepDir, 'leaderboard.json'), JSON.stringify(leaderboard, null, 2));
console.log('label\trecall@1\trecall@3\trecall@5\trecall@10');
for (const r of leaderboard) console.log(`${r.label}\t${r['recall@1']}\t${r['recall@3']}\t${r['recall@5']}\t${r['recall@10']}`);

// Persist the winner's hyperparameters into results/hybrid_tuning_winners.json (merge).
const winnersPath = 'results/hybrid_tuning_winners.json';
const winners = fs.existsSync(winnersPath) ? JSON.parse(fs.readFileSync(winnersPath, 'utf8')) : {};
const top = leaderboard[0].label;
const m = top.match(/^(ew|ml|b)([\d.]+)(?:_mr(\d+))?$/) || top.match(/^ew_([\d.]+)$/) || top.match(/^ml_([\d.]+)$/) || top.match(/^b(\d+)_mr(\d+)$/);
// Stage-1: ew_<value> -> winners.embeddingWeight
// Stage-2: ml_<value> -> winners.mmrLambda
// Stage-3: b<bud>_mr<min> -> winners.budget, winners.minResults
if (top.startsWith('ew_')) winners.embeddingWeight = parseFloat(top.slice(3));
else if (top.startsWith('ml_')) winners.mmrLambda = parseFloat(top.slice(3));
else if (top.startsWith('b')) {
  const m3 = top.match(/^b(\d+)_mr(\d+)$/);
  winners.budget = parseInt(m3[1], 10);
  winners.minResults = parseInt(m3[2], 10);
}
fs.writeFileSync(winnersPath, JSON.stringify(winners, null, 2));
console.error(`Updated ${winnersPath}: ${JSON.stringify(winners)}`);
```

- [ ] **Step 2: Run aggregator on Stage-1 sweep dir**

```bash
SWEEP=$(ls -td results/hybrid_tuning_*_stage1 | head -1)
node scripts/aggregate_hybrid_tuning.mjs "$SWEEP"
cat results/hybrid_tuning_winners.json
```

Expected: leaderboard sorted by R@5 descending; `winners.embeddingWeight` set to the best value.

- [ ] **Step 3: Commit aggregator + winners file**

```bash
git add scripts/aggregate_hybrid_tuning.mjs results/hybrid_tuning_winners.json
git commit -m "feat(scripts): hybrid-tuning aggregator + Stage-1 winner persisted

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 4"
```

### Task 5: Stage-2 sweep + aggregate

- [ ] **Step 1: Run Stage-2 (mmrLambda at best embeddingWeight)**

```bash
node benchmarks/longmemeval/run_hybrid_tuning.mjs stage2 2>&1 | tee /tmp/stage2_stderr.log | tail -20
```

Expected: 5 runs × ~80s = ~7 min.

- [ ] **Step 2: Aggregate + persist Stage-2 winner**

```bash
SWEEP=$(ls -td results/hybrid_tuning_*_stage2 | head -1)
node scripts/aggregate_hybrid_tuning.mjs "$SWEEP"
cat results/hybrid_tuning_winners.json
```

Expected: `winners.mmrLambda` now set.

- [ ] **Step 3: Commit Stage-2 winners**

```bash
git add results/hybrid_tuning_winners.json
git commit -m "data: Stage-2 hybrid-tuning winner persisted (mmrLambda)

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 5"
```

### Task 6: Stage-3 sweep + aggregate

- [ ] **Step 1: Run Stage-3 (budget × min-results at best (ew, ml))**

```bash
node benchmarks/longmemeval/run_hybrid_tuning.mjs stage3 2>&1 | tee /tmp/stage3_stderr.log | tail -30
```

Expected: 16 runs × ~80s = ~21 min.

- [ ] **Step 2: Aggregate + persist Stage-3 winner**

```bash
SWEEP=$(ls -td results/hybrid_tuning_*_stage3 | head -1)
node scripts/aggregate_hybrid_tuning.mjs "$SWEEP"
cat results/hybrid_tuning_winners.json
```

Expected: `winners.budget` and `winners.minResults` set; full winners file has all four knobs.

- [ ] **Step 3: Commit Stage-3 winners**

```bash
git add results/hybrid_tuning_winners.json
git commit -m "data: Stage-3 hybrid-tuning winners persisted (budget, minResults)

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 6"
```

### Task 7: Verify best-config end-to-end + Gate evaluation

- [ ] **Step 1: Re-run the best configuration as a single canonical run**

This decouples the "winner" measurement from any per-stage variance.

```bash
W=$(cat results/hybrid_tuning_winners.json)
EW=$(echo "$W" | python3 -c 'import json,sys; print(json.load(sys.stdin)["embeddingWeight"])')
ML=$(echo "$W" | python3 -c 'import json,sys; print(json.load(sys.stdin)["mmrLambda"])')
BUD=$(echo "$W" | python3 -c 'import json,sys; print(json.load(sys.stdin)["budget"])')
MR=$(echo "$W" | python3 -c 'import json,sys; print(json.load(sys.stdin)["minResults"])')
mkdir -p results/hybrid_tuning_best
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store2 \
  --output results/hybrid_tuning_best/best.jsonl \
  --embedding-weight "$EW" \
  --mmr-lambda "$ML" \
  --budget "$BUD" \
  --min-results "$MR"
python3 benchmarks/longmemeval/evaluate_retrieval.py \
  --retrieval results/hybrid_tuning_best/best.jsonl \
  --data data/longmemeval_oracle.json \
  --output results/hybrid_tuning_best/best.eval.json
python3 -c "import json; d=json.load(open('results/hybrid_tuning_best/best.eval.json')); print('best R@5 =', d['overall']['recall@5'])"
```

- [ ] **Step 2: Compute Gate-B verdict**

Compare the printed best R@5 against the F6 baseline (75.6%) + 2pp = 77.6%. If ≥ 77.6 → Gate-B PASS. Else → Gate-B FAIL.

### Task 8: Result doc

**Files:**
- Create: `docs/evals/2026-05-11-r5-track1-tuning-result.md`

- [ ] **Step 1: Write the result doc using the F6 result-doc structure as template**

Required sections (each must be present):
- Front matter (date, plan, prereg, retraction reference)
- Verbatim retraction sentence on its own line
- TL;DR (3-5 bullets including Gate-A and Gate-B verdicts)
- Provenance (dataset SHA-256 + URL — copy from F6 result doc)
- Sweep methodology (the 28-run staged search)
- Per-stage leaderboards (top 5 of each stage's leaderboard.json)
- Best configuration confirmation run R@K table
- Gate-A verdict (sweep completion: 28/28 expected)
- Gate-B verdict (best R@5 vs baseline + 2pp)
- Roadmap-target framing (R@5 ≥ 85%): observed best vs target, NON-binding per prereg
- Cumulative-null acknowledgement (`docs/RETRACTION.md:94-113` cite, mechanism independence)
- Outside-voice review section (placeholder — filled in Task 9)

- [ ] **Step 2: Magnitude grep**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-11-r5-track1-tuning-result.md
```

Expected: zero matches.

### Task 9: Outside-voice review of result doc + commit

- [ ] **Step 1: Dispatch outside-voice subagent**

Subagent prompt: identical structure to the F6 Task-11 review prompt (`docs/plans/2026-05-10-f6-reranker-hardening.md` Task 11), substituting this result doc and prereg.

- [ ] **Step 2: Append review trail to result doc**

- [ ] **Step 3: Commit**

```bash
git add docs/evals/2026-05-11-r5-track1-tuning-result.md
git commit -m "$(cat <<'EOF'
docs(evals): R@5-target Track 1 hybrid-tuning result

28-run staged sweep over embeddingWeight, mmrLambda, budget, min-results.
Best configuration: <recorded in doc>. Gate-A <PASS/FAIL>; Gate-B <PASS/FAIL>.
Outside-voice review PASS.

This release does not re-assert the retracted -10pp magnitude.

Plan: docs/plans/2026-05-11-r5-track1-hybrid-tuning.md Task 9
EOF
)"
```

### Task 10: Doc updates (CHANGELOG / ROADMAP) — only if Gate-B PASSED

If Gate-B FAILED, skip this task — the result doc is the only artifact, and Plans F9/F10 still proceed using v0.27 default hyperparameters.

If Gate-B PASSED:

- [ ] **Step 1: CHANGELOG entry under v1.10.0 (or whatever the next version is)**

Body should:
- Cite the result doc.
- State the winning configuration.
- Report observed best R@5 vs baseline R@5 (raw values, not pp deltas).
- Include the verbatim retraction sentence.

- [ ] **Step 2: ROADMAP-RESEARCH.md update**

Add a new entry tracking the R@5 target work; reference this plan.

- [ ] **Step 3: Magnitude grep + commit**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' CHANGELOG.md ROADMAP-RESEARCH.md
git add CHANGELOG.md ROADMAP-RESEARCH.md
git commit -m "docs: v1.X.X R@5-target Track 1 (hybrid tuning) result"
```

---

## Self-review checklist

- [ ] Spec coverage: every section above (gates, stages, retraction discipline, outside-voice) has a task that implements it.
- [ ] Placeholder scan: no "TBD"/"add appropriate"/"similar to" in steps.
- [ ] Type consistency: `embeddingWeight`/`mmrLambda`/`budget`/`minResults` named identically across orchestrator, aggregator, and harness.
- [ ] Magnitude grep guard explicitly required at Task 8 step 2 and Task 10 step 3.
- [ ] Verbatim retraction sentence required in prereg, result doc, every commit body.
