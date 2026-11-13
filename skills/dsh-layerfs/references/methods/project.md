# project calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| get | `layerfs project get <project>` | `project.get(project)` |
| stats | `layerfs project stats <project> [<branch>] [<commit>]` | `project.stats(project, branch?, commit?)` |

Your project is `$P`, always written with its Store: `<store>/<project>`. These two
calls read it. Creating, importing, exporting, listing or removing projects is the
user's setup, not part of your task: don't call `project init`, `list`, `export` or
`remove`.

## `project get`

The project's record: its Store, the Store's kind and the machine it lives on.

```bash
layerfs project get "$P"
```

```json
{"project":"shop/api","store":"shop","name":"api","kind":"sqlite","machine":"native","created":1793574061265}
```

## `project stats`

Entry counts of one saved tree: `main` by default, or a Branch's head, or one Commit.

```js
const stats = await layerfs.project.stats(P, B);
```

Use it for a quick size check before a wide `file glob` or `file grep`.
