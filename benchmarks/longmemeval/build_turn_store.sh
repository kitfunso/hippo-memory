#!/usr/bin/env bash
# Round-2 lane #5 (docs/evals/2026-09-23-mechanism-audit-round2-prereg.md): a per-turn store, never slept,
# then hybrid and cosine-only retrieval (3.0 removed the physics arm). Usage: HIPPO_MODEL_CACHE=<dir> bash build_turn_store.sh <run-dir> <data.json>
set -euo pipefail
R="$1"; DATA="$2"
W="$(cd "$(dirname "$0")/../.." && pwd)"
: "${HIPPO_MODEL_CACHE:?set HIPPO_MODEL_CACHE so every store uses the same local model file}"
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
mkdir -p "$R/turn"

hip() { local s="$1"; shift; env -C "$s" HIPPO_HOME="$s" HOME="$s" USERPROFILE="$s" node "$W/bin/hippo.js" "$@"; }
counts() {
  node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const n = (t) => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
console.log(n('memories'));
" "$1/.hippo/hippo.db"
}

t0=$(date +%s)
hip "$R/turn" init --no-hooks --no-schedule --no-learn
node "$W/benchmarks/longmemeval/ingest_turns.mjs" --data "$DATA" --store-dir "$R/turn"
hip "$R/turn" embed
out=$(hip "$R/turn" embed --status); echo "$out"
if grep -q "need embedding" <<< "$out"; then echo "ABORT: turn store not fully embedded"; exit 1; fi
read -r mem < <(counts "$R/turn")
echo "turn memories=$mem ingest+embed secs=$(( $(date +%s) - t0 ))"

ret() { node "$W/benchmarks/longmemeval/retrieve_inprocess.mjs" --data "$DATA" --store-dir "$R/turn" \
  --budget 1000000 --min-results 10 --top 10 "$@"; }
ret --output "$R/ret-turn-hybrid.jsonl" --mode hybrid
ret --output "$R/ret-turn-cosine.jsonl" --mode hybrid --embedding-weight 1 --no-mmr
echo "build done secs=$(( $(date +%s) - t0 ))"
