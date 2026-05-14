# F16 stronger embedder (multilingual-e5-large chunked-turn on `_s`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BGE-base with `intfloat/multilingual-e5-large` in the F14 chunked-turn pipeline, measure on the LongMemEval `_s` split, and gate at gbrain v0.28.8's R@5 = 97.6 + 0.1 margin (= 97.7). The legitimate experimental question this track answers: does the chunking lever (F13's contribution) amplify the embedder lever for multilingual-e5-large vs BGE-base on `_s`? F12 measured +0.6pp at session-level on oracle; F16 measures at chunked-turn on `_s`.

**Architecture:** Same chunked-turn retrieval pipeline as F14 (`chunk_per_turn_embed.mjs` → `chunk_per_turn_retrieve.mjs` → `evaluate_retrieval.py`) but with `Xenova/multilingual-e5-large` (335M params, 1024-dim, mean pooling, e5 "query: " / "passage: " prefix convention) substituted for `Xenova/bge-base-en-v1.5` (110M params, 768-dim, CLS pooling). Optional second stage: F15-style Opus-4.7 sub-agent rerank dispatched only if the F16 baseline doesn't clear Gate-B (budget optimisation: rerank costs ~$300-500 on Opus credits and ~3 hours wall time, vs ~$0 to skip; the prereg pre-commits to dispatching iff baseline R@5 < 97.7). Both variants tabled in the result regardless of Gate-B outcome; the verdict uses max.

