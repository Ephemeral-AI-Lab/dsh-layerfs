#!/usr/bin/env bash
# INSPECT_HOOK for a REAL LayerFS build (test/e2e-inspect-logs-lib.mjs,
# -files-lib.mjs and -observe-lib.mjs list the actions):
#
#   inspect-hook-real.sh <action> <machine|sandbox> <name> [args…]
#
# Environment:
#   LAYERFS_ROOT     the private LayerFS folder (root) the side server uses  required; its home is the
#                    root while it holds layerfs.json, else <root>/home (LayerFS's rule)
#   HOOK_FAULT_DIR   the folder of test/fixtures/cli-fault-shim.mjs ($LFS_INSPECT_DIR), when the side
#                    server's CLI is that shim. Without it every hang / refuse / deadline action is
#                    exit 3 (NOT_RUN).
#   HOOK_LOG         a file every call is appended to (action, target, how it was done)
#   HOOK_CLI         the real CLI, for machine-stop / machine-start; HOOK_CACHE_HOME its XDG_CACHE_HOME when the
#                    home was made with one
#
# What is done by real means, on the machine itself (the host machine: this computer; docker: `docker exec`
# in the worker container; lima: `limactl shell … sudo`; apple-container: `container exec`):
#   fill, append, truncate   the worker log (<worker root>/log/worker.log) or a Sandbox's daemon.log
#   rotate                   worker.log -> worker.1.log and a new empty worker.log, as a worker's start does. A daemon
#                            log never rotates in LayerFS: it is replaced by hand the same way, and the row says so
#   worker-pause / worker-resume   SIGSTOP / SIGCONT to the machine's worker (its pid in /layerfs/state/worker.pid)
#   machine-stop / machine-start   `layerfs machine stop <name> --force` / `machine start <name>` with $HOOK_CLI (the real CLI)
# What the fault shim injects (the row is then "real build, fault injected by shim"):
#   hang / unhang, refuse / unrefuse, hang-get / unhang-get,
#   files-hang / files-unhang, files-refuse / files-unrefuse, files-deadline / files-undeadline,
#   files-stop / files-start (a Sandbox: reads outside its run folder refused `Unavailable` with the
#   words LayerFS 73d824ec64 has for a Sandbox whose daemon is not running; nothing can start a killed daemon
#   again, so the real stop is a row of its own on a Sandbox made for it),
#   stats-hang / stats-unhang, stats-refuse / stats-unrefuse
# exit 0 done; exit 3 cannot here (stdout says why); anything else failed.
set -u
action=${1:?action}; kind=${2:?machine|sandbox}; name=${3:?name}; shift 3
: "${LAYERFS_ROOT:?LAYERFS_ROOT is not set}"
if [ -f "$LAYERFS_ROOT/layerfs.json" ]; then home=$LAYERFS_ROOT; else home=$LAYERFS_ROOT/home; fi
cannot() { echo "$*"; [ -n "${HOOK_LOG:-}" ] && echo "$(date -u +%FT%TZ) $action $kind $name: NOT_RUN ($*)" >> "$HOOK_LOG"; exit 3; }
did() { [ -n "${HOOK_LOG:-}" ] && echo "$(date -u +%FT%TZ) $action $kind $name $*" >> "$HOOK_LOG"; exit 0; }
rec() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2" 2>/dev/null; }
id8=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"][:8])' "$home/layerfs.json") || exit 1

