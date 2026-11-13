#!/bin/bash
# Who pays for the Commit's deferred reclamation? Right after a Commit, time:
#   A) unmount                         (the bench's case)
#   B) workspace status, then unmount  (does the first job after Commit absorb it?)
#   C) unmount --discard               (no dirty check; revoke/close jobs only)
# Usage: drain-check.sh <sandbox> <project> <prefix> <files> <bytes>
set -u
SB=$1 P=$2 PFX=$3 N=$4 B=$5
L=${LAYERFS_CLI:-$HOME/.layerfs/runtime/2.0.0-814768197b73/bin/layerfs}
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'; }
ms() { echo "$2 - $1" | bc | cut -d. -f1; }
k=0
prep() {
  k=$((k+1)); br="$PFX$k"; ws="$SB:c$k"
  $L branch fork "$P" "$br" main >/dev/null
  $L workspace mount "$SB" "$br" --name c$k >/dev/null
  $L workspace exec "$ws" "python3 -c 'import os
os.makedirs(\"gen\",exist_ok=True)
for i in range($N): open(\"gen/f%06d\"%i,\"wb\").write(os.urandom($B))'" >/dev/null
  $L workspace commit "$ws" -m g >/dev/null
}
for r in 1 2 3; do
  prep; a=$(now); $L workspace unmount "$ws" >/dev/null; b=$(now)
  echo -e "$N\t$B\tA unmount\t$(ms $a $b)"
  prep; a=$(now); $L workspace status "$ws" >/dev/null; b=$(now); $L workspace unmount "$ws" >/dev/null; c=$(now)
  echo -e "$N\t$B\tB status\t$(ms $a $b)\tthen unmount\t$(ms $b $c)"
  prep; a=$(now); $L workspace unmount "$ws" --discard >/dev/null; b=$(now)
  echo -e "$N\t$B\tC unmount --discard\t$(ms $a $b)"
done