**Tech Stack:** Node 20+ with `@huggingface/transformers` v4 fork (NOT `@xenova/transformers` v2.17 — F12 documented that v2.17 cannot load multilingual-e5-large's ONNX external-data format; the v4 fork is the only working backend in this sandbox). Python 3 for the canonical scorer and rerank-stage merge. fastembed for the model download (only used to ensure the GCS-vendored weights are present on disk — actual inference uses transformers.js per the F12 dispatch pattern). The model weights are already on-disk under `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` from the F12 track (HARD RETRACTION carve-out retained them); this plan re-uses them.

**Predecessor context:** F12 measured `multilingual-e5-large` at session-level granularity on oracle: R@5 = 78.8 with F9 stack (margin +0.6 over BGE-base session-level F11+F9 = 78.2). F13 then showed the chunk-per-turn lever lifted BGE-base from 78.2 → 86.8 R@5 on oracle (+8.6pp). F14 used BGE-base chunked-turn on `_s` and measured R@5 = 42.0, R@100 = 86.2 (Gate-B FAIL, HARD RETRACTION). F15 stacked Opus-4.7 sub-agent rerank on F14's top-100 and reached R@5 = 63.6 (Gate-B FAIL, HARD RETRACTION). F15's mechanism finding: a maximally-equipped LLM-as-reranker closes 48.9% of the within-pool gap; the R@100 = 86.2 ceiling is now the structural bottleneck. F16 attacks that ceiling.

**Pre-flight finding (binding):** F16's original framing was "stronger locally-runnable embedder." Pre-flight on 2026-05-14 enumerated fastembed's GCS-reachable text-embedding catalog: only 6 models are GCS-reachable (HF Hub blocked, all known HF mirrors blocked, fastembed's `rerank/cross_encoder/` has no GCS URLs at all per the F15 finding). Of those 6, only `intfloat/multilingual-e5-large` (1024-dim, 2.24 GB) is structurally stronger than the F14 baseline (`BAAI/bge-base-en-v1.5`, 768-dim, 0.21 GB). `bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, `gte-large` are all HF-only. F16 with `multilingual-e5-large` is therefore the only locally-runnable embedder swap available; the prereg must acknowledge this constraint and frame F16 honestly as a small-headroom experiment (F12's +0.6pp at session-level is the prior).

---

## File structure

Files this plan touches (relative to `/home/user/hippo-memory`):

**Reuse (no edits):**
- `benchmarks/longmemeval/chunk_per_turn_embed.mjs` — already parameterised. Positional args: `argv[2] = MODEL`, `argv[3] = OUT`, `argv[4] = DATA`. Defaults to `Xenova/multilingual-e5-large`. Applies e5 "passage: " prefix automatically and mean-pools per the e5 convention (model-name regex: `IS_E5 = /\be5\b/i.test(MODEL)`). Plan invokes with `node chunk_per_turn_embed.mjs Xenova/multilingual-e5-large benchmarks/longmemeval/data/turn_index_e5_s.json data/lme_s/longmemeval_s_cleaned.json` (positional args). The OUT path has `.jsonl` appended by the script.
- `benchmarks/longmemeval/chunk_per_turn_retrieve.mjs` — already parameterised. Positional args: `argv[2] = INDEX`, `argv[3] = OUT`, `argv[4] = TOP_K`, `argv[5] = DATA`. Applies e5 "query: " prefix, max-pools by `session_id`. Auto-resolves `INDEX + '.jsonl'` if the bare `INDEX` path doesn't end in `.jsonl` but the `.jsonl` sibling exists — so passing `turn_index_e5_s.json` Just Works.
- `benchmarks/longmemeval/rerank_split_v2.py` — used only if F16 baseline FAILs Gate-B. Same invocation as F15: `--batch-size 5 --max-candidates 100 --content-chars 1000`.
- `benchmarks/longmemeval/rerank_merge_v2.py` — used only if rerank stage dispatched.
- `benchmarks/longmemeval/evaluate_retrieval.py` — canonical scorer. Binding for Gate-B verdict.

**Create:**
- `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md` — F16 pre-registration.
- `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md` — F16 result document (filled in after measurement).

**Modify:**
- `ROADMAP-RESEARCH.md` — promote F16 forward bullet from generic to specific pivoted spec.

**Stage (gitignored, do NOT commit):**
- `data/lme_s/` — Sanderhoff-alt mirror copy of `longmemeval_s_cleaned.json`. Re-acquired (was deleted by F15 HARD RETRACTION).
- `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` — F16's chunked-turn index. ~1–2 GB on disk (199,509 turns × 1024-dim float32 + metadata as JSONL records). Note: `chunk_per_turn_embed.mjs` accepts an OUT argument and appends `.jsonl` automatically — passing `turn_index_e5_s.json` produces `turn_index_e5_s.json.jsonl`. Also creates `turn_index_e5_s.json.partial.jsonl` during the build (resume scaffold), removed on successful completion.
- `results/f16_e5_large/` — retrieval JSONL outputs + canonical-score JSON outputs.
- `/tmp/rerank_f16_batches/`, `/tmp/rerank_f16_outputs/` — only if rerank stage dispatched.
- `/tmp/f16_build.log`, `/tmp/f16_retrieve.log` — wall-time + progress logs from Tasks 4–5.

**Already on disk (NOT vendored by this plan, retained from F12 HARD RETRACTION carve-out):**
- `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` — config.json, onnx/, tokenizer files. Confirmed present 2026-05-14.

---

## Task 1: Update ROADMAP-RESEARCH F16 forward bullet to the pivoted spec

**Files:**
- Modify: `ROADMAP-RESEARCH.md`

The F15 commit `2acaf3a` updated F16's framing in the cross-track aggregate but left no dedicated F16 bullet. This task adds one, locking in the pivot to multilingual-e5-large + chunked-turn + `_s` as the binding spec.

- [ ] **Step 1: Read current F16 references in ROADMAP-RESEARCH**

```bash
grep -n "F16\|F17\|F18" ROADMAP-RESEARCH.md
```

Expected: a few mentions in the cross-track aggregate (post-F15) and possibly placeholder bullets in the "Queued" section. Identify where F16's forward bullet should go.

- [ ] **Step 2: Add the F16 forward bullet**

Locate the section listing forward tracks (after the F15 retrospective bullet, before any F17/F18 placeholders). Insert this exact text:

```markdown
- **F16 multilingual-e5-large chunked-turn on `_s`** [next, queued]: pre-flight on 2026-05-14 (post-F15) confirmed `intfloat/multilingual-e5-large` (1024-dim, 2.24 GB, mean pooling, e5 "query: " / "passage: " prefix convention) is the only GCS-reachable embedder structurally stronger than F14's `BAAI/bge-base-en-v1.5`. `bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, `gte-large` are all HF-only and unreachable from this sandbox. F12 measured the same embedder at session-level granularity on oracle: R@5 = 78.8 with F9 stack, +0.6pp over BGE-base session-level (Gate-B FAIL, HARD RETRACTION). F16 attacks the question F12 left open: does the F13 chunking lever (which lifted BGE-base by +8.6pp on oracle) amplify the embedder swap? Configuration: F14 pipeline with e5-large substituted; optional F15-style Opus rerank dispatched only if F16 baseline R@5 < 97.7 (budget optimisation). Gate-B threshold = 97.7 binding. R@100 lift over F14's 86.2 is the secondary mechanism question — if F16 baseline R@100 > 86.2 by ≥ 3 percentage points, the embedder lever materially survives chunked-turn; if ≤ 86.2, the F14 ceiling is structurally embedder-independent at this scale. Plan: `docs/superpowers/plans/2026-05-14-f16-stronger-embedder.md`. Prereg: `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md` (TBD).
```

Use Edit with `old_string` matching the location after F15 and `new_string` inserting the bullet.

- [ ] **Step 3: Run discipline grep on the changed file**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' ROADMAP-RESEARCH.md
```

Expected: exit 1 (no matches). The phrase "+0.6pp over BGE-base" and "+8.6pp on oracle" in the new bullet use Unicode `pp` but with `+` directly preceding the digit; verify the regex's `[0-9]\s*pp\s*(lift|drop|≥|−|\+)` clause does not match because `pp` is preceded by the digit and the qualifier comes AFTER, not before. If the grep does match, rephrase to "delta of 0.6 percentage points" (no pp shorthand near a + or − sign).

- [ ] **Step 4: Commit**

```bash
git add ROADMAP-RESEARCH.md
git commit -m "$(cat <<'EOF'
docs(roadmap): F16 forward bullet — e5-large chunked-turn on _s

Locks in the F16 pivot per the post-F15 pre-flight finding:
multilingual-e5-large is the only GCS-reachable embedder stronger
than F14's BGE-base. F12 (session-level on oracle, +0.6 delta) is the
prior; F16 measures whether F13's chunking lever amplifies the
embedder lever on _s.

Gate-B threshold stays at 97.7 binding (gbrain 97.60 + 0.1 margin).
Secondary mechanism question: does F16 baseline R@100 lift above
F14's 86.2 by >= 3 percentage points? If yes, the embedder lever
survives chunked-turn; if no, the F14 ceiling is structurally
embedder-independent at this scale.

Plan: docs/superpowers/plans/2026-05-14-f16-stronger-embedder.md

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
```

Expected: clean commit, no hook failures.

---

## Task 2: Re-acquire `_s` data (deleted by F15 HARD RETRACTION)

**Files:**
- Stage: `data/lme_s/longmemeval_s_cleaned.json`

The F14/F15 HARD RETRACTION arms deleted `data/lme_s/`. F16 needs it back. Same provenance as F14/F15: the Sanderhoff-alt unaffiliated mirror.

- [ ] **Step 1: Verify the mirror is still reachable and the SHA-256 matches F14/F15**

```bash
mkdir -p data/lme_s
cd data/lme_s
curl -sSLf https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz -o longmemeval_s_cleaned.json.gz
gunzip -t longmemeval_s_cleaned.json.gz && echo "gzip integrity OK"
gunzip longmemeval_s_cleaned.json.gz
sha256sum longmemeval_s_cleaned.json
cd /home/user/hippo-memory
```

Expected SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` (matches F14 and F15 provenance audits). If the SHA differs, STOP — the mirror has changed since F14/F15 and the F16 prereg's provenance clause cannot truthfully claim continuity with prior tracks. Surface to the user before proceeding.

- [ ] **Step 2: Verify question_id overlap with our verified oracle file**

```bash
python3 <<'PY'
import json
with open('data/lme_s/longmemeval_s_cleaned.json') as f:
    s = json.load(f)
with open('data/longmemeval_oracle.json') as f:
    o = json.load(f)
s_qids = {q['question_id'] for q in s}
o_qids = {q['question_id'] for q in o}
print(f's question_ids: {len(s_qids)}')
print(f'oracle question_ids: {len(o_qids)}')
print(f'intersection: {len(s_qids & o_qids)}')
assert s_qids == o_qids, f"qid mismatch: {len(s_qids ^ o_qids)} differ"
print('PASS: 500/500 question_id match')
PY
```

Expected: `500/500 question_id match`. This is the same integrity signal F14 and F15 used; it confirms the mirror file matches the oracle file's question identifiers (necessary but not sufficient — the mirror could in principle have plausible-distractor substitution that we cannot detect without HF access).

- [ ] **Step 3: Confirm gitignore covers `data/lme_s/`**

```bash
grep -nE "^data/lme_s" .gitignore || echo "MISSING from .gitignore"
git check-ignore data/lme_s/longmemeval_s_cleaned.json && echo "gitignored OK"
```

Expected: the file is ignored. If `MISSING` is printed, add `data/lme_s/` to `.gitignore` before any commit (it should already be there from F14/F15 — verify).

- [ ] **Step 4: No commit** — `data/lme_s/` is gitignored data; nothing to commit.

---

## Task 3: Write the F16 prereg

**Files:**
- Create: `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md`

- [ ] **Step 1: Create the prereg file**

Write `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md` with this exact structure (every section is mandatory; copy the template verbatim and fill in only what's bracketed):

```markdown
# LongMemEval R@5 target — Track 9 (F16) multilingual-e5-large chunked-turn on `_s` — pre-registration

**Date:** 2026-05-14
**Predecessors:** F14 baseline (BGE-base chunked-turn `_s`, R@5 = 42.0, R@100 = 86.2, Gate-B FAIL, HARD RETRACTION); F15 Opus rerank stacked on F14's top-100 (R@5 = 63.6, Gate-B FAIL, HARD RETRACTION); F12 multilingual-e5-large session-level oracle (R@5 = 78.8 with F9 stack, +0.6 delta over BGE-base session-level, Gate-B FAIL, HARD RETRACTION); F13 BGE-base chunked-turn oracle (R@5 = 86.8 with F9 stack, Gate-B PASS, v1.9.2 deployable).

**Motivation:** F15 demonstrated that the within-pool ranking gap closes ~50 % under a maximally-equipped LLM-as-reranker on the F14 candidate pool; the residual ~34 percentage-point gap to gbrain's 97.6 is now structurally attributable to the R@100 ceiling (F14's BGE-base places the answer-bearing session inside top-100 only 86.2 % of the time on `_s`). F16 attacks that ceiling by swapping the bi-encoder for the strongest GCS-reachable alternative (`Xenova/multilingual-e5-large`, 1024-dim, mean pooling, e5 prefix convention) while keeping the F13 chunked-turn granularity that lifted BGE-base by 8.6 percentage points on oracle. F12 already measured this embedder at session-level granularity on oracle and saw a 0.6-percentage-point delta — F16 tests whether the chunking lever amplifies that.

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding)

