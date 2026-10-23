# Windows dsh Live: WSL adapter verification

> **Status:** Current general guide. Scoped integration verification record, not release qualification.

The Windows dsh server and its default profile stay on Windows. One authenticated
loopback worker in a selected WSL2 distribution owns native LayerFS handles and
opens Stores directly on that distribution's local filesystem. Sandbox daemons
use that distribution's Docker Engine. This addresses the Windows runtime scope
of [#399](https://github.com/Ephemeral-AI-Lab/layerfs/issues/399).

## Change and boundaries

The adapter has separate WSL lifecycle and path handling; the existing macOS
container lifecycle stays in place. Both use versioned JSON with binary tags,
including Init's stdio channel, replacing V8 serialization across Node builds.
Malformed frames report a protocol error. A lost sent reply is Unknown and is
never replayed. Failed Windows Init and uncertain Init replies retain discovery
and the Store volume. Project removal closes cached native Store ownership and
clears the removed project's session lock, allowing another selection.

Windows agent traces default to the shell-writable workspace and retain their
location across Host restarts. Windows binding reads use the existing short
cross-process admission lock so they cannot overlap atomic replacement.
No client UI changes from the earlier local Windows commit are included.
The product SDK, daemon and Store format are unchanged by this change.

The macOS worker wire format changes: upgrade the Host and worker together while
no calls are active. There is no legacy-protocol fallback or replay.

## Source and runtime identity

Base: `f87a788a6c3e0d5f2993658d2eb5f0cb18877866`.
[identity.json](windows-live-20261022/identity.json) pins every Host production/test
file by SHA-256 with CRLF normalized to LF. [manifest.json](windows-live-20261022/manifest.json)
pins the reused release daemon/addon build, its source and compiler. The unchanged
native bundle is from `49b176c287abc9ec8586ca7aafb9ceea1ec7456f`, built with Rust
1.85.1; this is adapter integration evidence, not a newly built native main claim.
The worker verifies the bundle's file hashes and the Windows SDK source matches
its sealed Linux SDK before accepting use.

Windows Node: v24.11.1. WSL Node: v22.22.1. WSL Docker Engine: 29.9.2.
Runtime image: `sha256:0751d2c2245af1c311a24565c63f73378eed5f08fa39be7a68da2193192b0c51`.
All executed Stores use Disposable. Durable: NOT_RUN ? disabled by owner until
explicit reauthorization. No native build or benchmark was run for this change.

## Verification

- Windows `pnpm run test:windows`, bounded by a Python subprocess timeout of 100 s:
  PASS. Covers codec binary/tag collisions and malformed frames, Init stdio,
  Windows path boundaries, no request before authentication, no lost-reply replay,
  Host routing/traces and shared bindings including selecting again after removal.
- Linux Node tests `frames`, `windows`, `host`, `bindings-shared`, `sim`, `runtime`,
  each bounded at 100 s: PASS. After the final binary validation/custody changes,
  the affected `frames`, `host` and `bindings-shared` checkpoints passed again.
- `port-worker.mjs` in its own Linux Docker container with no external network
  and a fake binding, bounded at 100 s: PASS. Exercises the actual macOS worker
  entry point, authenticated handshake, binary SDK request and protocol diagnostic.
  This is not a macOS host/Docker Desktop proof.
- Final `windows-real.mjs <sealed-bundle> <image>` from Windows, bounded at 115 s:
  PASS. [receipt.json](windows-live-20261022/receipt.json) retains import with spaces,
  apostrophe and Chinese characters, .git and ignored-file membership, SDK write,
  FUSE mount/Exec/Commit/unmount, publish/read/history, text and raw binary output
  each larger than 1 MiB, the actual quiet-minute native close, reopen, graceful
  worker restart, runtime status and explicit removal of the owned test volume.
- The earlier correctness checkpoint before adding the final large binary sink
  assertion also passed; its receipt remains at the run-owned local directory
  `layerfs-windows-proof-0cZ5yh`. It is not relabeled as final-source evidence.
- `git diff --check`: PASS. No tests were deleted. No full-suite/CI claim.

macOS host execution: NOT_RUN. Packaged desktop and npm/plugin-market installation:
NOT_RUN, tracked in [#406](https://github.com/Ephemeral-AI-Lab/layerfs/issues/406).
Docker Desktop engine volumes from a nonroot WSL Linux Host remain unresolved in
[#380](https://github.com/Ephemeral-AI-Lab/layerfs/issues/380). The Windows adapter
uses a WSL-local Engine with access to its local Store volume root.

## Production source comparison

Production LOC: 108459 -> 108911 (delta +452).
Core 96696 -> 96696; SDK 3032 -> 3032; dsh 8731 -> 9183.
Reference absent (retired R9c; last counted 65,417 at tree 498dd1917812).
Method: `tools/production_loc.py` blob `e6d94d1a731b402ccc9159f49cef1eba5a74cfe0`
with `--root <snapshot> --json` on exact parent and staged Git trees, exported by
`git archive` for core/crates, sdk/js and dsh/packages. Tests, tools, docs and
manifests are excluded. [loc.json](windows-live-20261022/loc.json) retains the
per-crate counts. The increase is the Windows adapter and shared protocol/trace/
removal fixes, not a performance or algorithmic simplification claim.
