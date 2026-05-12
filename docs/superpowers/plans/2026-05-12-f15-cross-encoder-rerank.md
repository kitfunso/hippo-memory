# F15 Cross-Encoder Rerank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a locally-runnable cross-encoder rerank to the top-100 candidates from F14 BGE-base retrieval on the LongMemEval `_s` split, with a hard prereg (Gate-A validity, Gate-B value, HARD RETRACTION on FAIL) — targeting the ~35-point within-pool ranking gap that F14's bi-encoder cosine alone leaves on the table.

**Architecture:** Two-stage retrieve-then-rerank, no new bi-encoder index needed. F14's `results/f14_baseline/turn_bge_s_top100.jsonl` (27 MB, 500 queries × 100 candidates each with truncated turn text and parent `session_id` tag) is the input — no re-embed required. Stage 2 is a cross-encoder (start with `Xenova/ms-marco-MiniLM-L-6-v2` for the feasibility tier, escalate to `BAAI/bge-reranker-base` if Gate-A throughput allows) loaded via `@huggingface/transformers` ONNX runtime; for each (query, candidate) pair we get a relevance score and sort descending. Output is a new JSONL compatible with the existing `evaluate_retrieval.py`. Gate-B is binding at ≥ 97.7 R@5 (gbrain v0.28.8's 97.60 + 0.1 margin); FAIL triggers HARD RETRACTION of data artefacts per the F12/F14 precedent. The realistic-but-non-binding budget anchor for whether to run this experiment at all is "improves over F14+F9 stack of 50.8 R@5"; that is a budget anchor, NOT a discipline shortcut — the result doc reports R@5 honestly against the 97.7 threshold and executes the prereg's FAIL arm if it falls short.

**Tech Stack:** Node 22 + `@huggingface/transformers` (already in `package.json`); Python 3 for scoring + sub-agent dispatch; Qdrant fastembed GCS bucket for model artefacts (HF Hub is host-blocked from this sandbox, verified 2026-05-11 and 2026-05-12).

---

## File structure

**Create:**
- `docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md` — F15 prereg (provenance, embedder-mismatch, Gate-A, Gate-B)
- `docs/evals/2026-05-12-r5-track8-cross-encoder-result.md` — F15 result (filled in after measurement)
- `benchmarks/longmemeval/rerank_cross_encoder.mjs` — Node script: load top-100 JSONL, score with cross-encoder, write reranked JSONL
- `benchmarks/longmemeval/test_rerank_cross_encoder_toy.mjs` — TDD anchor: 3-candidate toy case with known correct order

**Modify:**
- `ROADMAP-RESEARCH.md` — add F14 retroactive entry + F15/F16/F17/F18 forward entries; append F-track cross-track summary line

