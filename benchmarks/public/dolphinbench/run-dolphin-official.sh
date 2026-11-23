#!/usr/bin/env bash
# One stage of dolphin_official.py, run in WSL as the normal user: the judge proxy stays this user, the rest is root.
# Usage: run-dolphin-official.sh setup|smoke|ingest|seed|test|report|rejudge-published [flags]; see the prereg.
set -euo pipefail
stage="${1:?stage: setup|smoke|ingest|seed|test|report|rejudge-published}"
shift
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
win_home="${DOLPHIN_WIN_HOME:-$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")}"
export DOLPHIN_BENCH_HOME="${DOLPHIN_BENCH_HOME:-$win_home/hippo-bench}"
label="${LABEL:-official}"

as_root() {
  wsl.exe -d Ubuntu -u root --exec /usr/bin/env DOLPHIN_BENCH_HOME="$DOLPHIN_BENCH_HOME" \
    /usr/bin/python3 "$here/dolphin_official.py" "$stage" "$@"
}

start_judge() {
  export DOLPHIN_CODEX_HOME="${DOLPHIN_CODEX_HOME:-$win_home/.dolphin-codex}"
  mkdir -p "$DOLPHIN_CODEX_HOME"
  # a refresh of the main login voids the old copy (401), so take the newer file at every start
  if [ "$win_home/.codex/auth.json" -nt "$DOLPHIN_CODEX_HOME/auth.json" ]; then
    cp "$win_home/.codex/auth.json" "$DOLPHIN_CODEX_HOME/auth.json"
  fi
  mkdir -p "$DOLPHIN_BENCH_HOME/logs"
  "$DOLPHIN_BENCH_HOME/.venv-dolphin-wsl/bin/python" "$here/dolphin_official.py" judge --kind "${JUDGE:-codex}" \
    --label "$label" >>"$DOLPHIN_BENCH_HOME/logs/official-judge-$label.log" 2>&1 &
  judge_pid=$!
  trap 'kill "$judge_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 300); do
    if (exec 3<>/dev/tcp/127.0.0.1/18765) 2>/dev/null; then return; fi
    kill -0 "$judge_pid" 2>/dev/null || { echo "the judge exited; see $DOLPHIN_BENCH_HOME/logs" >&2; exit 1; }
    sleep 0.2
  done
  echo "the judge did not open port 18765" >&2
  exit 1
}

case "$stage" in
  setup) as_root --hippo "${HIPPO_SPEC:?set HIPPO_SPEC}" --plugin "${HIPPO_PLUGIN:?set HIPPO_PLUGIN}" "$@" ;;
  smoke) as_root --run "${RUN:-smoke}" --persona morgan --limit 20 --agent claude "$@" ;;
  ingest|seed|report) as_root "$@" ;;
  test|rejudge-published) start_judge; as_root "$@" ;;
  *) echo "unknown stage: $stage" >&2; exit 2 ;;
esac
