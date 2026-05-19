# F15 Cross-Encoder Rerank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a locally-runnable cross-encoder rerank to the top-100 candidates from F14 BGE-base retrieval on the LongMemEval `_s` split, with a hard prereg (Gate-A validity, Gate-B value, HARD RETRACTION on FAIL) — targeting the ~35-point within-pool ranking gap that F14's bi-encoder cosine alone leaves on the table.

**Architecture:** Two-stage retrieve-then-rerank, no new bi-encoder index needed. F14's `results/f14_baseline/turn_bge_s_top100.jsonl` (27 MB, 500 queries × 100 candidates each with truncated turn text and parent `session_id` tag) is the input — no re-embed required. Stage 2 is a cross-encoder (start with `Xenova/ms-marco-MiniLM-L-6-v2` for the feasibility tier, escalate to `Xenova/bge-reranker-base` if Gate-A throughput allows) loaded via `@huggingface/transformers` ONNX runtime; for each (query, candidate) pair we get a relevance score and sort descending. Output is a new JSONL compatible with the existing `evaluate_retrieval.py`. Gate-B is binding at ≥ 97.7 R@5 (gbrain v0.28.8's 97.60 + 0.1 margin); FAIL triggers HARD RETRACTION of data artefacts per the F12/F14 precedent. The realistic-but-non-binding budget anchor for whether to run this experiment at all is "improves over F14+F9 stack of 50.8 R@5"; that is a budget anchor, NOT a discipline shortcut — the result doc reports R@5 honestly against the 97.7 threshold and executes the prereg's FAIL arm if it falls short.

**Structural ceiling acknowledgement (binding):** F14's R@100 on `_s` is 86.2 — for 14 % of queries the answer-bearing session is not in F14's top-100 candidate pool at all. A cross-encoder rerank can only reorder within the pool; it cannot promote a session from outside top-100 into top-5. Therefore the maximum achievable F15 R@5 on this candidate set is bounded above by 86.2, regardless of how well the cross-encoder ranks. Since 86.2 < 97.7, F15 cannot mathematically clear Gate-B. **F15 is a mechanism-characterisation track**: its value is measuring how much of the within-pool ranking gap a locally-runnable cross-encoder closes (F14+F9 sub-agent rerank closed 8.8 of the ~44 within-pool points; F15 quantifies whether a model-based cross-encoder closes more). Gate-B remains binding at 97.7 with the HARD RETRACTION arm — this is the project's standard "no soft tiered gates" discipline — but the engineer should not expect Gate-B PASS. The path to actually clearing Gate-B is F15 + F16 combined (cross-encoder rerank on top of a stronger embedder that lifts R@100 closer to 100). F16 is queued in `ROADMAP-RESEARCH.md`.

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
- **F15 cross-encoder rerank on top-100 (this track)** [next]: replace F9's sub-agent rerank with a locally-runnable cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2` feasibility tier or `Xenova/bge-reranker-base` quality tier, both via Qdrant fastembed GCS). Reuses F14's existing top-100 retrieval; no new bi-encoder index. Cross-encoders score (query, candidate) jointly via cross-attention rather than via post-hoc cosine on independent encodings — qualitatively stronger at fine-grained relevance ranking, and the F14 result doc identifies a ~35pp ranking gap within F14's top-100 candidate pool that this lever directly targets. Gate-B = ≥ 97.7 R@5 (gbrain's 97.60 + 0.1 margin), binding, HARD RETRACTION on FAIL. Plan: `docs/superpowers/plans/2026-05-12-f15-cross-encoder-rerank.md`.
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

This release does not re-assert the retracted −10pp magnitude.

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
4. **Cross-encoder model selection rationale (new section, binding):** state which model(s) will be used. Default: `Xenova/ms-marco-MiniLM-L-6-v2` (feasibility tier, 22M params, ~30 pair/s on CPU) AND `Xenova/bge-reranker-base` (quality tier, 278M params, ~3-5 pair/s on CPU). Both via Qdrant fastembed GCS bucket (HF Hub host-blocked). Both run end-to-end; both tabled in result regardless of Gate-B outcome. Best variant selected post-hoc for the Gate-B verdict.
5. **Goal:** describe the pipeline in 4 bullet points (load F14 top-100, score with cross-encoder, sort descending, evaluate with existing `evaluate_retrieval.py`).
6. **Magnitude-smuggling guard:** verbatim grep command from F14 prereg + verbatim retraction sentence on its own line.
7. **Gate-A — workload validity (binding):** five PASS conditions:
   - Cross-encoder model loads successfully (vendored from Qdrant fastembed GCS, not HF Hub).
   - For each query, the reranked candidate set is a permutation of F14's top-100 (no candidate dropped or invented).
   - Score distribution non-degenerate: stddev of scores across 100 candidates per query > 0.01 for ≥ 90% of queries (rejects all-zeros bug).
   - At least 50% of queries have a different top-1 from F14 baseline (rejects no-op rerank).
   - Wall-time per query logged; aggregate throughput within 2x of the feasibility-spike estimate (rejects silent OOM-thrash).