**Re-acquire (deleted in F14 HARD RETRACTION; same provenance):**
- `data/lme_s/longmemeval_s_cleaned.json` (SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`) — needed for ground-truth `answer_session_ids` at Gate-B scoring time. Gitignored. Mirror: `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz`.

**Use as-is (unchanged):**
- `results/f14_baseline/turn_bge_s_top100.jsonl` — F14 top-100 retrieval, 27 MB on disk (each entry has `question_id`, `question`, `retrieved_memories[]` with `id`, `content`, `tags`, `score`)
- `benchmarks/longmemeval/evaluate_retrieval.py` — Gate-B scoring
- `docs/RETRACTION.md` — magnitude-smuggling discipline cited at `RETRACTION.md:94-113`

**Will NOT touch:**
- Anything under `src/`. F15 is benchmark scaffolding only, mirroring the F13/F14 pattern of all-mechanism-in-`benchmarks/`. The F-track discipline keeps `src/` quiet unless a mechanism graduates to the deployable surface.

---

## Task 1: Update ROADMAP-RESEARCH with F14 retroactive + F15-F18 forward entries

**Files:**
- Modify: `ROADMAP-RESEARCH.md:381-386` (the F6 sub-section listing F8..F13 cross-track results)

- [ ] **Step 1: Read the current F-track block**

```bash
sed -n '370,395p' ROADMAP-RESEARCH.md
```

Expected: starts with the F6 heading and the cross-track bullet list ending with the F13 entry and the "Cross-track aggregate" paragraph.

- [ ] **Step 2: Append F14 retroactive bullet + F15-F18 forward bullets**

Use `Edit` to insert the following block AFTER the F13 bullet (currently `ROADMAP-RESEARCH.md:384`) and BEFORE the `Cross-track aggregate:` paragraph (currently `ROADMAP-RESEARCH.md:386`). Exact text to insert:

```markdown
- **F14 chunk-per-turn pipeline on `_s` split** (`docs/evals/2026-05-12-r5-track7-s-split-result.md`): the first F-track measurement against gbrain v0.28.8's split rather than the easier `oracle` (~48 sessions per haystack, 19,195 unique sessions, 500 questions). Source data re-acquired via `Sanderhoff-alt/longmemeval-zh` GitHub mirror (SHA-256 d6f21ea9d..., 500/500 question_id match with oracle, no signed chain-of-custody to canonical HF release). Gate-A PASS (199,509 turns indexed across all 19,195 sessions, dim 768, L2-norms in [0.999999, 1.000000], session_id tag coverage 19,195/19,195). Gate-B FAIL @ 97.7 with F14 + F9 stack R@5 = 50.8 (F14 baseline alone = 42.0). Shortfall 46.9pp dominated by the embedder: gbrain's own ablation shows their pure-vector adapter (text-embedding-3-large alone) at R@5 = 97.40 vs their hybrid+RRF at 97.60 — a 0.2-point top-up over the embedder. F14's BGE-base baseline (42.0) sits between gbrain's BM25-only (19.80) and gbrain's vector-only (97.40), consistent with BGE-base being meaningfully better-than-keyword but qualitatively below text-embedding-3-large at this distractor density. **HARD RETRACTION executed:** `data/lme_s/` (265 MB) and `benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl` (3.3 GiB) deleted; CHANGELOG/README/ROADMAP/RETRACTION canonical docs NOT updated; result doc retained as negative-result audit trail. Cleanest scaling measurement produced: F13 vs F14 (same pipeline, same embedder, oracle vs `_s`) shows R@5 collapses 86.8 → 50.8 under a 16x increase in distractors per haystack.
- **F15 cross-encoder rerank on top-100 (this track)** [next]: replace F9's sub-agent rerank with a locally-runnable cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2` feasibility tier or `BAAI/bge-reranker-base` quality tier, both via Qdrant fastembed GCS). Reuses F14's existing top-100 retrieval; no new bi-encoder index. Cross-encoders score (query, candidate) jointly via cross-attention rather than via post-hoc cosine on independent encodings — qualitatively stronger at fine-grained relevance ranking, and the F14 result doc identifies a ~35pp ranking gap within F14's top-100 candidate pool that this lever directly targets. Gate-B = ≥ 97.7 R@5 (gbrain's 97.60 + 0.1 margin), binding, HARD RETRACTION on FAIL. Plan: `docs/superpowers/plans/2026-05-12-f15-cross-encoder-rerank.md`.
- **F16 stronger locally-runnable embedder on `_s`** [planned]: re-run the F14 pipeline with `mxbai-embed-large-v1` or `bge-large-en-v1.5` (1024-dim) or `bge-m3` (dense + sparse + multivector). Probably +5–10pp R@5 alone on `_s`; the multivector path of `bge-m3` is the closest in spirit to gbrain's `text-embedding-3-large` full late-interaction. Cost: ~7h re-embed wall on the CPU sandbox. Predecessor: F15 result determines whether the rerank lever is sufficient or whether the embedder needs to move too.
- **F17 `text-embedding-3-large` via OpenAI API** [deferred]: would essentially close the gap with gbrain, but `api.openai.com` is host-blocked from this sandbox (verified 2026-05-11 and 2026-05-12 egress audits). Changes the deployable from "MIT locally-runnable" to "needs external service". Revisit when sandbox egress to `api.openai.com` (or a self-hosted equivalent like Vespa's E5-Mistral endpoint) becomes available.
- **F18 fine-tune BGE-base on LongMemEval-style contrastive pairs** [research]: hard-negative mining from F14's R@100-misses (the 14% of queries where the answer-bearing session is outside top-100 even at BGE-base level). Training-on-eval contamination risk is real; would require a held-out subset and pre-registered split discipline. Probably not the next track to pursue unless F15 + F16 stall.
```

- [ ] **Step 3: Update the Cross-track aggregate paragraph**

The current paragraph (currently `ROADMAP-RESEARCH.md:386`) reads:

```
Cross-track aggregate: **roadmap target R@5 ≥ 85% is MET on the oracle split as of v1.9.2** (F13 + F9 stack = 86.8). The deployable cross-track best on `data/longmemeval_oracle.json` is now F13 + F9 stack at R@5 = 86.8. Split-mismatch with gbrain v0.28.8's 97.60 on `longmemeval_s_cleaned` is unchanged and NOT directly comparable (different split AND different embedder; HF Hub and OpenAI API both host-blocked from this sandbox, verified 2026-05-12).
```

Replace with:

```
Cross-track aggregate: **roadmap target R@5 ≥ 85% remains MET on the oracle split as of v1.9.2** (F13 + F9 stack = 86.8). The deployable cross-track best on `data/longmemeval_oracle.json` is still F13 + F9 stack at R@5 = 86.8. F14 (2026-05-12) was the first track to measure against gbrain v0.28.8's `_s` split; Gate-B FAIL by 46.9pp, HARD RETRACTION executed. The split is now matched (a first); the embedder is not (gbrain uses `text-embedding-3-large` via `api.openai.com`, still host-blocked from this sandbox). F15 (in flight) attempts to close the within-pool ranking gap via a locally-runnable cross-encoder; F16-F18 are queued as alternative levers.
```

- [ ] **Step 4: Discipline grep on the roadmap diff**

Run:
```bash
git diff ROADMAP-RESEARCH.md | grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))'
```

Expected: empty (exit 1). If any match, rewrite the offending lines to use raw numbers rather than smuggled magnitudes.

- [ ] **Step 5: Commit**

```bash
git add ROADMAP-RESEARCH.md
git commit -m "$(cat <<'EOF'
docs(roadmap): log F14 retroactive + queue F15-F18 forward items

F14 was completed 2026-05-12 (chunk-per-turn pipeline on _s split,
Gate-B FAIL at R@5 = 50.8 vs threshold 97.7, HARD RETRACTION
executed). Adding the retroactive cross-track bullet so the F-track
ledger stays complete.

F15-F18 are the four next-step levers identified from F14's
mechanism characterisation:
- F15 cross-encoder rerank (next): targets the ~35pp within-pool
  ranking gap left by BGE-base bi-encoder cosine
- F16 stronger locally-runnable embedder (planned): mxbai-embed-large
  or bge-m3 multivector path
- F17 text-embedding-3-large via OpenAI API (deferred): would close
  the gap, but api.openai.com is host-blocked
- F18 fine-tune BGE-base on contrastive pairs (research): risky for
  held-out-set integrity

Cross-track aggregate updated to reflect the split-matched F14
measurement and queue F15.

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
```

---

## Task 2: Re-acquire the `_s` source data

**Files:**
- Create: `data/lme_s/longmemeval_s_cleaned.json` (265 MB, gitignored)

- [ ] **Step 1: Verify the directory is empty (it was deleted in F14)**

```bash
ls data/lme_s 2>&1 | head
```
Expected: `ls: cannot access 'data/lme_s': No such file or directory`. If the directory exists, skip to Step 4 after running Step 3 against the existing file.

- [ ] **Step 2: Download + decompress from the mirror**

```bash
mkdir -p data/lme_s
curl -fsSL https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz \
  -o data/lme_s/longmemeval_s_cleaned.json.gz
gunzip -f data/lme_s/longmemeval_s_cleaned.json.gz
```

Expected: `data/lme_s/longmemeval_s_cleaned.json` exists, ~265 MB.

- [ ] **Step 3: Verify SHA-256**

```bash
sha256sum data/lme_s/longmemeval_s_cleaned.json
```

Expected (must match exactly):
```
d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  data/lme_s/longmemeval_s_cleaned.json
```

If the SHA-256 differs, STOP. The mirror has been mutated since F14. Do not proceed — surface to the user. The F14 result is conditional on this exact byte stream.

- [ ] **Step 4: Verify schema + question_id match with oracle**

```bash
python3 <<'PY'
import json, hashlib
with open('data/lme_s/longmemeval_s_cleaned.json') as f:
    s = json.load(f)
with open('data/longmemeval_oracle.json') as f:
    oracle = json.load(f)
