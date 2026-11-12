#!/usr/bin/env bash
# Round 4 run driver (plan: Run steps after the freeze, Failure model): one call is one step. The order rule, stop ids and log entries live in z0-drive.mjs.
# It starts no bash background job: each launcher goes through Start-Process, so no fork of it outlives the command that made it.
PATH=/usr/bin:/mingw64/bin:$PATH
HERE=$(cygpath -m "$(dirname "$0")")
USAGE='usage: s4-drive.sh <plans|smoke|1|2|3|4|5|6|7|8|founder-go|cause|stage-checks> <checkout> <root> [--approved <usd>] [--fake <knobs>] [--attempt <n>] [--poll <s>] [--level-sims <n>] [--rule <file>] [--print]
       founder-go adds --question <whole-run|power|pilot|figure> [--figure <usd>] [--stop] --words "<words>"; cause adds --kind <version|other|no-version> --words "<words>"'
usage() { echo "$USAGE"; exit 1; }
# An input error exits 1 with no log entry, so a mistyped root gets no file.
refuse() { echo "$1"; exit 1; }

[ $# -ge 3 ] || usage
STEP=$1 CHECKOUT=$2 ROOT=$3
shift 3
case $STEP in plans | smoke | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | founder-go | cause | stage-checks) ;; *) usage ;; esac
APPROVED=2140 ATTEMPT=1 POLL=300 FAKE='' SIMS='' RULE='' PRINT=0 QUESTION='' FIGURE='' STOP=0 WORDS='' KIND=''
while [ $# -gt 0 ]; do
  case $1 in
    --print) PRINT=1; shift ;;
    --stop) STOP=1; shift ;;
    --approved | --fake | --attempt | --poll | --level-sims | --rule | --question | --figure | --words | --kind)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || usage
      case $1 in
        --approved) [[ $2 =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || usage; APPROVED=$2 ;;
        --attempt) [[ $2 =~ ^[1-9][0-9]*$ ]] || usage; ATTEMPT=$2 ;;
        --poll) [[ $2 =~ ^[1-9][0-9]*$ ]] || usage; POLL=$2 ;;
        --level-sims) [[ $2 =~ ^[1-9][0-9]*$ ]] || usage; SIMS=$2 ;;
        --figure) [[ $2 =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || usage; FIGURE=$2 ;;
        --fake) FAKE=$2 ;;
        --rule) RULE=$2 ;;
        --question) QUESTION=$2 ;;
        --words) WORDS=$2 ;;
        --kind) KIND=$2 ;;
      esac
      shift 2 ;;
    *) usage ;;
  esac
done
case $STEP in
  founder-go)
    [ -z "$KIND" ] || usage
    case $QUESTION in whole-run | power | pilot | figure) ;; *) usage ;; esac
    [ -n "$WORDS" ] || usage
    if [ "$STOP" = 0 ] && { [ "$QUESTION" = figure ] || [ "$QUESTION" = pilot ]; } && [ -z "$FIGURE" ]; then usage; fi ;;
  cause)
    [ -z "$QUESTION$FIGURE" ] && [ "$STOP" = 0 ] || usage
    case $KIND in version | other | no-version) ;; *) usage ;; esac
    [ -n "$WORDS" ] || usage ;;
  *) [ -z "$QUESTION$FIGURE$WORDS$KIND" ] && [ "$STOP" = 0 ] || usage ;;
esac

# The root in one form, cygpath -m with no trailing slash, and only that form goes on to a command.
RAW=$ROOT
ROOT=$(cygpath -m "$RAW" 2> /dev/null) || refuse "DRIVE: cygpath cannot read the root $RAW"
while [ "${ROOT%/}" != "$ROOT" ]; do ROOT=${ROOT%/}; done
ROOT=${ROOT^}
[[ $ROOT =~ ^[A-Z]:/ ]] || refuse "DRIVE: root $RAW must be an absolute path such as C:/z0-runs/r4"
CHECKOUT=$(cygpath -m "$CHECKOUT" 2> /dev/null) || refuse "DRIVE: cygpath cannot read the checkout $CHECKOUT"
while [ "${CHECKOUT%/}" != "$CHECKOUT" ]; do CHECKOUT=${CHECKOUT%/}; done
# The launcher command holds these inside single quotes, so a space or a quote in one would split or break its argv.
plain() { [[ $2 != *[\ \']* ]] || refuse "DRIVE: $1 $2 holds a space or a single quote, which the launcher command cannot carry"; }
plain root "$ROOT"
plain checkout "$CHECKOUT"
plain 'script folder' "$HERE"
[ -d "$ROOT" ] || refuse "DRIVE: root $ROOT is not a folder"
[ -f "$CHECKOUT/scripts/token-eval/z0-drive.mjs" ] || refuse "DRIVE: $CHECKOUT holds no scripts/token-eval/z0-drive.mjs"
DRY=0
[ -f "$ROOT/DRYRUN" ] && DRY=1
case $STEP in smoke | 1 | 3 | 5 | 6) LAUNCHES=1 ;; *) LAUNCHES=0 ;; esac
if [ "$DRY" = 1 ]; then
  { [ "$LAUNCHES" = 0 ] || [ -n "$FAKE" ]; } || refuse "DRIVE: $ROOT is a DRYRUN root; pass --fake <knobs>"
else
  [ -z "$FAKE" ] || refuse "DRIVE: --fake is for a DRYRUN root; $ROOT has no DRYRUN file"
  [ -z "$RULE$SIMS" ] || refuse "DRIVE: --rule and --level-sims are for a DRYRUN root; $ROOT has no DRYRUN file"
  # Z0_DRIVE_STUBS swaps the CLIs, so only a dry root may use it, as s4-batch.sh does for Z0_REPOS_FILE.
  [ -z "${Z0_DRIVE_STUBS:-}" ] || refuse "DRIVE: Z0_DRIVE_STUBS is set, but $ROOT holds no DRYRUN file; only a dry root may use it"
  # Z0_BOX_CHECK stands in for the launcher's box check, which s4-run.ps1 refuses on a real root too.
  [ -z "${Z0_BOX_CHECK:-}" ] || refuse "DRIVE: Z0_BOX_CHECK is set, but $ROOT holds no DRYRUN file; only a dry root may use it"
fi
if [ -n "$FAKE" ]; then
  [ -f "$FAKE" ] || refuse "DRIVE: --fake $FAKE is not a file"
  plain --fake "$FAKE"
fi
if [ -n "${Z0_BOX_CHECK:-}" ]; then
  [ -f "$Z0_BOX_CHECK" ] || refuse "DRIVE: Z0_BOX_CHECK $Z0_BOX_CHECK is not a file"
  plain Z0_BOX_CHECK "$Z0_BOX_CHECK"
fi
[ -z "$RULE" ] || [ -f "$RULE" ] || refuse "DRIVE: --rule $RULE is not a file"
[[ ${Z0_GRACE_S:-600} =~ ^[0-9]+$ ]] || refuse "DRIVE: Z0_GRACE_S ${Z0_GRACE_S} must be a whole number of seconds"
[ -z "${Z0_DRIVE_STUBS:-}" ] || [ -d "$Z0_DRIVE_STUBS" ] || refuse "DRIVE: Z0_DRIVE_STUBS $Z0_DRIVE_STUBS is not a folder"
export Z0_CHECKOUT=$CHECKOUT
# The listing a batch of this driver runs cannot reach the driver through parent links, so s4-procs.ps1 reads its pid from here; without it a batch waits on its own driver.
# The creation time goes with the pid, so a process that reuses the pid is told apart from this driver.
WINPID=$(< /proc/$$/winpid) || WINPID=
[[ $WINPID =~ ^[0-9]+$ ]] || refuse "DRIVE: cannot read this driver's Windows pid from /proc/$$/winpid"
STARTED=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=$WINPID').CreationDate.ToUniversalTime().Ticks" < /dev/null 2> /dev/null | tr -d '\r') || STARTED=
[[ $STARTED =~ ^[0-9]+$ ]] || refuse "DRIVE: cannot read the creation time of driver pid $WINPID from Win32_Process"
export Z0_DRIVER_WINPID=$WINPID Z0_DRIVER_STARTED=$STARTED
case $STEP in [1-8]) LABEL="step $STEP" ;; *) LABEL=$STEP ;; esac
POETRY=C:/z0-runs/r4/poetry-2.5.1
BASE_COMMIT=04835462b
declare -A TC

