# file calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.
`side` stands for a side Branch you forked.

| Call | Command | SDK |
| --- | --- | --- |
| read | `layerfs file read <project> <branch> <path> [--at C] [--line 1] [--limit 2000]` | `file.read(project, branch, path, { at, line, limit })` |
| stat | `layerfs file stat <project> <branch> <path> [--at C]` | `file.stat(project, branch, path, { at })` |
| list | `layerfs file list <project> <branch> <path> [--at C] [--limit 100] [--cursor C]` | `file.list(project, branch, path, { at, limit, cursor })` |
| glob | `layerfs file glob <project> <branch> <pattern> [path] [--exclude G] [--at C] [--limit 100] [--cursor C]` | `file.glob(project, branch, pattern, path?, { exclude, at, limit, cursor })` |
| grep | `layerfs file grep <project> <branch> <pattern> [path] [--include G] [--exclude G] [--ignore-case] [--at C] [--limit 100] [--cursor C]` | `file.grep(project, branch, pattern, path?, { include, exclude, ignore_case, at, limit, cursor })` |
| history | `layerfs file history <project> <branch> <path> [--at C] [--traversal provenance] [--limit 100] [--cursor C]` | `file.history(project, branch, path, { at, traversal, limit, cursor })` |
| blame | `layerfs file blame <project> <branch> <path> [--at C] [--line 1] [--limit 2000]` | `file.blame(project, branch, path, { at, line, limit })` |
| write | `layerfs file write <project> <branch> <path> [--mode M] [--expected C] [-m msg] [--from file]` (content on stdin) | `file.write(project, branch, path, content, { mode, expected, message })` |
| edit | `layerfs file edit <project> <branch> <path> --old-string S --new-string S [--replace-all] [--expected C] [-m msg]` | `file.edit(project, branch, path, { old_string, new_string, replace_all, expected, message })` |
| rm | `layerfs file rm <project> <branch> <path> [--recursive] [--expected C] [-m msg]` | `file.rm(project, branch, path, { recursive, expected, message })` |
| mkdir | `layerfs file mkdir <project> <branch> <path> [--mode M] [--expected C] [-m msg]` | `file.mkdir(project, branch, path, { mode, expected, message })` |
| mv | `layerfs file mv <project> <branch> <from> <to> [--expected C] [-m msg]` | `file.mv(project, branch, from, to, { expected, message })` |
| cp | `layerfs file cp <project> <branch> <from> <to> [--expected C] [-m msg]` | `file.cp(project, branch, from, to, { expected, message })` |
| apply | `layerfs file apply <project> <branch> [--expected C] [-m msg] [--from file]` (JSON list on stdin) | `file.apply(project, branch, changes, { expected, message })` |