s_ids = {e['question_id'] for e in s}
o_ids = {e['question_id'] for e in oracle}
print(f"_s questions:     {len(s)}")
print(f"oracle questions: {len(oracle)}")
print(f"intersection:     {len(s_ids & o_ids)}")
assert len(s) == 500, f"_s should have 500 questions, got {len(s)}"
assert s_ids == o_ids, f"question_id mismatch: {(s_ids - o_ids) | (o_ids - s_ids)}"
print("PASS: 500/500 question_ids match oracle")
PY
```

Expected: `PASS: 500/500 question_ids match oracle`.

No commit step — `data/lme_s/` is gitignored.

---

## Task 3: Write the F15 prereg

**Files:**
- Create: `docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md`

The prereg pattern mirrors F14's exactly. Read `docs/evals/2026-05-12-r5-track7-s-split-prereg.md` and follow its section structure.

- [ ] **Step 1: Write the prereg with the following exact section headings**

The full prereg structure (all sections required, no placeholders):

1. **Header block:** date, predecessors (F14 FAIL by 46.9pp; F13 deployable at oracle R@5 = 86.8), single-line motivation, verbatim retraction line.
2. **Provenance disclosure (binding):** restate F14's `Sanderhoff-alt` mirror provenance and SHA-256 verbatim; note F15 inherits the same provenance, no new data source.
3. **Embedder-mismatch disclosure (binding):** restate gbrain's `text-embedding-3-large@1536` vs F15's `BGE-base + cross-encoder` stack. Clarify that the cross-encoder is a NEW component beyond what F14 measured.
4. **Cross-encoder model selection rationale (new section, binding):** state which model(s) will be used. Default: `Xenova/ms-marco-MiniLM-L-6-v2` (feasibility tier, 22M params, ~30 pair/s on CPU) AND `BAAI/bge-reranker-base` (quality tier, 278M params, ~3-5 pair/s on CPU). Both via Qdrant fastembed GCS bucket (HF Hub host-blocked). Both run end-to-end; both tabled in result regardless of Gate-B outcome. Best variant selected post-hoc for the Gate-B verdict.
5. **Goal:** describe the pipeline in 4 bullet points (load F14 top-100, score with cross-encoder, sort descending, evaluate with existing `evaluate_retrieval.py`).
6. **Magnitude-smuggling guard:** verbatim grep command from F14 prereg + verbatim retraction sentence on its own line.
7. **Gate-A — workload validity (binding):** five PASS conditions:
   - Cross-encoder model loads successfully (vendored from Qdrant fastembed GCS, not HF Hub).
   - For each query, the reranked candidate set is a permutation of F14's top-100 (no candidate dropped or invented).
   - Score distribution non-degenerate: stddev of scores across 100 candidates per query > 0.01 for ≥ 90% of queries (rejects all-zeros bug).
   - At least 50% of queries have a different top-1 from F14 baseline (rejects no-op rerank).
   - Wall-time per query logged; aggregate throughput within 2x of the feasibility-spike estimate (rejects silent OOM-thrash).
8. **Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL):** threshold = ≥ 97.7 R@5 (gbrain v0.28.8's 97.60 + 0.1 margin). Best F15 variant selected post-hoc from the two cross-encoders run. PASS triggers conventional release update (CHANGELOG / README / ROADMAP / RETRACTION). FAIL triggers HARD RETRACTION arm.
9. **HARD RETRACTION arm (binding):** four actions identical to F14:
   - `data/lme_s/` deleted from disk
   - `results/f15_cross_encoder/` deleted from disk
   - Cross-encoder model weights under `benchmarks/longmemeval/data/model-cache/` deleted ONLY for newly-downloaded models; existing F11/F13/F14 model weights retained
   - CHANGELOG / README / ROADMAP / RETRACTION canonical docs NOT updated
   - Result doc retained as negative-result audit trail
10. **Cumulative-null cite:** explicit reference to `docs/RETRACTION.md:94-113`.

- [ ] **Step 2: Discipline grep on the prereg**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md
echo "exit: $?  (1 = clean)"
grep -nF "This release does not re-assert" docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md
```

Expected: first grep exits 1 (no matches); second grep returns at least one line.

- [ ] **Step 3: Commit the prereg**

```bash
git add docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md
git commit -m "$(cat <<'EOF'
docs(evals): F15 prereg — cross-encoder rerank on F14 top-100

F15 attempts to close the within-pool ranking gap left by F14:
BGE-base bi-encoder cosine ranks the right session outside top-5
too often, even when it's in the top-100 candidate pool.
Cross-encoders score (query, candidate) jointly via cross-attention
and are qualitatively stronger at fine-grained relevance.

Two reranker variants run end-to-end:
  - Xenova/ms-marco-MiniLM-L-6-v2 (feasibility tier, 22M params)
  - BAAI/bge-reranker-base (quality tier, 278M params)
Both via Qdrant fastembed GCS bucket (HF Hub host-blocked).

Gate-A: model loads, candidate-set permutation invariant,
score-distribution non-degeneracy, >=50% top-1 changes, throughput
within 2x of spike estimate.

Gate-B: >= 97.7 R@5 on _s (gbrain 97.60 + 0.1 margin), binding,
HARD RETRACTION on FAIL. Best of the two cross-encoder variants
selected post-hoc.

Source data (data/lme_s/) re-acquired from the same Sanderhoff-alt
mirror used in F14 (SHA-256 d6f21ea9d...). F14's top-100 retrieval
file (results/f14_baseline/turn_bge_s_top100.jsonl, 27 MB) is
retained on disk and used as the candidate input — no new
bi-encoder index needed.

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
```

---

## Task 4: Cross-encoder feasibility spike

**Files:**
- Create: `benchmarks/longmemeval/test_rerank_cross_encoder_toy.mjs`

This is the TDD anchor for the rerank script. Before writing the full pipeline, prove the cross-encoder runs locally and produces sensible scores on a known toy case.

- [ ] **Step 1: Write the failing toy test**

Create `benchmarks/longmemeval/test_rerank_cross_encoder_toy.mjs`:

```js
#!/usr/bin/env node
/**
 * F15 TDD anchor: cross-encoder toy case.
 *
 * Three candidates, one obviously correct. The cross-encoder must rank
 * the correct candidate first. Exits 0 on PASS, 1 on FAIL.
 *
 * Set HIPPO_MODEL_CACHE before running (defaults to local).
 */
import { resolve } from 'node:path';

if (!process.env.HIPPO_MODEL_CACHE) {
  process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
}

const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = process.env.HIPPO_MODEL_CACHE;
env.localModelPath = process.env.HIPPO_MODEL_CACHE;
env.allowRemoteModels = false;

const MODEL = process.argv[2] || 'Xenova/ms-marco-MiniLM-L-6-v2';

console.log(`[F15 toy] loading cross-encoder ${MODEL}...`);
const reranker = await pipeline('text-classification', MODEL);
console.log(`[F15 toy] loaded.`);

const query = 'What degree did I graduate with?';
const candidates = [
  { id: 'A', content: "I'm a graduate with a degree in Business Administration." },
  { id: 'B', content: "I love eating pizza on weekends." },
  { id: 'C', content: "The weather in Paris is mild in May." },
];

const scored = [];
for (const c of candidates) {
  const out = await reranker({ text: query, text_pair: c.content });
  const score = Array.isArray(out) ? out[0].score : out.score;
  scored.push({ id: c.id, score });
  console.log(`  ${c.id}: score=${score.toFixed(4)}`);
}
scored.sort((a, b) => b.score - a.score);
const winner = scored[0].id;
console.log(`[F15 toy] winner: ${winner}`);
if (winner !== 'A') {
  console.error(`FAIL: expected A to rank first, got ${winner}`);
  process.exit(1);
}
console.log('PASS');
```

- [ ] **Step 2: Vendor the cross-encoder model into the local cache**

The Qdrant fastembed GCS bucket pattern is `https://storage.googleapis.com/qdrant-fastembed/<model_dir>.tar.gz`. The reranker model dir name varies — check the existing model-cache for the BGE-base layout used by F11/F13/F14:

```bash
ls benchmarks/longmemeval/data/model-cache/ 2>/dev/null
```

If `Xenova/` subdirectory exists, the layout is `Xenova/<model-name>/<files>`. To vendor `Xenova/ms-marco-MiniLM-L-6-v2`:

```bash
cd benchmarks/longmemeval/data/model-cache
mkdir -p Xenova
curl -fsSL https://storage.googleapis.com/qdrant-fastembed/Xenova--ms-marco-MiniLM-L-6-v2.tar.gz \
  -o /tmp/reranker.tar.gz 2>&1 | tail
```

If that URL 404s (the fastembed bucket uses `--` as a path separator inconsistently across models), try the alternative path:
```bash
curl -fsSL https://storage.googleapis.com/qdrant-fastembed/fast-bge-reranker-base.tar.gz \
  -o /tmp/reranker.tar.gz
```

If both 404, the fallback is to attempt a direct HF Hub fetch (will likely fail with host-blocked, but documents the failure for the prereg):
```bash
curl -fsSL https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model.onnx -o /tmp/test 2>&1 | head -5
```

If all three fail, STOP and surface to the user — F15 cannot run without a vendored cross-encoder. Possible mitigation paths to discuss: (a) ask the user to copy a model tarball from a non-sandboxed machine, (b) defer F15 and proceed to F16 with a different non-cross-encoder mechanism.

If one URL works, extract:
```bash
cd benchmarks/longmemeval/data/model-cache
tar xzf /tmp/reranker.tar.gz
ls Xenova/ms-marco-MiniLM-L-6-v2/  # or whatever path the tar extracted to
```
Expected: `model.onnx` (or `onnx/model.onnx`), `tokenizer.json`, `config.json`, `tokenizer_config.json`.

- [ ] **Step 3: Run the toy test**

```bash
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  node benchmarks/longmemeval/test_rerank_cross_encoder_toy.mjs Xenova/ms-marco-MiniLM-L-6-v2
```

Expected: `PASS` and exit 0. If FAIL, the cross-encoder is loading but not behaving as a reranker (most likely cause: wrong pipeline name; cross-encoders sometimes need `text-classification` with `top_k: null` or `feature-extraction`-then-pooling). Debug by inspecting the raw output of `pipeline()` on one (query, candidate) pair before continuing.

- [ ] **Step 4: Throughput spike**

Once the toy test passes, measure throughput on a realistic batch:

```bash
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache node -e "
import('@huggingface/transformers').then(async ({ pipeline, env }) => {
  env.cacheDir = process.env.HIPPO_MODEL_CACHE;
  env.localModelPath = process.env.HIPPO_MODEL_CACHE;
  env.allowRemoteModels = false;
  const reranker = await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2');
  const t0 = Date.now();
  const N = 100;
  for (let i = 0; i < N; i++) {
    await reranker({ text: 'What is the capital of France?', text_pair: 'Paris is the capital and largest city of France.' });
  }
  const dt = (Date.now() - t0) / 1000;
  console.log('throughput: ' + (N / dt).toFixed(1) + ' pair/s (' + dt.toFixed(2) + 's for ' + N + ' pairs)');
});
"
```

Expected output line: `throughput: XX.X pair/s (Y.YYs for 100 pairs)`.

- [ ] **Step 5: Record the throughput and decide the tier**

Compute the full-run wall time: `50000 / throughput / 60 = minutes`. Decision rule:
- ≥ 10 pair/s (≤ 84 min) — proceed with MiniLM-L-6-v2 AND also vendor `BAAI/bge-reranker-base` for the quality tier (Step 6).
- 2-10 pair/s (84 min – 7 h) — proceed with MiniLM only as the F15 default; defer bge-reranker-base to a follow-up if MiniLM clears Gate-A.
- < 2 pair/s (> 7 h) — STOP, surface to user. F15 budget is exceeded; consider reducing top-100 to top-30 (cuts to 15k pairs) or switching to an even smaller cross-encoder.

No commit step — this is exploratory scaffolding; the toy-test file gets committed with the rerank script in Task 5.

---

## Task 5: Implement `rerank_cross_encoder.mjs`

**Files:**
- Create: `benchmarks/longmemeval/rerank_cross_encoder.mjs`

- [ ] **Step 1: Write the script**

Create `benchmarks/longmemeval/rerank_cross_encoder.mjs`:

```js
#!/usr/bin/env node
/**
 * F15: cross-encoder rerank over an F14-style top-100 candidate JSONL.
 *
 * Input format (each JSONL line):
 *   { question_id, question, retrieved_memories: [{ id, content, tags, score, ... }] }
 *
 * Output format (same shape, with retrieved_memories reordered by cross-encoder score
 * and each candidate's `score` field replaced by the cross-encoder relevance score).
 *
 * Supports resume: writes to `<out>.partial.jsonl` and renames on completion.
 *
 * Usage:
 *   HIPPO_MODEL_CACHE=... node rerank_cross_encoder.mjs <model_id> <input.jsonl> <output.jsonl> [max_candidates]
 */
import { readFileSync, writeFileSync, createReadStream, createWriteStream, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

if (process.argv.length < 5) {
  console.error('usage: rerank_cross_encoder.mjs <model_id> <input.jsonl> <output.jsonl> [max_candidates]');
  process.exit(2);
}

const MODEL = process.argv[2];
const INPUT = process.argv[3];
const OUTPUT = process.argv[4];
const MAX_CANDIDATES = parseInt(process.argv[5] || '100', 10);

if (!process.env.HIPPO_MODEL_CACHE) {
  process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
}

const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = process.env.HIPPO_MODEL_CACHE;
env.localModelPath = process.env.HIPPO_MODEL_CACHE;
env.allowRemoteModels = false;

console.log(`[F15] loading cross-encoder ${MODEL}...`);
const reranker = await pipeline('text-classification', MODEL);
console.log(`[F15] loaded.`);

// Load all input entries
const entries = [];
const rl = createInterface({ input: createReadStream(INPUT) });
for await (const line of rl) {
  if (!line.trim()) continue;
  entries.push(JSON.parse(line));
}
console.log(`[F15] loaded ${entries.length} queries from ${INPUT}`);

// Resume support: if <output>.partial.jsonl exists, count completed lines
const partialPath = OUTPUT + '.partial.jsonl';
let alreadyDone = new Set();
if (existsSync(partialPath)) {
  const existing = readFileSync(partialPath, 'utf8').split('\n').filter(l => l.trim());
  for (const line of existing) {
    try { alreadyDone.add(JSON.parse(line).question_id); } catch {}
  }
  console.log(`[F15] resuming: ${alreadyDone.size} queries already done`);
}

const out = createWriteStream(partialPath, { flags: 'a' });

const tStart = Date.now();
let totalPairs = 0;
let qIdx = 0;
for (const entry of entries) {
  qIdx++;
  if (alreadyDone.has(entry.question_id)) continue;
  const cands = (entry.retrieved_memories || []).slice(0, MAX_CANDIDATES);
  const scored = [];
  for (const c of cands) {
    const r = await reranker({ text: entry.question || '', text_pair: c.content || '' });
    const score = Array.isArray(r) ? r[0].score : r.score;
    scored.push({ ...c, score });
    totalPairs++;
  }
  scored.sort((a, b) => b.score - a.score);
  const outEntry = { ...entry, retrieved_memories: scored, num_retrieved: scored.length };
  out.write(JSON.stringify(outEntry) + '\n');
  if (qIdx % 10 === 0) {
    const dt = (Date.now() - tStart) / 1000;
    const rate = totalPairs / dt;
    const remaining = entries.length - qIdx;
    const eta = remaining * MAX_CANDIDATES / rate / 60;
    console.log(`[F15] ${qIdx}/${entries.length} queries, ${totalPairs} pairs, ${rate.toFixed(1)} pair/s, ETA ${eta.toFixed(1)} min`);
  }
}
out.end();
await new Promise(resolve => out.on('close', resolve));

renameSync(partialPath, OUTPUT);
console.log(`[F15] wrote ${OUTPUT}`);
```

- [ ] **Step 2: Smoke-test on a 10-query slice**

```bash
head -10 results/f14_baseline/turn_bge_s_top100.jsonl > /tmp/f14_top100_smoke.jsonl
mkdir -p results/f15_cross_encoder
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  node benchmarks/longmemeval/rerank_cross_encoder.mjs \
  Xenova/ms-marco-MiniLM-L-6-v2 \
  /tmp/f14_top100_smoke.jsonl \
  /tmp/f15_smoke_minilm.jsonl \
  100
```

Expected: completes in ~30s on MiniLM tier; produces `/tmp/f15_smoke_minilm.jsonl` with 10 lines, each with `retrieved_memories` reordered.

- [ ] **Step 3: Verify the smoke output**

```bash
python3 <<'PY'
import json
with open('/tmp/f15_smoke_minilm.jsonl') as f:
    out = [json.loads(l) for l in f if l.strip()]
with open('/tmp/f14_top100_smoke.jsonl') as f:
    inp = [json.loads(l) for l in f if l.strip()]
assert len(out) == len(inp) == 10
for o, i in zip(out, inp):
    assert o['question_id'] == i['question_id']
    inp_ids = {m['id'] for m in i['retrieved_memories'][:100]}
    out_ids = {m['id'] for m in o['retrieved_memories']}
    assert inp_ids == out_ids, f"id-set mismatch on {o['question_id']}"
    # Score distribution non-degenerate (Gate-A condition 3)
    scores = [m['score'] for m in o['retrieved_memories']]
    import statistics
    sd = statistics.stdev(scores)
    print(f"{o['question_id']}: top1={o['retrieved_memories'][0]['id']}, stddev={sd:.4f}")
print('PASS: smoke output schema OK')
PY
```

Expected: all 10 queries print `top1=... stddev=X` with stddev > 0.01, ending in `PASS`.

- [ ] **Step 4: Commit the script + toy test**

```bash
git add benchmarks/longmemeval/rerank_cross_encoder.mjs \
        benchmarks/longmemeval/test_rerank_cross_encoder_toy.mjs
git commit -m "$(cat <<'EOF'
feat(benchmarks): cross-encoder rerank script for F15

Two new benchmark scaffolding files (no src/ changes):

- rerank_cross_encoder.mjs: loads an F14-style top-100 JSONL,
  scores each (query, candidate.content) pair with a transformers.js
  cross-encoder pipeline, sorts descending, writes a reranked JSONL
  compatible with evaluate_retrieval.py. Resume-on-restart via
  <output>.partial.jsonl. Tunable max_candidates flag.

- test_rerank_cross_encoder_toy.mjs: TDD anchor. Three-candidate
  toy case with one obviously correct answer. Exits 0 on PASS,
  1 on FAIL. Used as the first smoke gate before running the full
  500-query rerank.

No src/ changes. Model vendoring uses the Qdrant fastembed GCS
bucket pattern (HF Hub host-blocked).

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
```