say() { [ "$PRINT" = 1 ] || printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$ROOT/drive.log"; }
. "$HERE/s4-units.sh"
zd() { node "$CHECKOUT/scripts/token-eval/z0-drive.mjs" "$@"; }
last_line() { LAST=$(tr -d '\r' 2> /dev/null < "$1" | grep -v '^[[:space:]]*$' | tail -n 1); }
first_line() { LAST=$(tr -d '\r' 2> /dev/null < "$1" | grep -v '^[[:space:]]*$' | head -n 1); }

# ------------------------------------------------------------------------------------------------ the entry
TAG='' COMMIT='' PINS_SHA='' CLAUDE_V='' ENTRY_EXTRA=()
# Appends the step's entry, then exits with its code (a start entry returns). No entry is written when the append itself fails, and that is said.
finish() {
  local code=$1 id=$2 line=$3 args out
  [ "$PRINT" != 1 ] || return 0
  args=(append --root "$ROOT" --step "$STEP" --attempt "$ATTEMPT" --exit "$code")
  [ -z "$id" ] || args+=(--stop-id "$id")
  [ -z "$line" ] || args+=(--line "$line")
  [ -z "$TAG" ] || args+=(--tag "$TAG")
  [ -z "$COMMIT" ] || args+=(--commit "$COMMIT")
  [ -z "$PINS_SHA" ] || [ "$PINS_SHA" = none ] || args+=(--pins-sha256 "$PINS_SHA")
  [ -z "$CLAUDE_V" ] || [ "$CLAUDE_V" = none ] || args+=(--claude-version "$CLAUDE_V")
  out=$(zd "${args[@]}" "${ENTRY_EXTRA[@]}" 2>&1 < /dev/null) || {
    echo "DRIVE: $LABEL could not log its entry: ${out%%$'\n'*}"
    exit 1
  }
  say "entry $LABEL exit $code${id:+ $id}"
  [ "$id" != start ] || return 0
  exit "$code"
}
# A fault: the line is printed, logged and ends the step with exit 1.
bail() {
  echo "$1"
  finish 1 fault "$1"
}
# A refusal of the order or the tag: the line is printed, logged under stop id $1 and ends the step with exit 3.
stop3() { echo "$2"; finish 3 "$1" "$2"; }

# ------------------------------------------------------------------------------------------------ commands
# Each command is `NAME args`: its output is printed, CMD_RC and CMD_LAST are set, and under --print only the line is printed, as the first call of a fresh root would run it.
CMD_RC=0 CMD_LAST='' CMD_NAME=''
exec_cmd() {
  local shown=$1 name=$2
  shift 2
  CMD_NAME=$name
  if [ "$PRINT" = 1 ]; then
    printf '%s' "$shown"
    printf ' %s' "$@"
    printf '\n'
    CMD_RC=0 CMD_LAST='' CMD_OUT=''
    return 0
  fi
  CMD_OUT=$("${RUN[@]}" "$@" 2>&1 < /dev/null)
  CMD_RC=$?
  CMD_OUT=${CMD_OUT//$'\r'/}
  [ -z "$CMD_OUT" ] || printf '%s\n' "$CMD_OUT"
  CMD_LAST=$(printf '%s\n' "$CMD_OUT" | grep -v '^[[:space:]]*$' | tail -n 1)
  say "cmd $shown $* exit $CMD_RC: $CMD_LAST"
}
# A CLI of the checkout; a stub in Z0_DRIVE_STUBS replaces it on a dry root and is logged.
cli() {
  local name=$1 file
  shift
  file=$CHECKOUT/scripts/token-eval/$name.mjs
  if [ -n "${Z0_DRIVE_STUBS:-}" ] && [ -f "$Z0_DRIVE_STUBS/$name.mjs" ]; then
    file=$Z0_DRIVE_STUBS/$name.mjs
    [ "$PRINT" = 1 ] || echo "stub $name" >> "$ROOT/stubs.log"
  fi
  RUN=(node "$file")
  exec_cmd "$name.mjs" "$name" "$@"
}
script() {
  local name=$1
  shift
  RUN=(bash "$HERE/$name.sh")
  exec_cmd "$name.sh" "$name" "$@"
}
launcher() {
  RUN=(powershell -NoProfile -ExecutionPolicy Bypass -File "$HERE/s4-run.ps1")
  exec_cmd s4-run.ps1 s4-run "$@"
}
# After a command: a listed stop ends the step with that command's exit code and last line, any other non-zero exit is a fault. $1 is the command's name in the stop table.
check() {
  local id rc
  [ "$PRINT" != 1 ] || return 0
  [ "$CMD_RC" != 0 ] || return 0
  id=$(zd stop-id --root "$ROOT" --step "$STEP" --cmd "$1" --exit "$CMD_RC" ${2:+--kind "$2"} 2>&1 < /dev/null)
  rc=$?
  [ "$rc" = 0 ] || bail "DRIVE: $LABEL fault: z0-drive stop-id exit $rc: ${id%%$'\n'*}"
  if [ "$id" = fault ]; then bail "DRIVE: $LABEL fault: $CMD_NAME exit $CMD_RC: $CMD_LAST"; fi
  finish "$CMD_RC" "$id" "$CMD_LAST"
}
done_ok() { finish 0 '' "$CMD_LAST"; }

# Writes `<text>` and a line feed to `<file>` whole: older temps removed, a temp of this process, then a rename tried five times 0.5 s apart; returns 1 when it never lands.
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

# ------------------------------------------------------------------------------------------------ the process scan
scan() { units_scan || refuse "DRIVE: process scan failed: $UNITS_ERR"; }
# Each poll of a wait prints one line per process of the root, as a phase start waits for it.
wait_quiet() {
  local lines pid role path
  while :; do
    scan
    stop_finished "$ROOT"
    lines=$(root_lines "$ROOT")
    [ -z "$lines" ] && return 0
    while read -r pid role path; do echo "DRIVE: waiting for $pid $role"; done <<< "$lines"
    sleep "$POLL"
  done
}
# A driver is a pid that a call line of drive.log names; the forks of one bash script all show its command line, and those of a killed driver are not a driver.
orphan_check() {
  local pid
  pid=$(root_lines "$ROOT" | while read -r p role path; do [ "$role" = s4-drive ] && grep -q " pid $p\$" "$ROOT/drive.log" 2> /dev/null && echo "$p"; done | sort -n | head -n 1)
  [ -z "$pid" ] || refuse "DRIVE: driver $pid already runs on $ROOT"
}

# ------------------------------------------------------------------------------------------------ units and phases
current_of() { if [ -d "$1-a3" ]; then CUR=$1-a3; elif [ -d "$1-a2" ]; then CUR=$1-a2; else CUR=$1; fi; }
next_retry() { case $1 in *-a2) NEXT=${1%-a2}-a3 ;; *-a3) NEXT=$1 ;; *) NEXT=$1-a2 ;; esac; }
state_of() {
  local out
  out=$(unit_state "$1") || bail "DRIVE: $LABEL: ${out#"state error $1 "}"
  STATE=${out#state }
  STATE=${STATE%% *}
}
# A unit folder is one that holds the runner's run/ or its run.log, which s4-run.ps1 also refuses to plan over; dry plans under dry/ do not count.
unit_started() { local f; for f in "$1" "$1-a2" "$1-a3"; do { [ -d "$f/run" ] || [ -f "$f/run.log" ]; } && return 0; done; return 1; }
any_started() {
  local u
  for u in "$@"; do unit_started "$u" && return 0; done
  return 1
}
started_in() {
  local d
  for d in "$ROOT/$1"/*; do unit_started "$d" && return 0; done
  return 1
}
tc_of() {
  local out
  if [ -z "${TC[$1]:-}" ]; then
    if out=$(ur toolchain "$1" "$ROOT/pilot-tasks/repos.json" 2>&1 < /dev/null); then TC[$1]=$out
    elif [ "$PRINT" = 1 ]; then TC[$1]='<t>'
    else bail "DRIVE: $LABEL: ${out%%$'\n'*}"; fi
  fi
}
# A unit spec is `batch|key|folder|arms|extra launcher flags`; its flags go to FLAGS for the folder it launches in.
unit_flags() {
  local batch key base arms extra more=()
  IFS='|' read -r batch key base arms extra <<< "$1"
  tc_of "$key"
  FLAGS=(-Checkout "$CHECKOUT" -Root "$ROOT" -Batch "$batch" -Key "$key" -Arms "$arms" -Toolchain "${TC[$key]}" -Folder "$2" -Seeds 1 -Attempt "$ATTEMPT")
  read -ra more <<< "$extra"
  FLAGS+=("${more[@]}")
  case $2 in *-a[23]) FLAGS+=(-Retry "${2##*-a}") ;; esac
  [ -z "$FAKE" ] || FLAGS+=(-FakeAgent "$FAKE")
  [ -z "${Z0_BOX_CHECK:-}" ] || FLAGS+=(-BoxCheck "$Z0_BOX_CHECK")
}
# Starts s4-run.ps1 detached through Start-Process, as s4-batch.sh does, so it outlives this call; the new pid comes back through a file.
launch_unit() {
  local folder=$2 lit='' a pid
  unit_flags "$1" "$folder"
  mkdir -p "$folder" || bail "DRIVE: $LABEL: cannot make $folder"
  # A launch.txt left by an earlier launch must never read as this one's output.
  rm -f "$folder/launch.txt" "$folder/launch.err" "$folder/start.out" "$folder/start.err" 2> /dev/null
  for a in "${FLAGS[@]}"; do lit+=",'$a'"; done
  powershell -NoProfile -Command "\$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$HERE/s4-run.ps1'$lit -RedirectStandardOutput '$folder/launch.txt' -RedirectStandardError '$folder/launch.err' -WindowStyle Hidden -PassThru; \$p.Id" < /dev/null > "$folder/start.out" 2> "$folder/start.err"
  pid=$(tr -d '\r\n' 2> /dev/null < "$folder/start.out")
  if ! [[ $pid =~ ^[0-9]+$ ]]; then
    first_line "$folder/start.err"
    bail "DRIVE: $LABEL launch failed: ${folder##*/} Start-Process gave no pid: ${LAST:-no error text}"
  fi
  say "launch ${folder##*/} pid $pid ${FLAGS[*]}"
}
# Polls until the unit is no longer alive; the finished-runner stop applies at each poll.
wait_unit() {
  while :; do
    sleep "$POLL"
    scan
    stop_finished "$ROOT"
    state_of "$1"
    [ "$STATE" = alive ] || return 0
  done
}