8. **Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL):** threshold = ≥ 97.7 R@5 (gbrain v0.28.8's 97.60 + 0.1 margin). Best F15 variant selected post-hoc from the two cross-encoders run. PASS triggers conventional release update (CHANGELOG / README / ROADMAP / RETRACTION). FAIL triggers HARD RETRACTION arm.
   **Structural ceiling subsection (required in the prereg doc):** explicitly state that F14's R@100 on `_s` = 86.2 is the absolute upper bound on F15's achievable R@5 (since a rerank can only reorder within the candidate pool; it cannot promote a session from outside top-100 into top-5). 86.2 < 97.7, therefore F15 cannot mathematically clear Gate-B from the F14 candidate pool alone. The Gate-B threshold remains 97.7 because the project's discipline forbids retargeting gates to what an experiment can achieve (that pattern is exactly the magnitude-smuggling the project's RETRACTION.md disciplines against). F15's legitimate value is mechanism characterisation: measuring how much of the within-pool ranking gap a locally-runnable cross-encoder closes. The path to actually clearing Gate-B is F15 + F16 combined (cross-encoder on a stronger embedder that lifts R@100 closer to 100); F16 is queued in `ROADMAP-RESEARCH.md`.
9. **HARD RETRACTION arm (binding):** four actions identical to F14:
   - `data/lme_s/` deleted from disk
   - `results/f15_subagent_rerank/` deleted from disk
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
  - Xenova/bge-reranker-base (quality tier, 278M params)
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

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
```

---

## PIVOT NOTE (2026-05-12)

Tasks 4-6 below were rewritten on 2026-05-12 after the original Task 4 (cross-encoder feasibility spike) discovered the sandbox cannot reach any cross-encoder ONNX source. See commit `458f006` and the revised prereg `docs/evals/2026-05-12-r5-track8-subagent-rerank-prereg.md` for the full pivot history. The replacement mechanism is a maximally-equipped LLM-as-reranker using Claude Opus 4.7 sub-agents, configured with deeper pool, richer context, structured rubric, and smaller batches. Tasks 1-3 above and Tasks 7-10 below are otherwise unchanged at the methodology level (path slugs updated from `f15_cross_encoder` to `f15_subagent_rerank`).

---

## Task 4: Generate per-batch rerank input files

**Files:**
- (Reuse) `benchmarks/longmemeval/rerank_split_v2.py` — no changes needed; CLI already supports the F15 parameters.
- Write: `/tmp/rerank_f15_batches/batch_000.json` … `batch_099.json` (100 files, 5 queries × 100 candidates each, gitignored under `/tmp/`).

- [ ] **Step 1: Verify F14 retrieval input is present and well-formed**

Run this verification before generating batches:

```bash
ls -lh results/f14_baseline/turn_bge_s_top100.jsonl
wc -l results/f14_baseline/turn_bge_s_top100.jsonl
python3 -c "
import json
with open('results/f14_baseline/turn_bge_s_top100.jsonl') as f:
    first = json.loads(f.readline())
keys = sorted(first.keys())
print('keys:', keys)
mems = first.get('retrieved_memories', [])
print('n_memories:', len(mems))
print('sample memory keys:', sorted(mems[0].keys()) if mems else 'none')
print('sample content[:80]:', (mems[0].get('content') or '')[:80] if mems else '')
print('sample tags:', mems[0].get('tags') if mems else None)
"
```

Expected: file is ~27 MB, 500 lines, each line has `retrieved_memories` with 100 entries, each entry has `id`, `score`, `tags`, `content`. If anything looks off, STOP and surface to the controller.

- [ ] **Step 2: Generate the 100 batch input files with F15 parameters**

```bash
rm -rf /tmp/rerank_f15_batches
mkdir -p /tmp/rerank_f15_batches
python3 benchmarks/longmemeval/rerank_split_v2.py \
    --retrieval results/f14_baseline/turn_bge_s_top100.jsonl \
    --out-dir /tmp/rerank_f15_batches \
    --batch-size 5 \
    --max-candidates 100 \
    --content-chars 1000