---

## Task 6: Run cross-encoder rerank on the full 500-query top-100

**Files:**
- Create: `results/f15_cross_encoder/<model_id>_top100.jsonl` (gitignored sibling of `results/f14_baseline/`)

- [ ] **Step 1: Set up the output directory + log file**

```bash
mkdir -p results/f15_cross_encoder
# Confirm input still on disk
wc -l results/f14_baseline/turn_bge_s_top100.jsonl
```
Expected: `500 results/f14_baseline/turn_bge_s_top100.jsonl`.

- [ ] **Step 2: Run the MiniLM tier in the background**

```bash
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  nohup node benchmarks/longmemeval/rerank_cross_encoder.mjs \
  Xenova/ms-marco-MiniLM-L-6-v2 \
  results/f14_baseline/turn_bge_s_top100.jsonl \
  results/f15_cross_encoder/minilm_l6_top100.jsonl \
  100 \
  > /tmp/f15_minilm.log 2>&1 &
echo "started PID $!"
```

Expected wall time per Task 4 spike. If throughput was 30 pair/s, ~28 min for 50,000 pairs. If 10 pair/s, ~84 min. Monitor with `tail -f /tmp/f15_minilm.log`.

- [ ] **Step 3: After MiniLM completes, run the bge-reranker-base tier (only if Task 4 tier permitted)**

If Task 4's throughput-spike decision rule permits the quality tier:

```bash
# First vendor bge-reranker-base (same pattern as Task 4 Step 2)
# Then:
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  nohup node benchmarks/longmemeval/rerank_cross_encoder.mjs \
  Xenova/bge-reranker-base \
  results/f14_baseline/turn_bge_s_top100.jsonl \
  results/f15_cross_encoder/bge_reranker_base_top100.jsonl \
  100 \
  > /tmp/f15_bge.log 2>&1 &
echo "started PID $!"
```

Wall time will be larger by the throughput ratio.

If Task 4's decision rule did NOT permit the quality tier, skip this step and table only the MiniLM result in Task 8.

- [ ] **Step 4: Verify both output files completed (no `.partial.jsonl` left)**

```bash
ls -la results/f15_cross_encoder/
wc -l results/f15_cross_encoder/*.jsonl
```
Expected: each `*.jsonl` is 500 lines. No `.partial.jsonl` should exist.

- [ ] **Step 5: Gate-A validity checks**

```bash
python3 <<'PY'
import json, statistics

with open('results/f14_baseline/turn_bge_s_top100.jsonl') as f:
    f14 = {json.loads(l)['question_id']: json.loads(l) for l in f}

def check(path, name):
    print(f"\n=== Gate-A for {name} ===")
    n_qs = 0
    n_perm_ok = 0
    n_stddev_ok = 0
    n_top1_changed = 0
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            n_qs += 1
            qid = r['question_id']
            f14_ids = [m['id'] for m in f14[qid]['retrieved_memories'][:100]]
            f15_ids = [m['id'] for m in r['retrieved_memories']]
            if set(f14_ids) == set(f15_ids) and len(f14_ids) == len(f15_ids):
                n_perm_ok += 1
            scores = [m['score'] for m in r['retrieved_memories']]
            if len(scores) > 1 and statistics.stdev(scores) > 0.01:
                n_stddev_ok += 1
            if f14_ids[0] != f15_ids[0]:
                n_top1_changed += 1
    print(f'  queries: {n_qs} (expected 500)')
    print(f'  permutation-invariant: {n_perm_ok}/{n_qs}')
    print(f'  score-stddev > 0.01:   {n_stddev_ok}/{n_qs} (need >= 90%)')
    print(f'  top-1 changed vs F14:  {n_top1_changed}/{n_qs} (need >= 50%)')
    ok = (n_qs == 500 and n_perm_ok == n_qs and n_stddev_ok / n_qs >= 0.90 and n_top1_changed / n_qs >= 0.50)
    print(f'  Gate-A: {"PASS" if ok else "FAIL"}')

import os
for f in sorted(os.listdir('results/f15_cross_encoder')):
    if f.endswith('.jsonl'):
        check(f'results/f15_cross_encoder/{f}', f)
PY
```

