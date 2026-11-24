#!/usr/bin/env bash
set -euo pipefail
R="$1"; DATA="$2"
W="$(cd "$(dirname "$0")/../.." && pwd)"
: "${HIPPO_MODEL_CACHE:?set HIPPO_MODEL_CACHE so every store uses the same local model file}"
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY HIPPO_LLM_BASE_URL HIPPO_LLM_API_KEY HIPPO_LLM_MODEL HIPPO_LLM_ALLOW_HTTP
mkdir -p "$R/turn"

hip() { local s="$1"; shift; env -C "$s" HIPPO_HOME="$s" HOME="$s" USERPROFILE="$s" node "$W/bin/hippo.js" "$@"; }
counts() {
  node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const n = (t) => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
console.log(n('memories'), n('memory_physics'));
" "$1/.hippo/hippo.db"
}

t0=$(date +%s)
hip "$R/turn" init --no-hooks --no-schedule --no-learn
node "$W/benchmarks/longmemeval/ingest_turns.mjs" --data "$DATA" --store-dir "$R/turn"
hip "$R/turn" embed
hip "$R/turn" embed --reset-physics
out=$(hip "$R/turn" embed --status); echo "$out"
if grep -q "need embedding" <<< "$out"; then echo "ABORT: turn store not fully embedded"; exit 1; fi
read -r mem phys < <(counts "$R/turn")
if [ "$mem" != "$phys" ]; then echo "ABORT: turn store has $mem memories but $phys particles"; exit 1; fi
echo "turn memories=$mem particles=$phys ingest+embed secs=$(( $(date +%s) - t0 ))"

ret() { node "$W/benchmarks/longmemeval/retrieve_inprocess.mjs" --data "$DATA" --store-dir "$R/turn" \
  --budget 1000000 --min-results 10 --top 10 "$@"; }
ret --output "$R/ret-turn-physics.jsonl" --mode physics
ret --output "$R/ret-turn-hybrid.jsonl" --mode hybrid
ret --output "$R/ret-turn-cosine.jsonl" --mode hybrid --embedding-weight 1 --no-mmr
echo "build done secs=$(( $(date +%s) - t0 ))"
