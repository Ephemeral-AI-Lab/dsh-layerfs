# branch calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| list | `layerfs branch list <project> [--prefix P] [--exclude-prefix P] [--limit 100] [--cursor C]` | `branch.list(project, { prefix, exclude_prefix, limit, cursor })` |
| get | `layerfs branch get <project> <branch>` | `branch.get(project, branch)` |
| fork | `layerfs branch fork <project> <name> [from] [--at C]` | `branch.fork(project, name, from?, { at })` |
| merge | `layerfs branch merge <project> <branch> <from> [--into NEW] [--units JSON] [--expected C] [-m msg]` | `branch.merge(project, branch, from, { into, units, expected, message })` |
| publish | `layerfs branch publish <project> <branch> [--at C] [--expected C] [--force]` | `branch.publish(project, branch, { at, expected, force })` |
| remove | `layerfs branch remove <project> <branch>` | `branch.remove(project, branch)` |

To list Commits, read one Commit or compare two Branches/Commits, use
[`commit`](commit.md) (`commit list`, `commit get`, `commit diff`) — the old 1.x
`branch commits`, `branch get-commit` and `branch diff` calls do not exist in 2.0.

`main` is not a Branch: it is the project's published line of Layers. It shows in
`branch list`; you can read it and fork from it, and it changes only through
`branch publish`.

## Which Branches are whose

| Branch | Whose | You may |
| --- | --- | --- |
| `$B` (the session Branch, `dsh.…`) | This conversation, saved by checkpoints | Read, diff, fork from, publish when the user asks |
| Other `dsh.…` Branches | Other conversations, and the project's identity | Read only |
| `main` | The published version | Read, diff, fork from |
| Branches you fork | You | Everything (fork, read, write, merge, remove) |

Name your Branches for their work, such as `try-cache` or `sub-auth`: 1 to 63
lowercase letters, digits, `_ . -`, never starting with `dsh.`.

## `branch list` and `branch get`

`branch list` pages with `--limit` (1 to 1000, default 100) and `--cursor`, returning
`{ items, next_cursor? }`. Each short item is `{ branch, commit }` (`--detail` adds
`forked_from`, `id`, `base`, `root`). `branch get` returns `{ commit }` (short;
`--detail` adds `forked_from`, `branch`, `id`, `base`, `root`), or `NotFound`
(`detail.code: "NoSuchBranch"`).

```bash
layerfs branch list "$P" --text
```

```
BRANCH  COMMIT
main    3256e1f13d0b…
work    12ad2061f04f…
```

```js
const mine = (await layerfs.branch.list(P, { limit: 1000 })).items.filter((b) => !b.branch.startsWith("dsh."));
```

## `branch fork`

Creates a Branch from another Branch's head (`from` defaults to `main`), or from one
of its Commits (`--at` / `{ at }`, accepting a full 66-hex id or >=8-char prefix).
It copies nothing, so it is instant.

```bash
layerfs branch fork "$P" try-cache "$B"                 # from the last checkpoint
layerfs branch fork "$P" fix-login main                 # from the published version
```

```js
await layerfs.branch.fork(P, "before-refactor", B, { at: olderCommitId });
```

Short answer: `{"commit":"12ad2061f04f…"}` (`--detail` adds `outcome: "forked"`,
`branch`, `base`, `root`). Forking from `$B` starts from the **last checkpoint**, not
from this turn's unsaved Workspace changes. Forking `main` returns `main`'s head Layer
id as `commit`.

| Code | Meaning | Do |
| --- | --- | --- |
| `Exists` | A Branch with that name exists (`detail.code: "NameTaken"`) | Use it, or pick another name |
| `InvalidInput` | Reserved name (`main`), bad Commit ref (`at`), or missing source | `branch list`; copy id or >=8-char prefix from `commit list` |
| `NotFound` | `from` Branch or Commit does not exist | `branch list`, `commit list` |

## `branch merge`

Merges `from` into `branch` in place — **unless `--into <new>` (`{ into }`) is
passed**, in which case a new Branch `<new>` is created and neither `branch` nor
`from` changes! Always pass `--into` when you want a new integrated Branch rather
than moving `branch`. Never pass `$B` or `main` as the target `branch` without
`--into`.