Expected: Gate-A PASS for at least one variant. If both FAIL, surface the failure mode to the user (most likely cause: score-distribution degenerate — the cross-encoder isn't actually outputting a usable relevance score; debug the pipeline output shape).

No commit step — results are gitignored.

---

## Task 7: Score with `evaluate_retrieval.py` (Gate-B)

- [ ] **Step 1: Score each reranked variant**

```bash
python3 <<'PY'
import json
from collections import defaultdict

with open('data/lme_s/longmemeval_s_cleaned.json') as f:
    data = json.load(f)
gt = {e['question_id']: e for e in data}

def hit(memories, sids, k):
    for mem in memories[:k]:
        for tag in mem.get('tags', []):
            for sid in sids:
                if sid in tag:
                    return True
    return False

def score(path):
    res = defaultdict(list)
    by_type = defaultdict(lambda: defaultdict(list))
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            qid = rec['question_id']
            qtype = rec.get('question_type', 'unknown')
            mems = rec.get('retrieved_memories', [])
            sids = gt.get(qid, {}).get('answer_session_ids', [])
            if not sids: continue
            for k in (1, 3, 5, 10, 20, 50, 100):
                h = hit(mems, sids, k)
                res[k].append(h)
                by_type[qtype][k].append(h)
    return res, by_type

def pct(xs): return round(100 * sum(xs) / len(xs), 1) if xs else 0.0

import os
print('| Variant | R@1 | R@3 | R@5 | R@10 | R@20 |')
print('|---|---:|---:|---:|---:|---:|')
print(f'| F14 baseline (BGE-base only) | 21.6 | 34.4 | 42.0 | 51.8 | 65.6 |')
print(f'| F14+F9 stack (sub-agent rerank top-20) | 33.6 | 46.8 | 50.8 | 56.2 | 65.2 |')
for fname in sorted(os.listdir('results/f15_cross_encoder')):
    if not fname.endswith('.jsonl'): continue
    r, t = score(f'results/f15_cross_encoder/{fname}')
    label = fname.replace('_top100.jsonl', '').replace('_', '-')
    print(f'| F15 {label} | {pct(r[1])} | {pct(r[3])} | {pct(r[5])} | {pct(r[10])} | {pct(r[20])} |')
print(f'| gbrain v0.28.8 hybrid | — | — | 97.60 | — | — |')
print(f'| F15 Gate-B threshold  | — | — | 97.7 | — | — |')

# Per-type for the best F15 variant
print('\nPer-type R@5 for best F15 variant:')
best_path = None
best_r5 = -1
for fname in sorted(os.listdir('results/f15_cross_encoder')):
    if not fname.endswith('.jsonl'): continue
    r, t = score(f'results/f15_cross_encoder/{fname}')
    if pct(r[5]) > best_r5:
        best_r5 = pct(r[5])
        best_t = t
        best_path = fname
print(f'(best: {best_path}, R@5 = {best_r5})')
for qt in sorted(best_t.keys()):
    print(f'  {qt:<30s} n={len(best_t[qt][5]):>4d}  R@5={pct(best_t[qt][5]):>5.1f}%')

print()
print(f'=== Gate-B verdict: {"PASS" if best_r5 >= 97.7 else "FAIL"} (best R@5 = {best_r5} vs threshold 97.7) ===')
PY
```

Expected: the script prints a fully-formatted result table plus per-type breakdown plus the Gate-B verdict. Capture the output (e.g. `... | tee /tmp/f15_score.txt`) — it goes verbatim into the result doc.

---

## Task 8: Write the F15 result doc

**Files:**
- Create: `docs/evals/2026-05-12-r5-track8-cross-encoder-result.md`

- [ ] **Step 1: Write the result doc using F14 result as the template**

Required sections (no placeholders allowed in the final committed version):

1. **Header block:** date, predecessor citations, motivation in one sentence.
2. **Verbatim retraction line** on its own line.
3. **Provenance disclosure** identical to F14's (same mirror, same SHA-256, same conditional-on-integrity caveat).
4. **Embedder + reranker mismatch disclosure** — note that F15 uses BGE-base + cross-encoder vs gbrain's text-embedding-3-large + RRF.
5. **TL;DR** — 4-6 bullets ending with the Gate-B verdict and what it means for the deployable best.
6. **Gate-A — workload validity** — PASS or FAIL per Task 6 Step 5; list each of the 5 conditions and the measured value.
7. **Gate-B — proven value at R@5** — verdict line, threshold arithmetic (`best_r5 < 97.7`, shortfall = `97.7 - best_r5` pp) OR (`best_r5 >= 97.7`, margin = `best_r5 - 97.7` pp). Both reranker variants tabled.
8. **Per-K table** for both variants AND the F14 baselines, showing R@1, R@3, R@5, R@10, R@20.
9. **Per-type breakdown** at R@5 for the best F15 variant + F14 baseline + F14+F9 stack.
10. **Cross-track summary** — extend the F14 result's cross-track table with the new F15 row(s).
11. **HARD RETRACTION executed** OR **Deploy / conventional release** section, depending on verdict.
12. **Outside-voice review trail** with placeholder for Task 9's review verdict.

Discipline checks must hold for the FINAL committed version. No magnitude smuggling; verbatim retraction line; cumulative-null cite to `docs/RETRACTION.md:94-113`.

- [ ] **Step 2: Discipline grep on the result doc**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-12-r5-track8-cross-encoder-result.md
echo "exit: $?  (1 = clean)"
grep -nF "This release does not re-assert" docs/evals/2026-05-12-r5-track8-cross-encoder-result.md
grep -nF "RETRACTION.md:94-113" docs/evals/2026-05-12-r5-track8-cross-encoder-result.md
```

Expected: first grep exit 1 (no matches); second + third return ≥ 1 line each.

---

## Task 9: Outside-voice review

- [ ] **Step 1: Dispatch an isolated-context review subagent**

Use the Agent tool with `subagent_type=general-purpose` and `model=sonnet`. Prompt template (mirror the F14 review structure exactly):

```
Isolated-context outside-voice review. No prior context — review only what's on disk.

Read `/home/user/hippo-memory/docs/evals/2026-05-12-r5-track8-cross-encoder-result.md` and audit. Reference docs:
- `/home/user/hippo-memory/docs/evals/2026-05-12-r5-track8-cross-encoder-prereg.md`
- `/home/user/hippo-memory/docs/evals/2026-05-12-r5-track7-s-split-result.md` (F14, the predecessor)
- `/home/user/hippo-memory/docs/RETRACTION.md:94-113`

Audit (PASS / FAIL / NOTE) the same 13-check list used for F14:
1. Verbatim retraction sentence on own line.
2. Provenance disclosure binding (SHA-256, no HF chain, tamper-conditional).
3. Embedder + reranker mismatch disclosure binding.
4. Gate-A verdict with 5 measurable conditions.
5. Gate-B arithmetic (best_r5 vs 97.7, shortfall or margin).
6. Per-K + per-type tables internally consistent.
7. Cross-track table internally consistent with F14 result.
8. PASS/FAIL arm executed correctly.
9. Magnitude-smuggling grep returns 0 matches.
10. Cumulative-null cite `docs/RETRACTION.md:94-113`.
11. F14 vs F15 framing honest (same retrieval, same data, different rerank).
12. The "cross-encoder lever" claim correctly framed (whether it closed the within-pool gap or not).
13. Anything missing or misleading.

Output: one-line verdict + bulleted per-check + required fixes + optional improvements. Under 700 words.
```

- [ ] **Step 2: Apply required fixes inline**

If the review returns PASS_WITH_NOTES with optional improvements, apply them. If FAIL with required fixes, address each and re-dispatch the review.

- [ ] **Step 3: Fill in the review-trail section**

Replace the placeholder in result-doc Section 12 with the review verdict + per-check summary, mirroring F14 result's "Outside-voice review trail" section.

---

## Task 10: Commit + push + execute Gate-B arm

- [ ] **Step 1: Decide the arm**

If Gate-B PASS (best_r5 ≥ 97.7):
- Update `CHANGELOG.md` with a new entry citing F15 + the new deployable cross-track best.
- Update `README.md` benchmarks section.
- Update `ROADMAP-RESEARCH.md` F15 bullet from `[next]` to `[shipped]` + update the cross-track aggregate paragraph.
- Update `docs/RETRACTION.md` with a one-line entry: F15 PASS at R@5 = X, gbrain matched / bested, no retraction.

If Gate-B FAIL (best_r5 < 97.7):
- HARD RETRACTION: delete `data/lme_s/` and `results/f15_cross_encoder/`.
- Delete any newly-vendored cross-encoder model weights from `benchmarks/longmemeval/data/model-cache/` (retain BGE-base, e5-large, and any pre-F15 reranker weights).
- Do NOT update CHANGELOG / README / ROADMAP / RETRACTION canonical docs.
- Retain the result doc as the negative-result audit trail.
- Surface the next-track recommendation (likely F16) to the user.

- [ ] **Step 2: Final discipline grep across all changed files**

```bash
for f in $(git diff --name-only HEAD); do
  echo "--- $f ---"
  grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' "$f"
done
echo "(any output above is a magnitude-smuggling violation)"
```

Expected: no output. If any output appears, rewrite the offending line.

- [ ] **Step 3: Commit + push the result doc + arm-specific changes**

For PASS arm:
```bash
git add docs/evals/2026-05-12-r5-track8-cross-encoder-result.md \
        CHANGELOG.md README.md ROADMAP-RESEARCH.md docs/RETRACTION.md
git commit -m "$(cat <<'EOF'
docs(evals): F15 result — cross-encoder rerank GATE-B PASS

F15 [cross-encoder, top-100] reaches R@5 = <r5> on the _s split,
clearing Gate-B (97.7) by <margin>pp. Deployable cross-track best
on _s is now F15 at R@5 = <r5>. F14 result doc retained as the
negative-result record of the BGE-base-only baseline.

Best variant: <model_id> on the top-100 candidate pool from F14's
existing retrieval (no new bi-encoder index built). Wall time:
<wall> min. Score distribution non-degenerate (stddev > 0.01 on
500/500 queries), top-1 changed vs F14 on <pct>% of queries.

Per-K (best variant):
  R@1  = <r1>
  R@3  = <r3>
  R@5  = <r5>
  R@10 = <r10>
  R@20 = <r20>

Per-type R@5: see result doc Section 9.

Outside-voice review: PASS_WITH_NOTES (<n>/13 checks). Trail in
result doc Section 12.

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp
```

For FAIL arm:
```bash
rm -rf data/lme_s
rm -rf results/f15_cross_encoder
# (selective model-cache cleanup — confirm with user before bulk delete)

git add docs/evals/2026-05-12-r5-track8-cross-encoder-result.md
git commit -m "$(cat <<'EOF'
docs(evals): F15 result — cross-encoder rerank, GATE-B FAIL, HARD RETRACTION

F15 swapped F14's F9 sub-agent rerank for a locally-runnable
cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2 + BAAI/bge-reranker-base
variants) over the existing F14 top-100 retrieval. Both ran
end-to-end on _s; best R@5 = X.X (variant: Y).

