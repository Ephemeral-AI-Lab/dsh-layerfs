# A Commit after a content Conflict fails `invalid record: captured inode creation binding`

Draft for the user to file (not filed). Found 2026-11-13 while profiling Workspace Commit
for Quarry v2.

- **Build:** pinned runtime `2.0.0-814768197b73`, commit `ba87a425` (`layerfs_v2_0_0`).
- **Host:** macOS (Darwin 25.4), sqlite Store on `native`, `native` Sandbox (NFS route),
  private `LAYERFS_HOME`.

## Steps

1. Branch `b`. Workspace `w` mounted on `b`, then about 51,000 files of 8 KB written and
   committed in steps over several Commits.
2. A second Workspace `w2` on `b` commits 1,000 rewritten files and `/small.txt`, so `b`'s
   head moves past `w`.
3. In `w`: `echo z1 > small.txt`, then `workspace commit` → `Conflict` (content, `/small.txt`,
   `markers: false`, 1,000 files `written` into `w` from the head). It took 8.9 s.
4. In `w` again, without resolving: `echo z2 > small.txt`, then `workspace commit` →

```
{"code":"Failed","message":"invalid record: captured inode creation binding","detail":{"phase":"Commit Construct"}}
```

5. The next Commit fails the same way. `workspace status` now reports:

```
"overlay":{"inodes":51001,"entries":0,"pending_merge":true}, "head_moved_since_mount":false
```

Before step 4 it reported 1 dirty inode. The Workspace can only be unmounted with
`--discard`.

## Expected

After a Conflict, a further Commit either completes the merge or is refused with
`Conflict`, `Dirty` or `InvalidInput`, saying what to resolve. It should never fail as
`invalid record`, and the dirty set should not jump to the whole tree.

## Why it matters

v1 Quarry already had 10 `invalid record` failures on merges and Workspace Commits (watch
row V4). In Quarry v2, workers share lane Branches, so the head moves under most
Commits and Conflicts are routine.
