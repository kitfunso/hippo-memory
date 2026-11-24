#!/usr/bin/env bash
set -euo pipefail
MODEL="${1:-gpt-4o-mini}"
HIPPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$HOME/hippo-bench}"
: "${OPENAI_API_KEY:?set OPENAI_API_KEY}"
mkdir -p "$WORK" && cd "$WORK"

[ -d memory-benchmarks ] || git clone https://github.com/mem0ai/memory-benchmarks
[ -d locomo ] || git clone --depth 1 https://github.com/snap-research/locomo
git -C memory-benchmarks checkout -q 4b61c5d
python3 -m venv .venv && . .venv/bin/activate
pip install -q -r memory-benchmarks/requirements.txt nltk regex numpy

(cd "$HIPPO" && npm run build >/dev/null)
node "$HIPPO/benchmarks/public/hippo-mem0-server.mjs" --arm hippo --port 8891 --data-dir "$WORK/stores-hippo" & S1=$!
node "$HIPPO/benchmarks/public/hippo-mem0-server.mjs" --arm bm25  --port 8892 --data-dir "$WORK/stores-bm25"  & S2=$!
trap 'kill $S1 $S2 2>/dev/null || true' EXIT
sleep 3

ARMS=(hippo=8891 bm25=8892)
if command -v docker >/dev/null && (cd memory-benchmarks && docker compose up -d >/dev/null 2>&1); then
  sleep 20 && ARMS+=(mem0oss=8888)
else
  echo "Docker not available: skipping the mem0-oss arm"
fi

cd memory-benchmarks
for pair in "${ARMS[@]}"; do
  name="${pair%%=*}"; port="${pair##*=}"
  echo "== $name"
  python -m benchmarks.locomo.run --project-name "trial-$name" --backend oss --mem0-host "http://localhost:$port" \
    --answerer-model "$MODEL" --judge-model "$MODEL" --top-k-cutoffs 10,50,200 \
    --dataset-path "$WORK/locomo/data/locomo10.json" --output-dir "$WORK/out" --max-workers 8
done

ARGS=()
for pair in "${ARMS[@]}"; do name="${pair%%=*}"; ARGS+=(--arm "$name=$WORK/out/predicted_trial-$name"); done
python "$HIPPO/benchmarks/public/score_locomo.py" --locomo-repo "$WORK/locomo" \
  --dataset "$WORK/locomo/data/locomo10.json" "${ARGS[@]}" --baseline bm25 | tee "$WORK/locomo-trial-scores.txt"
echo "Scores: $WORK/locomo-trial-scores.txt   Raw outputs: $WORK/out"
