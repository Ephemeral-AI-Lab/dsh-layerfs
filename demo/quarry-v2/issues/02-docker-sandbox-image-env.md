# A docker machine's namespaces Sandbox ignores the Sandbox image's `ENV` (no Rust on PATH)

Draft for the user to file (not filed). Found 2026-11-13 07:23Z while preparing Quarry v2.

- **Build:** pinned runtime `2.0.0-814768197b73` (`layerfs_v2_0_0`), app home, `docker`
  machine (worker `lfs-0c9dc9c9-docker`, `backend: namespaces`, `route: fuse`).
- **Image:** the bundle's `sandbox-image.tar`, digest
  `sha256:1d91885de27a20805af0d1b99602ace066f0514983613e391ee1f73ac8e7c2e9`
  (`layerfs-352-runtime`, Node 24 + Rust 1.85.1). Its Docker config sets
  `PATH=/usr/local/cargo/bin:…`, `RUSTUP_HOME=/usr/local/rustup`, `CARGO_HOME=/usr/local/cargo`.

## Repro

```bash
layerfs sandbox create <store>/<project> sb docker
layerfs branch fork <store>/<project> b main && layerfs workspace mount sb b --name w
layerfs workspace exec sb:w 'echo $PATH; rustc -V' --stream
#  /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
#  bash: line 1: rustc: command not found
layerfs workspace exec sb:w '/usr/local/cargo/bin/rustc -V' --stream
#  error: rustup could not choose a version of rustc to run … no default is configured
layerfs workspace exec sb:w 'export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH; rustc -V' --stream
#  rustc 1.85.1 (4eb161250 2025-03-15)
```

`docker run --rm <image> rustc -V` works, because Docker applies the image config.

## Expected

The docs say the default Sandbox image is the runtime image with Rust 1.85.1
(`docs/versioned/2.0.0/machines-and-stores.md`). A Sandbox rooted in that image should
get the image's `Env` (at least `PATH` and the tool homes), as a container would.

## Also seen

- `/tmp` in the Sandbox is a `tmpfs` of 3.9 GB (half of the 8 GiB Docker VM), shared by
  every Workspace of the Sandbox. Large test data there competes with RAM.
- `HOME` is the Sandbox's run folder on the data disk
  (`/layerfs/data/machine/native/run/lfs-<id>-<sandbox>/tmp`); the process runs as uid 501.

## Workaround (done)

The dsh-layerfs skill (`SKILL.md` "Running commands", `references/rules/cargo.md`,
`references/rules/team.md`) tells agents to export `RUSTUP_HOME` and `PATH` in every exec
and to keep large temp data under `$HOME/tmp/<ws>`.
