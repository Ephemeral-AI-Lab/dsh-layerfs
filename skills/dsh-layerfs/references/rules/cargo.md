# Rust and Cargo in a Workspace

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`).

## Keep all mutable Cargo state inside the Workspace

The Rust toolchain comes from the Sandbox (its image, or the host for a `native`
Sandbox): check with `command -v cargo rustc`. On a `docker` Sandbox the image's
environment is not applied, so `cargo` is not on `PATH` and rustup has no home: add
`export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH` to every exec
(before setting `CARGO_HOME` inside the Workspace; the rustup proxies still work). Everything Cargo writes belongs inside
the Workspace: the Commit saves it with the project, and the next mount of the Branch
starts with the registry, the sources and `target/` already there, so nothing is
fetched or compiled again. Set the variables in every exec: exports don't survive
between calls.

```bash
ws=$SB:fetch
layerfs workspace mount "$SB" "$B" --name fetch >/dev/null || exit 1
trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT
layerfs workspace exec "$ws" 'timeout 540 bash -c "set -eu
export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:\$PATH
export CARGO_HOME=\$PWD/.cargo-home CARGO_TARGET_DIR=\$PWD/target CARGO_NET_RETRY=0 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
unset RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
cargo fetch --locked"' --stream; code=$?        # in a bash call with a 600 s timeout
layerfs workspace commit "$ws" -m "cargo fetch (exit $code)" >/dev/null
```

Use the project's toolchain and `Cargo.lock` as they are. Don't use a Cargo home or
target outside the Workspace, `sccache`, host-built artifacts, or edits to downloaded
registry sources.

## Build reuse across mounts

Every mount has its own path (`…/workspaces/<n>`, new each time). Cargo copes with
that: it records the Workspace's own files relative to it, so a fresh mount of a Branch
with `target/` committed reuses it, and an unchanged `cargo build` prints no
`Compiling` at all. What breaks reuse is **a flag that contains the mount path**:
`RUSTFLAGS` (and `CARGO_ENCODED_RUSTFLAGS`, `[build] rustflags`) is part of every
fingerprint, so `--remap-path-prefix=$PWD=…`, `-L $PWD/…` or any other `$PWD` there
changes on every mount and rebuilds everything, every time (`CARGO_LOG=cargo::core::compiler::fingerprint=info`
shows `dirty: RustflagsChanged`). A full rebuild also makes the Commit slow: thousands
of rewritten `target/` files to process, even when their bytes are unchanged.

So keep `RUSTFLAGS` free of mount paths (absolute paths that are the same in every mount,
like the toolchain's sysroot, are fine) and set the same flags, profile, features and job
count in **every** exec, in every Workspace. Check once per task that a fresh mount's
unchanged `cargo build` prints no `Compiling`; if it recompiles, compare the flags first.

## Keep build output small

Every byte a build writes goes through the Workspace, and the Commit reads it again
and stores what is new. A build that writes hundreds of MB of fresh artifacts makes
every Commit and every later mount heavier, and many small writes cost more than a few
large ones. So:

- Debug info is most of a test binary. Use `[profile.dev] debug = 0` (the test profile
  inherits it) and `[profile.dev.package."*"] debug = false` unless the task needs a
  debugger; panics still name the failing test and function. Never `debug = "full"`.
- Each file in a crate's `tests/` is its own binary that links the whole crate and its
  dependencies again. Keep a crate's integration tests in one binary: `tests/it/main.rs`
  with `mod parser; mod planner;` (one module per former file).
- Build only what you run: `-p <package>`, `--test <name>`, `--lib`.

## Split and label the work

One bash call is one Workspace: mount, the cargo steps, commit, unmount. Keep each
call within 600 s (inner `timeout` 30 s less; on a native macOS Sandbox, which has no
`timeout`: `perl -e 'alarm shift; exec @ARGV' 570 …`), and run longer builds as in
[team runs: waiting](team.md#waiting). Build a test target first with
`cargo test --locked --offline -p <package> --no-run`, commit, then run it in the next
call. Use package and target selections when the whole workspace would not fit.

## Merging

A Rust project can rule only generated `target/` and `.cargo-home/` in
[`/.lww`](lww.md) (both are usually in `.gitignore` already). Never rule `Cargo.lock`,
manifests, sources or tests: inspect real source conflicts, keep both changes, then
rebuild and test the merged result.
