# Rust and Cargo in a Workspace

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`).

## Keep all mutable Cargo state inside the Workspace

The Rust toolchain comes from the Sandbox (its image, or the host for a `native`
Sandbox): check with `command -v cargo rustc`. Everything Cargo writes belongs inside
the Workspace: the Commit saves it with the project, and the next mount of the Branch
starts with the registry, the sources and `target/` already there, so nothing is
fetched or compiled again. Set the variables in every exec: exports don't survive
between calls.

```bash
ws=$SB:fetch
layerfs workspace mount "$SB" "$B" --name fetch >/dev/null || exit 1
trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT
layerfs workspace exec "$ws" 'timeout 540 bash -c "set -eu
export CARGO_HOME=\$PWD/.cargo-home CARGO_TARGET_DIR=\$PWD/target CARGO_NET_RETRY=0 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
export RUSTFLAGS=\"--remap-path-prefix=\$PWD=/w\"
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
cargo fetch --locked"' --stream; code=$?        # in a bash call with a 600 s timeout
layerfs workspace commit "$ws" -m "cargo fetch (exit $code)" >/dev/null
```

Use the project's toolchain and `Cargo.lock` as they are. Don't use a Cargo home or
target outside the Workspace, `sccache`, host-built artifacts, or edits to downloaded
registry sources.

## Build reuse across mounts

Every mount has its own path, so Cargo sees a new source location each time unless the
paths are remapped. Set the same `RUSTFLAGS` (with `--remap-path-prefix=$PWD=/w`),
profile, features and job count in **every** exec, in every Workspace. Then a fresh
mount of a Branch with `target/` committed reuses it: an unchanged `cargo build`
prints no `Compiling` for dependencies. Check that once per task; if it recompiles,
compare the flags first. `debug = "full"` makes `target/` several times larger:
prefer `[profile.dev] debug = "line-tables-only"` unless the task needs full debuginfo.

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