```

Expected stderr: `Wrote 100 batches (500 queries) to /tmp/rerank_f15_batches`.

- [ ] **Step 3: Verify the batches**

```bash
ls /tmp/rerank_f15_batches/ | wc -l    # expect 100
ls /tmp/rerank_f15_batches/ | head -3
ls /tmp/rerank_f15_batches/ | tail -3
python3 -c "
import json, glob
files = sorted(glob.glob('/tmp/rerank_f15_batches/batch_*.json'))
print(f'batches: {len(files)}')
b0 = json.loads(open(files[0]).read())
print(f'batch 0: {len(b0)} queries')
q = b0[0]
print(f'  q0: question_id={q["question_id"]} n_cands={len(q["candidates"])}')
print(f'  q0 first cand content[:80]: {q["candidates"][0]["content"][:80]!r}')
print(f'  q0 last cand content[:80]: {q["candidates"][-1]["content"][:80]!r}')
total_qs = sum(len(json.loads(open(f).read())) for f in files)
print(f'total queries across all batches: {total_qs} (expect 500)')
"
```

Expected: 100 batch files, each containing 5 query objects, each query carrying 100 candidates with 1000-char-truncated content. Total queries = 500.

No commit step — `/tmp/rerank_f15_batches/` is ephemeral scaffolding.

---

## Task 5: Dispatch 100 Opus-4.7 sub-agent rerank batches

**Files:**
- Write: `/tmp/rerank_f15_outputs/batch_000.json` … `batch_099.json` (100 files).

This task runs in the controller (the orchestrating Claude session). The controller dispatches 100 `Agent` calls with `subagent_type=general-purpose` and `model=opus`, running up to 10 in parallel per message. Each sub-agent processes one batch — 5 queries × 100 candidates each — and emits a JSON file with `ranked_ids` per query.

- [ ] **Step 1: Define the rubric prompt template**

The controller uses this exact prompt template for each batch dispatch (substituting `<BATCH_NUM>` and inlining the batch's JSON):

```
You are a relevance reranker for a long-conversation retrieval benchmark (LongMemEval). For each of the 5 questions in this batch, you receive 100 candidate turns retrieved from a chat history. Each candidate is a turn from a specific session; the goal is to identify which sessions are most likely to contain the ground-truth answer.

Score each candidate against its query on three independent 0-3 scales:

1. TOPICAL_MATCH (0-3): how closely the candidate's subject matches the query's subject. 0 = unrelated; 1 = same general domain; 2 = same specific topic; 3 = identical claim space.
2. EVIDENCE_SPECIFICITY (0-3): how precisely the candidate addresses the query's particular fact. 0 = vague/general; 1 = mentions the topic but not the fact; 2 = mentions the fact partially; 3 = explicit statement of the fact.
3. RECENCY_OF_CLAIM (0-3): for questions about current state ("what do I prefer", "what's my latest"), prefer claims that read as current/standalone. 0 = clearly superseded or outdated context; 1 = unclear; 2 = current-ish; 3 = clearly current/canonical.

Compute total = TOPICAL_MATCH + EVIDENCE_SPECIFICITY + RECENCY_OF_CLAIM (0-9 per candidate). Rank candidates within each query by total descending. Break ties first by TOPICAL_MATCH descending, then by EVIDENCE_SPECIFICITY descending, then preserve the input order.

Output strict JSON only — no prose, no markdown — to `/tmp/rerank_f15_outputs/batch_<BATCH_NUM>.json`:

[
  {"question_id": "<qid>", "ranked_ids": ["<id1>", "<id2>", ..., "<id100>"]},
  ...   // exactly one entry per question in the batch
]

Constraints:
- `ranked_ids` for each question must be a permutation of the 100 input candidate ids — same set, no duplicates, no inventions.
- Output exactly 5 entries (one per question in the batch).
- Write the file with the Write tool. Use the absolute path `/tmp/rerank_f15_outputs/batch_<BATCH_NUM>.json`.

Batch input (5 questions, 100 candidates each, 1000-char content):

<inline the contents of /tmp/rerank_f15_batches/batch_<BATCH_NUM>.json here>

