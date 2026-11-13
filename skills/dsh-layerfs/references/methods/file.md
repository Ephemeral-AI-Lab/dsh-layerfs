# file calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.
`side` stands for a side Branch you forked.

| Call | Command | SDK |
| --- | --- | --- |
| read | `layerfs file read <project> <branch> <path> [<commit>] [--start-line N] [--end-line N]` | `file.read(project, branch, path, commit?, { start_line, end_line })` |
| stat | `layerfs file stat <project> <branch> <path> [<commit>]` | `file.stat(project, branch, path, commit?)` |
| list | `layerfs file list <project> <branch> <path> [<commit>] [--page-size N] [--page-pos N]` | `file.list(project, branch, path, commit?, { page_size, page_pos })` |
| glob | `layerfs file glob <project> <branch> <path> <pattern> [<commit>] [--page-size N] [--page-pos N]` | `file.glob(project, branch, path, pattern, commit?, { page_size, page_pos })` |
| grep | `layerfs file grep <project> <branch> <path> <text> [<commit>] [--page-size N] [--page-pos N]` | `file.grep(project, branch, path, text, commit?, { page_size, page_pos })` |
| revision | `layerfs file revision <project> <branch> <path> [--at-commit <id>] [--page-size N]` | `file.revision(project, branch, path, { at_commit, page_size })` |
| blame | `layerfs file blame <project> <branch> <path> [<commit>] [--from-line N] [--line-count N]` | `file.blame(project, branch, path, commit?, { from_line, line_count })` |
| diff | `layerfs file diff <project> <left-branch> <left-path> <right-branch> <right-path> [--left-commit <id>] [--right-commit <id>]` | `file.diff(project, left_branch, left_path, right_branch, right_path, { left_commit, right_commit })` |
| write | `layerfs file write <project> <branch> <path> [-m <msg>] [--mode N] [--from <file>]` (content on stdin) | `file.write(project, branch, path, content, { message, mode })` |
| edit | `layerfs file edit <project> <branch> <path> --old <text> --new <text> [-m <msg>]` | `file.edit(project, branch, path, { old, new, message })` |
| rm | `layerfs file rm <project> <branch> <path> [-m <msg>]` | `file.rm(project, branch, path, { message })` |
| mkdir | `layerfs file mkdir <project> <branch> <path> [-m <msg>]` | `file.mkdir(project, branch, path, { message, mode })` |
| mv | `layerfs file mv <project> <branch> <from-path> <to-path> [-m <msg>]` | `file.mv(project, branch, from_path, to_path, { message })` |
| cp | `layerfs file cp <project> <branch> <from-path> <to-path> [-m <msg>]` | `file.cp(project, branch, from_path, to_path, { message })` |
| apply | `layerfs file apply <project> <branch> [-m <msg>] [--from <file>]` (JSON list on stdin) | `file.apply(project, branch, changes, { message })` |

In the SDK an optional positional you skip is left out (`file.read(P, B, path, { start_line: 2 })`);
`layerfs help file <call>` and `layerfs.table` list every option.

## When to use them

- **Reads** see what is saved on the Branch: every `file` write and every Workspace
  Commit, but not a mounted Workspace's uncommitted changes. They are how you read the
  project, an older version, another Branch or `main`, without mounting anything.
- **Writes** go straight to a Branch as a Commit. They are how you change files, on
  the session Branch `$B` and on side Branches. Use a command in a Workspace instead
  for a batch change with logic (a codemod, `sed -i` across files, a generator, a
  formatter). Never write to `main` (`ReadOnly`) or to any other `dsh.…` Branch.
- A Workspace mounted before a write doesn't show it until that Workspace's next
  Commit. Make the writes a command needs before you mount for it.

## Shared rules

- Paths are absolute and canonical (`/src/cart.js`). A relative path is refused
  `InvalidInput`.
- Pass a full 66-hex Commit id as `commit` to read an older state. In this build the
  Commit decides what is read and the Branch is not checked, so pass a Commit of that
  Branch.
- A write makes exactly one Commit, or nothing. `UpToDate` means nothing changed and
  no Commit was made. Parent folders must exist; `file mkdir` creates missing parents.
- Pages: `list`, `glob` and `grep` answer `{ items, has_more, next_page_pos }`.
  The page size is 1 to 1000, default 50. A short page is not the end while
  `has_more` is true. Narrow the path or pattern instead of paging far.
- Single-path reads start with `{ kind: "ok", snapshot, root, path }`; `snapshot`
  names what was read, such as `"work@a99d99faf59f"`.

**Shared refusals**

| Code | Meaning | Do |
| --- | --- | --- |
| `NoSuchPath` | The path, or a write's parent folder, doesn't exist | `file list` the parent; `file mkdir` first |
| `NoSuchBranch`, `NoSuchCommit` | Wrong Branch or Commit | `branch list`, `commit list` |
| `ReadOnly` | A write on `main` | Write on `$B` or a side Branch; publish only when the user asks |
| `HeadMoved` | Another writer committed on the Branch during the write; nothing was written | Read the file again, then redo the change |
| `IsDirectory`, `NotDirectory` | A folder where a file is needed, or the other way round | `file stat` it |
| `Binary` | A read of a file that is not UTF-8 text | Look at it or copy it with a command (`xxd`, `cp`) |
| `InvalidInput` | A bad argument: page bounds, line numbers, a relative path, a short Commit id | Read `message` |
| `Failed` | The call failed before committing | Stop and report `message` |

