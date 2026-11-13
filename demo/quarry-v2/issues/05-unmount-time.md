Filed as https://github.com/Ephemeral-AI-Lab/layerfs/issues/679

# `workspace unmount` right after a Commit runs the Commit's deferred reclamation

Found 2026-11-13 while profiling Quarry v2.
Repro scripts: [`05-unmount-time/`](05-unmount-time/).

- **Build:** pinned runtime `2.0.0-814768197b73` (commit `ba87a425`, `layerfs_v2_0_0`). Read
  against the tip `4c0803283e`: no code change in this area since the pin (the diff touches docs
  and the call log only).
- **Hosts:** a `docker` Sandbox on Linux FUSE (Docker Desktop VM, kernel 6.12, 8 CPUs, the
  bundle's Sandbox image), and a `native` macOS Sandbox (NFS route). Private LayerFS homes only.

## Symptom

In the Quarry v2 run (docker Sandbox, one Workspace per bash call: mount → exec → commit →
unmount), unmount time followed the size of the Commit just before it:

| Unmount after… | Count | Median | p90 | Max |
| --- | ---: | ---: | ---: | ---: |
| no Commit | 28 | 21 ms | 32 ms | 135 ms |
| an `UpToDate` Commit | 48 | 20 ms | 43 ms | 291 ms |
| a Commit under 1 s | 65 | 20 ms | 42 ms | 350 ms |
| a Commit over 5 s | 120 | 520 ms | 1.44 s | 16.2 s |

After the run stopped rewriting `target/` on every mount, Commits were still 3–48 s (real
compile output). Each unmount still took about 4–6% of its Commit's time: 2.2 s after a 40 s
Commit, 1.4 s after 24 s, 87 ms after 2.7 s. Times include about 16–19 ms of CLI start-up.

## Cause

The time is not unmount's own work. A Commit answers before reclaiming the overlay rows its
releases freed, and the next owner job on that Workspace runs all of that reclamation inside
itself. For a per-call Workspace, that next job is the unmount's first one.

1. Commit's releases use `call_deferred` (`layerfs-store-service/src/overlay/owner.rs:243`):
   "leaves the maintenance it readies queued instead of draining it on this thread. The next
   job of any caller, or `reclaim`, drains it; terminal close deletes it with the file."
2. After answering, the daemon starts `reclaim_after_commit`
   (`layerfs-daemon/src/control/operations.rs:375`). Its doc says the drain is "one bounded
   step per hold of the Workspace lock, so requests interleave with it and unmount stops it".
3. Every ordinary owner job ends with `if needs_maintenance && drain { self.maintain() }`
   (`owner.rs:446`), and `maintain()` loops until no maintenance is pending. So the first
   foreground job after a Commit doesn't interleave with the reclamation: it runs the rest of it.
4. Unmount's first owner job is the dirty check's `client.state(route)`
   (`layerfs-daemon/src/control/dirty.rs:73`). With `--discard` it is the kernel forgets during
   drain (FUSE `forget` → `kernel_forget`, an ordinary job; FUSE reply attempts drain too,
   `reply_attempted` in `owner.rs`), then `kernel_revoke` (`control/detach.rs:153`). Each of
   them drains. (`retire_namespace` runs after close and isn't one of them.)
5. The reclaimed rows live in the Workspace's own overlay SQLite file
   (`run/<sandbox>/overlay/<n>.sqlite`, 340 MB after writing a 300 MB file). Terminal close
   deletes that file a few milliseconds later. So, for a Workspace being unmounted, the
   reclamation is pure waste.

The work the Commit releases grows with what it wrote, so unmount time tracks Commit size.

## Measurements

The cases come from [`unmount-bench.sh`](05-unmount-time/unmount-bench.sh): 3 runs each, medians
shown, wall time per CLI call. CLI start-up alone (`layerfs --version`) takes 19 ms (docker run)
and 12 ms (native). Docker numbers share the VM with a live team run, so they carry some noise.

Unmount time, by what the mount did:

| Case | docker (Linux FUSE) | native (macOS NFS) |
| --- | ---: | ---: |
| mount, unmount, nothing done | 31 ms | 34 ms |
| 10 × 1 KB, committed | 24 ms | 35 ms |
| 1,000 × 1 KB, committed | 27 ms | 56 ms |
| 10,000 × 1 KB, committed | **584 ms** | 247 ms |
| 10,000 × 1 KB, not committed (`--discard`) | 153 ms | 217 ms |
| 10,000 × 1 KB, rewritten with identical bytes, committed | **531 ms** | 305 ms |
| 10,000 × 1 KB read (no writes) | 35 ms | 178 ms |
| 1 × 1 MB, committed | 25 ms | 35 ms |
| 1 × 100 MB, committed | **376 ms** (1 run) | 108 ms |
| 1 × 1 GB, committed | **2.70 s** (1 run) | 3.55 s |
| 100 × 10 MB, identical rewrite, committed | **2.17 s** (1 run) | 4.31 s |

Reading 10,000 files, so the kernel holds 10,000 lookups and forgets them at unmount, costs
almost nothing on Linux (35 ms). A single 1 GB file costs 2.7 s. So the cost is not per inode
or per FORGET; it's the Commit's released data.

**Who pays** ([`drain-check.sh`](05-unmount-time/drain-check.sh), docker, 3 runs each, right
after the Commit):

| After the Commit | 1 × 100 MB | 10,000 × 1 KB |
| --- | --- | --- |
| A: `unmount` | 200–241 ms | 306–364 ms |
| B: `workspace status`, then `unmount` | status **186–265 ms**, then unmount **24–30 ms** | status **278–312 ms**, then unmount **30–57 ms** |
| C: `unmount --discard` | 208–255 ms | 288–344 ms |

**A pause instead** ([`delay-bench.sh`](05-unmount-time/delay-bench.sh), docker, 2 runs each):
the unmount gets cheap once something else has drained the reclamation.

| Pause between Commit and unmount | 1 × 100 MB | 10,000 × 1 KB |
| --- | --- | --- |
| 0 s | 328–381 ms | 312–1,063 ms |
| 1 s | 69–81 ms | 75–98 ms |
| 3 s | 51–58 ms | 68–93 ms |
| 10 s | 40–74 ms | 88–154 ms |

On the native NFS route the data part behaves the same (`status` absorbs it; then unmount takes
38–45 ms for 100 MB). The macOS NFS client's own `umount` adds about 200 ms per 10,000 files
touched: 10,000 files cost about 200 ms even after `status`, and 10,000 merely-read files 178 ms.
That cost is in the OS client, outside the deferred reclamation.

## What unmount itself costs

With the reclamation already drained, unmount takes 24–57 ms on docker (B above), including
19 ms of CLI start-up. That is about 5–40 ms for detach, drain, revoke, close and namespace
retirement, whatever the Commit's size.

## Options

| Option | Where | Expected gain | Cost / risk | Keeps the user's model? |
| --- | --- | --- | --- | --- |
| **1. A terminal unmount doesn't run the deferred reclamation**: its owner jobs (dirty `state`, kernel forgets and reply attempts after detach, `kernel_revoke`) run without draining (`drain = false`, as `call_deferred` does), and close discards the pending maintenance with the file, as `call_deferred`'s doc already says | LayerFS | Unmount after any Commit: about 25–55 ms on docker (CLI included), instead of 0.3–16 s. For per-call Workspaces, no reclamation I/O or CPU at all (about 2.5 s per GB and about 30 ms per 1,000 files on docker), which also helps a busy VM | Small and local. A Workspace that stays mounted still reclaims on its next job | Yes: nothing changes for agents |
| 2. Foreground jobs take one bounded maintenance step, not the whole backlog, while `reclaim_after_commit` runs (what its doc promises) | LayerFS | Any call right after a Commit (`status`, `exec` for a second Commit) stops paying for the backlog. Unmount still waits unless option 1 is done too | The total reclamation work stays the same | Yes |
| 3. A commit-and-close call (`workspace commit --unmount`) | LayerFS API | Option 1's gain plus one fewer CLI process (about 19 ms) per bash call | A new option in the contract | Yes |
| 4. Unmount in the background in the skill's `trap` (`( layerfs workspace unmount "$ws" & )`) | dsh-layerfs skill | Takes 0.3–16 s off each bash call's critical path today | The reclamation still burns the VM. The slot (16 per Sandbox) and the `--name` stay taken until it ends, so fixed per-worker names hit `NameTaken` (names would need a per-call suffix). An unmount refusal goes unseen by the agent (the call log still has it) | Yes, but it adds name and slot rules |
| 5. Keep a Workspace mounted across bash calls | skill | Saves mount/unmount (about 50 ms per call). The reclamation still runs, on the next call's first job | Breaks "one Workspace per bash call": stale view between Commits, slots and disk held | **No** |
| 6. `unmount --discard` after the Commit | skill | None (measured: C above) | — | — |
| 7. Avoid identical-byte rewrites (no mount path in `RUSTFLAGS`; done in the run, F17) | skill / run | Shrinks the Commit's released data and with it the unmount. In the run, unmounts after it still cost 0.1–2.2 s | Already done | Yes |

Nothing here removes anything installed or committed to the Store. The reclaimed rows are the
Workspace's local overlay copies of data the Commit already saved.

## Recommendation

File option 1 upstream; it's the actual fix. `call_deferred`'s doc ("terminal close deletes it
with the file") and `reclaim_after_commit`'s doc ("unmount stops it") both describe it as the
intended behaviour, and `job()`'s unconditional drain defeats both. Option 2 is the same bug seen
from non-terminal calls; file it in the same issue.

Until it ships, keep option 7 (already in place) and don't adopt option 4 unless unmount time
blocks agents. Option 4's gain is real, but it needs per-call Workspace names and leaves the
wasted reclamation running on the VM.

## Repro

```bash
# private home only; docker needs the bundle
export LAYERFS_HOME=<private 0700 dir> XDG_CACHE_HOME=<private cache>
export LAYERFS_BUNDLE=~/.layerfs/runtime/2.0.0-814768197b73/bundle/linux-aarch64
L=~/.layerfs/runtime/2.0.0-814768197b73/bin/layerfs
mkdir -p "$XDG_CACHE_HOME/layerfs/bundle/2.0.0/macos-aarch64"
cp ~/.layerfs/runtime/2.0.0-814768197b73/bin/layerfs-daemon "$XDG_CACHE_HOME/layerfs/bundle/2.0.0/macos-aarch64/"
$L store create umd && $L project init umd/p <src dir> && $L machine start docker
$L store push umd docker && $L sandbox create umd/p sbd docker
./05-unmount-time/drain-check.sh sbd umd/p dc 1 104857600     # A/B/C table, 100 MB
./05-unmount-time/drain-check.sh sbd umd/p de 10000 1024      # A/B/C table, 10k files
CASES="1 104857600;10000 1024" ./05-unmount-time/delay-bench.sh sbd umd/p dl
./05-unmount-time/unmount-bench.sh sbd umd/p 3                # the full table
# cleanup: layerfs sandbox close sbd; layerfs machine stop docker; remove that home's worker container and volume
```
