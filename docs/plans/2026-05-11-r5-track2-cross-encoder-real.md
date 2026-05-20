# LongMemEval R@5 target — Track 2: cross-encoder real-eval

> **For agentic workers:** execute task-by-task; each task ends in a commit. Stay on the assigned branch; controller pushes.

**Goal:** get the cross-encoder reranker (`src/rerankers/cross-encoder.ts`) actually loading a real model end-to-end, run it against the LongMemEval 500-question workload, and gate on R@5 improvement. Either it ships proven, or it gets removed from `src/`.

**Architecture:** the F6 release shipped the cross-encoder track, but the test sandbox blocks `huggingface.co`, so all 500 invocations took the identity-fallback branch. This plan unblocks the real model via a multi-path discovery — three parallel subagent probes try (A) HuggingFace mirrors / proxies, (B) hosted reranker APIs (Cohere / Voyage / Jina), (C) pre-vendored model weights. First successful path wins; the cross-encoder reranker is wired to it. Then the F6 sweep is re-run against the v0.27 hippo store using the winning hybrid configuration from Plan F8 (or default if F8 hasn't been run).

**Tech stack:** Node 22 (harness, reranker), `@xenova/transformers` (existing optional peer dep) OR HTTP fetch (if hosted-API path wins), Vitest, evaluate_retrieval.py.

**Predecessor:** F6 (`docs/plans/2026-05-10-f6-reranker-hardening.md`). F6's result doc reports cross-encoder R@5 = 75.6% (identical to baseline by construction — identity fallback).

**Sequencing:** runs after Plan F8 (hybrid tuning) if available; if F8 has not landed by start, run with v0.27 defaults and note the dependency in the result doc.

---

## Pre-registration

This release does not re-assert the retracted −10pp magnitude.

**Magnitude-smuggling guard.** Per `docs/RETRACTION.md`. All result-doc / CHANGELOG / commit bodies must satisfy:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <touched-files>
```

returns zero matches.

**Workload-validity gates (binding):**

- **Gate-A (model loaded for real):** the cross-encoder track must produce non-identity orderings on at least 250/500 questions. Operationalised: write a one-shot script that compares the cross-encoder track's `ordered_memory_ids` per question against the baseline track's `ordered_memory_ids`. The count of questions where the two orderings differ must be ≥ 250. (Identity-fallback produces identical orderings everywhere; a real model produces different orderings on most non-trivial queries.)
- **Gate-B (proven value):** cross-encoder R@5 ≥ baseline R@5 + 5pp on the same hippo store and the same hybrid configuration. (Baseline = 75.6% from F6; threshold = 80.6%.)

**Failure handling:**

- Gate-A FAIL: the chosen model-loading path is broken; revert the wiring commit. No retraction needed because no value claim was made.
- Gate-B FAIL: **HARD RETRACTION.** The cross-encoder reranker is not pulling its weight. Tasks 9-11 of this plan execute a removal protocol that deletes `src/rerankers/cross-encoder.ts`, removes `cross-encoder` from the dispatcher, deletes the unit tests + fixture, and updates ROADMAP / CHANGELOG to record the removal with the retracted-mechanism framing.

**Outside-voice review:** before Task 4 (wiring) starts, the prereg must pass an outside-voice subagent review.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `docs/evals/2026-05-11-r5-track2-cross-encoder-prereg.md` | Pre-registration | CREATE |
| `docs/evals/2026-05-11-r5-track2-cross-encoder-result.md` | Result doc | CREATE (Task 8) |
| `src/rerankers/cross-encoder.ts` | Cross-encoder reranker | MODIFY (wire winning path) OR DELETE (Gate-B FAIL) |
| `src/rerankers/cross-encoder-hosted.ts` | Hosted-API variant | CREATE only if Path B wins |
| `tests/rerankers/cross-encoder-real.test.ts` | TDD: real-model integration test | CREATE |
| `benchmarks/longmemeval/data/model-cache/` | Vendored model weights | CREATE only if Path C wins (large; gitignore + git-lfs OR external storage) |
| `scripts/diff_orderings.mjs` | Gate-A diff script | CREATE |

---

## Tasks

### Task 1: Pre-registration document + outside-voice review

**Files:**
- Create: `docs/evals/2026-05-11-r5-track2-cross-encoder-prereg.md`

- [ ] **Step 1: Write the prereg doc**

Same skeleton as Plan F8's prereg, but with the gates from this plan's "Pre-registration" section. Include the retraction protocol pseudocode for Gate-B FAIL (the Tasks 9-11 removal sequence).

- [ ] **Step 2: Outside-voice subagent review**

- [ ] **Step 3: Append review trail and commit**

### Task 2: Discovery phase — three parallel subagent probes for model access

**Files:** none (controller dispatches subagents; outputs go to `/tmp/path_*_report.md`)

- [ ] **Step 1: Dispatch three parallel subagents (single message, three Agent calls)**

Each subagent gets a focused brief and a `/tmp/path_<X>_report.md` output target. They run in parallel — first to succeed wins, but ALL three should report so the controller can pick the best (lowest-friction, lowest-cost, highest-fidelity).

**Subagent A — HF mirrors / proxies:**
> Goal: load `Xenova/ms-marco-MiniLM-L-6-v2` (or another MS-MARCO cross-encoder compatible with @xenova/transformers) into a Node script in this sandbox.
>
> Tactics to try:
> - hf-mirror.com (China-mirror, public)
> - ghproxy.com (GitHub proxy)
> - jsdelivr / unpkg / esm.sh — anyone serving HF assets?
> - Direct probe: `curl -sI https://hf-mirror.com/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model_quantized.onnx`. If allowlisted, configure `@xenova/transformers` via `env.remoteHost = 'https://hf-mirror.com'` (read transformers.js docs).
> - If hf-mirror works, prove end-to-end: `node -e "import('@xenova/transformers').then(...)"` script that loads the model and rescores a 5-doc 1-query example.
>
> Constraints: this sandbox blocks huggingface.co (verified). Other hosts must be allowlist-probed first via `curl -sI`. Time budget: 30 min. Report: working URL + 5-doc rescore output + node loader snippet, or NOT_FOUND with table of avenues + status.

**Subagent B — hosted reranker APIs:**
> Goal: identify a hosted reranker API that (a) is reachable from this sandbox, (b) is free or under $5 for 500 reranks of ~20 docs each, (c) returns scored permutations.
>
> Candidates to probe:
> - Cohere Rerank (rerank-english-v3.0) — `api.cohere.com`
> - Voyage Rerank (rerank-2) — `api.voyageai.com`
> - Jina Reranker — `api.jina.ai`
> - Mixedbread Rerank — `api.mixedbread.ai`
>
> For each: probe allowlist (`curl -sI`), check pricing (free tier? trial credits?), and confirm docs (POST endpoint, request shape, response shape). If one is free + reachable + adequate, write a working `node` snippet that calls it on a 5-doc 1-query example.
>
> Time budget: 30 min. Report: chosen API + pricing + auth requirement + working snippet, or NOT_FOUND with table.

**Subagent C — vendored model weights:**
> Goal: produce `model_quantized.onnx` (~22MB) + `tokenizer.json` (~1MB) + config files for `Xenova/ms-marco-MiniLM-L-6-v2` as files committable to the repo (or storable in a known location, e.g. GitHub release asset on a hippo-memory release).
>
> Tactics:
> - Search GitHub for repos that have committed these files (recent ML hobby repos sometimes do). Try `https://api.github.com/search/code?q=ms-marco-MiniLM-L-6-v2+extension:onnx` (likely 403 without auth — try anyway).
> - Look for npm packages that bundle the model (e.g. `xenova-model-pack` or similar). Search `https://registry.npmjs.org/-/v1/search?text=ms-marco+onnx`.
> - Worst case: instruct controller on how to download once locally (outside sandbox) and commit via git-lfs. Provide the specific URLs, filenames, and target paths under `benchmarks/longmemeval/data/model-cache/`.
>
> Time budget: 30 min. Report: a fully described path (either "X file URL is reachable, vendoring takes 5 min" or "controller must run these 3 commands locally, files total ~25MB, commit to git-lfs at path Y").

- [ ] **Step 2: Pick winner**

Decision rule (in priority order, lowest-friction first):
1. Path A (HF mirror) wins if it works — zero new deps, just a config knob.
2. Path B (hosted API) wins if Path A fails — small new code path, recurring cost.
3. Path C (vendored weights) wins if A and B both fail — bigger repo, but no recurring cost.

If ALL THREE fail: STOP. Report to controller; the plan cannot proceed.

- [ ] **Step 3: Commit the discovery report (no source changes)**

Concatenate the three subagent reports into `docs/evals/2026-05-11-r5-track2-cross-encoder-discovery.md` and commit.

```bash
git add docs/evals/2026-05-11-r5-track2-cross-encoder-discovery.md
git commit -m "docs(evals): cross-encoder model-access discovery — Path <X> wins

Plan: docs/plans/2026-05-11-r5-track2-cross-encoder-real.md Task 2"
```

### Task 3: TDD — failing integration test for real-model rescoring

**Files:**
- Create: `tests/rerankers/cross-encoder-real.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rerankers/cross-encoder-real.test.ts
import { describe, test, expect } from 'vitest';
import { rerankWithCrossEncoder } from '../../src/rerankers/cross-encoder.js';

const SHOULD_RUN = process.env.HIPPO_RUN_CROSS_ENCODER_REAL === '1';

describe.skipIf(!SHOULD_RUN)('cross-encoder real-model integration', () => {
  test('rescores a 5-doc query with non-identity ordering', async () => {
    const query = 'What is photosynthesis?';
    const docs = [
      { id: 'd1', score: 0.5, content: 'The Eiffel Tower is in Paris.' },
      { id: 'd2', score: 0.5, content: 'Photosynthesis is the process by which plants convert light energy.' },
      { id: 'd3', score: 0.5, content: 'Bananas are yellow.' },
      { id: 'd4', score: 0.5, content: 'Plants use chlorophyll to absorb sunlight during photosynthesis.' },
      { id: 'd5', score: 0.5, content: 'The capital of France is Paris.' },
    ];
    const out = await rerankWithCrossEncoder(query, docs as any, 5);
    // Real cross-encoder must put d2 or d4 (the photosynthesis docs) at rank 1.
    expect(['d2', 'd4']).toContain(out[0].id);
    // And the non-relevant docs should not all be tied at score 0.5 (which is the identity fallback).
    const uniqueScores = new Set(out.map(d => d.rerankScore));
    expect(uniqueScores.size).toBeGreaterThan(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run with `HIPPO_RUN_CROSS_ENCODER_REAL=1`; verify it FAILS**

```bash
HIPPO_RUN_CROSS_ENCODER_REAL=1 npx vitest run tests/rerankers/cross-encoder-real.test.ts
```

Expected: FAIL — current cross-encoder.ts goes straight to identity fallback because the model can't load.

### Task 4: Implement the winning path

The implementation depends on which Path won in Task 2.

**Path A (HF mirror):**

- [ ] Modify `src/rerankers/cross-encoder.ts` to set `env.remoteHost` and any required HF-mirror auth before model load. Keep the layered fallback so behaviour is unchanged when the mirror is unreachable.
- [ ] Single-line edit at the top of `loadModel()`:
  ```ts
  if (process.env.HIPPO_HF_MIRROR_HOST) {
    const mod = await import('@xenova/transformers');
    mod.env.remoteHost = process.env.HIPPO_HF_MIRROR_HOST;
  }
  ```

**Path B (hosted API):**

- [ ] Create `src/rerankers/cross-encoder-hosted.ts` exporting `rerankWithHostedCrossEncoder(query, docs, topK)` that POSTs to the chosen API. Existing `src/rerankers/cross-encoder.ts` stays as-is (identity fallback) for users without an API key.
- [ ] Update the dispatcher in `src/rerankers/index.ts` (or wherever rerankers are registered) to route `--reranker cross_encoder` to the hosted variant when `HIPPO_RERANK_API_KEY` is set, else to the local variant.
- [ ] Update `tests/rerankers/cross-encoder-real.test.ts` to call `rerankWithHostedCrossEncoder` (gated on a separate env var).

**Path C (vendored weights):**

- [ ] Set up git-lfs (if not already): `git lfs install`. Add `*.onnx` to `.gitattributes` for LFS.
- [ ] Commit vendored files under `benchmarks/longmemeval/data/model-cache/` (or pull from external storage at first use).
- [ ] Modify `src/rerankers/cross-encoder.ts` to set `env.localModelPath` to the cache dir before model load.

For all three paths:

- [ ] Run unit tests including the real-model integration:

```bash
npm run build 2>&1 | tail -3
HIPPO_RUN_CROSS_ENCODER_REAL=1 [other env vars] npx vitest run tests/rerankers/
```

Expected: 14/14 pass (13 existing + 1 new).

- [ ] **Commit:**

```bash
git add <path-specific files>
git commit -m "feat(rerankers): wire cross-encoder via Path <X>; real-model integration test

Plan: docs/plans/2026-05-11-r5-track2-cross-encoder-real.md Task 4"
```

### Task 5: Re-run F6 sweep with cross-encoder using winning hybrid config

- [ ] **Step 1: Determine the hybrid config to use**

If `results/hybrid_tuning_winners.json` exists (Plan F8 completed): use those values.
Else: use v0.27 defaults (no extra flags) and note the dependency in the result doc.

- [ ] **Step 2: Run baseline + cross-encoder runs only (skip features tracks; that's Plan F10's domain)**

```bash
mkdir -p results/cross_encoder_real_$(date +%Y%m%d-%H%M)
SWEEP=$(ls -d results/cross_encoder_real_* | tail -1)

# Baseline
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store2 \
  --output "$SWEEP/baseline.jsonl" \
  [hybrid-config flags from F8 winners file if present]

# Cross-encoder real
[env vars from Path] node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir hippo_store2 \
  --output "$SWEEP/cross_encoder_real.jsonl" \
  --reranker cross_encoder \
  [hybrid-config flags]
```

- [ ] **Step 3: Score both**

```bash
for f in "$SWEEP"/*.jsonl; do
  name=$(basename "$f" .jsonl)
  python3 benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval "$f" --data data/longmemeval_oracle.json \
    --output "$SWEEP/${name}.eval.json"
done
```

### Task 6: Gate-A evaluation — non-identity ordering count

**Files:**
- Create: `scripts/diff_orderings.mjs`

- [ ] **Step 1: Build the diff script**

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
const [a, b] = process.argv.slice(2);
const linesA = fs.readFileSync(a, 'utf8').trim().split('\n').map(JSON.parse);
const linesB = fs.readFileSync(b, 'utf8').trim().split('\n').map(JSON.parse);
const byId = new Map(linesA.map(r => [r.question_id, r]));
let diff = 0, same = 0;
for (const rb of linesB) {
  const ra = byId.get(rb.question_id);
  if (!ra) continue;
  const idsA = (ra.retrieved_memory_ids ?? []).join(',');
  const idsB = (rb.retrieved_memory_ids ?? []).join(',');
  if (idsA === idsB) same++; else diff++;
}
console.log(`differing orderings: ${diff} / ${diff + same}`);
process.exit(diff >= 250 ? 0 : 1); // exit 0 = Gate-A PASS
```

- [ ] **Step 2: Run + record Gate-A verdict**

```bash
node scripts/diff_orderings.mjs "$SWEEP/baseline.jsonl" "$SWEEP/cross_encoder_real.jsonl"
echo "Gate-A: exit $? (0=PASS)"
```

- [ ] **Step 3: Commit diff script**

```bash
git add scripts/diff_orderings.mjs
git commit -m "feat(scripts): diff_orderings.mjs for Gate-A non-identity check

Plan: docs/plans/2026-05-11-r5-track2-cross-encoder-real.md Task 6"
```

### Task 7: Gate-B evaluation — R@5 vs baseline + 5pp

- [ ] **Step 1: Compute Gate-B verdict from eval.json files**

```bash
python3 -c "
import json
b = json.load(open('$SWEEP/baseline.eval.json'))
c = json.load(open('$SWEEP/cross_encoder_real.eval.json'))
print('baseline R@5:', b['overall']['recall@5'])
print('cross-encoder R@5:', c['overall']['recall@5'])
threshold = b['overall']['recall@5'] + 5.0
print('Gate-B threshold:', threshold)
print('Gate-B:', 'PASS' if c['overall']['recall@5'] >= threshold else 'FAIL')
"
```

### Task 8: Result doc

**Files:**
- Create: `docs/evals/2026-05-11-r5-track2-cross-encoder-result.md`

- [ ] **Step 1: Write result doc** following the F6 result-doc template, sections required:

- Front matter, verbatim retraction sentence
- TL;DR with both gate verdicts
- Provenance (dataset SHA-256 + URL + chosen Path A/B/C model + version)
- Sweep methodology (which hybrid config was used: from F8 winners or v0.27 defaults)
- R@K table: baseline vs cross-encoder (overall + per-type)
- Gate-A verdict (differing orderings count)
- Gate-B verdict (R@5 comparison)
- Roadmap-target framing (R@5 ≥ 85%): observed vs target, NON-binding per prereg
- If Gate-B PASS: "Mechanism shipped. Cross-encoder reranker is proven valuable on this workload."
- If Gate-B FAIL: "Retraction protocol triggered — see Tasks 9-11. Cross-encoder reranker removed from `src/`."
- Outside-voice review (placeholder)

- [ ] **Step 2: Magnitude grep + outside-voice review subagent dispatch + append + commit**

### Task 9: Retraction protocol — code removal (only if Gate-B FAILED)

If Gate-B PASSED, skip to Task 12.

- [ ] **Step 1: Delete the cross-encoder reranker**

```bash
git rm src/rerankers/cross-encoder.ts tests/rerankers/cross-encoder.test.ts tests/rerankers/cross-encoder-real.test.ts
# Also remove src/rerankers/cross-encoder-hosted.ts if Path B was the path
```

- [ ] **Step 2: Update the dispatcher**

Edit `src/rerankers/index.ts` (or wherever rerankers are registered): remove the `'cross_encoder'` case. The dispatcher should now throw `unknown reranker: cross_encoder` if asked.

- [ ] **Step 3: Remove the micro-eval fixture**

```bash
git rm benchmarks/micro/fixtures/reranker-cross-encoder.json
# (or whatever path the fixture lives at — confirm with: ls benchmarks/micro/fixtures/ | grep cross)
```

- [ ] **Step 4: Build + test**

```bash
npm run build 2>&1 | tail -3
npx vitest run tests/rerankers/ 2>&1 | tail -10
```

Expected: build clean; ~10 tests (was 13, now 13 minus the cross-encoder ones).

- [ ] **Step 5: Commit removal**

```bash
git commit -am "$(cat <<'EOF'
revert(rerankers): remove cross-encoder track per Gate-B FAIL

Plan F9 Gate-B required cross-encoder R@5 >= baseline + 5pp on the
LongMemEval workload. Observed: <values from result doc>. Threshold not
met. Per the prereg's "proven value or removed" stance and the v1.8.1
retraction discipline, the track is removed from src/.

Code removed:
- src/rerankers/cross-encoder.ts (+ hosted variant if applicable)
- tests/rerankers/cross-encoder*.test.ts
- benchmarks/micro/fixtures/reranker-cross-encoder.json
- 'cross_encoder' case from src/rerankers/ dispatcher

Result doc: docs/evals/2026-05-11-r5-track2-cross-encoder-result.md
This release does not re-assert the retracted -10pp magnitude.

Plan: docs/plans/2026-05-11-r5-track2-cross-encoder-real.md Task 9
EOF
)"
```

### Task 10: Documentation retraction (only if Gate-B FAILED)

- [ ] **Step 1: CHANGELOG retraction entry**

Prepend to `CHANGELOG.md`:

```markdown
## v1.X.Y — <date> — Cross-encoder reranker retraction

This release does not re-assert the retracted −10pp magnitude.

**Retracted:** the cross-encoder reranker track shipped in v1.9.0 has been removed from `src/` after a real-model evaluation under Plan F9 found it did not meet the binding R@5 ≥ baseline + 5pp gate on the LongMemEval workload. Result: `docs/evals/2026-05-11-r5-track2-cross-encoder-result.md`.

The reranker SEAM (`RerankerFn` in `src/search.ts`) and the features track (`src/rerankers/features.ts`) remain shipped pending Plan F10 outcome. The LLM track (`src/rerankers/llm.ts`) is unchanged.
```

- [ ] **Step 2: README "What's new" entry — same theme**

- [ ] **Step 3: ROADMAP-RESEARCH.md F6 entry update**

Append a "**Retraction note:**" paragraph to the F6 entry describing the cross-encoder removal and citing this plan's result doc.

- [ ] **Step 4: evals/README.md update**

Mark the v1.9.0 cross_encoder row as "TRACK RETRACTED" with cite.

- [ ] **Step 5: Magnitude grep + commit**

### Task 11: Push and notify (Gate-B FAIL branch)

- [ ] **Step 1: Push branch**

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Report status to controller**

Report: "Cross-encoder retracted. Plan F10 (richer ingest) status: not affected by this retraction; features track is independent and may still be evaluated."

### Task 12: Doc updates (Gate-B PASS branch)

If Gate-B PASSED, do these instead of Tasks 9-11.

- [ ] **Step 1: CHANGELOG entry — cross-encoder shipped proven**

Body: cite the result doc, state Path A/B/C used, report observed R@5 (raw values), include verbatim retraction sentence.

- [ ] **Step 2: README "What's new"**

- [ ] **Step 3: ROADMAP-RESEARCH.md update — note cross-encoder validated; adjust the "R@5 ≥ 85% deferred" framing**

- [ ] **Step 4: evals/README.md update — replace v1.9.0 cross_encoder row with the new real-eval row**

- [ ] **Step 5: Magnitude grep + commit + push**

---

## Self-review checklist

- [ ] Spec coverage: discovery (Task 2), wiring (Task 4), Gate-A (Task 6), Gate-B (Task 7), retraction protocol (Tasks 9-11), success protocol (Task 12) — all covered.
- [ ] Placeholder scan: every step has either concrete code or a concrete command.
- [ ] Type consistency: `rerankWithCrossEncoder` / `rerankWithHostedCrossEncoder` named consistently across src + tests.
- [ ] Magnitude grep guard explicitly required at Task 8 step 2 and Task 10 step 5.
- [ ] Verbatim retraction sentence required in prereg, result doc, every commit body.
- [ ] Retraction protocol is concrete (file paths to delete, dispatcher update, fixture removal) — not "remove the track somehow".
