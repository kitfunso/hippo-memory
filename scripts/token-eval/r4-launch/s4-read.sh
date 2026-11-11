#!/usr/bin/env bash
# Round 4 read (plan slice R, after r3-final-read.sh): read set, hook hold and G5 combine, their committed copies, then the blind read and, with --unblind, the unblinded one.
# It starts no background job. Exit 0 valid, 1 any failure or bad input, 3 an invalid blind read; the driver logs 3 as read-invalid and 1 as fault.
PATH=/usr/bin:/mingw64/bin:$PATH
HERE=$(cygpath -m "$(dirname "$0")")
USAGE='usage: s4-read.sh <checkout> <root> [--unblind]'
die() { echo "$1"; exit "${2:-1}"; }

{ [ $# -eq 2 ] || { [ $# -eq 3 ] && [ "$3" = --unblind ]; }; } || die "$USAGE"
CHECKOUT=$1 ROOT=$2 UNBLIND=${3:-}
# -a, so a relative root is named by the absolute form it needs.
form=$(cygpath -m -a "$ROOT")
form=${form%/}
{ [ "$ROOT" = "$form" ] && [[ $ROOT =~ ^[A-Za-z]:/ ]]; } || die "READ: root $ROOT must be written as $form"
CHECKOUT=$(cygpath -m "$CHECKOUT")
CHECKOUT=${CHECKOUT%/}
export Z0_CHECKOUT=$CHECKOUT
. "$HERE/s4-units.sh"
CLI=$CHECKOUT/scripts/token-eval R=$ROOT/read E=$ROOT/results/docs/evals/z0-r4

last_line() { tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1; }
# git ends a fatal message with hints, so its own fatal or error line names the failure.
git_line() { local t; t=$(tr -d '\r'); grep -E '^(fatal|error): ' <<< "$t" | tail -n 1 | grep . || last_line <<< "$t"; }
# Runs "$@" with both streams in OUT; a non-zero exit stops the read with the command's label and last line.
try() {
  local label=$1 rc
  shift
  OUT=$("$@" 2>&1 < /dev/null)
  rc=$?
  [ "$rc" = 0 ] || die "READ FAILED: $label exit $rc: $(last_line <<< "$OUT")"
}
cli() { local name=$1; shift; try "$name" node "$CLI/$name.mjs" "$@"; }
git_try() {
  local rc
  OUT=$(git -C "$ROOT/results" "$@" 2>&1 < /dev/null)
  rc=$?
  [ "$rc" = 0 ] || die "READ FAILED: git exit $rc: $(git_line <<< "$OUT")"
}
need() { [ -e "$1" ] || die "READ: $1 is missing"; }

# Every input is checked before the first command runs.
for f in pins-r4.json prices.json levels/pre-freeze.json levels/batch-1.json seed-rule.json drift-inputs.txt; do need "$ROOT/$f"; done
DRIFT=() n=0
declare -A SEEN
re='^--runs ([^ ]+) --plan ([^ ]+)$'
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line=${line%$'\r'}
  [[ $line =~ $re ]] || die "READ: drift-inputs.txt line $n is not \"--runs <f> --plan <p>\""
  [ -z "${SEEN[$line]:-}" ] || die "READ: drift-inputs.txt line $n repeats line ${SEEN[$line]}"
  SEEN[$line]=$n
  need "${BASH_REMATCH[1]}"
  need "${BASH_REMATCH[2]}"
  DRIFT+=(--drift-runs "${BASH_REMATCH[1]}" --drift-plan "${BASH_REMATCH[2]}")
done < "$ROOT/drift-inputs.txt"
[ ${#DRIFT[@]} -gt 0 ] || die "READ: drift-inputs.txt holds no line"
need "$ROOT/results/.git"

# A failed call must not leave an old read that looks current.
rm -f "$R/blind.json" "$R/blind.stdout" "$R/blind.stderr" "$R/unblind.json" "$R/unblind.stdout" "$R/unblind.stderr" || die "READ FAILED: rm exit $?: stale files in $R"
mkdir -p "$R" || die "READ FAILED: mkdir exit $?: $R"

cli z0-read-set --root "$ROOT" --batches 1,2,raise --out "$R/read-set.txt"
HOLD=()
for r in $(grep -o -- '--runs [^ ]*' "$R/read-set.txt" | cut -d' ' -f2); do HOLD+=(--runs "$r"); done
cli z0-hookhold --design r4 "${HOLD[@]}" --sensitivity "$R/drop-list.json"

# The G5 folders of each batch, as s4-batch.sh lists them: each key's completed first run, then its leak reruns by seed.
folder_of() {
  local marker=$ROOT/$1/done/$2
  need "$marker"
  FOLDER=$ROOT/$1/$(< "$marker")
}
GRADING=()
for b in 1 2 raise; do
  case $b in
    1 | 2) d=batch$b ;;
    raise) d=raise; [ ! -e "$ROOT/raise/NONE" ] || continue ;;
  esac
  try z0-unit-record ur keys "$ROOT" "$b"
  keys=$OUT
  for k in $keys; do
    folder_of "$d" "$k"
    GRADING+=(--grading "$FOLDER/run/grading.json")
    try z0-unit-record ur seeds "$FOLDER/leaks.json"
    for s in $OUT; do
      folder_of "$d" "$k-e$s"
      GRADING+=(--grading "$FOLDER/run/grading.json")
    done
  done
done
cli z0-grading-combine "${GRADING[@]}" --out "$R/grading.json"

# The unblind refuses a file that is untracked or changed, so both reads take the committed copies, and a rerun commits only a copy that differs.
mkdir -p "$E" || die "READ FAILED: mkdir exit $?: $E"
for f in grading.json drop-list.json; do
  cmp -s "$R/$f" "$E/$f" || try cp cp "$R/$f" "$E/$f"
done
git_try status --porcelain -- docs/evals/z0-r4
if grep -qE '^[ MADRCU?!]{2} ' <<< "$OUT"; then
  git_try add -- docs/evals/z0-r4/grading.json docs/evals/z0-r4/drop-list.json
  git_try commit -q -m "z0 r4: grading and drop list for the read" -- docs/evals/z0-r4/grading.json docs/evals/z0-r4/drop-list.json
fi

ARGV=(--design r4 --read-set "$R/read-set.txt" --prices "$ROOT/prices.json" --grading "$E/grading.json" --levels "$ROOT/levels/pre-freeze.json" --levels "$ROOT/levels/batch-1.json"
  --seed-rule "$ROOT/seed-rule.json" --pins "$ROOT/pins-r4.json" "${DRIFT[@]}" --key "$ROOT/blind-key.json")
# One z0-analyze call into read/<name>.json; a failure is named by its last stderr line, else its last stdout line.
analyze() {
  local name=$1 rc line
  shift
  node "$CLI/z0-analyze.mjs" "${ARGV[@]}" "$@" --out "$R/$name.json" > "$R/$name.stdout" 2> "$R/$name.stderr" < /dev/null
  rc=$?
  [ "$rc" != 0 ] || return 0
  line=$(last_line < "$R/$name.stderr")
  die "READ FAILED: z0-analyze exit $rc: ${line:-$(last_line < "$R/$name.stdout")}"
}

analyze blind
status=$(grep -E '^  "status": "[a-z]+",?$' "$R/blind.json" | head -n 1 | cut -d'"' -f4)
[ -n "$status" ] || die "READ FAILED: z0-analyze exit 0: $R/blind.json holds no top-level status line"
if [ "$status" = invalid ]; then
  list=$(grep -m 1 '^invalid: ' "$R/blind.stdout" | cut -c10-)
  die "READ INVALID: ${list:-$status}" 3
fi
[ "$status" = valid ] || die "READ INVALID: $status" 3
[ -n "$UNBLIND" ] || die "READ BLIND: valid" 0

# Every original, attempt, rerun and raise folder that holds the out mark, failed attempts included; no smoke, pilot, effort or merged folder.
LEDGER=()
for d in "$ROOT"/batch1/*/run "$ROOT"/batch2/*/run "$ROOT"/raise/*/run; do
  if [ -e "$d/runs.jsonl" ] || [ -e "$d/plan.json" ] || [ -e "$d/warmups" ] || [ -e "$d/ABANDONED" ]; then LEDGER+=(--ledger-runs "$d"); fi
done
analyze unblind --unblind --drop-list "$E/drop-list.json" "${LEDGER[@]}"
die "READ UNBLIND: valid" 0
