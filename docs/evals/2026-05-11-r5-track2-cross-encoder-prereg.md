# LongMemEval R@5 target — Track 2: cross-encoder real-eval pre-registration

**Author:** Claude Code (subagent-driven-development workflow)
**Date:** 2026-05-11
**Plan:** docs/plans/2026-05-11-r5-track2-cross-encoder-real.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

## TL;DR / scope

This pre-registration covers a real-model end-to-end evaluation of the
cross-encoder reranker (`src/rerankers/cross-encoder.ts`) against the
LongMemEval 500-question workload using the v0.27 hippo store at
`hippo_store2/`. The F6 release shipped the cross-encoder track but the
HuggingFace block caused all 500 invocations to take the identity-fallback
branch; this plan unblocks the real model via multi-path discovery and
re-runs the F6 sweep.

The eval is gated on two binding criteria: proof that the real model loaded
(Gate-A) and proof that it adds measurable retrieval value (Gate-B). Gate-B
FAIL triggers a hard retraction removing the cross-encoder track from `src/`.

## Upstream dependency — HF blocker (CRITICAL CAVEAT)

**The same blocker that paused Plan F8 (`docs/evals/2026-05-11-r5-track1-tuning-result.md`) also affects this plan.**

HuggingFace (`huggingface.co`) is blocked in this sandbox. This has two
compounding effects:

1. **Embeddings not populated:** `hippo_store2/.hippo/embeddings.json` does
   not exist because `ingest_direct.py` (used in F6 Task 10) never invoked the
   embedding pipeline, and `hippo embed` depends on the HF-hosted model
   `Xenova/all-MiniLM-L6-v2`. Without embeddings, `hybridSearch` collapses to a
   pure BM25 ranking — the `embeddingWeight` parameter has no effect. This was
   confirmed by F8 Stage-1: all seven `embeddingWeight` variants produced
   identical R@K across 500 questions.

2. **Cross-encoder model blocked:** the MS-MARCO cross-encoder
   (`Xenova/ms-marco-MiniLM-L-6-v2`) is also HF-hosted. The identity-fallback
   path fires whenever the model cannot load.

**Consequence for this plan:** the cross-encoder reranks whatever the BM25
path returns. If the correct answer is not in the BM25 top-K candidates fed
to the cross-encoder, the cross-encoder CANNOT fix it — it can only reorder
the candidates it receives. On a BM25-only retrieval path with no embedding
diversification, the top-K set may already be sub-optimal, capping the
cross-encoder's headroom.

Task 2 of this plan (multi-path discovery) is the required unblock:
- Path A (HF mirror) or Path C (vendored ONNX weights) unblocks both the
  cross-encoder real-model load AND the embedding index build (which enables F8
  re-run).
- Path B (hosted reranker API) unblocks the cross-encoder load only; the
  embedding index would still require a separate solution.

**If Task 2 fails (all three paths blocked): the plan cannot proceed.** Report
to controller; no eval gate fires and no retraction triggers.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. The result doc, the CHANGELOG entry, the README
"What's new" entry, and any commit body authored under this plan must satisfy:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <touched-files>
```

returns zero matches.

## Workload-validity gates (binding)

### Gate-A (model loaded for real)

The cross-encoder track must produce non-identity orderings on at least
250/500 questions versus the baseline track.

**Operationalised:** use `scripts/diff_orderings.mjs` (to be built in Task 6)
to compare `retrieved_memory_ids` per question between the baseline JSONL and
the cross-encoder JSONL. A question is counted as "differing" if the
comma-joined ordering string differs between the two tracks. The count of
differing questions must be ≥ 250.

```bash
node scripts/diff_orderings.mjs results/<sweep>/baseline.jsonl \
  results/<sweep>/cross_encoder_real.jsonl
