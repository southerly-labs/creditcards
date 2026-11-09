#!/usr/bin/env bash
# Check one formal verification model against tables generated from the real code.
# Usage: bash tools/verify/run.sh <skill dir> <Spec> <table script>
# Example: bash tools/verify/run.sh .cursor/skills/verify-sync-holds SyncHolds holds-table.ts
# TLC stops at the first broken invariant, so a broken one is reported, dropped
# and the rest are checked again. Invariants named in <skill dir>/known-findings
# are reported but do not fail the run; any other broken invariant does.
set -euo pipefail

spec_dir=$1
spec=$2
table=$3

TLC_VERSION=1.7.4
TLC_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAVA_TOOL=java@temurin-25

root=$(git rev-parse --show-toplevel)
work="$root/.cache/verify/$spec"
rm -rf "$work"
mkdir -p "$work"

bun "$root/tools/verify/$table" > "$work/${spec}Code.tla"
cp "$root/$spec_dir/$spec.tla" "$work/"
known=()
if [ -f "$root/$spec_dir/known-findings" ]; then
  mapfile -t known < <(grep -v '^[[:space:]]*\(#\|$\)' "$root/$spec_dir/known-findings")
fi

jar=${TLA2TOOLS:-$HOME/.cache/creditcards-verify/tla2tools-$TLC_VERSION.jar}
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL "https://github.com/tlaplus/tlaplus/releases/download/v$TLC_VERSION/tla2tools.jar" -o "$jar.part"
  echo "$TLC_SHA256  $jar.part" | sha256sum -c --quiet
  mv "$jar.part" "$jar"
fi

java=${JAVA:-}
if [ -z "$java" ] && command -v mise > /dev/null; then
  java=$(mise which java --tool "$JAVA_TOOL" 2> /dev/null || { mise install "$JAVA_TOOL" > /dev/null && mise which java --tool "$JAVA_TOOL"; })
fi
java=${java:-java}

cfg="$root/$spec_dir/$spec.cfg"
mapfile -t remaining < <(awk '/^INVARIANTS?/{on=1; next} /^[A-Z_]+/{on=0} on && NF {print $1}' "$cfg")
awk '/^INVARIANTS?/{on=1; next} /^[A-Z_]+/{on=0} !on' "$cfg" > "$work/base.cfg"

cd "$work"
broken=()
unexpected=0
while :; do
  { cat base.cfg; echo "INVARIANTS"; printf '  %s\n' "${remaining[@]}"; } > "$spec.cfg"
  set +e
  "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -cleanup -config "$spec.cfg" "$spec.tla" > tlc.out 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    grep -E "states generated" tlc.out | tail -n 1
    break
  fi
  name=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' tlc.out | head -n 1)
  if [ -z "$name" ]; then
    tail -n 20 tlc.out
    echo "ERROR: TLC exit $status without an invariant violation; see $work/tlc.out"
    exit "$status"
  fi
  cp tlc.out "tlc-$name.out"
  label="NEW"
  for k in "${known[@]}"; do if [ "$k" = "$name" ]; then label="known finding"; fi; done
  if [ "$label" = "NEW" ]; then unexpected=1; fi
  broken+=("$name")
  echo "BROKEN ($label): $name — trace in $work/tlc-$name.out"
  grep -E "^State [0-9]+: <" "tlc-$name.out" | sed 's/ line [0-9].*//'
  next=()
  for r in "${remaining[@]}"; do if [ "$r" != "$name" ]; then next+=("$r"); fi; done
  remaining=("${next[@]}")
  if [ "${#remaining[@]}" -eq 0 ]; then break; fi
done

for r in "${remaining[@]}"; do echo "holds: $r"; done
if [ "$unexpected" -ne 0 ]; then
  echo "FAIL: $spec has a broken invariant that is not a known finding"
  exit 1
fi
echo "PASS: $spec${broken:+ (known findings: ${broken[*]})}"
