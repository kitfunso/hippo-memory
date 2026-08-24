#!/bin/sh
# First-boot init for the AML evaluation deployment.
#
# The store root is /data/.hippo (the .hippo directory IS the root). On a
# fresh volume, initialize it; on restarts the existing store persists.
#
# API keys are minted OUT OF BAND by the operator:
#   fly ssh console -a hippo-aml -C "node /app/dist/src/cli.js auth create --label aml-eval --role writer --json"
# The plaintext is shown exactly once; hippo stores only a scrypt hash.
# Nothing here prints or stores a key.
set -eu

cd /data

if [ ! -f /data/.hippo/index.json ] && [ ! -f /data/.hippo/hippo.db ]; then
  echo "[aml] fresh volume - initializing store at /data/.hippo"
  node /app/dist/src/cli.js init --no-hooks --no-schedule --no-learn
fi

echo "[aml] starting hippo serve (auth required, port ${HIPPO_PORT:-8080})"
exec node /app/dist/src/cli.js serve --host 0.0.0.0 --port "${HIPPO_PORT:-8080}"