if [ "$kind" = machine ]; then machine=$name; else machine=$(rec "$home/sandbox/$name/record.json" machine); fi
platform=$(rec "$home/machine/$machine/record.json" platform)
vm=$(rec "$home/machine/$machine/record.json" vm_name)
case "$machine" in macos-host|linux-host) platform=host;; esac
# run a root shell script on the machine's side, stdin passed
side() {
  case "$platform" in
    host) sh -c "$1";;
    docker) docker exec -i "${vm:-layerfs-$id8-$machine}" sh -c "$1";;
    lima) limactl shell --workdir / "$vm" sudo sh -c "$1";;
    apple-container) container exec -i "$vm" sh -c "$1";;
    *) echo "machine $machine: platform '$platform' is not one this hook reaches" >&2; return 2;;
  esac
}
root=/layerfs/data; [ "$platform" = host ] && root=$home
if [ "$kind" = machine ]; then log=$root/log/worker.log; old=$root/log/worker.1.log
else run=$root/machine/$machine/run/layerfs-$id8-$name; [ -d "$run" ] || [ "$platform" != host ] || run=$root/machine/$machine/run/lfs-$id8-$name; log=$run/daemon.log; old=$run/daemon.1.log; fi
lines() { node -e 'const [tag,from,n]=[process.argv[1],Number(process.argv[2]),Number(process.argv[3])];let s="";for(let i=from;i<from+n;i++)s+=`${new Date(Date.UTC(2026,10,16,10,0,0)+i*1000).toISOString()} INFO ${tag} ${String(i).padStart(6,"0")} served\n`;process.stdout.write(s)' "$@"; }
haslog() { [ "$kind" = sandbox ] || [ "$platform" != host ] || cannot "the host machine has no worker log: its calls run in the caller's process"; }

