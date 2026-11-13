#!/bin/bash
# Unmount right after a Commit vs after a pause: is unmount waiting for the Commit's background work?
# Usage: delay-bench.sh <sandbox> <project> <prefix>   (CASES: "files bytes;..."; DELAYS: "0 1 3 10")
set -u
SB=$1 P=$2 PFX=$3
L=${LAYERFS_CLI:-$HOME/.layerfs/runtime/2.0.0-814768197b73/bin/layerfs}
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'; }
k=0
IFS=';' read -ra SPECS <<< "${CASES:-1 104857600;10000 1024}"
for spec in "${SPECS[@]}"; do
  read -r n b <<< "$spec"
  for d in ${DELAYS:-0 1 3 10}; do
    for r in 1 2; do
      k=$((k+1)); br="$PFX$k"; ws="$SB:d$k"
      $L branch fork "$P" "$br" main >/dev/null
      $L workspace mount "$SB" "$br" --name d$k >/dev/null
      $L workspace exec "$ws" "python3 -c 'import os
os.makedirs(\"gen\",exist_ok=True)
for i in range($n): open(\"gen/f%06d\"%i,\"wb\").write(os.urandom($b))'" >/dev/null
      s=$(now); $L workspace commit "$ws" -m g >/dev/null; c=$(now)
      perl -e "select(undef,undef,undef,$d)"
      s2=$(now); $L workspace unmount "$ws" >/dev/null; e=$(now)
      printf '%s\t%s\tdelay=%s\tcommit=%.0f\tunmount=%.0f\n' "$n" "$b" "$d" "$(echo "$c - $s" | bc)" "$(echo "$e - $s2" | bc)"
    done
  done
done
