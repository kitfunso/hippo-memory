#!/usr/bin/env bash
# Mechanism audit (docs/evals/2026-09-23-mechanism-audit-prereg.md): one ingest, a never-slept and a slept copy,
# then hybrid and physics retrieval on each. Usage: HIPPO_MODEL_CACHE=<dir> bash build_mech_stores.sh <run-dir> <data.json>
set -euo pipefail
R="$1"; DATA="$2"
W="$(cd "$(dirname "$0")/../.." && pwd)"
: "${HIPPO_MODEL_CACHE:?set HIPPO_MODEL_CACHE so every store uses the same local model file}"
unset ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY COHERE_API_KEY HIPPO_LLM_RERANKER_KEY TYPESAFE_API_KEY
mkdir -p "$R"

# ingest.py runs a hippo binary once per session; point it at this checkout, not a global install.
if command -v cygpath > /dev/null; then
  printf '@node "%s" %%*\r\n' "$(cygpath -w "$W/bin/hippo.js")" > "$R/hippo.cmd"; HIPPO_BIN="$(cygpath -w "$R/hippo.cmd")"
else
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$W/bin/hippo.js" > "$R/hippo"; chmod +x "$R/hippo"; HIPPO_BIN="$R/hippo"
fi
hip() { local s="$1"; shift; env -C "$s" HIPPO_HOME="$s" HOME="$s" USERPROFILE="$s" node "$W/bin/hippo.js" "$@"; }
full_cover() {
  local out; out=$(hip "$1" embed --status); echo "$out"
  if grep -q "need embedding" <<< "$out"; then echo "ABORT: $1 not fully embedded"; exit 1; fi
}
counts() {
  node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const n = (t) => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
console.log(n('memories'), n('memory_physics'));
" "$1/.hippo/hippo.db"
}

t0=$(date +%s)
python "$W/benchmarks/longmemeval/ingest.py" --data "$DATA" --hippo "$HIPPO_BIN" --store-dir "$R/nosleep" --skip-sleep
hip "$R/nosleep" embed
full_cover "$R/nosleep"
read -r mem phys < <(counts "$R/nosleep")
if [ "$mem" != "$phys" ]; then echo "ABORT: nosleep has $mem memories but $phys particles"; exit 1; fi
echo "nosleep memories=$mem particles=$phys ingest+embed secs=$(( $(date +%s) - t0 ))"

cp -r "$R/nosleep" "$R/sleep"
t1=$(date +%s)
hip "$R/sleep" sleep > "$R/sleep.log" 2>&1
hip "$R/sleep" embed
full_cover "$R/sleep"
read -r mem phys < <(counts "$R/sleep")
echo "sleep memories=$mem particles=$phys sleep+embed secs=$(( $(date +%s) - t1 ))"

for S in nosleep sleep; do
  for M in hybrid physics; do
    node "$W/benchmarks/longmemeval/retrieve_inprocess.mjs" --data "$DATA" --store-dir "$R/$S" \
      --output "$R/ret-$S-$M.jsonl" --budget 1000000 --min-results 10 --top 10 --mode "$M"
  done
done
echo "build done secs=$(( $(date +%s) - t0 ))"
