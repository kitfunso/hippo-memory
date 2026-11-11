#!/usr/bin/env bash
# The scan and the unit states of the round 4 batch (plan: Failure model). s4-batch.sh sources it; `bash s4-units.sh <function> <args>` scans once and calls that function.
# Every state call of one poll reads that poll's listing, so a caller scans, then asks. The checkout comes from Z0_CHECKOUT.
PATH=/usr/bin:/mingw64/bin:$PATH
UNITS_HERE=$(cygpath -m "$(dirname "${BASH_SOURCE[0]}")")
UNITS_LIST=''
UNITS_ERR=''
declare -F say > /dev/null || say() { echo "$*" >&2; }

ur() { node "$Z0_CHECKOUT/scripts/token-eval/z0-unit-record.mjs" "$@"; }

# One powershell run: `<pid> <role> <path>` lines in UNITS_LIST, CR removed; a failed scan returns 1 with its last line in UNITS_ERR.
units_scan() {
  local out
  out=$(powershell -NoProfile -ExecutionPolicy Bypass -File "$UNITS_HERE/s4-procs.ps1" < /dev/null) || {
    UNITS_ERR=$(printf '%s\n' "$out" | tr -d '\r' | tail -n 1)
    return 1
  }
  UNITS_LIST=$(printf '%s\n' "$out" | tr -d '\r')
}

# Whole-path equality on the lowercased folder: `<k>-w1` never matches `<k>-w1-a2`.
unit_alive() {
  local want=${1,,} pid role path
  want=${want//\\//}
  while read -r pid role path; do
    case $role in ab-run | z0-regrade | s4-run | s4-regrade) [ "$path" = "$want" ] && return 0 ;; esac
  done <<< "$UNITS_LIST"
  return 1
}

# `state done|alive|failed|none <folder>`; a record file that cannot be read prints `state error <folder> <line>` and returns 1.
unit_state() {
  local folder=$1 rec s=none
  rec=$(ur unit "$folder" 2>&1 < /dev/null) || { echo "state error $folder ${rec%%$'\n'*}"; return 1; }
  if [[ $rec == *" records-line" ]]; then s=done
  elif unit_alive "$folder"; then s=alive
  elif [[ $rec == *" all-records" ]]; then s=done
  elif [ -f "$folder/run.log" ]; then s=failed
  fi
  echo "state $s $folder"
}

# `call done|alive|failed <folder> <call>`; the batch reads error rows from `z0-unit-record call` itself.
call_state() {
  local folder=$1 call=$2 rec s=failed
  rec=$(ur call "$folder" "$call" 2>&1 < /dev/null) || { echo "call error $folder $call ${rec%%$'\n'*}"; return 1; }
  if [[ $rec == "record done "* ]]; then s=done
  elif unit_alive "$folder"; then s=alive
  fi
  echo "call $s $folder $call"
}

# The listing lines whose path is the root or lies under it.
root_lines() {
  local root=${1,,} pid role path
  while read -r pid role path; do
    [ -n "$pid" ] || continue
    if [ "$path" = "$root" ] || [[ $path == "$root"/* ]]; then echo "$pid $role $path"; fi
  done <<< "$UNITS_LIST"
}

batch_lines() {
  local root=${1,,} pid role path
  while read -r pid role path; do
    if [ "$role" = s4-batch ] && [ "$path" = "$root" ]; then echo "$pid $role $path"; fi
  done <<< "$UNITS_LIST"
}

# A runner that printed its Records: line but has not exited for Z0_GRACE_S seconds is stopped with its tree (r3-wave1.sh:24); its unit stays done.
# The pid comes from a scan seconds old, so stop-tree.ps1 kills only a process whose command line names the unit; a failed stop is said and the next poll tries again.
stop_finished() {
  local prefix=${1,,} grace=${Z0_GRACE_S:-600} pid role path rec mtime now out rc line last
  now=$(date +%s)
  while read -r pid role path; do
    [ "$role" = ab-run ] && [[ $path == "$prefix"/* ]] || continue
    rec=$(ur unit "$path" 2> /dev/null < /dev/null)
    [[ $rec == *" records-line" ]] || continue
    mtime=$(stat -c %Y "$path/run.log" 2> /dev/null) || continue
    [ $((now - mtime)) -ge "$grace" ] || continue
    say "${path##*/} finished but did not exit, stopping pid $pid"
    out=$(timeout 120 powershell -NoProfile -ExecutionPolicy Bypass -File "$Z0_CHECKOUT/scripts/token-eval/stop-tree.ps1" -RootPid "$pid" -Mark "$path" 2>&1 < /dev/null)
    rc=$?
    out=$(printf '%s\n' "$out" | tr -d '\r')
    while IFS= read -r line; do [ -z "$line" ] || say "${path##*/} stop: $line"; done <<< "$out"
    last=${out%$'\n'end}
    [ "$rc" -eq 0 ] || say "${path##*/} stop exit $rc: ${last##*$'\n'}"
  done <<< "$UNITS_LIST"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -ge 1 ] && [ -n "$Z0_CHECKOUT" ] || { echo 'usage: Z0_CHECKOUT=<checkout> bash s4-units.sh <function> <args>'; exit 1; }
  fn=$1
  shift
  units_scan || { echo "process scan failed: $UNITS_ERR"; exit 1; }
  "$fn" "$@"
fi