Report back when written. No prose summary needed; the JSON file is the deliverable.
```

- [ ] **Step 2: Prepare output directory and dispatch**

```bash
mkdir -p /tmp/rerank_f15_outputs
```

The controller dispatches batches in groups of up to 10 parallel `Agent` calls per message. With 100 batches total and 10-at-a-time parallelism, this is 10 controller messages.

For each batch NNN (000..099): the controller reads `/tmp/rerank_f15_batches/batch_NNN.json`, formats the rubric prompt with that JSON inlined, and dispatches an `Agent` call with:
- `subagent_type=general-purpose`
- `model=opus`
- `description=F15 rerank batch NNN`
- `prompt` = the rubric template with `<BATCH_NUM>` substituted and the batch JSON inlined

Each sub-agent's task is purely to read the inlined input, do the ranking, and Write the JSON output to the prescribed path. No other tools needed.

- [ ] **Step 3: Verify completeness**

```bash
ls /tmp/rerank_f15_outputs/ | wc -l    # expect 100
python3 <<'PYV'
import json, glob
files = sorted(glob.glob('/tmp/rerank_f15_outputs/batch_*.json'))
print(f'output files: {len(files)} (expect 100)')
missing = [f'batch_{i:03d}.json' for i in range(100) if not any(f.endswith(f'batch_{i:03d}.json') for f in files)]
if missing:
    print(f'MISSING: {missing[:10]}{"..." if len(missing) > 10 else ""}')
else:
    print('all 100 batch outputs present')
total_qs = 0
bad = []
for f in files:
    try:
        d = json.loads(open(f).read())
        assert isinstance(d, list)
        total_qs += len(d)
    except Exception as e:
        bad.append((f, str(e)))
print(f'total queries in outputs: {total_qs} (expect 500)')
print(f'malformed files: {len(bad)}')
for f, e in bad[:5]:
    print(f'  {f}: {e}')
PYV
```

Expected: 100 files, 500 queries total, 0 malformed. If any batches are missing or malformed, re-dispatch JUST the failing batches; do NOT re-run the entire 100.

No commit step — `/tmp/rerank_f15_outputs/` is ephemeral.

---

## Task 6: Merge rerank outputs into the reranked JSONL and Gate-A validity

**Files:**
- (Reuse) `benchmarks/longmemeval/rerank_merge_v2.py`
- Write: `results/f15_subagent_rerank/opus_top100_reranked.jsonl` (gitignored under `results/`)

- [ ] **Step 1: Merge**

```bash
mkdir -p results/f15_subagent_rerank
python3 benchmarks/longmemeval/rerank_merge_v2.py \
    --retrieval results/f14_baseline/turn_bge_s_top100.jsonl \
    --ranks-dir /tmp/rerank_f15_outputs \
    --out results/f15_subagent_rerank/opus_top100_reranked.jsonl
```

Expected stderr: `Loaded rerank for 500 questions` and `Wrote 500 reranked entries (0 kept as-is) to results/f15_subagent_rerank/opus_top100_reranked.jsonl`. If kept-as-is > 0, some queries did not have a matching rerank output — investigate and re-dispatch.

- [ ] **Step 2: Gate-A validity checks**

```bash
python3 <<'PYG'
import json

with open('results/f14_baseline/turn_bge_s_top100.jsonl') as f:
    f14 = {json.loads(l)['question_id']: json.loads(l) for l in f}

def check(path, name):
    print(f"\n=== Gate-A for {name} ===")
    n_qs = 0
    n_perm_ok = 0
    n_top1_changed = 0
    n_tags_intact = 0
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            n_qs += 1
            qid = r['question_id']
            f14_ids = [m['id'] for m in f14[qid]['retrieved_memories'][:100]]
            f15_ids = [m['id'] for m in r['retrieved_memories']]
            if set(f14_ids) == set(f15_ids) and len(f14_ids) == len(f15_ids):
                n_perm_ok += 1
            if f14_ids[0] != f15_ids[0]:
                n_top1_changed += 1
            f14_by_id = {m['id']: m for m in f14[qid]['retrieved_memories'][:100]}
            tags_ok = all(
                m.get('tags') and m['tags'] == f14_by_id[m['id']]['tags']
                for m in r['retrieved_memories']
            )
            if tags_ok:
                n_tags_intact += 1
    print(f'  queries: {n_qs} (expected 500)')
    print(f'  permutation-invariant: {n_perm_ok}/{n_qs} (need 100%)')
    print(f'  tags intact + match input: {n_tags_intact}/{n_qs} (need 100%)')
    print(f'  top-1 changed vs F14: {n_top1_changed}/{n_qs} (need >= 50%)')
    ok = (n_qs == 500
          and n_perm_ok == n_qs
          and n_tags_intact == n_qs
          and n_top1_changed / n_qs >= 0.50)
    print(f'  Gate-A (dispatch + permutation + tags + top-1): {"PASS" if ok else "FAIL"}')