# exit 0 = Gate-A PASS (diff >= 250); exit 1 = FAIL
```

Threshold: **≥ 250 differing orderings out of 500 questions = PASS.**

Rationale: identity-fallback produces identical orderings everywhere. A real
model reranks on query-document relevance and will produce different orderings
on the majority of non-trivial queries. A threshold of 250/500 (50%) is
conservative — the real model is expected to differ on nearly all 500, but
250 is sufficient to confirm the model loaded and fired.

### Gate-B (proven value)

Cross-encoder R@5 must be ≥ baseline R@5 + 5pp on the same hippo store and
the same hybrid configuration.

**Baseline:** 75.6% (F6 result, which was BM25-only due to the identity
fallback).

**Threshold: ≥ 80.6% = PASS.**

Both tracks must use the same `hippo_store2/` store and the same hybrid
configuration flags. If Plan F8 has completed and
`results/hybrid_tuning_winners.json` exists, use those flags; otherwise use
v0.27 defaults and note the dependency in the result doc.

## Failure handling

### Gate-A FAIL

The chosen model-loading path is broken; the cross-encoder is still running
the identity fallback. Revert the wiring commit (Task 4). No retraction needed
because no value claim was made. Document the failure in the result doc and
stop the plan.

### Gate-B FAIL — HARD RETRACTION

The cross-encoder reranker is not pulling its weight on this workload. The
following retraction protocol fires (Tasks 9-11 of the plan):

**Step 1: Delete the cross-encoder files**

```bash
git rm src/rerankers/cross-encoder.ts \
       tests/rerankers/cross-encoder.test.ts \
       tests/rerankers/cross-encoder-real.test.ts \
       benchmarks/micro/fixtures/reranker-cross-encoder.json
# Also: git rm src/rerankers/cross-encoder-hosted.ts  (if Path B was the winning path)
```

**Step 2: Remove the dispatcher case**

Edit `src/rerankers/index.ts` (or wherever the reranker dispatcher lives) and
remove the `'cross_encoder'` case. The dispatcher must throw
`unknown reranker: cross_encoder` if asked after this edit.

**Step 3: Documentation retraction**

- CHANGELOG: prepend a retraction entry citing the Gate-B FAIL, the result
  doc, and the verbatim retraction sentence.
- ROADMAP-RESEARCH.md: append a "Retraction note:" paragraph to the F6 entry
  describing the cross-encoder removal and citing this plan's result doc.
- `docs/evals/README.md` (if it exists): mark the cross-encoder row as
  "TRACK RETRACTED" with a cite to the result doc.

**Step 4: Build + test clean**

```bash
npm run build 2>&1 | tail -3
npx vitest run tests/rerankers/ 2>&1 | tail -10
```

Expected: build clean; cross-encoder tests absent from the run.

## Cumulative-null status

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's
cumulative-null status is independent of this cross-encoder evaluation plan.
This plan changes no mechanism in `src/` related to the goal-stack; it
evaluates a retrieval reranker on a different metric and corpus path. The
cumulative-null finding for dlPFC goal-stack therefore stands unchanged and is
not affected by the outcomes of this plan, regardless of whether Gate-A and
Gate-B PASS or FAIL.

## Outside-voice review

### Review (2026-05-11)

**Reviewer:** general-purpose subagent dispatched by the subagent-driven-development controller. Isolated context (did not see plan-writing or implementer reasoning trace). Read `docs/RETRACTION.md`, the F8 prereg, the F8 termination note, and this prereg fresh.

**Verdict:** PASS (no required fixes).

**Per-check results:**

1. Verbatim retraction sentence — PASS (line 8).
2. Magnitude-smuggling grep — PASS (0 matches).
3. Gate-A — PASS (lines 73-97; ≥ 250/500 differing orderings; `scripts/diff_orderings.mjs` binary exit code enforces).
4. Gate-B — PASS (lines 98-111; R@5 ≥ 80.6% threshold; baseline 75.6% + 5pp explicit).
5. Retraction protocol concrete — PASS (lines 125-159; specific file paths to `git rm`, dispatcher case in `src/rerankers/index.ts`, CHANGELOG / ROADMAP-RESEARCH.md / evals/README.md updates, build + vitest clean run).
6. HF-blocker upstream caveat — PASS (lines 24-58, section "Upstream dependency — HF blocker (CRITICAL CAVEAT)"; explicit cross-encoder-reranks-BM25-only ceiling statement).
7. Cumulative-null acknowledgement — PASS (lines 162-169; `docs/RETRACTION.md:94-113` cite + dlPFC goal-stack independence).
8. Outside-voice review section — PASS (this section, now filled).
9. Soft-magnitude scan — PASS (no prose magnitude characterisations; "lift" appears only inside gate label).

**Required fixes:** None. Controller authorised to proceed to Task 2 (model-access discovery).