# The units of a phase that are not done: QUEUE holds `spec|folder|N` (N a first launch, R a retry), SPENT the -a3 folders that failed.
phase_scan() {
  local spec base cur
  QUEUE=() SPENT=()
  for spec in "${UNITS[@]}"; do
    IFS='|' read -r _ _ base _ <<< "$spec"
    current_of "$base"
    cur=$CUR
    state_of "$cur"
    case $STATE in
      done) ;;
      none) QUEUE+=("$spec|$cur|N") ;;
      failed)
        if [[ $cur == *-a3 ]]; then SPENT+=("${cur##*/}"); else next_retry "$cur"; QUEUE+=("$spec|$NEXT|R"); fi ;;
      *) bail "DRIVE: $LABEL unit ${cur##*/} is alive; run the step again" ;;
    esac
  done
  [ ${#SPENT[@]} -eq 0 ] || {
    local s
    for s in "${SPENT[@]}"; do echo "DRIVE: $LABEL retries spent: $s"; done
    ENTRY_EXTRA=(--spent "${SPENT[0]}")
    finish 1 fault "DRIVE: $LABEL retries spent: ${SPENT[0]}"
  }
}
# One unit at a time: launch, wait, go on to the next whatever the first one did; then each launched unit is read.
phase_run() {
  local item spec folder f name code lines=() launched=()
  for item in "${QUEUE[@]}"; do
    spec=${item%|*|*}
    folder=${item%|*}
    folder=${folder##*|}
    launch_unit "$spec" "$folder"
    launched+=("$folder")
    wait_unit "$folder"
  done
  for f in "${launched[@]}"; do
    name=${f##*/}
    state_of "$f"
    case $STATE in
      failed)
        code=$(tr -dc '0-9' 2> /dev/null < "$f/run/exit.txt")
        lines+=("DRIVE: $LABEL unit $name failed, runner exit ${code:-unknown}") ;;
      none)
        last_line "$f/launch.txt"
        lines+=("DRIVE: $LABEL launch failed: $name ${LAST:-no output}") ;;
    esac
  done
  [ ${#lines[@]} -eq 0 ] || {
    printf '%s\n' "${lines[@]}"
    finish 1 fault "${lines[0]}"
  }
}
# Under --print a phase prints the launch of each unit in its first folder.
phase_print() {
  local spec base
  for spec in "${UNITS[@]}"; do IFS='|' read -r _ _ base _ <<< "$spec"; unit_flags "$spec" "$base"; launcher "${FLAGS[@]}"; done
}
phase() {
  if [ "$PRINT" = 1 ]; then phase_print; else phase_scan; phase_run; fi
}

# ------------------------------------------------------------------------------------------------ ledger and admit
outmarked() { [ -e "$1/runs.jsonl" ] || [ -e "$1/plan.json" ] || [ -e "$1/warmups" ] || [ -e "$1/ABANDONED" ]; }
# LEDGER is the last LEDGER line of z0-ledger over RUNS and PRUNS; with no run folder at all it is 0 and nothing runs. A pilot-only root passes its folders as --run (z0-ledger needs one).
ledger_of() {
  if [ "$PRINT" = 1 ]; then LEDGER='<L>'; return 0; fi
  local runs=("${RUNS[@]}") pruns=("${PRUNS[@]}") led
  if [ ${#runs[@]} -eq 0 ]; then runs=("${pruns[@]}"); pruns=(); fi
  if [ ${#runs[@]} -eq 0 ]; then LEDGER=0; return 0; fi
  if [ ${#pruns[@]} -eq 0 ]; then
    cli z0-ledger --design r4 --prices "$ROOT/prices.json" --run "${runs[@]}"
  else
    cli z0-ledger --design r4 --prices "$ROOT/prices.json" --run "${runs[@]}" --pilot-run "${pruns[@]}"
  fi
  check -
  led=$(printf '%s\n' "$CMD_OUT" | grep '^LEDGER ' | tail -n 1)
  [ -n "$led" ] || bail "DRIVE: $LABEL fault: z0-ledger printed no LEDGER line"
  LEDGER=${led#LEDGER }
}
# Every batch, rerun and raise folder as --run; every smoke, pilot and effort folder as --pilot-run.
ledger_all() {
  local d b
  RUNS=() PRUNS=()
  for b in batch1 batch2 raise; do for d in "$ROOT/$b"/*/run; do [ -d "$d" ] && outmarked "$d" && RUNS+=("$d"); done; done
  for b in smoke pilot effort; do for d in "$ROOT/$b"/*/run; do [ -d "$d" ] && outmarked "$d" && PRUNS+=("$d"); done; done
  ledger_of
}
# The pilot and effort folders of this attempt, a failed one and a retry included, as --run.
ledger_attempt() {
  local d b
  RUNS=() PRUNS=()
  for b in pilot effort; do for d in "$ROOT/$b"/*-p"$ATTEMPT"/run "$ROOT/$b"/*-p"$ATTEMPT"-a[23]/run; do [ -d "$d" ] && outmarked "$d" && RUNS+=("$d"); done; done
  ledger_of
}
# Every admit carries the attempt, figure, ledger, basis, pins and log; the pilot file from step 2 on, and the scale once sealed.
admit_flags() {
  ADM=(--attempt "$ATTEMPT" --approved "$APPROVED" --ledger-total "$1" --spend-basis "$ROOT/spend-basis.json" --pins "$ROOT/pins-r4.json" --log "$ROOT/budget-log.jsonl")
  case $STEP in 2 | 3 | 5 | 6) ADM+=(--pilot "$ROOT/pilot.json") ;; esac
  [ ! -f "$ROOT/scale.json" ] || ADM+=(--scale "$ROOT/scale.json")
}
# `rep --units a b` puts `--units a --units b` in REP, the form z0-budget reads.
rep() {
  local f=$1 v
  shift
  REP=()
  for v in "$@"; do REP+=("$f" "$v"); done
}
keys_of() {
  local out
  if out=$(ur keys "$ROOT" "$1" 2>&1 < /dev/null); then readarray -t KEYS <<< "$out"
  elif [ "$PRINT" = 1 ]; then KEYS=('<k>')
  else bail "DRIVE: $LABEL: ${out%%$'\n'*}"; fi
}
# The unit folders of one batch, `<root>/<b>/<k>-w<w>`, as `--units` pairs in REP.
units_of() {
  local k folders=()
  keys_of "$2"
  for k in "${KEYS[@]}"; do folders+=("$ROOT/$1/$k-w$3"); done
  rep --units "${folders[@]}"
}
get_r() {
  local out rc
  if [ "$PRINT" = 1 ]; then RVAL='<r>'; return 0; fi
  out=$(zd pilot-r --root "$ROOT" 2>&1 < /dev/null)
  rc=$?
  [ "$rc" = 0 ] || bail "DRIVE: $LABEL fault: z0-drive pilot-r exit $rc: ${out%%$'\n'*}"
  RVAL=$out
}
# `--whole-plan <root>/whole-plan/<k>/plan.json` for each key whose plan exists.
whole_plans() {
  local d
  WP=()
  for d in "$ROOT"/whole-plan/*/plan.json; do [ -f "$d" ] && WP+=(--whole-plan "$d"); done
  [ ${#WP[@]} -gt 0 ] || { [ "$PRINT" = 1 ] && WP=(--whole-plan "$ROOT/whole-plan/<k>/plan.json"); } || bail "DRIVE: $LABEL: $ROOT/whole-plan holds no <key>/plan.json; run plans first"
}
B1=() LV=()
inputs_of() {
  B1=(--read-set "$ROOT/batch1/read-set.txt" --prices "$ROOT/prices.json" --grading "$ROOT/batch1/grading.json" --drop-list "$ROOT/batch1/drop-list.json")
  LV=(--levels "$ROOT/levels/pre-freeze.json" --levels "$ROOT/levels/batch-1.json")
}
level_sims() { LS=(); [ -z "$SIMS" ] || LS=(--level-sims "$SIMS"); }

# ------------------------------------------------------------------------------------------------ steps
step_plans() {
  local d k ks=()
  cli z0-pins-check --manifest-check "$ROOT/tasks"; check -
  for d in "$ROOT"/tasks/*/tasks-run.json; do [ -f "$d" ] && { k=${d%/tasks-run.json}; ks+=("${k##*/}"); }; done
  [ ${#ks[@]} -gt 0 ] || { [ "$PRINT" = 1 ] && ks=('<k>'); } || bail "DRIVE: plans: $ROOT/tasks holds no <key>/tasks-run.json"
  for k in "${ks[@]}"; do
    cli ab-run --tasks "$ROOT/tasks/$k/tasks-run.json" --out "$ROOT/whole-plan/$k" --design r4 --seeds 3 --dry-run; check -
  done
  cli z0-pins-check --manifest "$ROOT/whole-plan"; check -
  done_ok
}

step_smoke() {
  local unit=$ROOT/smoke/w$ATTEMPT
  UNITS=("smoke|effort|$unit|O1,S0,S1,S2,S4,S5|-MaxPosition 1")
  if [ "$PRINT" = 1 ] || ! unit_started "$unit"; then
    unit_flags "${UNITS[0]}" "$unit"
    launcher "${FLAGS[@]}" -PlanOnly; check -
    ledger_all
    admit_flags "$LEDGER"
    cli z0-budget admit --step smoke --units "$unit" --plans "$unit/dry/plan.json" "${ADM[@]}"; check admit
  fi
  phase
  if [ "$PRINT" = 1 ]; then CUR=$unit; else current_of "$unit"; fi
  cli g1-pins --run "$CUR/run" --pins "$ROOT/pins-r4.json" --plan-of "$CUR/run" --out "$CUR/off-pin.json" --strict; check g1-pins
  done_ok
}

# The warm-ups of the last passing smoke: its done folder is the latest folder of that attempt.
smoke_warmups() {
  local n out
  if [ "$PRINT" = 1 ]; then WARM='<warmups>'; return 0; fi
  out=$(zd last-smoke --root "$ROOT" 2>&1 < /dev/null) || bail "DRIVE: $LABEL: ${out%%$'\n'*}"
  n=$out
  current_of "$ROOT/smoke/w$n"
  state_of "$CUR"
  [ "$STATE" = done ] || bail "DRIVE: $LABEL: smoke attempt $n has no done folder"
  WARM=$CUR/run/warmups
}

step_1() {
  local spec base keys k e units=() plans=() queued=() rplans=() item L first f
  UNITS=()
  if [ "$PRINT" = 1 ] && [ ! -f "$ROOT/pilot-tasks/repos.json" ]; then keys=('<k>'); else
    keys=$(zd pilot-keys --root "$ROOT" 2>&1 < /dev/null) || bail "DRIVE: $LABEL: ${keys%%$'\n'*}"
    readarray -t keys <<< "$keys"
  fi
  for k in "${keys[@]}"; do UNITS+=("pilot|$k|$ROOT/pilot/$k-p$ATTEMPT|O1,S1,S2|"); done
  for e in low high; do UNITS+=("effort|effort|$ROOT/effort/$e-p$ATTEMPT|O1,S1|-MaxPosition 1 -Effort $e"); done
  for spec in "${UNITS[@]}"; do IFS='|' read -r _ _ base _ <<< "$spec"; units+=("$base"); plans+=("$base/dry/plan.json"); done
  smoke_warmups
  first=0
  if [ "$PRINT" = 1 ] || ! any_started "${units[@]}"; then
    first=1
    for spec in "${UNITS[@]}"; do
      IFS='|' read -r _ _ base _ <<< "$spec"
      unit_flags "$spec" "$base"
      launcher "${FLAGS[@]}" -PlanOnly; check -
    done
    ledger_all
    admit_flags "$LEDGER"
    rep --units "${units[@]}"; units=("${REP[@]}")
    rep --plans "${plans[@]}"; plans=("${REP[@]}")
    cli z0-budget admit --step pilot "${units[@]}" "${plans[@]}" --warmups "$WARM" "${ADM[@]}"; check admit
  fi
  if [ "$PRINT" = 1 ]; then
    phase_print
  else
    phase_scan
    # Every phase after the first checks the pilot's own cap alone, on the attempt's spend so far, over each queued unit: a retry and a first launch that failed to start alike.
    for item in "${QUEUE[@]}"; do
      [ "$first" = 0 ] || break
      IFS='|' read -r _ _ base _ <<< "${item%|*|*}"
      f=${item%|*}
      queued+=("${f##*|}") rplans+=("$base/dry/plan.json")
    done
    if [ ${#queued[@]} -gt 0 ]; then
      ledger_all
      L=$LEDGER
      ledger_attempt
      admit_flags "$L"
      rep --units "${queued[@]}"; units=("${REP[@]}")
      rep --plans "${rplans[@]}"; plans=("${REP[@]}")
      cli z0-budget admit --step pilot --cap-only --attempt-ledger "$LEDGER" "${units[@]}" "${plans[@]}" --warmups "$WARM" "${ADM[@]}"; check admit
    fi
    phase_run
  fi
  pilot_done
}
# With all four units done: g1-pins on each done folder, then the pilot read.
pilot_done() {
  local spec base pins runs=() effort=() offpins=() L P
  for spec in "${UNITS[@]}"; do
    IFS='|' read -r _ _ base _ <<< "$spec"
    if [ "$PRINT" = 1 ]; then CUR=$base; else current_of "$base"; fi
    case $spec in *"-Effort low") pins=$ROOT/pins-r4-effort-low.json ;; *"-Effort high") pins=$ROOT/pins-r4-effort-high.json ;; *) pins=$ROOT/pins-r4.json ;; esac
    cli g1-pins --run "$CUR/run" --pins "$pins" --plan-of "$CUR/run" --out "$CUR/off-pin.json"; check g1-pins
    offpins+=(--off-pin "$CUR/off-pin.json")
    case $spec in
      *"-Effort low") effort+=(--effort-run "low:$CUR/run") ;;
      *"-Effort high") effort+=(--effort-run "high:$CUR/run") ;;
      *) runs+=(--runs "$CUR/run/runs.jsonl" --plan "$CUR/run/plan.json") ;;
    esac
  done
  ledger_all
  L=$LEDGER
  ledger_attempt
  P=$LEDGER
  [ "$PRINT" != 1 ] || P='<P>'
  cli z0-pilot "${runs[@]}" "${effort[@]}" "${offpins[@]}" --prices "$ROOT/prices.json" --spend-basis "$ROOT/spend-basis.json" --pilot-tasks "$ROOT/pilot-tasks" --pins "$ROOT/pins-r4.json" \
    --ledger-total "$L" --pilot-spend "$P" --attempt "$ATTEMPT" --tag "${TAG:-<tag>}" --out "$ROOT/pilot.json"; check z0-pilot
  done_ok
}

step_2() {
  local words r3=()
  get_r
  whole_plans
  if [ -f "$ROOT/r3-inputs.txt" ]; then
    while read -r -a words; do [ ${#words[@]} -eq 0 ] || r3+=("${words[@]}"); done < "$ROOT/r3-inputs.txt"
  elif [ "$PRINT" = 1 ]; then r3=(--runs '<f>' --plan '<p>')
  else bail "DRIVE: $LABEL: $ROOT/r3-inputs.txt is missing"; fi
  cli z0-size --design r4-on-r3 --power --cost-ratio "$RVAL" --levels "$ROOT/levels/pre-freeze.json" "${r3[@]}" --prices "$ROOT/r3/prices.json" --r3-unblind "$ROOT/r3/unblind.stdout" \
    --grading "$ROOT/r3/grading.json" --drop-list "$ROOT/r3/drop-list.json" "${WP[@]}"; check -
  ledger_all
  admit_flags "$LEDGER"
  units_of batch1 1 1
  cli z0-budget admit --step whole-run "${REP[@]}" "${ADM[@]}"; check admit
  done_ok
}

step_3() {
  local mark=$ROOT/batch1/ADMITTED
  if [ "$PRINT" = 1 ] || ! started_in batch1; then
    ledger_all
    admit_flags "$LEDGER"
    units_of batch1 1 1
    cli z0-budget admit --step batch-1 "${REP[@]}" "${ADM[@]}" --mark "$mark"; check admit
  fi
  batch_run 1
  inputs_of
  whole_plans
  cli z0-size --design r4 --batch1-block "${B1[@]}" "${WP[@]}" --key "$ROOT/blind-key.json" --out "$ROOT/batch1/block.json"; check block
  done_ok
}

# `s4-batch.sh <n> <checkout> <root> --poll <s> [--fake <knobs>]` in the foreground: its exit 3 is batch-failed and 7 is labels, any other failure a fault.
batch_run() {
  local more=()
  [ -z "$FAKE" ] || more=(--fake "$FAKE")
  script s4-batch "$1" "$CHECKOUT" "$ROOT" --poll "$POLL" "${more[@]}"; check s4-batch
}

step_4() {
  get_r
  inputs_of
  whole_plans
  level_sims
  cli z0-size --design r4 --level-check "${B1[@]}" "${WP[@]}" --pre-levels "$ROOT/levels/pre-freeze.json" --out "$ROOT/levels/batch-1.json" "${LS[@]}"; check level-check
  cli z0-size --design r4 --power "${B1[@]}" "${WP[@]}" "${LV[@]}" --cost-ratio "$RVAL" --spend-basis "$ROOT/spend-basis.json" --r3-unblind "$ROOT/r3/unblind.stdout"; check power
  done_ok
}

step_5() {
  if [ "$PRINT" = 1 ] || ! started_in batch2; then
    get_r
    inputs_of
    whole_plans
    cli z0-size --design r4 --seed-rule-preview "${B1[@]}" "${WP[@]}" "${LV[@]}" --cost-ratio "$RVAL" --spend-basis "$ROOT/spend-basis.json" --out "$ROOT/seed-preview.json"; check -
    ledger_all
    admit_flags "$LEDGER"
    units_of batch2 2 1
    cli z0-budget admit --step batch-2 "${REP[@]}" --seed-preview "$ROOT/seed-preview.json" "${ADM[@]}" --mark "$ROOT/batch2/ADMITTED"; check admit
  fi
  batch_run 2
  done_ok
}

# A marker of batch $2 that s4-batch.sh writes whole; its absence means the batch did not finish.
need() { [ -f "$1" ] || bail "DRIVE: $LABEL: $1 is missing; batch $2 did not finish"; }
# The G5 folders of batches 1 and 2, as s4-batch.sh lists them: each key's first run, then its leak reruns by seed.
g5_folders() {
  local n b k first s out seeds
  G5=()
  for n in 1 2; do
    b=batch$n
    keys_of "$n"
    for k in "${KEYS[@]}"; do
      need "$ROOT/$b/done/$k" "$n"
      first=$ROOT/$b/$(< "$ROOT/$b/done/$k")
      G5+=("$first")
      seeds=$(ur seeds "$first/leaks.json" 2>&1 < /dev/null) || bail "DRIVE: $LABEL: ${seeds%%$'\n'*}"
      for s in $seeds; do need "$ROOT/$b/done/$k-e$s" "$n"; G5+=("$ROOT/$b/$(< "$ROOT/$b/done/$k-e$s")"); done
    done
  done
}

step_6() {
  local r hold=() grading=() g out j k
  get_r
  inputs_of
  if [ "$PRINT" = 1 ] || [ ! -f "$ROOT/raise/max-seed.json" ]; then
    cli z0-read-set --root "$ROOT" --batches 1,2 --out "$ROOT/seed/read-set.txt"; check -
    if [ "$PRINT" = 1 ]; then hold=(--runs '<runs>'); else
      for r in $(grep -o -- '--runs [^ ]*' "$ROOT/seed/read-set.txt" | cut -d' ' -f2); do hold+=(--runs "$r"); done
    fi
    cli z0-hookhold --design r4 "${hold[@]}" --sensitivity "$ROOT/seed/drop-list.json"; check -
    if [ "$PRINT" = 1 ]; then grading=(--grading '<g5>/run/grading.json'); else
      g5_folders
      for g in "${G5[@]}"; do grading+=(--grading "$g/run/grading.json"); done
    fi
    cli z0-grading-combine "${grading[@]}" --out "$ROOT/seed/grading.json"; check -
    cli z0-seed-rule --design r4 --read-set "$ROOT/seed/read-set.txt" --prices "$ROOT/prices.json" --grading "$ROOT/seed/grading.json" --drop-list "$ROOT/seed/drop-list.json" \
      --cost-ratio "$RVAL" "${LV[@]}" --out "$ROOT/seed-rule.json"; check -
    if [ -n "$RULE" ]; then
      if [ "$PRINT" = 1 ]; then echo "cp $RULE $ROOT/seed-rule.json"; else cp "$RULE" "$ROOT/seed-rule.json" || bail "DRIVE: $LABEL fault: cp $RULE exit $?"; fi
    fi
    ledger_all
    admit_flags "$LEDGER"
    units_of raise raise 2
    cli z0-budget admit --step seeds "${REP[@]}" --seed-rule "$ROOT/seed-rule.json" --seal "$ROOT/raise/max-seed.json" "${ADM[@]}" --mark "$ROOT/raise/ADMITTED"
    # Exit 6 is the cap: the raise still runs, to the sealed seed.
    [ "$CMD_RC" = 6 ] || check admit
  fi
  batch_run raise
  [ "$PRINT" = 1 ] && return 0
  out=$(zd max-seed --root "$ROOT" 2>&1 < /dev/null) || bail "DRIVE: $LABEL fault: z0-drive max-seed: ${out%%$'\n'*}"
  read -r j k <<< "$out"
  if [ "$j" -lt "$k" ]; then
    echo "CAP: max-seed $j of $k"
    finish 6 cap "CAP: max-seed $j of $k"
  fi
  echo "max-seed $k"
  finish 0 '' "max-seed $k"
}

step_7() {
  script s4-read "$CHECKOUT" "$ROOT"; check s4-read
  script s4-read "$CHECKOUT" "$ROOT" --unblind; check s4-read
  done_ok
}

step_8() {
  local out stopped=() id at
  ledger_all
  if [ "$PRINT" = 1 ]; then stopped=(--stopped '<id>' --step '<step>'); else
    out=$(zd terminal --root "$ROOT" 2>&1 < /dev/null) || bail "DRIVE: $LABEL fault: z0-drive terminal: ${out%%$'\n'*}"
    if [ -n "$out" ]; then read -r id at <<< "$out"; stopped=(--stopped "$id" --step "$at"); fi
    rm -f "$ROOT/report.txt"
  fi
  cli z0-budget report --log "$ROOT/budget-log.jsonl" --ledger-total "$LEDGER" --approved "$APPROVED" --pins "$ROOT/pins-r4.json" --pilot "$ROOT/pilot.json" "${stopped[@]}"; check -
  if [ "$PRINT" != 1 ]; then write_whole "$ROOT/report.txt" "$CMD_OUT" || bail "DRIVE: $LABEL fault: cannot write $ROOT/report.txt"; fi
  done_ok
}

step_founder_go() {
  local more=()
  [ "$QUESTION" != pilot ] || more+=(--attempt "$ATTEMPT")
  [ -z "$FIGURE" ] || more+=(--figure "$FIGURE")
  [ "$STOP" = 0 ] || more+=(--stop)
  ENTRY_EXTRA=(--question "$QUESTION" --stop "$([ "$STOP" = 1 ] && echo true || echo false)")
  [ -z "$FIGURE" ] || ENTRY_EXTRA+=(--figure "$FIGURE")
  say "founder-go $QUESTION figure ${FIGURE:-none} stop $STOP words: $WORDS"
  cli z0-budget founder-go --question "$QUESTION" "${more[@]}" --words "$WORDS" --log "$ROOT/budget-log.jsonl"
  if [ "$PRINT" != 1 ] && [ "$CMD_RC" != 0 ]; then bail "DRIVE: $LABEL fault: z0-budget exit $CMD_RC: $CMD_LAST"; fi
  [ "$STOP" = 0 ] || finish 0 founder-stop "$CMD_LAST"
  done_ok
}

step_cause() {
  local out rc info
  if [ "$PRINT" = 1 ]; then echo "z0-drive.mjs cause --root $ROOT --kind $KIND"; return 0; fi
  say "cause $KIND words: $WORDS"
  out=$(zd cause --root "$ROOT" --kind "$KIND" 2>&1 < /dev/null)
  rc=$?
  [ -z "$out" ] || echo "$out"
  # Only the two stops (exit 3) are logged; any other exit is an input error and ends the call with no entry.
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || exit 1
  info=$(zd failure --root "$ROOT" 2>&1 < /dev/null) || { echo "DRIVE: cause could not read its failure: ${info%%$'\n'*}"; exit 1; }
  read -r FAILED_STEP ATTEMPT TAG <<< "$info"
  [ "$TAG" != none ] || TAG=''
  ENTRY_EXTRA=(--kind "$KIND" --failed-step "$FAILED_STEP")
  CMD_RC=$rc CMD_LAST=${out##*$'\n'} CMD_NAME=z0-drive
  check cause "$KIND"
  done_ok
}

step_stage_checks() {
  local diff rc freeze
  if [ "$PRINT" != 1 ]; then
    freeze=$(git -C "$CHECKOUT" rev-parse -q --verify 'refs/tags/z0-r4-freeze-2^{commit}' 2> /dev/null)
    [ -n "$freeze" ] && [ "$freeze" = "$COMMIT" ] || stop3 tag "DRIVE: stage-checks needs HEAD at z0-r4-freeze-2; HEAD is ${COMMIT:-unknown}"
    last_line "$ROOT/dryrun.log"
    # Slice D's line goes on after the commit (plan :388), so the line matches by its prefix.
    case $LAST in "DRY RUN PASS $COMMIT:"*) ;; *) stop3 order "DRIVE: stage-checks needs a last line of $ROOT/dryrun.log that starts DRY RUN PASS $COMMIT:; its last line is ${LAST:-empty}" ;; esac
  fi
  cli z0-size --check-levels "$ROOT/levels/pre-freeze.json"; check -
  if [ "$PRINT" = 1 ]; then echo "git -C $CHECKOUT diff --stat $BASE_COMMIT HEAD -- src extensions"; return 0; fi
  diff=$(git -C "$CHECKOUT" diff --stat "$BASE_COMMIT" HEAD -- src extensions 2>&1 < /dev/null)
  rc=$?
  [ "$rc" = 0 ] || bail "DRIVE: $LABEL fault: git diff exit $rc: ${diff%%$'\n'*}"
  [ -z "$diff" ] || bail "DRIVE: $LABEL fault: src or extensions differ from $BASE_COMMIT: ${diff%%$'\n'*}"
  finish 0 '' "$CMD_LAST"
}

# ------------------------------------------------------------------------------------------------ one call
run_step() {
  case $STEP in
    plans) step_plans ;; smoke) step_smoke ;; 1) step_1 ;; 2) step_2 ;; 3) step_3 ;; 4) step_4 ;; 5) step_5 ;; 6) step_6 ;; 7) step_7 ;; 8) step_8 ;;
    founder-go) step_founder_go ;; cause) step_cause ;; stage-checks) step_stage_checks ;;
  esac
}

