#!/usr/bin/env bash
# Stub of s4-batch.sh for the s4-drive.sh tests: this bash process carries the name and root the scan reads, and the stub CLI beside it does what the knob says.
PATH=/usr/bin:/mingw64/bin:$PATH
HERE=$(cygpath -m "$(dirname "$0")")
# With a list-root knob file it lists its root as the real batch does, once at its start and again when the test puts list-again, so a test sees what a batch sees of its own driver.
# The second listing has no clock: the test puts list-again only once its own stand-ins are up, and its case cleanup kills this bash if it never does.
if [ -f "$Z0_STUB_KNOBS/list-root" ]; then
  . "$HERE/s4-units.sh"
  # The file appears only once the scan is done, so a test that waits for it reads a whole listing.
  list_root() {
    if units_scan; then LISTED=$(root_lines "$4"); else LISTED="scan failed: $UNITS_ERR"; fi
    echo "$LISTED" > "$Z0_STUB_KNOBS/$1"
  }
  list_root listed-1.txt "$@"
  until [ -f "$Z0_STUB_KNOBS/list-again" ] || [ ! -d "$Z0_STUB_KNOBS" ]; do sleep 0.2; done
  [ ! -f "$Z0_STUB_KNOBS/list-again" ] || list_root listed-2.txt "$@"
fi
Z0_STUB_NAME=s4-batch node "$HERE/stub-cli.mjs" "$@" < /dev/null
exit $?