Write refusals carry `detail.index`: 0 for single writes, the failing change for
`apply`.

## `file read`

```bash
layerfs file read "$P" "$B" /src/math.js --start-line 2 --end-line 3
```

```js
const r = await layerfs.file.read(P, B, "/src/math.js", { start_line: 2, end_line: 3 });
```

```json
{"kind":"ok","snapshot":"work@a99d99faf59f","root":"f55fa9660a73…","path":"/src/math.js",
 "text":"  return a + b;\n}\n","start_line":2,"end_line":3,"line_truncated":false,
 "truncated":false,"next_line":null,"size":46}
```

The command's `--text` prints the text alone. **One answer holds at most 2000 lines
and 48 KiB**; `truncated: true` and `next_line` say where to continue. A huge single
line comes back as a prefix (`line_truncated`). Refusals: `IsDirectory`, `Binary`
(not UTF-8: look at it in a Workspace), plus the shared ones.

Before you write back a file you read in windows, check you have all of it:
`Buffer.byteLength(text) === (await layerfs.file.stat(P, br, path)).size`. If they
differ, read it with `cat` in a Workspace and report the mismatch.

Read a whole long file window by window:

```js
let line = 1, text = "";
for (;;) {
  const r = await layerfs.file.read(P, B, "/src/cart.js", { start_line: line });
  text += r.text;
  if (r.next_line == null) break;
  line = r.next_line;
}
```

## `file stat`

```json
{"kind":"ok","snapshot":"work@a99d99faf59f","root":"f55fa9660a73…","path":"/src/math.js","type":"file","inode":7,"size":46,"mode":420}
```

`type` is `file`, `dir` or `symlink`; `mode` is decimal (420 = `0644`). A missing path
is refused `NoSuchPath`, which is how to test for existence:

```js
const exists = await layerfs.file.stat(P, B, "/package.json").then(
  () => true,
  (e) => { if (e.code === "NoSuchPath") return false; throw e; },
);
```

## `file list`

A folder's entries, as a page. Each item is `{ name, path, type, inode }`.

```bash
layerfs file list "$P" "$B" / --text
```

```
NAME        PATH         TYPE  INODE
.gitignore  /.gitignore  file  2
.lww        /.lww        file  3
src         /src         dir   5
```

## `file glob`

Paths under `path` matching `pattern`, as a page of path strings. `*` and `?` match
within one name; `**` spans folders.

```bash
layerfs file glob "$P" "$B" / '**/*.js'
```

```js
const all = [];
for (let pos = 0; pos !== null; ) {
  const page = await layerfs.file.glob(P, B, "/", "src/**/*.js", { page_size: 1000, page_pos: pos });
  all.push(...page.items);
  pos = page.has_more ? page.next_page_pos : null;
}
```

```json
{"kind":"ok","snapshot":"work@a99d99faf59f","root":"…","path":"/","items":["/src/index.js","/src/math.js"],"has_more":false,"next_page_pos":null}
```

## `file grep`

Lines under `path` that contain the text. **The text is plain, not a regular
expression**, whatever `layerfs help` says. Each item is `{ path, line, text,
line_truncated }`; `skipped` counts binary files passed over. It searches everything
under `path`, `node_modules` included, so keep `path` narrow. For regular expressions,
run `rg` in the Workspace.

```bash
layerfs file grep "$P" "$B" /src 'retries'
```

## `file revision`

The saved changes to one literal path, newest first, from the Branch's head (or
`at_commit`). Use it to find when a file changed and in which Commit; then
`file read … <commit>` or `file diff` shows the content.

```bash
layerfs file revision "$P" "$B" /src/app.js
```

## `file blame`

The Commit and message of each line, from `from_line` (default 1).

```json
{"kind":"ok","snapshot":"work@a99d99faf59f","root":"…","path":"/src/index.js",
 "lines":[{"n":1,"text":"export const retries = 1;","line_truncated":false,"clipped":false,
   "commit":"12a99d99faf5…","message":"one attempt"}],
 "origins":[],"versions":2,"comparison_coarse":false,"next_line":null}
```

## `file diff`

The difference between two files. Each side is a Branch and a path, with an optional
Commit per side.

```bash
layerfs file diff "$P" main /src/index.js "$B" /src/index.js
layerfs file diff "$P" "$B" /src/a.js "$B" /src/a.js --left-commit <older-id>   # since a checkpoint
```

```js
const d = await layerfs.file.diff(P, "main", "/src/index.js", B, "/src/index.js");
console.log(d.hunks.filter((h) => h.op !== " ").map((h) => h.op + h.text).join("\n"));
```

