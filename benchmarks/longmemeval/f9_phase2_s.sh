#!/usr/bin/env bash
#
# F9 Phase 2 — `_s` 5-cell hybrid eval orchestrator (BINDING Gate-B).
#
# Identical 5-cell matrix as Phase 1 oracle, run against the `_s` split
# instead of oracle. The binding comparison is against F14's R@5 = 42.0
# baseline + the inherited 97.7 Gate-B threshold (same threshold F14 /
# F15 / F16 missed; not lowered per the prereg's discipline).
#
# Prereqs (must exist before running):
#   data/lme_s/longmemeval_s_cleaned.json  (SHA-256 d6f21ea9d60a0d56f...)
#   benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl   (~2.7h re-build)
#   benchmarks/longmemeval/data/bm25_corpus_s_turns.json
#   benchmarks/longmemeval/data/bm25_corpus_s_sessions.json
#   benchmarks/longmemeval/data/model-cache/Xenova/bge-base-en-v1.5/
#
# Usage:
#   bash benchmarks/longmemeval/f9_phase2_s.sh
#
# Output:
#   results/f9_phase2/<cell>/retrieval.jsonl
#   results/f9_phase2/<cell>/eval.json
#   results/f9_phase2/summary.json
#
set -euo pipefail

cd "$(dirname "$0")/../.."

DENSE=benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl
BM25_TURN=benchmarks/longmemeval/data/bm25_corpus_s_turns.json
BM25_SESS=benchmarks/longmemeval/data/bm25_corpus_s_sessions.json
DATA=data/lme_s/longmemeval_s_cleaned.json
OUTROOT=results/f9_phase2

export HIPPO_MODEL_CACHE="$(pwd)/benchmarks/longmemeval/data/model-cache"

# Sanity-check prereqs.
for f in "$DENSE" "$BM25_TURN" "$BM25_SESS" "$DATA"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done

mkdir -p "$OUTROOT"

declare -a CELLS=(
  "dense_only|$BM25_TURN|0.0|1.0"
  "turn_sym|$BM25_TURN|0.5|0.5"
  "turn_asym|$BM25_TURN|0.2|0.8"
  "session_sym|$BM25_SESS|0.5|0.5"
  "session_asym|$BM25_SESS|0.2|0.8"
)

for cell_spec in "${CELLS[@]}"; do
  IFS='|' read -r CELL BM25 WBM25 WDENSE <<< "$cell_spec"
  CELLOUT="$OUTROOT/$CELL"
  mkdir -p "$CELLOUT"
  RETJSONL="$CELLOUT/retrieval.jsonl"

  if [ -f "$RETJSONL" ] && [ "${F9_FORCE:-0}" != "1" ]; then
    echo "[f9-phase2] skip $CELL (output exists; set F9_FORCE=1 to rerun)"
    continue
  fi

  echo ""
  echo "============================================================"
  echo "[f9-phase2] cell=$CELL  bm25-w=$WBM25  dense-w=$WDENSE"
  echo "[f9-phase2] bm25-corpus=$BM25"
  echo "============================================================"

  node benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs \
    --turn-index "$DENSE" \
    --bm25 "$BM25" \
    --data "$DATA" \
    --out "$RETJSONL" \
    --rrf-weight-bm25 "$WBM25" \
    --rrf-weight-dense "$WDENSE" \
    --top-k 100
done

echo ""
echo "[f9-phase2] scoring 5 cells via evaluate_retrieval.py..."
for cell_spec in "${CELLS[@]}"; do
  IFS='|' read -r CELL _ _ _ <<< "$cell_spec"
  RETJSONL="$OUTROOT/$CELL/retrieval.jsonl"
  EVALJSON="$OUTROOT/$CELL/eval.json"

  python benchmarks/longmemeval/evaluate_retrieval.py \
    --retrieval "$RETJSONL" \
    --data "$DATA" \
    --output "$EVALJSON" \
    2>&1 | tail -40
done

SUMMARY="$OUTROOT/summary.json"
python - <<PYEOF
import json, pathlib
out = {"benchmark": "f9-phase2-s", "cells": {}}
for cell in ["dense_only", "turn_sym", "turn_asym", "session_sym", "session_asym"]:
    p = pathlib.Path("$OUTROOT") / cell / "eval.json"
    if p.exists():
        out["cells"][cell] = json.loads(p.read_text(encoding="utf-8"))
pathlib.Path("$SUMMARY").write_text(json.dumps(out, indent=2), encoding="utf-8")
print(f"summary written to $SUMMARY")
print()
print("=" * 70)
print("F9 PHASE 2 _s — top-line R@5 by cell:")
print("=" * 70)
for cell, ev in out["cells"].items():
    if "overall" in ev and "recall@5" in ev["overall"]:
        print(f"  {cell:<16s}  R@5 = {ev['overall']['recall@5']:.1f}")

# Gate-B verdict
best_hybrid = max(
    (out["cells"][c]["overall"]["recall@5"] for c in ["turn_sym","turn_asym","session_sym","session_asym"] if c in out["cells"]),
    default=0,
)
gate_b_threshold = 97.7
verdict = "PASS" if best_hybrid >= gate_b_threshold else "FAIL"
print()
print(f"Gate-B verdict (best hybrid R@5 = {best_hybrid:.1f} vs threshold {gate_b_threshold}): {verdict}")
PYEOF
