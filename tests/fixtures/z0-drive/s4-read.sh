#!/usr/bin/env bash
# Stub of s4-read.sh for the s4-drive.sh tests: this bash process carries the name and root the scan reads, and the stub CLI beside it does what the knob says.
PATH=/usr/bin:/mingw64/bin:$PATH
HERE=$(cygpath -m "$(dirname "$0")")
Z0_STUB_NAME=s4-read node "$HERE/stub-cli.mjs" "$@" < /dev/null
exit $?
