# branch calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| list | `layerfs branch list <project> [--page-size N] [--page-pos N]` | `branch.list(project, { page_size, page_pos })` |
| get | `layerfs branch get <project> <branch>` | `branch.get(project, branch)` |
| commits | `layerfs branch commits <project> <branch> [--page N] [--page-size N] [--at-commit <id>]` | `branch.commits(project, branch, { page, page_size, at_commit })` |
| get-commit | `layerfs branch get-commit <project> <branch> <commit>` | `branch.get_commit(project, branch, commit)` |
| fork | `layerfs branch fork <project> <name> <from-branch> [<from-commit>]` | `branch.fork(project, name, from_branch, from_commit?)` |
| merge | `layerfs branch merge <project> <name> <a> <b> [-m <msg>] [--units <json>]` | `branch.merge(project, name, a, b, { message, units })` |
| publish | `layerfs branch publish <project> <branch> [<commit>]` | `branch.publish(project, branch, commit?)` |
| diff | `layerfs branch diff <project> <from-branch> <to-branch> [--paths-only] [--path-prefix <p>] [--cursor <c>]` | `branch.diff(project, from_branch, to_branch, { paths_only, path_prefix, cursor, from_commit, to_commit })` |

`main` is not a Branch: it is the project's published line of Layers. It shows in
`branch list`; you can read it and fork from it, and it changes only through
`branch publish`.

## Which Branches are whose

| Branch | Whose | You may |
| --- | --- | --- |
| `$B` (the session Branch, `dsh.…`) | This conversation, saved by checkpoints | Read, diff, fork from, publish when the user asks |
| Other `dsh.…` Branches | Other conversations, and the project's identity | Read only |
| `main` | The published version | Read, diff, fork from |
| Branches you fork | You | Everything |

Name your Branches for their work, such as `try-cache` or `sub-auth`: 1 to 63
lowercase letters, digits, `_ . -`, never starting with `dsh.`.

## `branch list` and `branch get`

```bash
layerfs branch list "$P" --text
```

```
NAME   ID            BASE           HEAD           FORKED_FROM
main   -             3256e1f13d0b…  -              -
work   1197d2181af4… 3275838904b6…  12ad2061f04f…  3275838904b6…
```

Each item is `{ name, id, base, head, forked_from }`. `base` is the `main` Layer
underneath; `head` is the newest Commit, `null` before the first. `branch get` answers
one item, or `NoSuchBranch`.

```js
const mine = (await layerfs.branch.list(P, { page_size: 1000 })).items.filter((b) => !b.name.startsWith("dsh."));
```

## `branch commits` and `branch get-commit`

`branch commits` lists a Branch's saved Commits newest first, and also works on `main`,
where it lists the publications. `branch get-commit` (`branch.get_commit`) reads one.

```bash
layerfs branch commits "$P" main --page-size 10
```

## `branch fork`

Creates a Branch from another Branch's head, or from one of its Commits. It copies
nothing, so it is instant.

```bash
layerfs branch fork "$P" try-cache "$B"                 # from the last checkpoint
layerfs branch fork "$P" fix-login main                 # from the published version
```

```js
await layerfs.branch.fork(P, "before-refactor", B, olderCommitId);   // a full 66-hex id
```

```json
{"kind":"Forked","branch":"try-cache","base":"3275838904b6…","head":"12ad2061f04f…"}
```

Forking from `$B` starts from the **last checkpoint**, not from this turn's unsaved
Workspace changes. Forking `main` gives `head: null`.

| Code | Meaning | Do |
| --- | --- | --- |
| `NameTaken` | A Branch with that name exists | Use it, or pick another name |
| `ReservedName` | The name is `main` | Pick another name |
| `InvalidInput` | `from_branch` doesn't exist ("is not a Commit or Layer identity"), or `from_commit` is not a full Commit id | `branch list`; copy the full id from `commit list` |

## `branch merge`

Merges Branches `a` and `b` into a **new** Branch `name`. `a` and `b` don't change. The
new name comes second, as in `fork`.

```bash
layerfs branch merge "$P" sub-merged sub-api sub-ui -m "merge api and ui"
```

```js
const m = await layerfs.branch.merge(P, "sub-merged", "sub-api", "sub-ui", { message: "merge api and ui" });
```

```json
{"kind":"Merged","fast_forward":false,"branch":"sub-merged","head":"1285e865f74a…",
 "merge_base":"12ad2061f04f…","conflicts":[],"lww":[],"units":[]}
```

`fast_forward: true` means one side already contained the other. `lww` lists files
decided by `a`'s [`/.lww`](../rules/lww.md).

A merge can't move the session Branch: to bring a merged result into the session, see
[parallel work](../rules/parallel.md#bringing-work-into-the-session).

**Merge units** (`units`, a JSON list; the command's `--units '["dist/"]'`): each entry
is a pattern in the `/.lww` syntax, or `{ name, patterns }`. When both sides changed a
unit, the whole unit comes from the side with the later write: no text merge and no
conflict inside it, and the other side's changes there are dropped. Use units only for
generated output.

| Code | Meaning | Do |
| --- | --- | --- |
| `Conflict` | Overlapping changes; nothing was created | [Resolve it](../rules/conflicts.md#branch-merge-conflicts) |
| `NoMergeBase` | The Branches share no history | Fork from a common Branch |
| `NameTaken` | `name` exists | Pick a new name |
| `NoSuchBranch` | `a` or `b` doesn't exist | Check the names |

A `Conflict`'s `detail` (camelCase) lists `conflicts`, each `{ path, kind, hunks }`, and
`mergeBase`. The lists are bounded: `conflictsTruncated` says something was left out of
the reply, never out of the merge.

## `branch publish`

**Only when the user asks.** Makes `main` show the Branch's head, or the given Commit,
by adding a Layer to `main`.

- Publishing `$B` publishes its head: every `file` write and Workspace Commit on it so
  far. Uncommitted changes in a mounted Workspace are not in it: commit first.
- Publishing **replaces `main`'s view**. Publications made after your Branch's base
  that your Commit doesn't contain are skipped (they stay in history, listed in
  `overwrote`). If `main` may have moved, merge it in first and check the result:

```js
const changed = await layerfs.branch.diff(P, "main", B, { paths_only: true });    // what main will get
const m = await layerfs.branch.merge(P, "release-check", B, "main", { message: "merge main before publish" });
// mount m.branch in a Workspace of yours and run the tests, then:
const p = await layerfs.branch.publish(P, m.branch);
if (p.kind === "Added" && p.overwrote.length) console.log("skipped publications:", p.overwrote);
```

| `kind` | Meaning |
| --- | --- |
| `Added` | `main` now shows that Commit; check `overwrote` for skipped publications |
| `UpToDate` | `main` already shows it |

| Code | Meaning | Do |
| --- | --- | --- |
| `NoCommit` | The Branch has no Commit yet | Nothing to publish |
| `HeadMoved` | `main` moved during the call | Merge `main` in, then publish again |
| `NoSuchBranch` | No such Branch | Check the name |

## `branch diff`

Files that differ between two Branches' heads (`main` counts as one). Items are as in
[`commit diff`](commit.md#commit-diff). `paths_only` leaves out the line hunks;
`path_prefix` narrows it; resume a long diff with `cursor: next_cursor`.

```bash
layerfs branch diff "$P" main "$B" --paths-only
```
