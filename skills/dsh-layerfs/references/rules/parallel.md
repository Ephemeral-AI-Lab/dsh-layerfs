# Parallel work: subagents and side Branches

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

## Ways to split work

| Way | Use it for | Lands in the session |
| --- | --- | --- |
| **`file` calls on `$B`, separate files** | A few subagents changing different files | At once: each write is a Commit on `$B` |
| **Workspaces on `$B`**, one per bash call | A few subagents running commands at the same time | At each Workspace Commit |
| **A Branch each** | Experiments, alternatives, and 4 or more workers building at once ([team runs](team.md)) | Only when you bring it in (below) |

Subagents you start get the same variables: the same `$P`, `$B` and `$SB`, and they
share the Sandbox's 16 Workspace slots, dsh's own included. Tell each one which files
are its own, which Branch and Workspace names to use, and to report what it committed.

## A few subagents at the same time on `$B`

Two commands in one Workspace at once step on each other, so each subagent mounts its
own Workspace, under a name of its own, on `$B` in `$SB`, and goes mount, exec,
commit, unmount within the bash call. A Commit merges with what others committed
first; generated files merge by [`/.lww`](lww.md).

```js
const { ws } = await layerfs.workspace.mount(SB, B, { name: "w-api" });   // a name per subagent
try {
  const run = await layerfs.workspace.exec(ws, "timeout 110 npm test -- api 2>&1");
  const saved = await layerfs.workspace.commit(ws, { message: `api: tests (exit ${run.exit_code})` });
  console.log(saved.kind, saved.head);          // report this Commit
} finally {
  await layerfs.workspace.unmount(ws);
}
```

- A Workspace shows `$B` as it was at its mount (or last Commit): others' `file`
  writes and Commits since then appear at its next Commit.
- Give subagents separate files. Overlapping lines stop a Commit with a
  [Conflict](conflicts.md#commit-conflicts), which is that subagent's to resolve in its
  Workspace.
- More than 4 at once, or Rust builds: give each worker its own Branch
  ([team runs](team.md)).
- After a restore (the runtime context says the files were restored), `$B` is a new
  Branch. Variables are read fresh in every bash call, so new mounts use it. A
  Workspace still mounted on the old Branch saves nothing for the session: a worker
  that finds its Workspace's `branch` (`workspace status`) differs from
  `$DSH_LAYERFS_BRANCH` commits, unmounts and reports instead of carrying on.

## Side Branches

Fork from `$B` or from `main`, and work there with `file` calls, and Workspaces for
commands:

```bash
layerfs branch fork "$P" try-cache "$B"
layerfs file edit "$P" try-cache /src/cache.js --old 'ttl = 60' --new 'ttl = 300' -m "longer ttl"
layerfs branch diff "$P" "$B" try-cache --paths-only
```

Forked Branches stay in the project's history; you can't delete them. Name them for
their work, never `dsh.…`.

### Bringing work into the session

A merge always makes a new Branch, so it can't move `$B`. To bring a side Branch's
result into the session, merge it with `$B` into a new Branch, then write what changed
onto `$B` as one Commit. Generated output (`target/`, `node_modules/`) is not copied:
rebuild it after.

```js
const side = "try-cache", merged = `${side}-in`;
await layerfs.branch.merge(P, merged, B, side, { message: `bring ${side} into the session` });
const changes = [], removed = [], skipped = [];
for (let cursor = null; ; ) {
  const d = await layerfs.branch.diff(P, B, merged, { paths_only: true, page_size: 1000, ...(cursor ? { cursor } : {}) });
  for (const item of d.items) {
    if (removed.some((dir) => item.path.startsWith(dir + "/"))) continue;   // inside a removed folder
    if (/^\/(target|\.cargo-home)\/|\/node_modules\//.test(item.path)) continue;   // generated: rebuild after
    if (item.kind === "Removed") { changes.push({ op: "rm", path: item.path }); if (item.type === "dir") removed.push(item.path); continue }
    if (item.type === "dir") { if (item.kind === "Added") changes.push({ op: "mkdir", path: item.path }); continue }
    if (item.type === "symlink") { skipped.push(item.path); continue }
    let content = "", line = 1;
    try {
      for (;;) {
        const r = await layerfs.file.read(P, merged, item.path, { start_line: line });
        content += r.text;
        if (r.next_line == null) break;
        line = r.next_line;
      }
    } catch (e) { if (e.code !== "Binary") throw e; skipped.push(item.path); continue }
    const { mode } = await layerfs.file.stat(P, merged, item.path);   // keep executables executable
    changes.push({ op: "write", path: item.path, content, mode });
  }
  if (!d.has_more) break;
  cursor = d.next_cursor;
}
if (changes.length) console.log((await layerfs.file.apply(P, B, changes, { message: `bring ${side} into the session` })).kind);
console.log("copy in a Workspace:", skipped);
```

- A `Conflict` from the merge is yours to resolve first
  ([branch-merge conflicts](conflicts.md#branch-merge-conflicts)).
- Copy the `skipped` paths (binary files, symlinks) with a command, or ask the user.
- A team's integration Branch is usually published or forked from, not brought in.

## Cleaning up

Before your turn ends, and before you report:

- every Workspace you or your subagents mounted is committed and unmounted (when the
  session closes or idles out, dsh stops `$SB` and a Workspace still mounted there
  loses its uncommitted changes);
- `layerfs sandbox get "$SB" --page-size 16` lists only dsh's Workspace (`main`), and
  those another agent said it is keeping on purpose.

To clear a subagent's leftover Workspace: unmount it only when its `activity` is
`idle` (compare lowercase), both `dirty` counts are 0, `pending_merge` is false, and
nobody said they are keeping it. Never `discard` another agent's Workspace; an
unmount refused `Dirty` means its owner must commit (or resolve its Conflict) first.