# The pins check: smoke, steps 1 to 8 and stage-checks.
pins_check() { cli z0-pins-check --pins "$ROOT/pins-r4.json" --checkout "$CHECKOUT" --roles "$ROOT/pin-roles.txt" --poetry "$POETRY"; }
case $STEP in smoke | [1-8] | stage-checks) HAS_PINS=1 ;; *) HAS_PINS=0 ;; esac

if [ "$PRINT" = 1 ]; then
  [ "$HAS_PINS" = 0 ] || pins_check
  run_step
  exit 0
fi

say "call $STEP $CHECKOUT $ROOT attempt $ATTEMPT pid $Z0_DRIVER_WINPID"
scan
orphan_check
case $STEP in plans | founder-go | cause | stage-checks) ;; *) wait_quiet ;; esac

COMMIT=$(git -C "$CHECKOUT" rev-parse HEAD 2> /dev/null)
TAG=''
if git -C "$CHECKOUT" rev-parse -q --verify refs/tags/z0-r4-freeze-2 > /dev/null 2>&1; then TAG=z0-r4-freeze-2
elif git -C "$CHECKOUT" rev-parse -q --verify refs/tags/z0-r4-freeze-1 > /dev/null 2>&1; then TAG=z0-r4-freeze-1; fi

# Every entry from here on carries the pins sha and the claude version, a refusal too.
info=$(zd pins-info --root "$ROOT" 2>&1 < /dev/null) || { echo "DRIVE: $LABEL: z0-drive pins-info: ${info%%$'\n'*}"; exit 1; }
read -r PINS_SHA CLAUDE_V <<< "$info"