F16 inherits the same data source as F14/F15. The `_s` data used in F16 is re-acquired from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented institutional or provenance link to the LongMemEval authors (xiaowu0162) or to the canonical HF release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`. There is no signed chain-of-custody from HF to this mirror. The only integrity signal available is the 500/500 question_id match with our independently verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`) plus the canonical-schema match — same posture as F14 and F15. F16 introduces no new data source; the candidate pairs scored by the optional Opus rerank stage are drawn from F16's own retrieval output `results/f16_e5_large/turn_e5_s_top100.jsonl`.

## Embedder selection rationale (binding)

Pre-flight on 2026-05-14 enumerated fastembed's text-embedding catalog and confirmed only six models are GCS-reachable from this sandbox (HF Hub blocked, all known HF mirrors blocked, all PyPI alternatives wrap HF as first-line source). Of those six, only `intfloat/multilingual-e5-large` (1024-dim, 2.24 GB) is structurally stronger than the F14 baseline `BAAI/bge-base-en-v1.5` (768-dim, 0.21 GB). `BAAI/bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, `gte-large`, and all reranker-class cross-encoders are HF-only and structurally unreachable from this sandbox. F16 is therefore the only locally-runnable embedder-swap track available for `_s`; further embedder lever experiments are blocked on either (a) HF egress widening, (b) a user-supplied pre-downloaded model tarball, or (c) OpenAI API egress for `text-embedding-3-large` (gbrain's embedder). All three are listed as follow-ups in `ROADMAP-RESEARCH.md`.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked, confirmed 2026-05-11 + 2026-05-12 egress audits). F16 uses `Xenova/multilingual-e5-large` (335M params, 1024-dim, mean pooling, e5 prefix convention; vendored via Qdrant fastembed GCS, weights present on disk from F12's HARD RETRACTION carve-out). gbrain's published gbrain-vector adapter (pure-embedding ablation) scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. **F16 measures multilingual-e5-large chunked-turn + optional Opus rerank on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is matched; the embedder is not.** The chunking lever F13 contributed (and F14/F15 inherited) is preserved here — F16 is a 1-axis swap from F14 (the bi-encoder model), holding all other pipeline knobs constant.

## Goal

Apply F14's chunked-turn retrieval pipeline with multilingual-e5-large substituted for BGE-base. Concretely:

1. Build a chunked-turn index over all 19,195 unique sessions in `_s`, embedding each turn separately with `passage: <content>` and L2-normalising.
2. For each of the 500 queries, embed with `query: <text>`, compute cosine similarity against every turn vector, max-pool by `session_id`, and retain the top-100 sessions per query.
3. Evaluate the resulting retrieval JSONL with `benchmarks/longmemeval/evaluate_retrieval.py` (the canonical scorer; same invocation as F14/F15).
4. **Contingent second stage:** if F16 baseline R@5 ≥ 97.7, the Gate-B verdict is PASS and the rerank stage is skipped. If F16 baseline R@5 < 97.7, dispatch a F15-style Opus-4.7 sub-agent rerank over F16's top-100 (same parameters: 100 batches × 5 queries × 100 candidates × 1000-char content × structured rubric prompt). Re-score with the canonical scorer. Gate-B verdict uses the max of {F16 baseline R@5, F16 + Opus rerank R@5}.

Both variants (or just the baseline if rerank is skipped) are tabled in the result document regardless of Gate-B outcome.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F16 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After building the index and running retrieval:

- **Model load:** the multilingual-e5-large weights load from `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` (the F12 HARD RETRACTION carve-out cache). Rejects silent HF-fallback that would fail mid-run.
- **Index shape:** the chunked-turn index has 199,509 ± 100 turn vectors (matches F14's BGE-base index turn count to within 0.1 %, confirming the chunking pass is deterministic across embedders), each at dimension 1024 (e5-large native), with L2-norms in [0.9999, 1.0001] for ≥ 99 % of vectors. Rejects accidental session-level fallback, dimension mismatch, and unnormalised-vector bugs.
- **Retrieval completeness:** all 500 questions have a retrieval result with exactly 100 candidate sessions each. Rejects silent truncation or skipped queries.
- **Tags passthrough:** every retrieved candidate's `tags` field is non-empty and contains the session_id. Without this, a tags-stripping bug would silently zero out Gate-B hits (the canonical scorer `evaluate_retrieval.py:check_session_hit` matches via three paths; two of those three require the `tags` field).
- **Top-1 different from F14 BGE-base:** for at least 30 % of the 500 queries, F16's top-1 session_id differs from F14's top-1. Rejects a no-op embedder swap where the new embedder produces the same ranking as BGE-base. The 30 % threshold is lower than F15's 50 % because the embedder lever is structurally smaller than the LLM-rerank lever — F12 saw only +0.6pp at session-level, so a low top-1-change rate is plausible even for a successful swap.

PASS = all five conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

F16's best variant — defined as max(R@5) across (a) F16 baseline (e5-large chunked-turn alone) and (b) F16 + Opus rerank (only if (a) does not already clear Gate-B) — measured by `evaluate_retrieval.py` against the Sanderhoff-alt mirror of `longmemeval_s_cleaned.json`, must satisfy:

**R@5 ≥ 97.7 %** on `_s`.

The 97.7 threshold is gbrain v0.28.8's published 97.60 % R@5 on `_s` plus a 0.1 % margin. The Gate-B verdict binds on the canonical scorer; if any inline scorer diverges, the canonical script's number is binding.

PASS = F16 best variant `recall@5 ≥ 0.977` → conventional release update (CHANGELOG / README / ROADMAP / RETRACTION canonical docs updated to cite F16 numbers).
**FAIL** = F16 best variant `recall@5 < 0.977` → **HARD RETRACTION** (see below).

#### Structural ceiling (acknowledged)

F14's R@100 on `_s` = 86.2. If F16's R@100 turns out to be ≤ 86.2, then F16 has not lifted the embedder ceiling and Gate-B is structurally still 86.2 < 97.7 ⇒ unreachable. If F16's R@100 lifts to, say, 92, the structural ceiling moves to 92 — still < 97.7. **A R@100 lift from 86.2 to any value strictly below 97.7 does NOT change the Gate-B verdict; the 97.7 threshold is immovable.** To clear Gate-B from this sandbox with a 1-axis embedder swap alone, F16's R@100 would need to reach ≥ 97.7 in the baseline (since rerank only re-orders within the pool, the post-rerank R@5 is bounded above by the pre-rerank R@100). MTEB Retrieval delta from BGE-base-en-v1.5 to multilingual-e5-large is ~0–2 percentage points on standard benchmarks; LongMemEval `_s` is non-standard (mostly user-generated chat content, 48 distractors per haystack) so the delta could in principle be larger or smaller, but the prior is small. **F16's Gate-B FAIL is the expected outcome per this prereg.**

The legitimate value F16 delivers is mechanism characterisation: measuring (a) whether the chunking lever amplifies the embedder swap (F16 R@100 vs F14 R@100), and (b) whether F16 + Opus rerank materially closes the gap further (F16+Opus R@5 vs F15 R@5). **Important comparability caveat for mechanism finding (a):** F12 measured `multilingual-e5-large` at session-level granularity on the *oracle* split, observing a 0.6-percentage-point R@5 delta over BGE-base. F16 measures the same embedder at chunked-turn granularity on the `_s` split. The two configurations differ on TWO axes (split and granularity); the F12 vs F16 delta comparison is therefore directional, not strictly apples-to-apples.

**F16 is a single-configuration track**, not a sweep across embedder variants. The pre-flight ruled out `bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, and `gte-large` (all HF-only), leaving exactly one GCS-reachable stronger embedder to test. The result doc must not imply an ablation space was considered and rejected; the constraint is purely a sandbox-reachability artefact.

The path to actually clearing Gate-B from this sandbox is blocked on either HF egress widening (enabling `bge-large-en-v1.5` or `mxbai-embed-large-v1`), a user-supplied pre-downloaded model tarball, or OpenAI API egress for `text-embedding-3-large`. All three are queued in `ROADMAP-RESEARCH.md`. **F16 is therefore the last locally-executable embedder-swap track on `_s` until at least one of those three sandbox constraints relaxes.**

## HARD RETRACTION arm (binding)

On Gate-B FAIL, the following actions are executed in full:

1. `data/lme_s/` deleted from disk (entire directory; gitignored data artefact).
2. `results/f16_e5_large/` deleted from disk (all F16 output files).
3. `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` and `benchmarks/longmemeval/data/turn_index_e5_s.json.partial.jsonl` deleted (the ~1–2 GB F16 chunked-turn index and any partial-build scaffold; both gitignored).
4. `/tmp/rerank_f16_batches/`, `/tmp/rerank_f16_outputs/`, `/tmp/f16_build.log`, `/tmp/f16_retrieve.log` deleted (rerank dirs only if the rerank stage was dispatched; otherwise no-op).
5. `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` is **retained**, NOT deleted. These weights pre-date F16 (vendored by F12 in commit history pre-dating this plan) and were preserved by the F12 HARD RETRACTION carve-out. They are not newly downloaded by F16.
6. CHANGELOG / README / ROADMAP / RETRACTION canonical docs are NOT updated to cite F16 numbers.

The F16 result doc is retained as a negative-result audit trail regardless of Gate-B outcome.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F16 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F16 introduces (i) a staged `results/f16_e5_large/` directory (gitignored), (ii) a chunked-turn index `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` (gitignored, ~1–2 GB), (iii) F16 prereg + result docs. F16 reuses F14's `chunk_per_turn_embed.mjs` + `chunk_per_turn_retrieve.mjs` (already parameterised for both bge and e5 model families per F13's original design); no `src/` changes. The mechanism-null framing is unaffected.
```

- [ ] **Step 2: Discipline grep + retraction-sentence check**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md
echo "exit: $?  (1 = clean)"
grep -nF "This release does not re-assert the retracted −10pp magnitude." docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md
grep -nF "RETRACTION.md:94-113" docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md
```

Expected: discipline grep exits 1 (no matches); retraction sentence appears on its own line (count ≥ 1); cumulative-null cite present.

If the discipline grep matches, find the offending substring and rephrase. Common offenders: "+0.6pp" or "−1pp" with sign-adjacent-to-digit-and-pp. Rephrase to "0.6-percentage-point delta" or similar.

- [ ] **Step 3: Outside-voice review (optional but recommended for the prereg)**

Dispatch an isolated-context Sonnet sub-agent to review the prereg against `docs/evals/2026-05-12-r5-track7-s-split-prereg.md` (F14, the most similar precedent) and `docs/RETRACTION.md`. Use the same review template as F14 used. Skip if budget-constrained — the F14 prereg pattern is well-established and F16 is a near-identical 1-axis variant.

- [ ] **Step 4: Commit + push**

```bash
git add docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md
git commit -m "$(cat <<'EOF'
docs(evals): F16 prereg — multilingual-e5-large chunked-turn on _s

The only GCS-reachable embedder structurally stronger than F14's
BGE-base is intfloat/multilingual-e5-large (verified by enumerating
fastembed's catalog: 6 models GCS-reachable, only e5-large beats
bge-base on parameter count and dimension).

F16 swaps the embedder, keeps F14's chunked-turn pipeline + F13's
max-pool aggregation. Optional F15-style Opus rerank dispatched
contingently iff baseline does not clear Gate-B (budget
optimisation; Gate-B uses max of {baseline, baseline+rerank}).

Gate-B = R@5 >= 97.7 (gbrain 97.60 + 0.1 margin), binding, HARD
RETRACTION on FAIL. Structural ceiling acknowledged: F14 R@100 =
86.2; F16 needs R@100 >= 97.7 in baseline OR rerank to close
within-pool ranking gap to clear Gate-B. MTEB delta from bge-base
to e5-large is ~0-2 percentage points on standard benchmarks; F12
saw 0.6-pp delta at session-level on oracle. Gate-B FAIL is the
expected outcome.

HARD RETRACTION arm retains model-cache (weights pre-date F16,
preserved from F12 carve-out); deletes data + retrieval index +
results + ephemeral /tmp scaffolding.

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp 2>&1 | tail -3
```

Expected: clean commit + push.

---

## Task 4: Build the F16 chunked-turn index

**Files:**
- Stage: `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` (~1–2 GB; gitignored). The embed script's OUT arg is `turn_index_e5_s.json` but `.jsonl` is appended automatically; the on-disk filename is `turn_index_e5_s.json.jsonl`.

The `chunk_per_turn_embed.mjs` script is already parameterised. F16's invocation differs from F14's only in the `--model` and `--out` arguments (and the implicit pooling/prefix logic, which the script handles automatically based on the model name).

- [ ] **Step 1: Pre-flight — confirm e5-large weights are on-disk and load**

```bash
export HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache
ls -la "${HIPPO_MODEL_CACHE}/Xenova/multilingual-e5-large/"
ls -la "${HIPPO_MODEL_CACHE}/Xenova/multilingual-e5-large/onnx/" 2>/dev/null | head -5
node -e "
import('@huggingface/transformers').then(async ({ pipeline, env }) => {
  env.cacheDir = process.env.HIPPO_MODEL_CACHE;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-large', { pooling: 'mean', normalize: true });
  const v = await pipe('passage: hello world');
  const vec = v.data;
  const norm = Math.sqrt(vec.reduce((s, x) => s + x*x, 0));
  console.log('dim=', vec.length, 'norm=', norm.toFixed(6));
}).catch(e => { console.error('LOAD FAIL:', e.message); process.exit(1); });
"
```

Expected: `dim= 1024 norm= 1.000000` (or close to 1.0 ± 1e-5). If `LOAD FAIL: ...` appears, the v4 fork of `@huggingface/transformers` is not installed or the cache path is wrong. Verify `node_modules/@huggingface/transformers/package.json` shows a v4 version (NOT v2.17), per F12's documented constraint that v2.17 cannot load multilingual-e5-large's ONNX external-data format.

- [ ] **Step 2: Build the chunked-turn index**

```bash
export HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache
node benchmarks/longmemeval/chunk_per_turn_embed.mjs \
  Xenova/multilingual-e5-large \
  benchmarks/longmemeval/data/turn_index_e5_s.json \
  data/lme_s/longmemeval_s_cleaned.json \
  2>&1 | tee /tmp/f16_build.log
```

Expected stderr: progress logs every few hundred turns, ending with something like `Wrote N turns (1024-dim) to benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl`. Wall time: ~4–6 hours on the 4-core CPU (e5-large is heavier than BGE-base; F14's BGE-base on `_s` took roughly 5 hours per the F14 result doc, so e5-large is likely 5–8 hours — the 4–6 hour estimate is a lower bound; budget for up to 8). Run in a long-lived terminal or via `nohup`/`screen` if disconnect risk is high.

If the build dies partway, the script supports resuming — re-run the same command; it skips already-embedded (session_id, turn_idx) pairs (verify in the script source if uncertain).

- [ ] **Step 3: Verify the index**

Note: the actual file is `turn_index_e5_s.json.jsonl` (the embed script appends `.jsonl` to the OUT argument), one JSON record per line.

```bash
ls -lh benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl
python3 <<'PY'
import json, math
path = 'benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl'
header = None
turns = []
norms_sample = []
sids = set()
with open(path) as f:
    for i, line in enumerate(f):
        rec = json.loads(line)
        if i == 0 and 'model' in rec and 'turns' not in rec:
            # First record is a header (model/dim metadata)
            header = rec
            continue
        turns.append(1)  # count only
        sids.add(rec.get('session_id'))
        if len(norms_sample) < 20:
            v = rec.get('vec')
            if v:
                norms_sample.append(math.sqrt(sum(x*x for x in v)))
print(f"header: {header}")
print(f"turn records: {len(turns)}")
print(f"unique session_ids: {len(sids)}")
print(f"sample L2-norms (first 20): {[f'{n:.4f}' for n in norms_sample[:5]]} ... (min={min(norms_sample):.4f}, max={max(norms_sample):.4f})")
PY
```

Expected: `header` has `"model": "Xenova/multilingual-e5-large"` and `"dim": 1024`. `turn records` close to 199,509 (matching F14's BGE-base turn count to within 0.1 %). All sample L2-norms ≈ 1.0 (within ±1e-4). `unique session_ids: 19195`.

If `turns` is materially off from 199,509, investigate before proceeding — the chunking pass should be embedder-independent.

- [ ] **Step 4: No commit** — the index is gitignored at ~1–2 GB.

---

## Task 5: Run F16 baseline retrieval (top-100 per query)

**Files:**
- Stage: `results/f16_e5_large/turn_e5_s_top100.jsonl` (gitignored)

- [ ] **Step 1: Run retrieval**

```bash
mkdir -p results/f16_e5_large
export HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache
node benchmarks/longmemeval/chunk_per_turn_retrieve.mjs \
  benchmarks/longmemeval/data/turn_index_e5_s.json \
  results/f16_e5_large/turn_e5_s_top100.jsonl \
  100 \
  data/lme_s/longmemeval_s_cleaned.json \
  2>&1 | tee /tmp/f16_retrieve.log
```

Expected: progress every ~50 queries; final line `Wrote 500 queries to results/f16_e5_large/turn_e5_s_top100.jsonl`. Wall time: ~30–60 minutes (query embedding is 500 invocations of e5-large + a 1024-dim dense cosine over ~199k turn vectors per query; the latter dominates).

- [ ] **Step 2: Verify retrieval shape**

```bash
ls -lh results/f16_e5_large/turn_e5_s_top100.jsonl
wc -l results/f16_e5_large/turn_e5_s_top100.jsonl
python3 <<'PY'
import json
with open('results/f16_e5_large/turn_e5_s_top100.jsonl') as f:
    first = json.loads(f.readline())
print(f"keys: {sorted(first.keys())}")
mems = first.get('retrieved_memories', [])
print(f"n_memories: {len(mems)}")
if mems:
    print(f"sample memory keys: {sorted(mems[0].keys())}")
    print(f"sample tags: {mems[0].get('tags')}")
PY
```

Expected: `500 lines`, each with `retrieved_memories` of length 100, each memory has `id`, `score`, `content`, `tokens`, `tags`, `strength`-or-equivalent fields, and `tags` is non-empty containing the session_id. File size ~25–30 MB.

- [ ] **Step 3: No commit** — `results/` is gitignored.

---

## Task 6: Gate-A validity + canonical scorer on F16 baseline

**Files:**
- Stage: `results/f16_e5_large/scores/baseline_score.json` (gitignored)

- [ ] **Step 1: Gate-A validity checks**

```bash
python3 <<'PY'
import json, math

# Load F14 BGE-base for top-1 comparison
f14 = {}
with open('results/f14_baseline/turn_bge_s_top100.jsonl') as f:
    for line in f:
        r = json.loads(line)
        f14[r['question_id']] = r['retrieved_memories'][0]['id']

print("=== Gate-A for F16 baseline ===")
n_qs = 0
n_complete = 0
n_tags_ok = 0
n_top1_changed = 0
with open('results/f16_e5_large/turn_e5_s_top100.jsonl') as f:
    for line in f:
        r = json.loads(line)
        n_qs += 1
        mems = r.get('retrieved_memories', [])
        if len(mems) == 100:
            n_complete += 1
        if all(m.get('tags') for m in mems):
            n_tags_ok += 1
        qid = r['question_id']
        if qid in f14 and mems and mems[0]['id'] != f14[qid]:
            n_top1_changed += 1
print(f"  queries: {n_qs} (expect 500)")
print(f"  top-100 complete: {n_complete}/{n_qs}")
print(f"  tags non-empty: {n_tags_ok}/{n_qs}")
print(f"  top-1 changed vs F14 BGE-base: {n_top1_changed}/{n_qs} ({100*n_top1_changed/n_qs:.1f}%)")
# Note: model-load + index-shape are verified in Task 4 Step 3; this script
# checks the four remaining Gate-A conditions.
ok = (n_qs == 500
      and n_complete == n_qs
      and n_tags_ok == n_qs
      and n_top1_changed / n_qs >= 0.30)
print(f"  Gate-A (retrieval-completeness + tags + top-1-changed >= 30%): {'PASS' if ok else 'FAIL'}")
PY
```

Expected: 500 queries, 500/500 complete, 500/500 tags-non-empty, top-1-changed ≥ 150/500 (= 30 %), Gate-A PASS. If Gate-A FAIL on any condition, **STOP** — fix and re-run. Common failure modes:

- `top-100 complete < 500`: the retrieve script truncated at fewer than 100 sessions for some queries, likely because a session has fewer than 1 unique turn. Investigate that query.
- `tags non-empty < 500`: retrieve-script bug stripping `tags`; check `chunk_per_turn_retrieve.mjs:writeRetrievalResult`.
- `top-1-changed < 30 %`: the embedder swap is materially ineffective at producing different rankings — the new embedder is producing near-identical top-1 sessions to BGE-base. If this happens, surface to the controller before scoring — the experiment's premise is undermined.

- [ ] **Step 2: Canonical scorer**

```bash
mkdir -p results/f16_e5_large/scores
python3 benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval results/f16_e5_large/turn_e5_s_top100.jsonl \
    --data data/lme_s/longmemeval_s_cleaned.json \
    --output results/f16_e5_large/scores/baseline_score.json 2>&1 | tee results/f16_e5_large/scores/baseline_score.txt
```

Expected output: per-K breakdown (R@1, R@3, R@5, R@10, R@100) and per-question-type breakdown for n=500. Record the R@5 number — this is the F16 baseline Gate-B verdict candidate.

- [ ] **Step 3: Decision point**

```bash
python3 -c "
import json
d = json.load(open('results/f16_e5_large/scores/baseline_score.json'))
r5 = d['overall']['recall@5']
r100 = d['overall'].get('recall@100', None)
print(f'F16 baseline R@5 = {r5*100:.1f}%')
if r100 is not None:
    print(f'F16 baseline R@100 = {r100*100:.1f}%')
print(f'Gate-B threshold = 97.7%')
print(f'F14 R@100 = 86.2% (reference)')
if r5 >= 0.977:
    print('-> Gate-B PASS on baseline alone; skip rerank stage')
else:
    print(f'-> Gate-B FAIL on baseline ({r5*100:.1f} < 97.7); proceed to rerank stage (Task 7)')
"
```

If Gate-B PASS, skip Task 7 and Task 8 and proceed to Task 9 with the baseline-only result. If Gate-B FAIL, proceed to Task 7.

- [ ] **Step 4: No commit** — results are gitignored.

---

## Task 7: Optional Opus rerank stage (only if Task 6 says Gate-B FAIL)

**Files:**
- Stage: `/tmp/rerank_f16_batches/batch_NNN.json` × 100
- Stage: `/tmp/rerank_f16_outputs/batch_NNN.json` × 100
- Stage: `results/f16_e5_large/opus_top100_reranked.jsonl` (gitignored)

This stage replicates the F15 rerank workflow exactly, but on F16's top-100 instead of F14's. **Skip this entire task if F16 baseline already cleared Gate-B in Task 6 Step 3.**

Cost note: F15 measured ~2 h 15 min wall time at 10× parallel dispatch over 100 batches. Dollar cost is not directly anchored to a prior F-track measurement (F15's result doc logged timing but not dollar cost); a ~$300–500 Opus 4.7 envelope is a forward estimate based on F15's input+output token volume × Opus 4.7 pricing, not a measured F-track figure.

- [ ] **Step 1: Generate rerank batches**

```bash
rm -rf /tmp/rerank_f16_batches
mkdir -p /tmp/rerank_f16_batches
python3 benchmarks/longmemeval/rerank_split_v2.py \
    --retrieval results/f16_e5_large/turn_e5_s_top100.jsonl \
    --out-dir /tmp/rerank_f16_batches \
    --batch-size 5 \
    --max-candidates 100 \
    --content-chars 1000 2>&1
ls /tmp/rerank_f16_batches/ | wc -l
```

Expected: 100 batch files (5 queries × 100 candidates × 1000 chars each).

- [ ] **Step 2: Dispatch 100 Opus-4.7 sub-agents (10 parallel per wave, 10 waves total)**

This step runs in the controller (the orchestrating Claude session). For each batch NNN (000..099), dispatch an `Agent` call with `subagent_type=general-purpose`, `model=opus`, `run_in_background=true`, and the F15 rerank prompt (verbatim copy from F15's plan Task 5 Step 1).

The prompt template (substitute `<BATCH_NUM>` per dispatch):

```
You are a relevance-judgment reranker for the LongMemEval long-conversation retrieval benchmark.

# Critical methodology constraint

This is a **direct LLM judgment task**. Read each candidate yourself and judge its relevance using your own reading comprehension. **Forbidden:** writing Python or any scripting to "automate" the scoring; using Bash to grep / regex / word-overlap as a scoring proxy; computing scores via lexical similarity or algorithmic shortcuts. F15/F16 measure what Opus-4.7 as a *reading* reranker can do.

# The task

5 questions, 100 candidate turns each. Rank candidates per question by likelihood of indicating the answer-bearing session.

Load `/tmp/rerank_f16_batches/batch_<BATCH_NUM>.json`. Structure: `[{"question_id", "question", "candidates": [{"id", "content"}, ...100...]}, ...5...]`.

For each (query, candidate), read the content and score on three 0-3 scales:
1. **TOPICAL_MATCH**: 0=unrelated; 1=same domain; 2=same topic; 3=identical claim space.
2. **EVIDENCE_SPECIFICITY**: 0=vague; 1=mentions topic; 2=partial; 3=explicit statement of the fact.
3. **RECENCY_OF_CLAIM**: for current-state questions, prefer current/canonical. 0=superseded; 1=unclear; 2=current-ish; 3=current.

total = sum. Rank by total desc; tie-break: topical desc, evidence desc, input-order.

# Output

Write `/tmp/rerank_f16_outputs/batch_<BATCH_NUM>.json`:
[{"question_id": "...", "ranked_ids": ["id1",...,"id100"], "scores": [{"id": "id1", "topical": 3, "evidence": 3, "recency": 2, "total": 8}, ...100...]}, ...5...]

Constraints: 5 entries; each `ranked_ids` is permutation of 100 input ids; each `scores` has 100 entries; all integer scores 0-3.

When done: "PASS: wrote 5 entries with full scoring tables" or "PARTIAL: ..." with details.
```

Dispatch pattern: 10 parallel `Agent` tool calls per message, 10 messages total to cover batches 000-099. Wait for each wave's completion notifications before dispatching the next; redispatch any that error out (F15 had 1 streaming-timeout retry on batch 035).

- [ ] **Step 3: Verify all 100 outputs present**

```bash
ls /tmp/rerank_f16_outputs/batch_*.json | wc -l
python3 <<'PY'
import json, os
files = sorted([f for f in os.listdir('/tmp/rerank_f16_outputs/') if f.startswith('batch_') and f.endswith('.json')])
expected = set(f'batch_{i:03d}.json' for i in range(100))
present = set(files)
missing = expected - present
print(f'files: {len(files)} (expect 100)')
print(f'missing: {sorted(missing)}')
total_qs = 0
for f in files:
    d = json.loads(open(f'/tmp/rerank_f16_outputs/{f}').read())
    total_qs += len(d)
print(f'total queries: {total_qs} (expect 500)')
PY
```

Expected: 100 files, 500 queries total, no missing. If any missing, redispatch only the missing batches.

- [ ] **Step 4: Merge**

```bash
python3 benchmarks/longmemeval/rerank_merge_v2.py \
    --retrieval results/f16_e5_large/turn_e5_s_top100.jsonl \
    --ranks-dir /tmp/rerank_f16_outputs \
    --out results/f16_e5_large/opus_top100_reranked.jsonl
```

Expected: `Wrote 500 reranked entries (0 kept as-is)` — same merge invariant as F15.

- [ ] **Step 5: Gate-A on the merged rerank output** (identical to F15's Task 6 Step 2; same script)

```bash
python3 <<'PYG'
import json
with open('results/f16_e5_large/turn_e5_s_top100.jsonl') as f:
    f16 = {json.loads(l)['question_id']: json.loads(l) for l in f}

print("=== Gate-A for F16 + Opus rerank ===")
n_qs = 0; n_perm_ok = 0; n_top1_changed = 0; n_tags_intact = 0
with open('results/f16_e5_large/opus_top100_reranked.jsonl') as f:
    for line in f:
        r = json.loads(line)
        n_qs += 1
        qid = r['question_id']
        f16_ids = [m['id'] for m in f16[qid]['retrieved_memories'][:100]]
        f16r_ids = [m['id'] for m in r['retrieved_memories']]
        if set(f16_ids) == set(f16r_ids) and len(f16_ids) == len(f16r_ids):
            n_perm_ok += 1
        if f16_ids[0] != f16r_ids[0]:
            n_top1_changed += 1
        f16_by_id = {m['id']: m for m in f16[qid]['retrieved_memories'][:100]}
        tags_ok = all(m.get('tags') and m['tags'] == f16_by_id[m['id']]['tags'] for m in r['retrieved_memories'])
        if tags_ok:
            n_tags_intact += 1
print(f'  queries: {n_qs} (expected 500)')
print(f'  permutation-invariant: {n_perm_ok}/{n_qs}')
print(f'  tags intact + match input: {n_tags_intact}/{n_qs}')
print(f'  top-1 changed vs F16 baseline: {n_top1_changed}/{n_qs}')
ok = (n_qs == 500 and n_perm_ok == n_qs and n_tags_intact == n_qs and n_top1_changed / n_qs >= 0.50)
print(f'  Gate-A (post-rerank): {"PASS" if ok else "FAIL"}')
PYG
```

Expected: all four conditions PASS — 500 queries, 500/500 permutation-invariant, 500/500 tags intact, ≥ 250 top-1 changed vs F16 baseline (50 % threshold, same as F15 used).

- [ ] **Step 6: No commit** — results gitignored.

---

## Task 8: Canonical scorer on F16+rerank (only if Task 7 ran), final Gate-B verdict

**Files:**
- Stage: `results/f16_e5_large/scores/opus_score.json` (gitignored, only if Task 7 ran)

- [ ] **Step 1: Score F16+rerank**

```bash
python3 benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval results/f16_e5_large/opus_top100_reranked.jsonl \
    --data data/lme_s/longmemeval_s_cleaned.json \
    --output results/f16_e5_large/scores/opus_score.json 2>&1 | tee results/f16_e5_large/scores/opus_score.txt
```

Expected: per-K and per-type breakdown.

- [ ] **Step 2: Compute final Gate-B verdict**

```bash
python3 <<'PY'
import json, os
b = json.load(open('results/f16_e5_large/scores/baseline_score.json'))
b_r5 = b['overall']['recall@5']
if os.path.exists('results/f16_e5_large/scores/opus_score.json'):
    o = json.load(open('results/f16_e5_large/scores/opus_score.json'))
    o_r5 = o['overall']['recall@5']
else:
    o_r5 = None
best = max(b_r5, o_r5 or 0)
print(f'F16 baseline R@5 = {b_r5*100:.1f}%')
print(f'F16 + Opus R@5 = {o_r5*100:.1f}%' if o_r5 is not None else 'F16 + Opus: not run (baseline already PASS)')
print(f'F16 best variant R@5 = {best*100:.1f}%')
print(f'Gate-B threshold = 97.7%')
print(f'Gate-B verdict: {"PASS" if best >= 0.977 else f"FAIL (shortfall {(0.977-best)*100:.1f}pp)"}')
PY
```

Record the final verdict for the result doc.

- [ ] **Step 3: No commit** — results gitignored.

---

## Task 9: Write the F16 result doc

**Files:**
- Create: `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md`

- [ ] **Step 1: Write the result doc**

Use the F15 result doc as the structural template (`docs/evals/2026-05-12-r5-track8-subagent-rerank-result.md`). Mandatory sections:

1. **Header** with date, prereg link, predecessor cites, verbatim retraction sentence on its own line.
2. **Provenance disclosure (binding, inherited from F14)** — Sanderhoff-alt mirror SHA-256, no-HF-chain caveat, conditional-on-mirror-integrity framing.
3. **Embedder mismatch with gbrain (binding)** — name the model swap explicitly.
4. **Pre-flight finding (binding)** — only 1 GCS-reachable stronger embedder; explain the constraint that bounded F16's scope.
5. **TL;DR** — Gate-A verdict, Gate-B verdict (PASS/FAIL with arithmetic), structural-ceiling lift status (did F16's R@100 exceed F14's 86.2 by ≥ 3pp?), brief mechanism finding.
6. **Gate-A — workload validity** — table of 5 conditions × observed × verdict, identical shape to F15.
7. **Gate-B — proven value at R@5** — verdict + arithmetic. If FAIL, cite the structural-ceiling clause of the prereg.
8. **Per-K table** — F14 baseline, F14+F9 stack, F15 Opus, F16 baseline, F16+rerank (if run), F14 R@100 ceiling reference, F16 R@100 (the new ceiling), gbrain 97.60.
9. **Per-type breakdown at R@5** — same 6 question_types as F14/F15, with F16 column(s) added.
10. **Cross-track summary at R@5** — append F16 rows to the F15 table.
11. **Methodology caveats (binding)** — disclose any sub-agent shortcuts observed (if rerank ran), any retries (streaming timeouts), the e5-large external-data ONNX dispatch path.
12. **HARD RETRACTION arm (executing per prereg)** — list the 6 actions from the prereg verbatim with the actual sizes-on-disk filled in.
13. **Cumulative-null acknowledgement** — `docs/RETRACTION.md:94-113` cite, mechanism-null framing.
14. **Outside-voice review trail** — placeholder, filled by Task 10.

**Key data points to populate (from Tasks 6-8 measurements):**

| Field | Source |
|---|---|
| F16 baseline R@K table | `results/f16_e5_large/scores/baseline_score.json` |
| F16 baseline per-type | same file, `per_type` section |
| F16+rerank R@K table | `results/f16_e5_large/scores/opus_score.json` (if exists) |
| F16 R@100 ceiling | baseline_score.json `recall@100` |
| F16 chunked-turn index turn count | `wc` on the index or the build log |
| F16 build wall time | `/tmp/f16_build.log` final timing line |
| F16 baseline retrieval wall time | `/tmp/f16_retrieve.log` final timing line |
| (if rerank ran) batch durations | sub-agent completion notifications |
| disk usage of artefacts to be deleted | `du -sh` on each path |

**Mechanism finding framing (key — the legitimate value F16 produces):**

The result doc must compute and report two ratios:

(a) **Embedder-swap survival ratio:** `(F16_R5 - F14_R5) / (F12_session_R5 - F11_session_R5)` — does the chunking lever amplify, neutralise, or invert the F12 session-level delta? F12 saw +0.6 percentage-point delta at session-level on oracle (78.8 - 78.2). If F16 baseline minus F14 baseline > 0.6pp, the chunking lever amplifies; if = 0.6pp, neutral; if < 0.6pp, the chunking lever consumes most of the e5-large headroom.

(b) **R@100 ceiling lift:** `F16_R100 - F14_R100 = F16_R100 - 86.2`. If ≥ +3pp, the embedder lever materially survived at chunked-turn (the prereg's success threshold). If < +3pp, the F14 ceiling is structurally embedder-independent at this scale (within the GCS-reachable embedder set).

Both numbers go in the TL;DR.

- [ ] **Step 2: Discipline + retraction grep**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md
echo "exit: $? (1 = clean)"
grep -nF "This release does not re-assert the retracted −10pp magnitude." docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md
grep -nF "RETRACTION.md:94-113" docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md
```

Expected: discipline grep exits 1; retraction sentence present on its own line; cumulative-null cite present.

- [ ] **Step 3: No commit yet** — outside-voice review first.

---

## Task 10: Outside-voice review

**Files:**
- Modify: `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md` (review trail section)

- [ ] **Step 1: Dispatch the review**

Use the F15 review prompt as the template (`docs/evals/2026-05-12-r5-track8-subagent-rerank-result.md` outside-voice review section). Adjust the checks for F16:

- 13 checks: verbatim retraction sentence (with U+2212 minus); provenance disclosure; embedder mismatch; pre-flight finding disclosure; Gate-A 5 conditions; Gate-B arithmetic; per-K table consistency (numbers match JSON); per-type table consistency (n sums to 500, F16 ≥ F14 in most rows); cross-track table consistency; HARD RETRACTION arm fully specified (6 actions, including the model-cache *retention* carve-out); cumulative-null cite; magnitude-smuggling grep returns 0; methodology caveat honest.
- Reviewer must spot-check 3–5 numbers from the result doc against `results/f16_e5_large/scores/baseline_score.json` and `opus_score.json` (if exists).
- Reviewer must verify the "embedder-swap survival ratio" and "R@100 ceiling lift" computations are arithmetically correct.

Dispatch via `Agent` with `subagent_type=general-purpose`, `model=sonnet`, fresh context (the reviewer must not have any F-track history in their session).

- [ ] **Step 2: Apply any required fixes**

If the reviewer returns FAIL or PASS_WITH_NOTES with required fixes, apply them inline to the result doc.

- [ ] **Step 3: Fill the review trail section**

Append the reviewer's per-check summary verbatim under `## Outside-voice review trail`, matching the F15 result doc's review section shape.

- [ ] **Step 4: Final discipline grep**

```bash
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md
echo "exit: $? (1 = clean)"
```

Expected: exit 1. If the review trail introduced a violation (rare — reviewer summaries occasionally use shorthand), fix it.

---

## Task 11: Commit + push + execute Gate-B arm

**Files:**
- Modify: `ROADMAP-RESEARCH.md` (F16 status: queued → shipped)
- Modify (conditional on Gate-B PASS): `CHANGELOG.md`, `README.md`, `docs/RETRACTION.md` — only if F16 actually clears 97.7.

- [ ] **Step 1: Commit the result doc**

```bash
git add docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-result.md
git commit -m "$(cat <<'EOF'
docs(evals): F16 result — e5-large chunked-turn on _s, Gate-B [PASS|FAIL]

[Fill in commit body with F16 numbers, mechanism findings, and which
HARD RETRACTION clauses (if any) are about to execute. Mirror the
F15 commit body structure (commit 2b2edd2). Include:
  - F16 baseline R@K
  - F16 + Opus R@K (if run)
  - R@100 ceiling status (lifted by Xpp or not)
  - Embedder-swap survival ratio vs F12
  - Per-type biggest wins
  - HARD RETRACTION arm execution preview
  - Outside-voice review PASS verdict]

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp 2>&1 | tail -3
```

- [ ] **Step 2: Update ROADMAP F16 bullet to retrospective form**

Edit `ROADMAP-RESEARCH.md`: replace the F16 forward bullet (queued status, written in Task 1) with a retrospective bullet matching F14/F15's shape — actual numbers, Gate-B verdict, HARD RETRACTION execution status, embedder-swap survival ratio. Also update the cross-track aggregate paragraph to add F16's row.

```bash
git add ROADMAP-RESEARCH.md
git commit -m "$(cat <<'EOF'
docs(roadmap): F16 status -> shipped (Gate-B [PASS|FAIL])

[Retrospective bullet matching F15's pattern. Cross-track aggregate
updated to add the F16 row.]

This release does not re-assert the retracted −10pp magnitude.

https://claude.ai/code/session_017YFPsgCUC1i2PqoqAfcCUR
EOF
)"
git push -u origin claude/plan-implementation-workflow-sasNp 2>&1 | tail -3
```

- [ ] **Step 3: Execute the Gate-B arm**

**If Gate-B PASS (F16 best variant R@5 ≥ 97.7):**

This would be the first `_s` track to clear Gate-B. Update canonical docs:

```bash
# CHANGELOG: add a "Unreleased -> v1.10.0 candidate" entry citing F16 numbers
# README: update the "deployable best" line if F16 surpasses F13+F9 oracle = 86.8
# docs/RETRACTION.md: add the v1.10 entry to the cumulative null trajectory IF the F16 path is being shipped as a deployable change to src/

git add CHANGELOG.md README.md docs/RETRACTION.md
git commit -m "[appropriate message]"
git push -u origin claude/plan-implementation-workflow-sasNp 2>&1 | tail -3
```

**If Gate-B FAIL (F16 best variant R@5 < 97.7):**

Execute the prereg's HARD RETRACTION arm (the expected outcome per the prereg's structural-ceiling clause):

```bash
echo "=== HARD RETRACTION: F16 ==="
echo "--- before deletion ---"
du -sh data/lme_s/ 2>/dev/null
du -sh results/f16_e5_large/ 2>/dev/null
du -sh benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl 2>/dev/null
du -sh benchmarks/longmemeval/data/turn_index_e5_s.json.partial.jsonl 2>/dev/null
du -sh /tmp/rerank_f16_batches/ 2>/dev/null
du -sh /tmp/rerank_f16_outputs/ 2>/dev/null
du -sh /tmp/f16_build.log /tmp/f16_retrieve.log 2>/dev/null

rm -rf data/lme_s
rm -rf results/f16_e5_large
rm -f benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl
rm -f benchmarks/longmemeval/data/turn_index_e5_s.json.partial.jsonl
rm -rf /tmp/rerank_f16_batches /tmp/rerank_f16_outputs
rm -f /tmp/f16_build.log /tmp/f16_retrieve.log

echo ""
echo "--- after deletion ---"
ls data/lme_s 2>&1 | head -1
ls results/f16_e5_large 2>&1 | head -1
ls benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl 2>&1 | head -1

echo ""
echo "--- model-cache preserved (per prereg carve-out) ---"
ls benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/ | head -3

echo ""
echo "--- canonical docs NOT updated ---"
echo "CHANGELOG, README, ROADMAP-RESEARCH cross-track aggregate, RETRACTION.md left unchanged"
```

Expected: ~1.3 GB freed (data 265 MB + results 30 MB + index 1 GB + tmp scaffolding + logs). Model-cache retained at 2.24 GB.

- [ ] **Step 4: No final commit** — the deletions happen on gitignored paths; the result doc (committed in Step 1) and roadmap bullet (committed in Step 2) are the audit trail.

---

## Self-review

**Spec coverage:** The plan covers (a) ROADMAP forward bullet, (b) data re-acquisition, (c) prereg, (d) index build, (e) baseline retrieval, (f) Gate-A on baseline, (g) optional Opus rerank (contingent on Gate-B), (h) canonical score + final Gate-B verdict, (i) result doc, (j) outside-voice review, (k) commit + push + Gate-B arm. Both PASS and FAIL Gate-B branches have explicit action lists. No section of the user-approved scope is missing.

**Placeholder scan:** Three "TBD" / template-style elements remain in the plan, all justified:

1. Task 9 Step 1 says the result doc must include `[Fill in commit body...]` markers — these are inside the embedded commit-message HEREDOCS, meaning the result-doc-authoring engineer fills them in with measured numbers after Tasks 6-8. The numbers cannot be known at plan-write time. The plan documents exactly which JSON files to source each number from (the table in Task 9 Step 1).
2. Task 11 Step 1 and Step 2 commit messages contain `[Fill in ...]` markers for the same reason: F16 numbers + verdict don't exist until measurement.
3. Task 11 Step 3 "If Gate-B PASS" branch contains `[appropriate message]` — this is the standard precedent across F-track release commits; the engineer adapts to whether F16 is shipping deployably or just reporting.

None of these are vague step-skips; they're parameterised commit bodies that the engineer fills in from measured data.

**Type/path consistency:**
- `data/lme_s/longmemeval_s_cleaned.json` (Task 2, 4, 5, 8): consistent.
- `benchmarks/longmemeval/data/turn_index_e5_s.json` (Task 4, 5, 11): consistent. Note F13's original output path was `turn_index_e5.json` (no `_s`); the `_s` suffix disambiguates F16 from F13 since both used the same embedder.
- `results/f16_e5_large/turn_e5_s_top100.jsonl` (Task 5, 6, 7, 8): consistent.
- `results/f16_e5_large/opus_top100_reranked.jsonl` (Task 7, 8): consistent.
- `/tmp/rerank_f16_batches/`, `/tmp/rerank_f16_outputs/` (Task 7, 11): consistent.
- `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` (Task 4 pre-flight, Task 11 retention): consistent.

**One thing I rechecked:** `chunk_per_turn_embed.mjs` and `chunk_per_turn_retrieve.mjs` are `.mjs` files (Node ES modules), invoked via `node`. The Python scripts are `.py`. Plan consistently uses the right interpreter per file.

**Verdict:** plan is internally consistent and spec-complete.
