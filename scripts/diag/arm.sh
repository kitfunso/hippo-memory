#!/bin/bash
# usage: arm.sh <tag> <repo dir> [ENV=VALUE...]: one probed run of the p99 bench in <repo dir> with fsync calls traced.
TAG="$1"; DIR="$2"; shift 2
D="$(cd "$(dirname "$0")" && pwd)"
echo "=== arm $TAG ($DIR $*) ==="
cd "$DIR" || exit 1
env "$@" PROBE_OUT=/tmp/probe-$TAG.json strace -f -y --seccomp-bpf -ttt -T -e trace=fsync,fdatasync -o /tmp/st-$TAG.log node --import "$D/probe-preload.mjs" --experimental-strip-types benchmarks/a1/p99-recall.ts --store-size 1000 --warmup 50 --rounds 5 --queries 200 --gate-ms 60 2>&1 | grep -E "probe|round p99|gate \(|seed done|p50 / p95"
node "$D/join-strace.mjs" /tmp/st-$TAG.log /tmp/probe-$TAG.json
exit 0