```bash
layerfs branch merge "$P" sub-api sub-ui --into sub-merged -m "merge api and ui"
```

```js
const m = await layerfs.branch.merge(P, "sub-api", "sub-ui", {
  into: "sub-merged",
  message: "merge api and ui",
  detail: true,
});
```

Short answer: `{ commit, unchanged?, fast_forward?, overwritten?, overwritten_count? }`.
Long form (`--detail` / `{ detail: true }`) adds `outcome`, `branch`, `parent`,
`second_parent`, `merge_base`, `root`, `units`, `units_count`. `fast_forward: true`
means one side already contained the other. `overwritten` lists the first 20 paths
decided by `branch`'s [`/.lww`](../rules/lww.md) (`overwritten_count` when past 20).

A merge cannot target `$B` directly (nor `main`): to bring a merged result into the
session, merge into a new Branch with `--into` and apply changes onto `$B`
([parallel work](../rules/parallel.md#bringing-work-into-the-session)).

**Merge units** (`units`, a JSON list; the command's `--units '["dist/"]'`): each entry
is a pattern in the `/.lww` syntax, or `{ name, patterns }`. When both sides changed a
unit, the whole unit comes from the side with the later write: no text merge and no
conflict inside it, and the other side's changes there are dropped. Use units only for
generated output.

| Code | Meaning | Do |
| --- | --- | --- |
| `Conflict` | Overlapping changes (or `expected` mismatch); nothing changed | [Resolve it](../rules/conflicts.md#branch-merge-conflicts) |
| `InvalidInput` | Branches share no merge base (`NoMergeBase`), bad `expected`, or writing `main` | Fork from a common Branch |
| `Exists` | `--into` Branch name already exists (`NameTaken`) | Pick a new `--into` name |
| `NotFound` | `branch` or `from` does not exist (`NoSuchBranch`) | Check the names with `branch list` |

On a merge `Conflict`, the error carries flat `commit`, `conflicts` and
`conflicts_count`. When `--detail` / `{ detail: true }` was passed, `e.detail`
(camelCase) also includes `conflicts` (each `{ path, kind, blocks, hunks }`),
`mergeBase` and `lww`.

## `branch publish`

**Only when the user asks.** Makes `main` show the Branch's head, or `--at C`, by
adding a Layer to `main`.

- Publishing `$B` publishes its head: every `file` write and Workspace Commit on it so
  far. Uncommitted changes in a mounted Workspace are not in it: commit first.
- Publishing **replaces `main`'s view**. If `main` moved after your Branch's base,
  `branch publish` is refused `Conflict` unless `--force` (`{ force: true }`) is passed.
  To include `main`'s newer publications cleanly, merge `main` in first and test:

```js
const changed = await layerfs.commit.diff(P, B, { from: "main" });   // what main will get
const m = await layerfs.branch.merge(P, B, "main", {
  into: "release-check",
  detail: true,
  message: "merge main before publish",
});
// mount m.branch in a Workspace of yours and run the tests, then:
const p = await layerfs.branch.publish(P, m.branch);
if (p.previous) console.log("previous main layer:", p.previous);
```

Short answer: `{ commit, unchanged?, previous? }` (`previous` is the prior `main`
Layer id when `main` had one; `unchanged: true` when `main` already showed that
Commit). Long form adds `outcome` (`"published"` or `"unchanged"`), `branch`,
`source_commit`, `base`, `root`, `size`.

| Code | Meaning | Do |
| --- | --- | --- |
| `NotFound` | No such Branch or Commit (`NoSuchBranch`, `NoCommit`) | Check `branch list` / `commit list` |
| `Conflict` | `main` moved since the Branch's base, or `expected` missed (`HeadMoved`) | Merge `main` in, test, then publish again |

## `branch remove`

Removes a side Branch you created (`{"ok":true}`). Never remove `$B` or another agent's
Branch, and never remove a Branch while a Workspace is mounted on it (`InUse`).