In the SDK an optional positional you skip is left out (`file.glob(P, B, "**/*.js", { limit: 1000 })`);
to compare a file across two Commits or Branches, use [`commit diff`](commit.md#commit-diff) with `--path` and `--with patch` (`file.revision` and `file.diff` are removed in 2.0).

## When to use them

- **Reads** see what is saved on the Branch: every `file` write and every Workspace
  Commit, but not a mounted Workspace's uncommitted changes. They are how you read the
  project, an older version, another Branch or `main`, without mounting anything.
- **Writes** go straight to a Branch as a Commit. They are how you change files, on
  the session Branch `$B` and on side Branches. Use a command in a Workspace instead
  for a batch change with logic (a codemod, `sed -i` across files, a generator, a
  formatter). Never write to `main` (`InvalidInput`) or to any other `dsh.…` Branch.
- A Workspace mounted before a write doesn't show it until that Workspace's next
  Commit (`workspace status` sets `branch_moved: true`). Make the writes a command
  needs before you mount for it.

## Shared rules

- Paths are absolute and canonical (`/src/cart.js`). A relative path is refused
  `InvalidInput`.
- Pass `--at <commit>` (`{ at }`, a full 66-hex id or >=8-char prefix) to read an
  older state on that Branch. An ambiguous prefix is refused `InvalidInput` with
  `matches`.
- A write makes exactly one Commit, or nothing. `unchanged: true` (`outcome: "unchanged"`
  with `--detail`) means nothing changed and no Commit was made. If another writer
  moved the Branch, the write merges unless `expected` was passed (`merged: true`).
  Parent folders must exist; `file mkdir` creates missing parents.
- **Pages:** `list`, `glob`, `grep` and `history` take `--limit` (1 to 1000, default
  100) and `--cursor` (`{ limit, cursor }`), and answer `{ items, next_cursor? }`.
  While `next_cursor` is present, pass it as `cursor` to read the next page against
  the same pinned Commit.
- `mode` is 4-digit octal text (`"0644"`, `"0755"`), never a decimal number.

**Shared refusals** (pass `--detail` / `{ detail: true }` for `detail.code`):

| `error` | Meaning | Do |
| --- | --- | --- |
| `NotFound` | Missing path, parent folder, Branch or Commit (`NoSuchPath`, `NoSuchBranch`, `NoSuchCommit`), or `file edit` `old_string` absent (`NoMatch`) | `file list` the parent, `branch list`, `commit list`, or `file grep` |
| `InvalidInput` | Writing `main` (`ReadOnly`), `IsDirectory`/`NotDirectory`, non-empty `rm` without `recursive`, `file edit` on a binary file or ambiguous match (`AmbiguousMatch`, carries `matches`), bad option/cursor/mode/short prefix | Read `message` and `fix` |
| `Conflict` | Write conflicted with a moved head, or head did not match `expected` (`HeadMoved`; carries `commit`) | Read the file again, then redo the change |
| `Exists` | `cp` or `mv` onto an existing target | Pick another target |
| `Busy`; `Failed` with `busy before effect` or `Storage(Busy)` | Another writer held the Store; nothing was written | Wait 2–8 s (jittered) and run it again, at most 5 times |
| `Unknown`, `Unresolved` | Outcome uncertain or prior `Unknown` open | Check `file read`/`file stat`/`commit list` before acting again |
| `Failed` | The call failed before committing | Stop and report `message` |

## `file read`

```bash
layerfs file read "$P" "$B" /src/math.js --line 2 --limit 2
```

```js
const r = await layerfs.file.read(P, B, "/src/math.js", { line: 2, limit: 2 });
```

Short answer: `{"text":"  return a + b;\n}\n"}` (with `next_line` and
`line_truncated` when set). Long form (`--detail` / `{ detail: true }`) adds
`binary`, `size`, `commit`, `root`, `path`, `start_line`, `end_line`.

The command's `--text` prints the text alone. **One answer holds at most 2000 lines
and 48 KiB**; `next_line` says where to continue. Binary files do **not** error:
`file read` answers `{"binary":true,"size":<bytes>}` (inspect or copy their bytes in
a Workspace).

Before you write back a file you read in windows, check you have all of it:
`Buffer.byteLength(text) === (await layerfs.file.stat(P, br, path)).size`.

Read a whole long text file window by window:

```js
let line = 1, text = "";
for (;;) {
  const r = await layerfs.file.read(P, B, "/src/cart.js", { line });
  if (r.binary) throw new Error(`binary file (${r.size} bytes): inspect in a Workspace`);
  text += r.text ?? "";
  if (r.next_line == null) break;
  line = r.next_line;
}
```

## `file stat`

```json
{"type":"file","size":46,"mode":"0644"}
```

`type` is `file`, `dir` or `symlink`; `mode` is 4-digit octal text (`"0644"`).
Long form adds `commit`, `root`, `path`, `inode`, `modified_at`. A missing path is
refused `NotFound`, which is how to test for existence:

```js
const exists = await layerfs.file.stat(P, B, "/package.json").then(
  () => true,
  (e) => { if (e.error === "NotFound") return false; throw e; },
);
```

## `file list`

A folder's entries, as a page. Each short item is `{ path, type }` (`--detail` adds
`inode`, plus `skipped_hidden` on the answer).

```bash
layerfs file list "$P" "$B" / --text
```

```
PATH         TYPE
/.gitignore  file
/.lww        file
/src         dir
```

## `file glob`

Paths under `path` (default `/`) matching `pattern`, as a page of path strings.
**`pattern` comes BEFORE `[path]`!** `*` and `?` match within one name; `**` spans
folders; `--exclude` skips matching paths/folders (e.g. `node_modules`).

```bash
layerfs file glob "$P" "$B" '**/*.js' /
```

```js
const all = [];
let cursor;
do {
  const page = await layerfs.file.glob(P, B, "src/**/*.js", "/", { limit: 1000, cursor });
  all.push(...page.items);
  cursor = page.next_cursor;
} while (cursor);
```

## `file grep`

Lines under `path` (default `/`) that contain `pattern`. **`pattern` comes BEFORE
`[path]` and is literal plain text, not a regular expression.** Supports
`--include`, `--exclude`, `--ignore-case`. Each item is `{ path, line, text }`
(with `line_truncated` when cut); `--detail` adds `skipped_binary` on the answer.
For regular expressions, run `rg` in a Workspace.

