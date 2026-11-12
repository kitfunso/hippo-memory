#!/usr/bin/env bash
# Starts one DolphinBench stage in WSL. Usage: run-dolphin.sh ingest|dry|smoke|pilot|full|compare|check [label persona tests]
# The agent's token is read from the Windows User variable CLAUDE_CODE_OAUTH_TOKEN_DISABLED into this process only:
# never printed, never in a command line, never written back to any scope.
set -euo pipefail
stage="${1:?stage: ingest|dry|smoke|pilot|full|compare|check}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
win_home="${DOLPHIN_WIN_HOME:-$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")}"
export DOLPHIN_BENCH_HOME="${DOLPHIN_BENCH_HOME:-$win_home/hippo-bench}"
py="$DOLPHIN_BENCH_HOME/.venv-dolphin-wsl/bin/python"
run=("$py" "$here/dolphin_hippo.py")

load_token() {
  local value
  value="$(powershell.exe -NoProfile -NonInteractive -Command \
    "[Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN_DISABLED','User')" | tr -d '\r\n')"
  [ -n "$value" ] || { echo "CLAUDE_CODE_OAUTH_TOKEN_DISABLED is empty in the Windows User scope" >&2; exit 2; }
  export DOLPHIN_CLAUDE_OAUTH_TOKEN="$value"
}

load_codex_home() {
  export DOLPHIN_CODEX_HOME="${DOLPHIN_CODEX_HOME:-$win_home/.dolphin-codex}"
  if [ ! -f "$DOLPHIN_CODEX_HOME/auth.json" ]; then
    mkdir -p "$DOLPHIN_CODEX_HOME" && cp "$win_home/.codex/auth.json" "$DOLPHIN_CODEX_HOME/auth.json"
  fi
}

case "$stage" in
  ingest)  exec "${run[@]}" ingest ;;
  dry)     exec "${run[@]}" run --label "${LABEL:-dry}" --persona morgan --tests 2 --judge stub --agent fake ;;
  smoke)   load_token; load_codex_home
           exec "${run[@]}" run --label "${LABEL:-smoke}" --persona morgan --tests 1 --judge codex --agent claude ;;
  pilot)   load_token; load_codex_home
           exec "${run[@]}" run --label "${LABEL:-pilot}" --persona morgan --tests 20 --judge codex --agent claude ;;
  full)    load_token; load_codex_home
           for persona in morgan alex riley; do
             "${run[@]}" run --label "${LABEL:-full}" --persona "$persona" --tests 200 --judge codex --agent claude || exit 1
           done
           exec "${run[@]}" compare --label "${LABEL:-full}" ;;
  compare) load_token; exec "${run[@]}" compare --label "${LABEL:-full}" ;;
  check)   load_token
           exec "${run[@]}" check --label "${2:?label}" --persona "${3:-morgan}" --tests "${4:-20}" ;;
  *)       echo "unknown stage: $stage" >&2; exit 2 ;;
esac
