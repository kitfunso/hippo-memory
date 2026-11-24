#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DENSE=benchmarks/longmemeval/data/turn_index_bge_oracle.json.jsonl
BM25_TURN=benchmarks/longmemeval/data/bm25_corpus_oracle_turns.json
BM25_SESS=benchmarks/longmemeval/data/bm25_corpus_oracle_sessions.json
DATA=benchmarks/longmemeval/data/longmemeval_oracle.json
OUTROOT=results/f9_phase1

export HIPPO_MODEL_CACHE="$(pwd)/benchmarks/longmemeval/data/model-cache"

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