```json
{"kind":"Text","left":{"path":"/src/index.js","snapshot":"main@75838904b659","inode":6},
 "right":{"path":"/src/index.js","snapshot":"work@ad9dd3e33a2f","inode":6},
 "content_equal":false,"same_inode":true,"hunks_omitted":false,
 "hunks":[{"op":"-","text":"export const retries = 3;"},{"op":"+","text":"export const retries = 1;"},{"op":" ","text":""}]}
```

`kind` is `Text` (line diff in `hunks`), `Equal` or `Binary`. `op` is `" "`, `"-"` or
`"+"`. `hunks_omitted` is true when the diff was too large to return.

## Write results

Every write answers one of:

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `Committed` | `branch`, `head`, `commit` | A new Commit; `head` is its id; `commit` its record (as in `commit list`) |
| `UpToDate` | `branch`, `head`, `root` | Nothing changed, so no Commit was made |

## `file write`

Creates or replaces one file. The command reads the content from stdin, or from
`--from <file>` (a file on this machine, such as one in the scratch folder); the SDK
takes a string (text) or a `Buffer` (bytes). `mode` sets the permission bits.

```bash
layerfs file write "$P" side /src/math.js -m "add math" <<'EOF'
export function add(a, b) {
  return a + b;
}
EOF
layerfs file mkdir "$P" side /assets -m "assets folder"
layerfs file write "$P" side /assets/logo.png --from ./draft/logo.png -m "add logo"
```

```js
await layerfs.file.write(P, "side", "/src/cart.js", source, { message: "cart: add Cart class" });
```

## `file edit`

Replaces exactly one occurrence of `old` with `new`. It is the cheap way to change a
few lines of a big file. The command also takes `--old-from <file>` and
`--new-from <file>` for text with quotes or many lines.

```bash
layerfs file edit "$P" side /src/index.js --old "retries = 3" --new "retries = 1" -m "one attempt"
```

```js
await layerfs.file.edit(P, "side", "/src/index.js", { old: "retries = 3", new: "retries = 1", message: "one attempt" });
```

| Code | Meaning | Do |
| --- | --- | --- |
| `NoMatch` | `old` doesn't occur (`detail.matches: 0`) | `file grep` then `file read` the area; the text differs |
| `AmbiguousMatch` | `old` occurs more than once | Include more surrounding lines |
| `InvalidInput` | `old` is empty | Pass the text to replace |
| `Binary` | The file is not text | Use a Workspace |

On `NoMatch` or `AmbiguousMatch` nothing changed.

## `file apply`

Applies an ordered list of changes as **one** Commit, or nothing: the way to make a
multi-file change on a side Branch. The command reads the JSON list from stdin or
`--from`; the SDK takes the array. Field names are snake_case:

| Change | Fields |
| --- | --- |
| write | `{ op: "write", path, content, mode? }` (`content` may be a `Buffer` in the SDK) |
| chmod | `{ op: "chmod", path, mode }` (decimal, 493 = `0755`) |
| edit | `{ op: "edit", path, old, new }` |
| mkdir | `{ op: "mkdir", path }` |
| rm | `{ op: "rm", path }` |
| cp | `{ op: "cp", from_path, to_path }` |
| mv | `{ op: "mv", from_path, to_path }` |

Later changes see earlier ones: a `mkdir` before a `write` into that folder works.

```js
const files = {
  "/package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "/src/server.js": "export function start() {}\n",
  "/test/server.test.js": "import { test } from 'node:test';\ntest('loads', () => {});\n",
};
const dirs = [...new Set(Object.keys(files).map((p) => p.slice(0, p.lastIndexOf("/"))).filter(Boolean))];
await layerfs.file.apply(P, "side", [
  ...dirs.map((path) => ({ op: "mkdir", path })),
  ...Object.entries(files).map(([path, content]) => ({ op: "write", path, content })),
], { message: "scaffold: package, server, first test" });
```

```bash
layerfs file apply "$P" side -m "remove the old config" <<'EOF'
[{"op":"rm","path":"/config/old.json"},{"op":"mv","from_path":"/config/new.json","to_path":"/config/app.json"}]
EOF
```

**When a change fails** the refusal is the first failing change's, with
`detail.index` (zero-based); nothing is committed. Fix that change and apply the whole
list again.

## `file mkdir`, `file rm`, `file cp`, `file mv`

- `mkdir` creates a folder and any missing parents; an existing folder gives
  `UpToDate`. `NotDirectory` when a file is in the way.
- `rm` removes a file or a whole folder tree. `NoSuchPath` when it is missing.
- `cp` copies a file or folder tree, keeping modes and symlinks.
- `mv` moves or renames, keeping identity and timestamps.
- For `cp` and `mv`: `Exists` when the target exists; `InvalidInput` for the same path
  or a copy into its own subtree.

```bash
layerfs file mv "$P" side /src/basket.js /src/cart.js -m "cart: rename basket"
```

```js
await layerfs.file.rm(P, "side", "/src/legacy", { message: "remove legacy folder" });
```
