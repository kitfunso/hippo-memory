#!/bin/sh
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
  node /app/dist/cli.js init --no-hooks --no-schedule --no-learn
fi

echo "[aml] starting hippo serve (auth required, port ${HIPPO_PORT:-8080})"
exec node /app/dist/cli.js serve --host 0.0.0.0 --allow-cleartext --port "${HIPPO_PORT:-8080}"