check('results/f15_subagent_rerank/opus_top100_reranked.jsonl', 'F15 opus rerank')
PYG
```

Expected: Gate-A PASS. Conditions: 500 queries, permutation-invariant for all, tags intact for all, top-1 changed vs F14 baseline for ≥ 50%. If FAIL on permutation or tags, the rerank output has structural issues — surface to the controller before scoring.

The fifth Gate-A condition (dispatch-success, 100/100 batches returning without error) was already verified in Task 5 Step 3.

No commit step — results are gitignored.

---

## Task 7: Score with `evaluate_retrieval.py` (Gate-B)

The binding Gate-B verdict comes from the canonical `evaluate_retrieval.py` script (which matches via three paths: `sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial). The inline Python below is a comparison helper for the cross-track table; if its R@5 ever diverges from `evaluate_retrieval.py`'s R@5, the canonical script's number is binding.

- [ ] **Step 1: Score each reranked variant with the canonical scorer**

```bash
mkdir -p results/f15_subagent_rerank/scores
for f in results/f15_subagent_rerank/*.jsonl; do
  base=$(basename "$f" .jsonl)
  echo "=== canonical Gate-B scoring: $base ==="
  python3 benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval "$f" \
    --data data/lme_s/longmemeval_s_cleaned.json \
    --output "results/f15_subagent_rerank/scores/${base}_score.json" \
    --k-values 1 3 5 10 20 50 100 \
    2>&1 | tee "results/f15_subagent_rerank/scores/${base}_score.txt"
done
```

Expected: each variant emits a `_score.json` with per-K and per-type R@K + a tee'd console log. The `evaluate_retrieval.py` R@5 number is the binding Gate-B input — it is what the result doc and HARD RETRACTION arm decision use.

If `evaluate_retrieval.py` rejects the input format (e.g. `--k-values` flag mismatch), inspect the script's CLI signature with `python3 benchmarks/longmemeval/evaluate_retrieval.py --help` and adjust the flags. Do NOT silently fall back to the inline scorer for the Gate-B verdict.

- [ ] **Step 2: Build the cross-track comparison table from the canonical scores**

```bash
python3 <<'PY'
import json, os

# Load canonical scores
results = {}
for f in sorted(os.listdir('results/f15_subagent_rerank/scores')):
    if not f.endswith('_score.json'): continue
    label = f.replace('_top100_score.json', '').replace('_', '-')
    with open(f'results/f15_subagent_rerank/scores/{f}') as fp:
        results[label] = json.load(fp)

print('| Variant | R@1 | R@3 | R@5 | R@10 | R@20 |')
print('|---|---:|---:|---:|---:|---:|')
print('| F14 baseline (BGE-base only) | 21.6 | 34.4 | 42.0 | 51.8 | 65.6 |')
print('| F14+F9 stack (sub-agent rerank top-20) | 33.6 | 46.8 | 50.8 | 56.2 | 65.2 |')
for label, score in results.items():
    # The exact JSON shape depends on evaluate_retrieval.py's output schema.
    # Inspect one _score.json file first; the shape is roughly
    #   {"recall_at_k": {"1": 0.336, "3": 0.468, ...}}
    # or per-type nested. Adjust the access pattern to match.
    rk = score.get('recall_at_k', score.get('overall', {}))
    def fmt(k):
        v = rk.get(str(k), rk.get(k, None))
        return f'{v*100:.1f}' if isinstance(v, float) else (f'{v:.1f}' if v is not None else '—')
    print(f'| F15 {label} | {fmt(1)} | {fmt(3)} | {fmt(5)} | {fmt(10)} | {fmt(20)} |')
print('| gbrain v0.28.8 hybrid | — | — | 97.60 | — | — |')
print('| F15 Gate-B threshold  | — | — | 97.7 | — | — |')

# Determine best variant + Gate-B verdict from the canonical scores
best_label, best_r5 = None, -1.0
for label, score in results.items():
    rk = score.get('recall_at_k', score.get('overall', {}))
    r5 = rk.get('5', rk.get(5, 0))
    r5 = r5 * 100 if isinstance(r5, float) and r5 <= 1.0 else float(r5 or 0)
    if r5 > best_r5:
        best_r5, best_label = r5, label

print()
print(f'=== Gate-B verdict (canonical evaluate_retrieval.py): {"PASS" if best_r5 >= 97.7 else "FAIL"}')
print(f'    best R@5 = {best_r5:.1f} (variant: {best_label}) vs threshold 97.7')
print(f'    structural ceiling: 86.2 (F14 R@100); Gate-B unreachable from this pool by design')
PY
```