Gate-B threshold was 97.7; shortfall <Z>pp. The within-pool
ranking gap closed by <closed>pp (F14+F9 stack was 50.8, F15 best
is <r5>); the R@100 ceiling at 86.2 plus the residual ranking gap
leave F15 well below gbrain's 97.60. The embedder gap remains the
dominant factor — gbrain's pure-vector ablation alone hits 97.40,
so a cross-encoder on top of BGE-base cannot substitute for
text-embedding-3-large at this distractor density.

Per the F15 prereg HARD RETRACTION clause:
- data/lme_s/ deleted (re-acquirable from Sanderhoff-alt mirror)
- results/f15_cross_encoder/ deleted
- CHANGELOG / README / ROADMAP / RETRACTION canonical docs NOT
  updated. Result doc retained.
- Deployable cross-track best remains F13 + F9 on oracle = 86.8.

Next track per the roadmap: F16 (stronger locally-runnable embedder
on _s) or, conditional on egress, F17 (text-embedding-3-large).

Outside-voice review: PASS_WITH_NOTES (Y/13 checks). Trail in
the result doc Section 12.

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp
```

- [ ] **Step 4: Update ROADMAP-RESEARCH F15 status**

Regardless of arm: change F15's `[next]` to `[shipped]` (PASS) or `[shipped — Gate-B FAIL, HARD RETRACTION]` (FAIL), and update the cross-track aggregate paragraph one more time to reflect the F15 outcome.

```bash
git add ROADMAP-RESEARCH.md
git commit -m "$(cat <<'EOF'
docs(roadmap): F15 status -> shipped (verdict: <PASS|FAIL>)

[short commit body matching the arm]

This release does not re-assert the retracted -10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp
```

---

## Self-review checklist

Run before handing the plan off:

1. **Spec coverage:** the spec calls for hard prereg with Gate-A/Gate-B + cross-encoder rerank + honest deferred goal at 97.7 + realistic goal over 50.8. Mapped:
   - Hard prereg → Task 3
   - Gate-A → prereg Section 7 + Task 6 Step 5
   - Gate-B → prereg Section 8 + Task 7
   - Cross-encoder rerank → Tasks 4-6
   - 97.7 threshold → prereg Section 8, hard binding
   - 50.8 budget anchor → prereg explicitly labels this NON-binding, anti-magnitude-smuggling

2. **Placeholder scan:** every code block, command, and file path is concrete. Section headings in the result doc and prereg are listed by name (the engineer fills in the prose). No `TBD` / `TODO` / `fill in`.

3. **Type consistency:** `rerank_cross_encoder.mjs` arg order is `<model_id> <input.jsonl> <output.jsonl> [max_candidates]` everywhere it appears. Output path `results/f15_cross_encoder/<model_id>_top100.jsonl` consistent across Tasks 6, 7, 10. JSONL schema (`retrieved_memories[].{id, content, tags, score}`) consistent with F14's existing format.

4. **Discipline coverage:** every commit body includes the verbatim retraction line. Magnitude-smuggling grep runs on every doc edit (Tasks 1, 3, 8, 10). HARD RETRACTION arm is fully spelled out (Task 10 Step 1 FAIL branch).

5. **Reversibility check:** every step is recoverable. Cross-encoder model vendoring is the only step that touches a third-party network; if it fails, Task 4 Step 2 spells out the failure-handling path (surface to user). Data re-acquisition (Task 2) is idempotent. Smoke tests (Tasks 4, 5) gate the big run.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-f15-cross-encoder-rerank.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Particularly suited to F15 because Task 4 (feasibility spike) is gating and the spike outcome may rewrite Tasks 6-10's wall-time expectations.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster if the spike clears cleanly, slower if it doesn't.

Which approach?