# ---- the fault shim's control file
control() {
  [ -n "${HOOK_FAULT_DIR:-}" ] || cannot "no fault shim (HOOK_FAULT_DIR): nothing real makes this call $action here in bounded time"
  python3 - "$HOOK_FAULT_DIR/control.json" "$@" <<'PY'
import json, os, sys
path, op, table, key = sys.argv[1:5]
try: c = json.load(open(path))
except Exception: c = {}
t = c.setdefault(table, {})
if op == "set": t[key] = json.loads(sys.argv[5])
else: t.pop(key, None)
tmp = path + ".tmp"
json.dump(c, open(tmp, "w"), indent=2); os.replace(tmp, path)
PY
}
fkey() { if [ $# -ge 1 ]; then p=$1; [ "$p" = - ] && p=; echo "files-$kind:$name:$p"; else echo "files-$kind:$name"; fi; }
js() { python3 -c 'import json,sys;print(json.dumps(sys.argv[1] if len(sys.argv)==2 else {"code":sys.argv[1],"message":sys.argv[2]}))' "$@"; }

case "$action" in
  fill) haslog; lines "$2" 0 "$1" | side "rm -f '$old'; cat > '$log'" || exit 1; did "real: $1 lines written to $log on $machine";;
  append) haslog; lines "$3" "$1" "$2" | side "cat >> '$log'" || exit 1; did "real: $2 lines appended to $log on $machine";;
  truncate) haslog; side "rm -f '$old'; : > '$log'" </dev/null || exit 1; did "real: $log emptied on $machine";;
  rotate) haslog
    # LayerFS rotates a worker log when the worker starts and never a daemon log (logs.md). For a daemon log the file
    # is replaced by hand all the same (the daemon keeps writing to the old one): the stale cursor LayerFS then
    # refuses is its real answer to a state arranged by hand. HOOK_NO_DAEMON_REPLACE=1 makes that exit 3 instead.
    [ "$kind" = machine ] || [ -z "${HOOK_NO_DAEMON_REPLACE:-}" ] || cannot "a Sandbox's daemon log never rotates (logs.md): nothing real replaces it"
    side "mv -f '$log' '$old' && ( umask 077; : > '$log' )" </dev/null || exit 1
    if [ "$kind" = machine ]; then did "real: $log moved to $old, new empty log, on $machine"; else did "by hand: $log replaced (moved to $old, new empty file) on $machine; LayerFS itself never rotates a daemon log"; fi;;
  hang) control set delay_ms "$kind:$name" "$1"; did "shim: delay $1 ms";;
  unhang) control del delay_ms "$kind:$name"; did "shim";;
  refuse) control set refuse "$kind:$name" "$(js "$1" "$2")"; did "shim: refuse $1";;
  unrefuse) control del refuse "$kind:$name"; did "shim";;
  hang-get) control set delay_ms "call:sandbox.get:$name" "$1"; did "shim: delay $1 ms";;
  unhang-get) control del delay_ms "call:sandbox.get:$name"; did "shim";;
  files-hang) ms=$1; shift; control set delay_ms "$(fkey "$@")" "$ms"; did "shim: delay $ms ms $*";;
  files-unhang) control del delay_ms "$(fkey "$@")"; did "shim $*";;
  files-refuse) code=$1; msg=$2; shift 2; control set refuse "$(fkey "$@")" "$(js "$code" "$msg")"; did "shim: refuse $code $*";;
  files-unrefuse) control del refuse "$(fkey "$@")"; did "shim $*";;
  files-deadline) control set deadline "files-$kind:$name:$1" "$2"; did "shim: every page of $1 is read with --limit $2 and passed on with reason deadline";;
  files-undeadline) control del deadline "files-$kind:$name:$1"; did "shim";;
  files-stop) [ "$kind" = sandbox ] || cannot "files-stop is for a Sandbox"
    msg=${HOOK_STOPPED_MESSAGE:-}; [ -n "$msg" ] || msg=$(printf "sandbox.files: Sandbox %s\047s root is not there: its daemon is not running. Its home is still read: %s/tmp" "$name" "$run")
    control set stopped "$name" "$(python3 -c 'import json,sys;print(json.dumps({"under":sys.argv[1],"message":sys.argv[2]}))' "$run" "$msg")"; did "shim: reads outside $run refused Unavailable";;
  files-start) control del stopped "$name"; did "shim";;
  stats-hang) control set delay_ms "stats:$name" "$1"; did "shim: delay $1 ms";;
  stats-unhang) control del delay_ms "stats:$name"; did "shim";;
  stats-refuse) control set refuse "stats:$name" "$(js "$1" "$2")"; did "shim: refuse $1";;
  stats-unrefuse) control del refuse "stats:$name"; did "shim";;
  # ---- reads of the machine's side (test/e2e-inspect-leases.mjs): the entries of <worker root>/store/<store>/open, and the worker's pid
  leases) [ "$kind" = machine ] || cannot "leases is for a machine"
    if [ "$platform" = host ]; then ls -1 "$root/store/$1/open" 2>/dev/null; echo "worker -"; else side "ls -1 $root/store/$1/open 2>/dev/null; echo worker \$(cat /layerfs/state/worker.pid)" </dev/null || exit 1; fi; exit 0;;
  # ---- real means only (test/e2e-inspect-real.mjs)
  worker-pause|worker-resume)
    [ "$kind" = machine ] || cannot "$action is for a machine"
    [ "$platform" != host ] || cannot "the host machine has no worker: its calls run in the caller's process"
    sig=STOP; [ "$action" = worker-resume ] && sig=CONT
    side "kill -$sig \$(cat /layerfs/state/worker.pid)" </dev/null || exit 1; did "real: SIG$sig to the worker of $machine";;
  machine-stop|machine-start)
    [ "$kind" = machine ] || cannot "$action is for a machine"
    [ "$platform" != host ] || cannot "the host machine is stopped and started by machine stop and machine start, not by this hook"
    [ -n "${HOOK_CLI:-}" ] || cannot "HOOK_CLI (the real CLI) is not set"
    [ -z "${HOOK_CACHE_HOME:-}" ] || export XDG_CACHE_HOME=$HOOK_CACHE_HOME
    if [ "$action" = machine-stop ]; then "$HOOK_CLI" machine stop "$name" --force >/dev/null || exit 1; did "real: layerfs machine stop $name --force"
    else "$HOOK_CLI" machine start "$name" >/dev/null || exit 1; did "real: layerfs machine start $name"; fi;;
  *) cannot "this hook has no action \`$action\`";;
esac
