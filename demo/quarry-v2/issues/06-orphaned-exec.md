Draft, not filed yet. Needs a minimal repro on a private home before filing.

# A `workspace exec --stream` keeps running after its client is gone, and `workspace status` says Idle

Found 2026-11-13 during Quarry v2. Pinned runtime `2.0.0-8134bc02b50f` (commit c5e58735bb,
`layerfs_v2_0_0`, release). A `docker` Sandbox (Linux FUSE, Docker Desktop VM, 8 GiB).

## What happened

1. About 19:23Z, worker F2 ran one bash call through the managed CLI:
   `layerfs workspace exec dsh-939f81ff…:w-f2r15 '<script>' --stream`. The script is
   `. scripts/env.sh w-f2r15 && cargo fmt …; timeout 400 scripts/cargo-slot.sh …`. In the
   Sandbox, the script's bash is pid 3167, and its child `strata-slt tests/slt/13-recursive.slt`
   is pid 12259.
2. The test's recursive CTE never ends, and pid 12259 grew to 5 GB.
3. At 19:27Z, the operator stopped F2's DSH turn ("Stop generating"). That kills the host-side
   CLI process, which is the `--stream` client.
4. From 19:27Z on, `workspace status` on that Workspace reported activity `Idle`. Yet at 19:31Z,
   pid 12259 was still running at 5.08 GB with its parent bash (pid 3167). The guest had
   MemAvailable 0.3 GB and full swap.
5. The guest kernel OOM-killed pid 12259 shortly after (oom_kill 8 → 9). Neither LayerFS nor the
   script's `timeout 400` ended it.

The same thing had already happened at 19:23Z, with OOM kill #8, for an earlier run of the same
test.

## Why it matters

- A command whose caller is gone keeps consuming the Sandbox's CPU and memory with no owner.
  On a shared VM it starves the daemon: the earlier OOM episodes coincided with host stalls of
  10–43 s and a readiness timeout.
- `workspace status` says Idle, so no client can see that anything is running.
- `workspace exec-cancel <ws> <exec-id>` would end it. But the caller never learned the exec id:
  `--stream` was used without `--exec-id`, and the call log only records an exec when it ends.
  Nothing else lists running execs.

## Expected

One of these, ideally both:

1. When the `--stream` client disconnects (its process dies, or the control connection closes),
   the daemon treats it as `exec-cancel`: SIGTERM, then SIGKILL after a grace period, for the
   whole process group.
2. `workspace status` (or a new `workspace execs <ws>`) lists running execs with their ids, pids,
   start time and command. A detached exec is then visible and cancellable.

## Open questions for the repro

- Is it disconnect detection, or does the daemon cancel only the direct child (the bash) and
  miss its process group? `timeout 400` should have fired by 19:30 if the bash had been
  signalled, unless the exec started later than we think.
- Does `workspace status` "Idle" mean "no exec registered" (so the daemon dropped the exec on
  disconnect without killing it), or is activity tracked only for FUSE I/O?

## Repro sketch (private home)

```bash
export LAYERFS_HOME=<private> LAYERFS_BUNDLE=<pinned bundle>
L=<pinned cli>
$L workspace exec "$WS" 'sleep 600' --stream & pid=$!
sleep 2; kill -9 $pid
$L workspace status "$WS"          # activity?
docker exec <worker> ps -ef | grep 'sleep 600'   # still running?
```
