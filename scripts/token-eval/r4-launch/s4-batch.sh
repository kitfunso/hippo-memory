#!/usr/bin/env bash
# Round 4 batch (plan slice 3, Failure and Record models, after r3-wave1.sh and r3-regrade-go.sh): runs one batch's units in phases, then G5 per folder, then the end phase.
# It runs no budget check (the driver checks before a batch starts) and starts no bash background job, so no fork of it outlives the command that made it.
PATH=/usr/bin:/mingw64/bin:$PATH
HERE=$(cygpath -m "$(dirname "$0")")
USAGE='usage: s4-batch.sh <1|2|raise> <checkout> <root> [--poll <s>] [--fake <knobs>]'
usage() { echo "$USAGE"; exit 1; }

[ $# -ge 3 ] || usage
N=$1 CHECKOUT=$2 ROOT=$3
shift 3
case $N in 1) B=batch1 W=1 BATCHES=1 ;; 2) B=batch2 W=1 BATCHES=1,2 ;; raise) B=raise W=2 BATCHES=1,2,raise ;; *) usage ;; esac
POLL=300 FAKE=''
while [ $# -gt 0 ]; do
  case $1 in
    --poll) { [ $# -ge 2 ] && [[ $2 =~ ^[1-9][0-9]*$ ]]; } || usage; POLL=$2; shift 2 ;;
    --fake) { [ $# -ge 2 ] && [ -n "$2" ] && [ -f "$2" ]; } || usage; FAKE=$2; shift 2 ;;
    *) usage ;;
  esac
done
BOX_WAIT=${Z0_BOX_WAIT_S:-60}
[[ $BOX_WAIT =~ ^[0-9]+$ ]] || usage
REPOS=${Z0_REPOS_FILE:-C:/eval-authors/r3-repos.json}
BDIR=$ROOT/$B
declare -A ENTRY TC

say() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$BDIR/batch.log"; }
die() { echo "$1"; [ -d "$BDIR" ] && say "$1"; exit "${2:-1}"; }

form=$(cygpath -m "$ROOT")
form=${form%/}
[ "$ROOT" = "$form" ] || die "BATCH $N: root $ROOT must be written as $form"
[[ $ROOT =~ ^[A-Za-z]:/ ]] || die "BATCH $N: root $ROOT must be an absolute path such as C:/z0-runs/r4"
CHECKOUT=$(cygpath -m "$CHECKOUT")
CHECKOUT=${CHECKOUT%/}
export Z0_CHECKOUT=$CHECKOUT
# The launcher command holds these inside single quotes, so a space or a quote in one would split or break its argv.
plain() { [[ $2 != *[\ \']* ]] || die "BATCH $N: $1 $2 holds a space or a single quote, which the launcher command cannot carry"; }
plain root "$ROOT"
plain checkout "$CHECKOUT"
plain 'script folder' "$HERE"
[ -z "$FAKE" ] || plain --fake "$FAKE"
[[ ${Z0_GRACE_S:-600} =~ ^[0-9]+$ ]] || die "BATCH $N: Z0_GRACE_S ${Z0_GRACE_S} must be a whole number of seconds"
# Z0_REPOS_FILE swaps the toolchain table, so only a dry root may use it, as -BoxCheck is dry only.
[ -z "${Z0_REPOS_FILE:-}" ] || [ -f "$ROOT/DRYRUN" ] || die "BATCH $N: Z0_REPOS_FILE is set, but $ROOT holds no DRYRUN file; only a dry root may use it"
[ -f "$CHECKOUT/scripts/token-eval/z0-unit-record.mjs" ] || die "BATCH $N: $CHECKOUT holds no scripts/token-eval/z0-unit-record.mjs"
. "$HERE/s4-units.sh"

# Writes `<text>` and a line feed to `<file>` whole: older temps removed, a temp of this process, then a rename tried five times 0.5 s apart (a busy destination); returns 1 when it never lands.
write_whole() {
  local try
  rm -f "$1".tmp-* 2> /dev/null
  printf '%s\n' "$2" > "$1.tmp-$$" 2> /dev/null || return 1
  for try in 1 2 3 4 5; do
    mv -fT "$1.tmp-$$" "$1" 2> /dev/null && return 0
    sleep 0.5
  done
  rm -f "$1.tmp-$$" 2> /dev/null
  return 1
}
# A whole write whose failure stops the batch with a named line: no DONE prints without its END, and no marker logs without its file.
write_or_die() {
  local what=$1 rc
  write_whole "$2" "$3"
  rc=$?
  [ "$rc" = 0 ] || die "BATCH $N $what FAILED: write ${2##*/} exit $rc"
}
# A marker that exists is left as it is.
write_marker() {
  [ -f "$BDIR/done/$1" ] && return 0
  mkdir -p "$BDIR/done" 2> /dev/null
  write_or_die MARKER "$BDIR/done/$1" "$2"
  say "marker $1 $2"
}
last_line() { LAST=$(tr -d '\r' < "$1" 2> /dev/null | grep -v '^[[:space:]]*$' | tail -n 1); }
first_line() { LAST=$(tr -d '\r' < "$1" 2> /dev/null | grep -v '^[[:space:]]*$' | head -n 1); }
scan() { units_scan || die "BATCH $N: process scan failed: $UNITS_ERR"; }

# Runs one CLI of the checkout, logging argv, exit code and last line; its output is CMD_OUT and its exit code CMD_RC.
run_cmd() {
  local cli=$1
  shift
  CMD_OUT=$(node "$CHECKOUT/scripts/token-eval/$cli.mjs" "$@" 2>&1 < /dev/null)
  CMD_RC=$?
  CMD_OUT=${CMD_OUT//$'\r'/}
  say "cmd $cli $* exit $CMD_RC: ${CMD_OUT##*$'\n'}"
}
# One end-phase command; any failure stops the batch.
end_cmd() {
  run_cmd "$@"
  [ "$CMD_RC" = 0 ] || die "BATCH $N END FAILED: $1 exit $CMD_RC"
}

current_of() { if [ -d "$1-a3" ]; then CUR=$1-a3; elif [ -d "$1-a2" ]; then CUR=$1-a2; else CUR=$1; fi; }
next_retry() { case $1 in *-a2) NEXT=${1%-a2}-a3 ;; *-a3) NEXT=$1 ;; *) NEXT=$1-a2 ;; esac; }
state_of() {
  local out
  out=$(unit_state "$1") || die "BATCH $N: ${out#"state error $1 "}"
  STATE=${out#state }
  STATE=${STATE%% *}
}
toolchain_of() {
  [ -n "${TC[$1]}" ] && return 0
  TC[$1]=$(ur toolchain "$1" "$REPOS" 2>&1 < /dev/null) || die "BATCH $N: ${TC[$1]%%$'\n'*}"
}

# ------------------------------------------------------------------------------------------------ start
[ -f "$BDIR/ADMITTED" ] || die "BATCH $N: no ADMITTED; run it through s4-drive.sh"
say "repos file $REPOS"
if [ "$N" = raise ]; then
  [ -f "$ROOT/raise/max-seed.json" ] || die "BATCH raise: no raise/max-seed.json; run step 6 through s4-drive.sh"
  out=$(ur max-seed "$ROOT" 2>&1) || die "BATCH raise: ${out%%$'\n'*}"
  MAXSEED=${out#max-seed }
fi
if [ -f "$BDIR/END" ]; then
  line=$(< "$BDIR/END")
  die "$line" 0
fi
scan
line=$(batch_lines "$ROOT" | head -n 1)
[ -z "$line" ] || die "BATCH $N: s4-batch.sh ${line%% *} already runs on $ROOT"
if [ "$N" = raise ] && [ "$MAXSEED" -le 3 ]; then
  [ -f "$ROOT/seed-rule.json" ] || die "BATCH raise: $ROOT/seed-rule.json is missing"
  write_or_die NONE "$ROOT/raise/NONE" "$(sha256sum "$ROOT/seed-rule.json" | cut -d' ' -f1)"
  write_or_die END "$BDIR/END" 'BATCH raise DONE: 0 runs'
  die 'BATCH raise DONE: 0 runs' 0
fi
out=$(ur keys "$ROOT" "$N" 2>&1) || die "BATCH $N: ${out%%$'\n'*}"
readarray -t KEYS <<< "$out"
# The arms line of one `z0-unit-record arms` call in ARMS_OUT; a failure stops the batch with that tool's line, never an empty -Arms.
arms_of() { ARMS_OUT=$(ur arms "$@" 2>&1 < /dev/null) || die "BATCH $N: ${ARMS_OUT%%$'\n'*}"; }
arms_of first "$N"
ARMS_FIRST=$ARMS_OUT

# ------------------------------------------------------------------------------------------------ phase start
wait_quiet() {
  local lines
  while :; do
    scan
    stop_finished "$BDIR"
    lines=$(root_lines "$ROOT")
    [ -z "$lines" ] && return 0
    say "wait for ${lines//$'\n'/, }"
    sleep "$POLL"
  done
}

# Puts a unit that is not done into the queue (a failed one in its next retry folder), or into SPENT when -a3 failed.
queue_unit() {
  local kind=$1 k=$2 seed=$3 cur=$4 target=$4
  case $5 in
    none) ;;
    failed)
      if [[ $cur == *-a3 ]]; then SPENT+=("${cur##*/}"); return 0; fi
      next_retry "$cur"
      target=$NEXT ;;
    *) return 0 ;;
  esac
  if [ "$kind" = first ]; then FIRST_Q+=("$kind|$k|$target|$seed"); else RERUN_Q+=("$kind|$k|$target|$seed"); fi
}

# The markers of one key: its first run's, then (while done/<k> is absent) the leak list and each rerun's, and done/<k> last.
settle_key() {
  local k=$1 first seeds s pending=0
  [ -f "$BDIR/done/$k" ] && return 0
  if [ ! -f "$BDIR/done/$k-w$W" ]; then
    current_of "$BDIR/$k-w$W"
    state_of "$CUR"
    [ "$STATE" = done ] || { queue_unit first "$k" 0 "$CUR" "$STATE"; return 0; }
    write_marker "$k-w$W" "${CUR##*/}"
  fi
  first=$BDIR/$(< "$BDIR/done/$k-w$W")
  run_cmd z0-leaks --design r4 --runs "$first/run/runs.jsonl" --plan "$first/run/plan.json" --out "$first/leaks.json"
  [ "$CMD_RC" = 0 ] || die "BATCH $N LEAKS FAILED: $k z0-leaks exit $CMD_RC"
  seeds=$(ur seeds "$first/leaks.json" 2>&1) || die "BATCH $N: ${seeds%%$'\n'*}"
  for s in $seeds; do
    [ -f "$BDIR/done/$k-e$s" ] && continue
    current_of "$BDIR/$k-e$s"
    state_of "$CUR"
    if [ "$STATE" = done ]; then write_marker "$k-e$s" "${CUR##*/}"; else queue_unit rerun "$k" "$s" "$CUR" "$STATE"; pending=1; fi
  done
  [ "$pending" = 0 ] && write_marker "$k" "${first##*/}"
  return 0
}

phase_start() {
  local f k
  wait_quiet
  for f in "$BDIR"/*/run/runs.regraded.jsonl; do [ -e "$f" ] && die "BATCH $N: $f exists; round 4 never reads runs.regraded.jsonl"; done
  FIRST_Q=() RERUN_Q=() SPENT=()
  for k in "${KEYS[@]}"; do settle_key "$k"; done
  for f in "${SPENT[@]}"; do echo "BATCH $N RETRIES SPENT: $f"; say "BATCH $N RETRIES SPENT: $f"; done
  [ ${#SPENT[@]} -eq 0 ] || exit 1
  QUEUE=("${FIRST_Q[@]}" "${RERUN_Q[@]}")
  [ ${#QUEUE[@]} -eq 0 ] || return 0
  for k in "${KEYS[@]}"; do [ -f "$BDIR/done/$k" ] || die "BATCH $N: $k has no done/$k marker and nothing to launch"; done
}

# ------------------------------------------------------------------------------------------------ a phase
# `hold` or `ok` from the hook hold over every runs file of the root; no runs file yet reads ok without a call (round 3 prereg line 73, R102).
read_hold() {
  local runs=() f line
  for f in "$ROOT"/batch1/*/run/runs.jsonl "$ROOT"/batch2/*/run/runs.jsonl "$ROOT"/raise/*/run/runs.jsonl; do [ -f "$f" ] && runs+=(--runs "$f"); done
  if [ ${#runs[@]} -eq 0 ]; then
    HOLD=ok line='ok, no runs file yet'
  else
    run_cmd z0-hookhold --design r4 "${runs[@]}" --hold
    line=${CMD_OUT##*$'\n'}
    case $line in "hold "*) HOLD=hold ;; "ok "*) HOLD=ok ;; *) die "BATCH $N HOLD FAILED: $line" ;; esac
    [ "$CMD_RC" = 0 ] || die "BATCH $N HOLD FAILED: $line"
  fi
  [ "$line" = "$LASTHOLD" ] || say "hold read: $line"
  LASTHOLD=$line
}

# The runner and launcher flags of one queued unit, in FLAGS.
unit_flags() {
  local kind=$1 k=$2 folder=$3 seed=$4 first
  FLAGS=(-Checkout "$CHECKOUT" -Root "$ROOT" -Batch "$N" -Key "$k" -Toolchain "${TC[$k]}" -Folder "$folder")
  case $folder in *-a[23]) FLAGS+=(-Retry "${folder##*-a}") ;; esac
  [ -z "$FAKE" ] || FLAGS+=(-FakeAgent "$FAKE")
  if [ "$kind" = first ]; then
    if [ "$N" = raise ]; then arms_of first raise; FLAGS+=(-Arms "$ARMS_OUT" -SeedRule "$ROOT/seed-rule.json" -MaxSeed "$MAXSEED"); else FLAGS+=(-Arms "$ARMS_FIRST" -Seeds 3); fi
  else
    first=$BDIR/$(< "$BDIR/done/$k-w$W")
    arms_of rerun "$first" "$seed"
    FLAGS+=(-Arms "$ARMS_OUT" -OnlySeed "$seed")
    [ "$N" != raise ] || FLAGS+=(-SeedRule "$ROOT/seed-rule.json" -MaxSeed "$MAXSEED")
  fi
}

# Starts s4-run.ps1 detached through Start-Process, as s3x-run.ps1:28 starts its runner, so it outlives this batch; the new pid comes back on stdout.
launch_unit() {
  local kind k folder seed lit='' a pid
  IFS='|' read -r kind k folder seed <<< "$1"
  toolchain_of "$k"
  unit_flags "$kind" "$k" "$folder" "$seed"
  mkdir -p "$folder"
  # A launch.txt left by an earlier launch must never read as this one's output.
  rm -f "$folder/launch.txt" "$folder/launch.err" "$folder/start.out" "$folder/start.err" 2> /dev/null
  for a in "${FLAGS[@]}"; do lit+=",'$a'"; done
  # The pid comes back through a file, not a pipe: the launcher inherits this call's handles, and a pipe stays open until it ends.
  powershell -NoProfile -Command "\$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$HERE/s4-run.ps1'$lit -RedirectStandardOutput '$folder/launch.txt' -RedirectStandardError '$folder/launch.err' -WindowStyle Hidden -PassThru; \$p.Id" < /dev/null > "$folder/start.out" 2> "$folder/start.err"
  pid=$(tr -d '\r\n' < "$folder/start.out" 2> /dev/null)
  if ! [[ $pid =~ ^[0-9]+$ ]]; then
    first_line "$folder/start.err"
    die "BATCH $N LAUNCH FAILED: ${folder##*/} Start-Process gave no pid: ${LAST:-no error text}"
  fi
  say "launch ${folder##*/} pid $pid ${FLAGS[*]}"
  ENTRY[$folder]=$1
  LIVE+=("$folder")
  case " ${PHASE_UNITS[*]} " in *" $folder "*) ;; *) PHASE_UNITS+=("$folder") ;; esac
}