Expected: a comparison table + a Gate-B verdict line that quotes the canonical R@5 (NOT an inline reimplementation). Capture the output and use it verbatim in the F15 result doc.

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
- HARD RETRACTION: delete `data/lme_s/` and `results/f15_subagent_rerank/`.
- Delete ONLY the cross-encoder model weights F15 added, using the manifests captured in Task 4 and Task 6:

```bash
# Compose the exact retraction list from the diff manifests
{
  grep '^>' /tmp/f15_manifests/minilm_added.txt 2>/dev/null
  grep '^>' /tmp/f15_manifests/bge_added.txt 2>/dev/null
} | sed 's/^> //' | sort -u > /tmp/f15_manifests/retraction_list.txt
echo "=== will delete these directories (F15-vendored only) ==="
cat /tmp/f15_manifests/retraction_list.txt
echo "=== will RETAIN all other directories under model-cache (pre-F15) ==="

# Delete only those directories — pre-F15 weights (BGE-base, e5-large,
# MiniLM-L6 from F8) are NOT in the list and are preserved.
xargs rm -rf < /tmp/f15_manifests/retraction_list.txt
```

If `retraction_list.txt` is empty (i.e. neither MiniLM nor bge-reranker was successfully vendored — both 404'd in Task 4), no model-cache cleanup is needed for F15.

- Delete `/tmp/f15_manifests/` once the retraction list is executed (no longer needed; provenance is in the git history of the result doc).
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

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp
```

For FAIL arm:
```bash
rm -rf data/lme_s
rm -rf results/f15_subagent_rerank
# (selective model-cache cleanup — confirm with user before bulk delete)

git add docs/evals/2026-05-12-r5-track8-cross-encoder-result.md
git commit -m "$(cat <<'EOF'
docs(evals): F15 result — cross-encoder rerank, GATE-B FAIL, HARD RETRACTION

F15 swapped F14's F9 sub-agent rerank for a locally-runnable
cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2 + Xenova/bge-reranker-base
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
- results/f15_subagent_rerank/ deleted
- CHANGELOG / README / ROADMAP / RETRACTION canonical docs NOT
  updated. Result doc retained.
- Deployable cross-track best remains F13 + F9 on oracle = 86.8.

Next track per the roadmap: F16 (stronger locally-runnable embedder
on _s) or, conditional on egress, F17 (text-embedding-3-large).

Outside-voice review: PASS_WITH_NOTES (Y/13 checks). Trail in
the result doc Section 12.

This release does not re-assert the retracted −10pp magnitude.

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

This release does not re-assert the retracted −10pp magnitude.

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

3. **Type consistency:** `rerank_cross_encoder.mjs` arg order is `<model_id> <input.jsonl> <output.jsonl> [max_candidates]` everywhere it appears. Output path `results/f15_subagent_rerank/<model_id>_top100.jsonl` consistent across Tasks 6, 7, 10. JSONL schema (`retrieved_memories[].{id, content, tags, score}`) consistent with F14's existing format.

4. **Discipline coverage:** every commit body includes the verbatim retraction line. Magnitude-smuggling grep runs on every doc edit (Tasks 1, 3, 8, 10). HARD RETRACTION arm is fully spelled out (Task 10 Step 1 FAIL branch).

5. **Reversibility check:** every step is recoverable. Cross-encoder model vendoring is the only step that touches a third-party network; if it fails, Task 4 Step 2 spells out the failure-handling path (surface to user). Data re-acquisition (Task 2) is idempotent. Smoke tests (Tasks 4, 5) gate the big run.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-f15-cross-encoder-rerank.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Particularly suited to F15 because Task 4 (feasibility spike) is gating and the spike outcome may rewrite Tasks 6-10's wall-time expectations.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster if the spike clears cleanly, slower if it doesn't.

Which approach?