```bash
layerfs file grep "$P" "$B" 'retries' /src
```

## `file history`

The saved changes to one literal path, newest first, from the Branch's head (or
`--at C`). `traversal` is `"provenance"` (default, follows the path across forks) or
`"branch"`. Each item is `{ commit, change, message? }` (`--detail` adds `parent`,
`created_at`, `type`, `size`, `mode`, `content`, `metadata`, `identity`).

```bash
layerfs file history "$P" "$B" /src/app.js
```

## `file blame`

The Commit and message of each line, from `--line` (default 1) for `--limit` lines
(default 2000). Short answer: `{ ranges: [{ start, end, commit }], commits: [{ commit, message? }], next_line?, partial? }`;
`--detail` adds `commit`, `root`, `path` and `commits[].created_at`.

## Write results

Every write answers `{ commit }` plus, when set, `unchanged: true`, `merged: true`,
`overwritten` (first 20 `/.lww` paths), `overwritten_count` (when past 20). Long
form (`--detail` / `{ detail: true }`) adds `outcome` (`"committed"`, `"merged"`, or
`"unchanged"`), `branch`, `parent`, `root`, `message`, `created_at`.

## `file write`

Creates or replaces one file. The command reads the content from stdin, or from
`--from <file>` (a file on this machine, such as one in the scratch folder); the SDK
takes a string (text) or a `Buffer` / `Uint8Array` (bytes). `--mode` (`mode`) takes
octal text such as `"0755"`.

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

Replaces `old_string` with `new_string` (both required). Without `replace_all`, it
replaces exactly one unique occurrence. The command also takes `--old-string-from <file>`
and `--new-string-from <file>` for text with quotes or many lines.

```bash
layerfs file edit "$P" side /src/index.js --old-string "retries = 3" --new-string "retries = 1" -m "one attempt"
```

```js
await layerfs.file.edit(P, "side", "/src/index.js", { old_string: "retries = 3", new_string: "retries = 1", message: "one attempt" });
```

| `error` | Meaning | Do |
| --- | --- | --- |
| `NotFound` | `old_string` doesn't occur (`detail.code: "NoMatch"`) | `file grep` then `file read` the area; the text differs |
| `InvalidInput` | `old_string` occurs more than once (`matches` count, `fix` adds `--replace-all`), `old_string` is empty, or the file is binary | Include more surrounding lines, pass `--replace-all`, or edit in a Workspace |

On refusal nothing changed.

## `file apply`

Applies an ordered list of changes as **one** Commit, or nothing: the way to make a
multi-file change on a Branch. The command reads the JSON list from stdin or
`--from`; the SDK takes the array. Field names are snake_case:

| `op` | Fields |
| --- | --- |
| `write` | `{ op: "write", path, content, mode? }` (`mode` octal string e.g. `"0755"`, `content` string or bytes) |
| `edit` | `{ op: "edit", path, old_string, new_string, replace_all? }` |
| `mkdir` | `{ op: "mkdir", path, mode? }` |
| `chmod` | `{ op: "chmod", path, mode }` (`mode` is octal string e.g. `"0755"`, NOT decimal `493`) |
| `rm` | `{ op: "rm", path, recursive? }` |
| `cp`, `mv` | `{ op: "cp" \| "mv", from, to }` |

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
[{"op":"rm","path":"/config/old.json"},{"op":"mv","from":"/config/new.json","to":"/config/app.json"}]
EOF
```

When a change fails, nothing is committed; fix that change and apply the whole list again.

## `file mkdir`, `file rm`, `file cp`, `file mv`

- `mkdir` creates a folder and any missing parents; an existing folder gives
  `unchanged: true`. `InvalidInput` (`NotDirectory`) when a file is in the way.
- `rm` removes a file or folder (pass `--recursive` / `{ recursive: true }` for a
  non-empty folder). `NotFound` when missing.
- `cp` copies a file or folder tree, keeping modes and symlinks.
- `mv` moves or renames, keeping identity and timestamps.
- For `cp` and `mv`: `Exists` when `to` exists; `InvalidInput` for the same path
  or a copy into its own subtree.

```bash
layerfs file mv "$P" side /src/basket.js /src/cart.js -m "cart: rename basket"
```

```js
await layerfs.file.rm(P, "side", "/src/legacy", { recursive: true, message: "remove legacy folder" });
```