launch_ready() {
  local width entry
  [ ${#QUEUE[@]} -gt 0 ] || return 0
  read_hold
  [ "$HOLD" = ok ] || return 0
  width=3
  [ -f "$ROOT/width.txt" ] && width=$(tr -dc '0-9' < "$ROOT/width.txt")
  [ -n "$width" ] || width=3
  while [ ${#QUEUE[@]} -gt 0 ] && [ ${#LIVE[@]} -lt "$width" ]; do
    entry=${QUEUE[0]}
    QUEUE=("${QUEUE[@]:1}")
    launch_unit "$entry"
  done
}

# A launched unit that is no longer alive: its launcher's last line is logged, and a `box check failed` before any runner goes back to the head of the queue after the wait.
unit_ended() {
  local f=$1
  last_line "$f/launch.txt"
  say "unit ${f##*/} $STATE, launcher last line: ${LAST:-no output}"
  [ "$STATE" = none ] || return 0
  if ! grep -q '^run pid ' "$f/launch.txt" 2> /dev/null && [[ $LAST == *"box check failed"* ]]; then
    say "box check failed for ${f##*/}, waiting ${BOX_WAIT}s"
    sleep "$BOX_WAIT"
    QUEUE=("${ENTRY[$f]}" "${QUEUE[@]}")
  fi
}

run_phase() {
  local f keep
  LIVE=() PHASE_UNITS=()
  while :; do
    scan
    stop_finished "$BDIR"
    keep=()
    for f in "${LIVE[@]}"; do
      state_of "$f"
      if [ "$STATE" = alive ]; then keep+=("$f"); else unit_ended "$f"; fi
    done
    LIVE=("${keep[@]}")
    launch_ready
    [ ${#QUEUE[@]} -eq 0 ] && [ ${#LIVE[@]} -eq 0 ] && return 0
    sleep "$POLL"
  done
}

# Each unit launched in the phase: a failure line per failed or never-started one; with none, the next phase starts in the same call.
after_phase() {
  local f code rc=3 lines=() name
  for f in "${PHASE_UNITS[@]}"; do
    state_of "$f"
    name=${f##*/}
    case $STATE in
      failed)
        if [[ $f == *-a3 ]]; then lines+=("BATCH $N RETRIES SPENT: $name"); rc=1; else
          code=$(tr -dc '0-9' < "$f/run/exit.txt" 2> /dev/null)
          lines+=("BATCH $N FAILED: $name runner exit ${code:-unknown}")
        fi ;;
      none)
        last_line "$f/launch.txt"
        lines+=("BATCH $N LAUNCH FAILED: $name ${LAST:-no output}")
        rc=1 ;;
    esac
  done
  [ ${#lines[@]} -gt 0 ] || return 0
  for f in "${lines[@]}"; do echo "$f"; say "$f"; done
  exit $rc
}

# ------------------------------------------------------------------------------------------------ G5
# The G5 folders: each key's first run, then its leak reruns by seed; RERUNS counts the reruns.
g5_list() {
  local k first s seeds
  G5_DIR=() G5_KEY=() RERUNS=0
  for k in "${KEYS[@]}"; do
    first=$BDIR/$(< "$BDIR/done/$k")
    G5_DIR+=("$first") G5_KEY+=("$k")
    seeds=$(ur seeds "$first/leaks.json" 2>&1) || die "BATCH $N: ${seeds%%$'\n'*}"
    for s in $seeds; do G5_DIR+=("$BDIR/$(< "$BDIR/done/$k-e$s")") G5_KEY+=("$k"); RERUNS=$((RERUNS + 1)); done
  done
}

g5_wait() {
  while :; do
    scan
    stop_finished "$BDIR"
    unit_alive "$1" || return 0
    say "wait for ${1##*/}"
    sleep "$POLL"
  done
}

# A call taken as done must have its sealed files read through readSealed (Record model): a missing or changed one stops the batch.
g5_sealed() {
  local out
  out=$(ur sealed "$1" "$2" 2>&1 < /dev/null) || die "BATCH $N SEALED FAILED: ${1##*/} $2 ${out%%$'\n'*}"
}

# One G5 call on one folder: wait for its processes, remove a stale lock, skip a done call, run s4-regrade.ps1 in the foreground, then read the log.
# A draw whose key exists but whose call has no record was killed between the two: it is skipped, and the score call reads the key.
g5_call() {
  local folder=$1 k=$2 call=$3 name=${1##*/} lock=$1/run/g5/regrade.lock tries=0 out rc rec s held key=''
  case $call in
    reader-draw) key=$folder/run/g5/sealed/reader-r1.key.json ;;
    stored-draw) key=$folder/run/g5/sealed/stored.key.json ;;
  esac
  if [ -n "$key" ] && [ -f "$key" ]; then
    [[ $(ur call "$folder" "$call") == "record done "* ]] && g5_sealed "$folder" "$call"
    return 0
  fi
  toolchain_of "$k"
  while :; do
    if [[ $(ur call "$folder" "$call") == "record done "* ]]; then g5_sealed "$folder" "$call"; return 0; fi
    g5_wait "$folder"
    if [ -f "$lock" ]; then
      held=$(tr -dc '0-9' < "$lock")
      rm -f "$lock"
      say "$name stale regrade lock $held removed"
    fi
    s=$(call_state "$folder" "$call") || die "BATCH $N: ${s#"call error $folder $call "}"
    if [[ $s == "call done "* ]]; then g5_sealed "$folder" "$call"; return 0; fi
    powershell -NoProfile -ExecutionPolicy Bypass -File "$HERE/s4-regrade.ps1" -Checkout "$CHECKOUT" -Root "$ROOT" -Key "$k" -Toolchain "${TC[$k]}" -Folder "$folder" -Call "$call" < /dev/null > "$folder/g5-$call.launch.txt" 2>&1
    rc=$?
    last_line "$folder/g5-$call.launch.txt"
    out=$LAST
    say "call $call $name launcher exit $rc: $out"
    g5_wait "$folder"
    s=$(call_state "$folder" "$call") || die "BATCH $N: ${s#"call error $folder $call "}"
    if [[ $s == "call done "* ]]; then g5_sealed "$folder" "$call"; return 0; fi
    rec=$(ur call "$folder" "$call" 2>&1 < /dev/null)
    if [ "$call" = regrade ] && [[ $rec == *" error-rows "* ]]; then
      tries=$((tries + 1))
      [ "$tries" -lt 2 ] || die "BATCH $N REGRADE FAILED: $name regrade ${rec##* } error rows"
      continue
    fi
    last_line "$folder/g5-$call.err"
    die "BATCH $N REGRADE FAILED: $name $call ${LAST:-$out}"
  done
}

# After every folder's draws, each labels file must hold a label on every row.
g5_labels() {
  local i f rec empty=()
  for i in "${!G5_DIR[@]}"; do
    for f in reader-r1 stored; do
      rec=$(ur labels "${G5_DIR[$i]}/run/g5/$f/labels.tsv" 2>&1 < /dev/null) || die "BATCH $N: ${rec%%$'\n'*}"
      [[ $rec == "labels empty "* ]] && empty+=("${G5_DIR[$i]}/run/g5/$f/labels.tsv")
    done
  done
  [ ${#empty[@]} -eq 0 ] || die "BATCH $N LABELS: ${#empty[@]} files to fill: ${empty[*]}" 7
}

g5() {
  local i call
  g5_list
  for i in "${!G5_DIR[@]}"; do for call in regrade reader-draw stored-draw; do g5_call "${G5_DIR[$i]}" "${G5_KEY[$i]}" "$call"; done; done
  g5_labels
  for i in "${!G5_DIR[@]}"; do for call in reader-score stored-score grading; do g5_call "${G5_DIR[$i]}" "${G5_KEY[$i]}" "$call"; done; done
}

# ------------------------------------------------------------------------------------------------ end phase
end_merges() {
  local k first s reruns
  for k in "${KEYS[@]}"; do
    first=$BDIR/$(< "$BDIR/done/$k")
    reruns=()
    for s in $(ur seeds "$first/leaks.json"); do reruns+=(--rerun-of "$BDIR/$(< "$BDIR/done/$k-e$s")/run"); done
    [ ${#reruns[@]} -eq 0 ] || end_cmd z0-merge --first "$first/run" --leaks "$first/leaks.json" --first-off-pin "$first/off-pin.json" "${reruns[@]}" --out "$ROOT/merged/$B/$k-w$W"
  done
}

# Batch 1 only: the ledger over every batch 1 run folder that holds an out mark, then the sealed scale (a second call leaves scale.json as it was).
end_scale() {
  local d dirs=() led
  for d in "$ROOT"/batch1/*/run; do
    { [ -e "$d/runs.jsonl" ] || [ -e "$d/plan.json" ] || [ -e "$d/warmups" ] || [ -e "$d/ABANDONED" ]; } && dirs+=("$d")
  done
  end_cmd z0-ledger --design r4 --prices "$ROOT/prices.json" --run "${dirs[@]}"
  led=$(grep '^LEDGER ' <<< "$CMD_OUT" | tail -n 1)
  [ -n "$led" ] || die "BATCH $N END FAILED: z0-ledger exit $CMD_RC"
  end_cmd z0-budget scale --batch1-ledger "${led#LEDGER }" --spend-basis "$ROOT/spend-basis.json" --pins "$ROOT/pins-r4.json" --pilot "$ROOT/pilot.json" --out "$ROOT/scale.json"
}

end_phase() {
  local i grading=() hold=() r regrades=0 line
  wait_quiet
  for i in "${!G5_DIR[@]}"; do
    end_cmd g1-pins --run "${G5_DIR[$i]}/run" --pins "$ROOT/pins-r4.json" --plan-of "${G5_DIR[$i]}/run" --out "${G5_DIR[$i]}/off-pin.json"
    grading+=(--grading "${G5_DIR[$i]}/run/grading.json")
  done
  end_merges
  end_cmd z0-read-set --root "$ROOT" --batches "$BATCHES" --out "$BDIR/read-set.txt"
  for r in $(grep -o -- '--runs [^ ]*' "$BDIR/read-set.txt" | cut -d' ' -f2); do hold+=(--runs "$r"); done
  end_cmd z0-hookhold --design r4 "${hold[@]}" --sensitivity "$BDIR/drop-list.json"
  end_cmd z0-grading-combine "${grading[@]}" --out "$BDIR/grading.json"
  [ "$N" != 1 ] || end_scale
  for i in "${!G5_DIR[@]}"; do [[ $(ur call "${G5_DIR[$i]}" grading 2> /dev/null) == "record done "* ]] && regrades=$((regrades + 1)); done
  line="BATCH $N DONE: ${#KEYS[@]} runs, $RERUNS reruns, $regrades regrades"
  write_or_die END "$BDIR/END" "$line"
  die "$line" 0
}

while :; do
  phase_start
  [ ${#QUEUE[@]} -gt 0 ] || break
  run_phase
  after_phase
done
g5
end_phase
