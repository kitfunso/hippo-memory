#!/bin/sh
# First-boot init for the AML evaluation deployment.
#
# The store root is /data/.hippo (the .hippo directory IS the root). On a
# fresh volume, initialize it; on restarts the existing store persists.
#
# API keys are minted OUT OF BAND by the operator:
#   fly ssh console -a hippo-aml -C "node /app/dist/src/cli.js auth create --label aml-eval --role member --json"
# The plaintext is shown exactly once; hippo stores only a scrypt hash.
# Nothing here prints or stores a key.
set -eu

# Privilege drop: the Fly volume mounts root-owned, so first boot must chown
# it. Do that as root, then re-exec this script as the unprivileged node user
# via setpriv (execs in place, keeping PID 1 signal handling). Everything the
# server creates under /data is node-owned from then on, so the non-recursive
# chown of the mount point is sufficient.
if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  exec setpriv --reuid node --regid node --init-groups "$0" "$@"
fi

# setpriv changes uid but not the environment: HOME still says /root, and
# hippo resolves its global store from $HOME. Point it at node's real home.
export HOME=/home/node

cd /data

if [ ! -f /data/.hippo/index.json ] && [ ! -f /data/.hippo/hippo.db ]; then
  echo "[aml] fresh volume - initializing store at /data/.hippo"
  node /app/dist/src/cli.js init --no-hooks --no-schedule --no-learn
fi

echo "[aml] starting hippo serve (auth required, port ${HIPPO_PORT:-8080})"
exec node /app/dist/src/cli.js serve --host 0.0.0.0 --port "${HIPPO_PORT:-8080}"
