# commit calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| list | `layerfs commit list <project> <branch> [--at C] [--limit 100] [--cursor C]` | `commit.list(project, branch, { at, limit, cursor })` |
| get | `layerfs commit get <project> <commit> [--branch B]` | `commit.get(project, commit, { branch })` |
| diff | `layerfs commit diff <project> <ref> [--from R] [--path P] [--with patch] [--limit 100] [--cursor C]` | `commit.diff(project, ref, { from, path, limit, cursor, with: ["patch"] })` |

A Commit id is 66 hex characters and unique in its project. Anywhere a Commit is taken,
a full 66-hex id **or a prefix of 8 or more characters** is accepted (an ambiguous prefix
is refused `InvalidInput` with `matches`). On the session Branch `$B`, `file` writes
make Commits with `via: "file"` and Workspace Commits (yours, and dsh's checkpoints)
have `via: "workspace"`. dsh's checkpoints carry messages such as `dsh turn <n>`,
`Saved before restore`, `Saved before closing`.

## `commit list`

A Branch's Commits, newest first along first parents (or starting from `--at C`). The
page limit is 1 to 1000, default 100, returning `{ items, next_cursor? }`.

```bash
layerfs commit list "$P" "$B" --limit 10 --text
```

```js
const log = await layerfs.commit.list(P, B, { limit: 10, detail: true });
console.log(log.items.map((c) => `${c.commit.slice(0, 12)} ${c.via} ${c.message ?? ""}`).join("\n"));
```

Short item keys: `commit`, plus `message`, `message_truncated`, `source_branch` when
present. Long form (`--detail` / `{ detail: true }`) adds:

| Field | Meaning |
| --- | --- |
| `commit` | Commit id (66 hex chars) |
| `branch` | Branch name |
| `parent`, `second_parent` | Parents (`second_parent` only for merges) |
| `base` | The `main` Layer underneath |
| `root` | Root tree id |
| `via` | `workspace`, `file`, `merge`, `publish`, or `init` |
| `message` | Commit message |
| `merged_from` | Merge source, for merge Commits |
| `created_at` | RFC-3339 UTC timestamp |
| `source_branch`, `source_commit` | Source Branch/Commit on `main` publications |
| `size`, `new_canonical_bytes`, `new_stored_bytes`, `new_metadata_bytes` | Tree and new delta byte sizes |

On `main`, `commit list` lists `main`'s Layers (its publications, with `source_branch`
and `source_commit`). After an uncertain outcome (`Unknown`, `Unresolved`), `commit list`
is how you check whether a Commit happened.

## `commit get`

Reads one Commit in the project by full id or >=8-char prefix. Pass `--branch B`
(`{ branch }`) only if you want to verify or resolve within that Branch. Notice
`<branch>` is an **option**, not a positional argument!

```bash
layerfs commit get "$P" 12c7ef811a --detail
```

Short answer includes `branch`, `parent`, `message` when present; `--detail` adds
`commit`, `second_parent`, `base`, `root`, `via`, `created_at`, `merged_from`,
`displaced`, `overwritten`, `overwritten_count`, `units`, `source_branch`,
`source_commit` and size fields. `NotFound` (`detail.code: "NoSuchCommit"`) when the
Commit does not exist.

## `commit diff`

Files that differ between `<ref>` and `--from <from>` (defaults to `<ref>`'s parent
when omitted). Both `<ref>` and `--from` can be any Branch name (including `main`),
Commit id, or >=8-char prefix. Pass `--path P` to restrict to one path/prefix, and
`--with patch` (`with: ["patch"]`) to include line diff `hunks`.

```bash
layerfs commit diff "$P" "$B" --from main
layerfs commit diff "$P" "$B" --from main --path /src/index.js --with patch
```

```js
const [newest, previous] = (await layerfs.commit.list(P, B, { limit: 2 })).items;
const d = await layerfs.commit.diff(P, newest.commit, { from: previous.commit });
console.log(d.items.map((c) => `${c.change} ${c.path}`).join("\n"));
```

```json
{"items":[{"path":"/src/index.js","change":"modified","hunks":[{"op":"-","text":"export const retries = 3;"},{"op":"+","text":"export const retries = 1;"}],"hunks_omitted":false}]}
```

With `--detail`:

```json
{"from":"12c7ef811a49…","to":"12a99d99faf5…","from_root":"…","to_root":"…",
 "items":[{"path":"/src/index.js","change":"modified","type":"file","content":true,"metadata":true,"identity":false,
   "hunks":[{"op":"-","text":"export const retries = 3;"},{"op":"+","text":"export const retries = 1;"}],
   "hunks_omitted":false}],
 "next_cursor":null}
```

| Item field | Meaning |
| --- | --- |
| `path` | Changed path |
| `change` | `added`, `removed`, or `modified` (lowercase) |
| `type` | `file`, `dir`, or `symlink` (**only with `--detail` / `{ detail: true }`**) |
| `content`, `metadata`, `identity` | Which parts changed (`--detail` only) |
| `hunks`, `hunks_omitted` | Line diff for text files (only when `--with patch` / `{ with: ["patch"] }` is passed) |

Folders show up as items too. Resume a long diff with `--cursor` (`{ cursor: d.next_cursor }`).
`InvalidInput` for a prefix shorter than 8 characters or an unknown ref; `NotFound` for
a missing Commit.
