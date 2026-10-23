# Helpers for the replayed runs (scenarios shop, depot and crew, written by
# tools/replay/convert.mjs). Each replayed step's command sources this file
# after defining `layerfs` as the preset does, and then makes the recorded
# LayerFS calls with the layerfs command, one call per command.
#
# What outlives one bash call is kept as small files under
# $DSH_LAYERFS_HOME/$DSH_LAYERFS_PROJECT/replay/, removed with the project:
#   sandbox-<agent>   the number of the agent's Sandbox
#   image             the recorded run's runtime image, which its Sandboxes use
#   ws-<agent>-<key>  a Workspace that stays mounted across steps, by its recorded path
#   layer-<n>         main's Layer n (the n-th publish), for a fork from it
# Every call is attempted once. A refusal or an answer the record does not
# have ends the command with a non-zero exit, which stops the run there.
# Written for bash 3.2 (macOS).

case "$DSH_LAYERFS_PROJECT" in
  mock-*) ;;
  "") echo "✕ no LayerFS project in this conversation"; exit 1 ;;
  *) echo "✕ $DSH_LAYERFS_PROJECT is not a scenario's project (mock-…): refused"; exit 1 ;;
esac
R="$DSH_LAYERFS_HOME/$DSH_LAYERFS_PROJECT/replay"
mkdir -p "$R" || exit 1

# keep <key> <value> / kept <key> / forget <key>: the replay's notes
keep() { printf '%s\n' "$2" >"$R/$1.tmp" && mv "$R/$1.tmp" "$R/$1"; }
kept() { [ -f "$R/$1" ] || { echo "✕ nothing is kept as $1 (no earlier step made it)" >&2; return 1; }; cat "$R/$1"; }
forget() { rm -f "$R/$1"; }

# field <a.b.0.c>: one field of the JSON on stdin; fails when it is missing
field() {
  node -e 'const text = require("fs").readFileSync(0, "utf8");
let v;
try { v = JSON.parse(text); } catch { console.error(`✕ not a JSON answer: ${text.slice(0, 200) || "(nothing)"}`); process.exit(1); }
for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
if (v === undefined || v === null) { console.error(`✕ the answer has no ${process.argv[1]}`); process.exit(1); }
console.log(typeof v === "object" ? JSON.stringify(v) : String(v));' "$1"
}

# ... | kind <kind>...: prints a call's answer; fails unless its kind is one of these
kind() {
  local out k w
  out=$(cat) || return 1
  printf '%s\n' "$out"
  k=$(printf '%s' "$out" | field kind) || return 1
  for w in "$@"; do [ "$k" = "$w" ] && return 0; done
  echo "✕ answered $k; the record has $*" >&2
  return 1
}

# exit_is <code> <recorded>...: a command's exit code must be a recorded one
exit_is() {
  local code=$1 w
  shift
  echo "[exit $code] (recorded: $*)"
  for w in "$@"; do [ "$code" = "$w" ] && return 0; done
  echo "✕ the command exited $code; the record has $*" >&2
  return 1
}

# refused <code> <layerfs arguments>...: a call the record has refused with <code>
refused() {
  local want=$1 err code
  shift
  err=$(mktemp) || return 1
  if layerfs "$@" 2>"$err"; then rm -f "$err"; echo "✕ layerfs $1 $2 succeeded; the record has it refused $want" >&2; return 1; fi
  cat "$err" >&2
  code=$(field code <"$err" 2>/dev/null)
  rm -f "$err"
  [ "$code" = "$want" ] && { echo "refused $want, as recorded"; return 0; }
  echo "✕ refused ${code:-without a code}; the record has $want" >&2
  return 1
}

# sandbox_of <agent>: the agent's Sandbox number. A Sandbox closes itself two
# minutes after its last Workspace is unmounted, and holds 16 Workspaces at
# most; when the kept one is not running or is full (project.list_sandboxes),
# a new one is created from the recorded image (`keep image`) and kept, as the
# preset tells an agent to do.
sandbox_of() {
  local sb state
  sb=$(kept "sandbox-$1") || return 1
  state=$(layerfs project list_sandboxes --page-size 1000 | node -e 'const page = JSON.parse(require("fs").readFileSync(0, "utf8"));
const s = page.items.find((x) => String(x.sandbox) === process.argv[1]);
console.log(!s ? "not running" : s.workspaces >= 16 ? "full" : "ok");' "$sb") || return 1
  if [ "$state" != ok ]; then
    echo "(Sandbox $sb of $1 is $state: a new one)" >&2
    sb=$(layerfs sandbox create --image "$(kept image)" | field sandbox) || return 1
    keep "sandbox-$1" "$sb"
  fi
  printf '%s\n' "$sb"
}

# close_sandbox <agent>: sandbox.close of the agent's Sandbox. NoSuchSandbox
# means it already closed itself when idle. MountsActive with none of the
# agent's own Workspaces kept means its number was used again by another
# agent's new Sandbox after it closed itself; that one is left to close itself.
close_sandbox() {
  local sb err code
  sb=$(kept "sandbox-$1") || return 1
  err=$(mktemp) || return 1
  if layerfs sandbox close "$sb" 2>"$err"; then rm -f "$err"; forget "sandbox-$1"; return 0; fi
  code=$(field code <"$err" 2>/dev/null)
  case "$code" in
    NoSuchSandbox) echo "(Sandbox $sb had already closed itself)" ;;
    MountsActive)
      if ls "$R/ws-$1-"* >/dev/null 2>&1; then cat "$err" >&2; rm -f "$err"; return 1; fi
      cat "$err"
      echo "(Sandbox $sb holds Workspaces $1 did not keep: another agent's, its number used again after it closed itself; it closes itself when idle)" ;;
    *) cat "$err" >&2; rm -f "$err"; return 1 ;;
  esac
  rm -f "$err"
  forget "sandbox-$1"
}

# commit_of <branch> <message>...: the id of the Branch's own Commit with the
# first of these recorded messages it has (a recorded Commit this replay does
# not make names the one before it), else the node the Branch was forked from
commit_of() {
  node "$(dirname "${BASH_SOURCE[0]}")/replay-commit.mjs" "$@"
}

# census_own <output file> <comm>...: a process census written for the recorded
# runtime may fail only by finding these processes of the Sandbox's own
census_own() {
  node -e 'const [file, ...own] = process.argv.slice(1);
const line = require("fs").readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("{") && l.includes("\"unexpected\""));
let census = null; try { census = line ? JSON.parse(line) : null; } catch {}
const others = census?.unexpected?.filter((p) => !own.includes(p.comm)) ?? null;
if (!census?.unexpected?.length || others.length) { console.error(`✕ the census found ${others?.length ? "processes other than the Sandbox’s own: " + others.map((p) => p.pid + " " + p.comm).join(", ") : "no census line"}`); process.exit(1); }
console.log(`(the census found only the Sandbox’s own ${census.unexpected.map((p) => p.comm).join(", ")})`);' "$@"
}
