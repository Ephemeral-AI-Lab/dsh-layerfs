# project calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| get | `layerfs project get <project>` | `project.get(project)` |
| stats | `layerfs project stats <project> [--branch B] [--at C]` | `project.stats(project, { branch, at })` |

Your project is `$P`, always written with its Store: `<store>/<project>`. These two
calls read it. Creating, importing, exporting, listing, deleting, hiding paths in, or
doctoring projects belongs to the user's setup, not your task: don't call
`project init`, `list`, `export`, `delete`, `hide-path` or `doctor`.

## `project get`

The project's record: its Store, state and head Commit (with `--detail`: `project`,
`engine`, `machine` and `created_at`).

```bash
layerfs project get "$P"
```

```json
{"store":"shop","state":"ready","commit":"12ad2061f04f…"}
```

With `--detail`:

```json
{"store":"shop","state":"ready","commit":"12ad2061f04f…","op":null,"blocked_by":null,"reason":null,"fix":null,"project":"shop/api","engine":"sqlite","machine":"native","created_at":"2026-11-18T22:04:15Z"}
```

## `project stats`

Entry counts of one saved tree: `main` by default, or a Branch's head (`--branch` /
`{ branch }`), or one Commit (`--at` / `{ at }`). Passing `branch` as a second
positional argument is refused `InvalidInput`.

```bash
layerfs project stats "$P" --branch "$B"
```

```js
const stats = await layerfs.project.stats(P, { branch: B });
```

Short answer: `{ file_count, dir_count, symlink_count, size }` (plus `partial` when
cut); `--detail` adds `commit` and `root`. Use it for a quick size check before a wide
`file glob` or `file grep`.
