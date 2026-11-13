# commit calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| list | `layerfs commit list <project> <branch> [--page-size N] [--page-pos N]` | `commit.list(project, branch, { page_size, page_pos })` |
| get | `layerfs commit get <project> <branch> <commit>` | `commit.get(project, branch, commit)` |
| diff | `layerfs commit diff <project> <from-commit> <to-commit> [--paths-only] [--cursor <c>]` | `commit.diff(project, from_commit, to_commit, { paths_only, cursor })` |

A Commit id is 66 hex characters and unique in its project. On the session Branch
`$B`, `file` writes make Commits with `via: "fs"` and Workspace Commits (yours, and
dsh's checkpoints) have `via: "exec"`. dsh's carry its messages: `dsh turn <n>`,
`Saved before restore`, `Saved before closing`.

## `commit list`

A Branch's Commits, newest first along first parents. The page size is 1 to 1000,
default 50.

```bash
layerfs commit list "$P" "$B" --page-size 10 --text
```

```js
const log = await layerfs.commit.list(P, B, { page_size: 10 });
console.log(log.items.map((c) => `${c.id.slice(0, 12)} ${c.message}`).join("\n"));
```

| Field | Meaning |
| --- | --- |
| `id` | Commit id |
| `branch` | Branch name |
| `parent`, `second_parent` | Parents (`second_parent` only for merges) |
| `base` | The `main` Layer underneath |
| `via` | `exec` for a Workspace Commit (a checkpoint), `fs` for a `file` write |
| `message` | Commit message |
| `merged_from` | Merge source, for merge Commits |
| `time` | Commit time, ms since the epoch |

On `main`, `commit list` lists `main`'s Layers (its publications: `source_branch`,
`overwrote_count`, …) instead of Commits; `branch commits` on `main` is the same list
with each publication's source. After an uncertain outcome (`Unknown`, `Failed`),
`commit list` is how you check whether a Commit happened.

## `commit get`

One Commit of that Branch. It accepts an id prefix of 8 or more characters, but it
pages the Branch's history to find it, so it is slower on a long Branch. A Commit not
on the Branch's first-parent line is refused `NoSuchCommit`.

```bash
layerfs commit get "$P" "$B" 12c7ef811a
```

## `commit diff`

Files that differ between two Commits. No Branch is needed. Use `branch diff` for two
Branch heads.

```js
const [newest, previous] = (await layerfs.commit.list(P, B, { page_size: 2 })).items;
const d = await layerfs.commit.diff(P, previous.id, newest.id, { paths_only: true });   // what the last checkpoint changed
console.log(d.items.map((c) => `${c.kind} ${c.path}`).join("\n"));
```

```json
{"kind":"ok","from":{"commit":"12c7ef811a49…"},"to":{"commit":"12a99d99faf5…"},
 "items":[{"path":"/src/index.js","kind":"Modified","type":"file","content":true,"metadata":true,
   "hunks":[{"op":"-","text":"export const retries = 3;"},{"op":"+","text":"export const retries = 1;"}],
   "hunks_omitted":false}],
 "has_more":false,"next_page_pos":null,"next_cursor":null}
```

| Item field | Meaning |
| --- | --- |
| `path` | Changed path |
| `kind` | `Added`, `Removed` or `Modified` |
| `type` | `file`, `dir` or `symlink` |
| `content`, `metadata` | Whether the bytes, or the mode and attributes, changed |
| `hunks`, `hunks_omitted` | Line diff for text files (`null` with `paths_only`) |

Folders show up as items too. Resume a long diff with `cursor: next_cursor`.

**Refusals:** `NoSuchCommit` for a full id that doesn't exist; `InvalidInput` ("not a
Branch, and not a full Commit or Layer identity") for Branch names and short id
prefixes. Pass full ids.
