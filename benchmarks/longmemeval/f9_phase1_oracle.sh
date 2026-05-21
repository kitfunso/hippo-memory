#!/usr/bin/env bash
#
# F9 Phase 1 — oracle 5-cell hybrid eval orchestrator.
#
# Runs all 5 variant cells through chunk_per_turn_hybrid_retrieve.mjs +
# scores each via evaluate_retrieval.py. Emits a per-cell JSON results
# tree under results/f9_phase1/ for the result doc to consume.
#
# Prereqs (must exist before running):
#   benchmarks/longmemeval/data/longmemeval_oracle.json
#   benchmarks/longmemeval/data/turn_index_bge_oracle.json.jsonl
#   benchmarks/longmemeval/data/bm25_corpus_oracle_turns.json
#   benchmarks/longmemeval/data/bm25_corpus_oracle_sessions.json
#   benchmarks/longmemeval/data/model-cache/Xenova/bge-base-en-v1.5/
#
# Usage:
#   bash benchmarks/longmemeval/f9_phase1_oracle.sh
#
# Output:
#   results/f9_phase1/<cell>/retrieval.jsonl
#   results/f9_phase1/<cell>/eval.json
#   results/f9_phase1/summary.json
#
set -euo pipefail

cd "$(dirname "$0")/../.."

DENSE=benchmarks/longmemeval/data/turn_index_bge_oracle.json.jsonl
BM25_TURN=benchmarks/longmemeval/data/bm25_corpus_oracle_turns.json
BM25_SESS=benchmarks/longmemeval/data/bm25_corpus_oracle_sessions.json
DATA=benchmarks/longmemeval/data/longmemeval_oracle.json
OUTROOT=results/f9_phase1

export HIPPO_MODEL_CACHE="$(pwd)/benchmarks/longmemeval/data/model-cache"

# Sanity-check prereqs.
for f in "$DENSE" "$BM25_TURN" "$BM25_SESS" "$DATA"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    exit 1
  fi
done

mkdir -p "$OUTROOT"

# ---------------------------------------------------------------------------
# Cell definitions: name | bm25-corpus | bm25-weight | dense-weight
# ---------------------------------------------------------------------------
declare -a CELLS=(
  "dense_only|$BM25_TURN|0.0|1.0"
  "turn_sym|$BM25_TURN|0.5|0.5"
  "turn_asym|$BM25_TURN|0.2|0.8"
  "session_sym|$BM25_SESS|0.5|0.5"
  "session_asym|$BM25_SESS|0.2|0.8"
)

# Build the per-cell JSONL outputs first, then score each at the end so
# any single failure surfaces with the relevant retrieval log preserved.
for cell_spec in "${CELLS[@]}"; do
  IFS='|' read -r CELL BM25 WBM25 WDENSE <<< "$cell_spec"
  CELLOUT="$OUTROOT/$CELL"
  mkdir -p "$CELLOUT"
  RETJSONL="$CELLOUT/retrieval.jsonl"

  if [ -f "$RETJSONL" ] && [ "${F9_FORCE:-0}" != "1" ]; then
    echo "[f9-phase1] skip $CELL (output exists; set F9_FORCE=1 to rerun)"
    continue
  fi

  echo ""
  echo "============================================================"
  echo "[f9-phase1] cell=$CELL  bm25-w=$WBM25  dense-w=$WDENSE"
  echo "[f9-phase1] bm25-corpus=$BM25"
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

# ---------------------------------------------------------------------------
# Score each cell.
# ---------------------------------------------------------------------------
echo ""
echo "[f9-phase1] scoring 5 cells via evaluate_retrieval.py..."
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

# ---------------------------------------------------------------------------
# Compose summary.
# ---------------------------------------------------------------------------
SUMMARY="$OUTROOT/summary.json"
python - <<PYEOF
import json, pathlib
out = {"benchmark": "f9-phase1-oracle", "cells": {}}
for cell in ["dense_only", "turn_sym", "turn_asym", "session_sym", "session_asym"]:
    p = pathlib.Path("$OUTROOT") / cell / "eval.json"
    if p.exists():
        out["cells"][cell] = json.loads(p.read_text(encoding="utf-8"))
pathlib.Path("$SUMMARY").write_text(json.dumps(out, indent=2), encoding="utf-8")
print(f"summary written to $SUMMARY")
# Quick top-line print
print()
print("=" * 70)
print("F9 PHASE 1 ORACLE — top-line R@5 by cell:")
print("=" * 70)
for cell, ev in out["cells"].items():
    if "overall" in ev and "recall@5" in ev["overall"]:
        print(f"  {cell:<16s}  R@5 = {ev['overall']['recall@5']:.1f}")
PYEOF
