# Resolving conflicts

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

## Where conflicts happen

LayerFS merges in two places, and each can end in a `Conflict` refusal:

| | Commit conflict | Branch-merge conflict |
| --- | --- | --- |
| **Raised by** | `workspace commit`, when the Branch moved since the mount and both sides changed the same lines; also the session's checkpoint | `branch merge`, when `a` and `b` changed the same lines |
| **Left behind** | Nothing committed. Markers are written into the conflicted files **in the Workspace**, the other side's clean changes are installed there too, and the Workspace now follows the new head | Nothing created. `a` and `b` are unchanged; no markers anywhere |
| **`detail`** | `base`, `head`, `conflicts`, `markers`, `lww` | `sources`, `mergeBase`, `conflicts`, `lww` |
| **Where you resolve** | In that Workspace, then commit again | On working forks of the Branches, then merge again |

A refusal's `detail` keeps camelCase keys (`mergeBase`, `hunksOmitted`). Each entry of
`conflicts` is `{ path, kind, blocks, hunks }`; a hunk is `{ line, ours, theirs }`.

| `kind` | Meaning | What the Workspace holds (Commit conflict) |
| --- | --- | --- |
| `content` | Both sides changed the same lines of a text file | The file with `<<<<<<<` / `=======` / `>>>>>>>` blocks |
| `add/add` | Both sides created the same path with different text | As `content`, with no common base |
| `modify/delete`, `delete/modify` | One side changed a file the other deleted | The changed text inside one marker block |
| `binary` | Both changed a file that isn't text | Your version, without markers |
| `mode`, `type` | Different modes, or a file on one side and a folder on the other | Your version |

`lww` lists the paths [`/.lww`](lww.md) decided instead of conflicting.

## Three ways to resolve

| Way | When | Commit conflict | Branch-merge conflict |
| --- | --- | --- | --- |
| **Fix it** | Source code: both changes matter | Edit the files in the Workspace, then commit | Write the reviewed result identically on working forks of both sides, then merge |
| **Rule it** | Generated files: lockfiles, build output | Regenerate the file, add it to `/.lww`, commit | Add the path to `a`'s `/.lww`, merge again |
| **Take one side** | One side should win wholesale | Unmount with `discard` and redo on the new head | Copy the chosen side's files onto `a`, then merge |

A conflict is a code question, not a text question. Deleting markers, or taking one
side wholesale, makes the Commit pass but can still break the program.

## Commit conflicts

In a Workspace of yours, `ws`, mounted on Branch `br`. Don't mount again to inspect: a
new mount is a new Workspace, without the markers.

1. **Learn what the other side did and why:** `commit diff` from `detail.base` to
   `detail.head`, `file diff` for one file, `commit list` for their messages.
2. **Recall what your side did:** `file read` of the path at `detail.base` is the file
   before either change; the markers show your lines next to theirs.
3. **Read the surrounding code:** callers and tests, in the Workspace (`cat -n`,
   `rg -n`).
4. **Decide what the code must do with both changes,** usually a combination.
5. **Write the resolved file in the Workspace** (base64, as the skill shows), check no
   marker is left (`rg -n '^(<<<<<<<|=======|>>>>>>>)'`), and run the tests there.
6. **Commit again.** While a conflicted file still holds a marker block, the Commit is
   refused `Conflict` with `detail.markers: true`.

```js
// Gather the reading for one conflicted file. ws, br and the refusal's detail come from your step.
const { base, head } = detail, path = detail.conflicts[0].path;
const theirs = await layerfs.file.diff(P, br, path, br, path, { left_commit: base, right_commit: head });
const before = await layerfs.file.read(P, br, path, base);
const merged = await layerfs.workspace.exec(ws, `cat -n '.${path}'`);
const why = await layerfs.commit.list(P, br, { page_size: 10 });
console.log("their change:\n" + theirs.hunks.filter((h) => h.op !== " ").map((h) => h.op + h.text).join("\n"));
console.log("before both:\n" + before.text);
console.log("now, with markers:\n" + merged.stdout);
console.log("recent messages:", why.items.map((c) => c.message));
```

**A generated file conflicts** (a lockfile, build output): regenerate it instead of
merging by hand, and rule it so the next merge decides it by itself.

```bash
layerfs workspace exec "$ws" "rm -f package-lock.json && timeout 110 npm install --no-audit --no-fund 2>&1" --stream
layerfs workspace exec "$ws" "grep -qx 'package-lock.json' .lww || echo 'package-lock.json' >> .lww"
layerfs workspace commit "$ws" -m "regenerate the lockfile, rule it last-writer-wins"
```

**One side deleted a file the other changed:** decide whether the file should exist
(check its callers first), then keep the text without markers, or `rm` it, and commit.

**Give up and redo:** when the conflict is bigger than your change, unmount with
`discard`, mount the current head and redo your change on top of it.

### A checkpoint conflict

dsh records a checkpoint by committing its own Workspace `$DSH_LAYERFS_WS`. While
nobody runs commands in it, it holds no changes of its own, so the checkpoint only
takes in the Branch's head and can't conflict. If the app shows a checkpoint error,
someone changed files there: tell the user, and don't touch that Workspace yourself.

## Branch-merge conflicts

Nothing was created and both Branches are as they were, so resolving means changing
one of them and merging again. `detail.mergeBase` is the Commit where they diverged.

**Both edited the same source lines (fix it).** Read both changes, decide the combined
file, and write it identically on working forks of both sides: a combined file on only
one side can still overlap the other side's change. Keep the original Branches.

```js
const [mergeBase, path] = [detail.mergeBase, detail.conflicts[0].path];
const leftChange = await layerfs.file.diff(P, "sub-api", path, "sub-api", path, { left_commit: mergeBase });
const rightChange = await layerfs.file.diff(P, "sub-ui", path, "sub-ui", path, { left_commit: mergeBase });
// read the callers, decide what the code must do, then write the combination on both forks:
await layerfs.branch.fork(P, "sub-api-fix", "sub-api");
await layerfs.branch.fork(P, "sub-ui-fix", "sub-ui");
await layerfs.file.write(P, "sub-api-fix", path, combined, { message: `resolve ${path}: keep both changes` });
await layerfs.file.write(P, "sub-ui-fix", path, combined, { message: `resolve ${path} identically` });
const m = await layerfs.branch.merge(P, "sub-merged", "sub-api-fix", "sub-ui-fix", { message: "merge api and ui" });
```

For an `add/add` conflict the merge base has no file: read both Branches directly.

**A generated file conflicts (rule it).** The rules are read from `a` when the merge
runs, so adding the path to `a`'s `/.lww` is enough:

```bash
layerfs file read "$P" sub-api /.lww --text > ./lww && echo 'package-lock.json' >> ./lww
layerfs file write "$P" sub-api /.lww --from ./lww -m "lww: lockfile"
layerfs branch merge "$P" sub-merged sub-api sub-ui -m "merge api and ui"
```

**One side should win.** `branch merge` has no force. Copy the chosen side's version
of the files onto `a` first (identical files merge cleanly), or don't merge: fork your
next work from the Branch you want.