# The tag rule: a paid step runs on a clean checkout at the tag in force.
case $STEP in
  smoke | 1 | 3 | 5 | 6)
    want=${TAG:-z0-r4-freeze-1}
    tagged=$(git -C "$CHECKOUT" rev-parse -q --verify "refs/tags/$want^{commit}" 2> /dev/null)
    [ -n "$tagged" ] && [ "$tagged" = "$COMMIT" ] || stop3 tag "DRIVE: $LABEL must run on $want; HEAD is ${COMMIT:-unknown}"
    dirty=$(git -C "$CHECKOUT" status --porcelain 2> /dev/null) || bail "DRIVE: $LABEL fault: git status exit $?"
    [ -z "$dirty" ] || stop3 tag "DRIVE: $LABEL must run on a clean $want; $CHECKOUT has changes" ;;
esac

# Exit 3 of the pins check is its first PINS: line; any other failure is a fault.
if [ "$HAS_PINS" = 1 ]; then
  pins_check
  if [ "$CMD_RC" = 3 ]; then
    first=$(printf '%s\n' "$CMD_OUT" | grep -m 1 '^PINS:')
    finish 3 pins "${first:-$CMD_LAST}"
  fi
  [ "$CMD_RC" = 0 ] || bail "DRIVE: $LABEL fault: z0-pins-check exit $CMD_RC: $CMD_LAST"
fi

# Step 2 runs only before batch 1 starts, and a refusal there logs nothing.
if [ "$STEP" = 2 ] && started_in batch1; then
  echo "DRIVE: step 2 runs before batch 1 starts"
  exit 3
fi

verdict=$(zd gate --root "$ROOT" --step "$STEP" --tag "${TAG:-none}" --commit "${COMMIT:-none}" --pins-sha256 "$PINS_SHA" --claude-version "$CLAUDE_V" --attempt "$ATTEMPT" 2>&1 < /dev/null)
rc=$?
case $rc in
  0) ;;
  3) echo "$verdict"; finish 3 order "${verdict%%$'\n'*}" ;;
  *) echo "DRIVE: $LABEL: z0-drive gate exit $rc: ${verdict%%$'\n'*}"; exit 1 ;;
esac

# A smoke or step 1 call owns its attempt before it makes a folder, so a call killed after that resumes at the same attempt.
case $STEP in smoke | 1) finish 0 start ;; esac
run_step
