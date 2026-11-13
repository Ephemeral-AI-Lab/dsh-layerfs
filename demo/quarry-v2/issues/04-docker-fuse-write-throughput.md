# The pinned Linux bundle was a debug build: docker Workspaces wrote at ~30 MB/s

Resolved by rebuilding; nothing to file upstream about LayerFS code. Found 2026-11-13
while profiling Workspace Commit for Quarry v2. The cause was identified by the Quarry v2
operator.

## Cause

The runtime the app had pinned, `2.0.0-814768197b73`, built from `ba87a425ec`, shipped a
**debug** Linux bundle: `bundle.json` says `"profile": "debug"`, and its `layerfs-daemon`
is 211 MB. The macOS daemon in the same runtime was a release build (about 12.5 MB), so
native Sandboxes were never slow. Every docker Sandbox's FUSE daemon ran unoptimized
code.

The next runtime, `2.0.0-68efc1719472`, built from `de1d77e130` (the tip of
`layerfs_v2_0_0`), ships a **release** bundle with a 14.6 MB daemon. The 53 commits in
between change no FUSE write or Commit code: the call log (#659), the lease fix, the
`sandbox.get` fix, and docs. The speed-up therefore comes from the build profile.

## Measurements (private home, idle docker machine, one fresh Workspace each)

| Case | debug bundle (`814768197b73`) | release bundle (`68efc1719472`) | native (release) |
| --- | ---: | ---: | ---: |
| `dd bs=1M count=200` into the Workspace | 32.5 MB/s | 437 MB/s | 353 MB/s |
| `dd bs=4k count=25000` into the Workspace | 8.5 MB/s | 76 MB/s | 309 MB/s |
| Commit of one 200 MB random file | 10.2 s | 0.38 s | 0.87 s |
| `layerfs-daemon` CPU during writes | ~60% of a core | | |

For reference, the worker container writes `/layerfs/data` (ext4 on the VM disk) at
889 MB/s outside FUSE.

## Effect on Quarry v2

On the debug bundle, Commits cost about 2–6 MB/s of new content: 18.9 MB took 4.6 s,
69 MB took 13.4 s, 236 MB took 39.7 s, and 79 MB took 48 s. Writes during builds were
slowed by the same factor. After the switch to the release bundle (with RUSTFLAGS fixed
and `debug = 0`), round 2 measured a Commit median of 253 ms and p90 of 3.7 s.

## Follow-ups

- **Guard against it:** check that a pinned bundle's `bundle.json` has
  `"profile": "release"` before pinning it (a doctor check, or `scripts/runtime-pin.mjs`).
- **Open:** whether the daemon's design (no FUSE writeback cache, 128 KB write requests)
  still costs much on release builds. 437 MB/s for 1 MB writes suggests not much; 4 KB
  writes are still about 4× slower than native.

## Related

A Workspace's overlay file keeps everything written since mount. Measured on the debug
bundle, it was still 90 MB after an 80 MB write and its Commits, and later Commits in that
Workspace slowed down to match: 100 changed files took 11–14 s, against 227 ms in a fresh
mount. Not yet re-measured on the release bundle.
