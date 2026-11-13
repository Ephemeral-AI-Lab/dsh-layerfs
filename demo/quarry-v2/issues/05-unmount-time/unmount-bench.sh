#!/bin/bash
# Unmount timing repro for LayerFS v2 (pinned runtime 2.0.0-814768197b73).
# Private home only. Usage: unmount-bench.sh <sandbox> <project> [reps]
# Prints TSV: case  files  bytes_each  phase  ms  answer
set -u
SB=$1 P=$2 REPS=${3:-3}
L=${LAYERFS_CLI:-$HOME/.layerfs/runtime/2.0.0-814768197b73/bin/layerfs}
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'; }
t() { # t <case> <files> <bytes> <phase> cmd...  (prints the timing row, keeps the answer in $OUT)
  local c=$1 f=$2 b=$3 ph=$4; shift 4
  local s e; s=$(now); OUT=$("$@" 2>&1); RC=$?; e=$(now)
  printf '%s\t%s\t%s\t%s\t%.0f\t%s\n' "$c" "$f" "$b" "$ph" "$(echo "$e - $s" | bc)" "$(echo "$OUT" | tr -d '\n' | cut -c1-90)"
}
gen() { # python inside the Workspace: write <n> files of <bytes> each under gen/, deterministic content
  echo "python3 -c 'import os
n,b=$1,$2
os.makedirs(\"gen\",exist_ok=True)
for i in range(n):
  d=\"gen/d%03d\"%(i//500); os.makedirs(d,exist_ok=True)
  open(d+\"/f%06d.bin\"%i,\"wb\").write((b\"%08d\"%i)*(b//8)+b\"x\"*(b%8))'"
}
rewrite() { # rewrite every file under gen/ with identical bytes (new inode content, same data): the F17 shape
  echo "python3 -c 'import os
for r,_,fs in os.walk(\"gen\"):
  for f in fs:
    p=os.path.join(r,f); d=open(p,\"rb\").read(); os.remove(p); open(p,\"wb\").write(d)'"
}
for i in $(seq $REPS); do t startup 0 0 cli-version $L --version; done
k=0
run() { # run <case> <files> <bytes>
  local c=$1 n=$2 b=$3 br ws
  for r in $(seq $REPS); do
    k=$((k+1)); br="${PREFIX:-b}$k-$c"; ws="$SB:m$k"
    $L branch fork "$P" "$br" main >/dev/null 2>&1 || { echo "fork failed $br"; return; }
    case $c in
      empty)
        t $c $n $b mount $L workspace mount "$SB" "$br" --name m$k
        t $c $n $b unmount $L workspace unmount "$ws" ;;
      committed)
        t $c $n $b mount $L workspace mount "$SB" "$br" --name m$k
        t $c $n $b exec $L workspace exec "$ws" "$(gen $n $b)"
        t $c $n $b commit $L workspace commit "$ws" -m gen
        t $c $n $b unmount $L workspace unmount "$ws" ;;
      discarded)
        t $c $n $b mount $L workspace mount "$SB" "$br" --name m$k
        t $c $n $b exec $L workspace exec "$ws" "$(gen $n $b)"
        t $c $n $b unmount $L workspace unmount "$ws" --discard ;;
      identical)
        $L workspace mount "$SB" "$br" --name m$k >/dev/null
        $L workspace exec "$ws" "$(gen $n $b)" >/dev/null
        $L workspace commit "$ws" -m gen >/dev/null
        $L workspace unmount "$ws" >/dev/null
        t $c $n $b mount $L workspace mount "$SB" "$br" --name m$k
        t $c $n $b exec $L workspace exec "$ws" "$(rewrite)"
        t $c $n $b commit $L workspace commit "$ws" -m same
        t $c $n $b unmount $L workspace unmount "$ws" ;;
      readonly) # read every file (fills caches) then unmount: forget cost without writes
        $L workspace mount "$SB" "$br" --name m$k >/dev/null
        $L workspace exec "$ws" "$(gen $n $b)" >/dev/null
        $L workspace commit "$ws" -m gen >/dev/null
        $L workspace unmount "$ws" >/dev/null
        t $c $n $b mount $L workspace mount "$SB" "$br" --name m$k
        t $c $n $b exec $L workspace exec "$ws" "cat \$(find gen -type f) >/dev/null"
        t $c $n $b unmount $L workspace unmount "$ws" ;;
    esac
  done
}
# CASES: "case files bytes;case files bytes;..."
IFS=';' read -ra SPECS <<< "${CASES:-empty 0 0;committed 10 1024;committed 1000 1024;committed 10000 1024;committed 1 1048576;committed 1 104857600;committed 1 1073741824;discarded 1000 1024;discarded 10000 1024;identical 1000 1024;identical 10000 1024;identical 100 10485760;readonly 10000 1024}"
for spec in "${SPECS[@]}"; do
  read -r c n b <<< "$spec"; run "$c" "$n" "$b"
done
