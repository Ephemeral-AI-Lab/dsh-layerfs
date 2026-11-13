---
name: dsh-layerfs
description: Use in every LayerFS project session before the first LayerFS call. The project's files live in LayerFS, not in the local folder; this is how to read, search, change, run, save, branch and review them with the `layerfs` command ($DSH_LAYERFS_CLI) or the Node SDK ($DSH_LAYERFS_SDK), through the project, branch, commit, file, sandbox and workspace calls. File calls for reading and changing files, Workspaces (mount, exec, commit, unmount) for running commands; checkpoints, side Branches, subagents and team runs, conflicts and /.lww.
---

# LayerFS: your project filesystem

This conversation works on one LayerFS project. Its files are in LayerFS, not in
the local folder you are in. Use LayerFS as your filesystem:

1. **Read and change files with `file` calls** on the session Branch. Each change is
   saved at once as a Commit.
2. **Use a Workspace only to run commands** (build, test, install, git, a formatter, a
   batch edit): mount it, exec, commit, unmount.
3. **Look at history** with `commit`, `branch` and `file revision` calls.

You never set anything up: the project, its machine and its Sandbox are ready before
your first call.

## What you already have

Every bash call has these variables:

| Variable | What it is |
| --- | --- |
| `DSH_LAYERFS_CLI` | The LayerFS command, bound to this app's LayerFS home |
| `DSH_LAYERFS_SDK` | The LayerFS Node SDK (`@layerfs/node`), bound to the same home. Unset when no SDK is installed for this build: then use the command |
| `DSH_LAYERFS_PROJECT` | The project, `<store>/<project>`, such as `shop/api` |
| `DSH_LAYERFS_BRANCH` | The session Branch: the project as this conversation has it, and its saved history |
| `DSH_LAYERFS_WS` | dsh's own Workspace, `<sandbox>:main`, which records the checkpoints. Leave it alone; its Sandbox part is the session Sandbox, where you mount Workspaces |
| `DSH_LAYERFS_TRACE_CONTEXT` | Ties each call to this session and tool call. Keep it: never `env -i` or override it |

The runtime context names the project and its machine. There is nothing to install,
import or configure: no `LAYERFS_HOME`, no `npm install`, no Store, no machine.

- If `$DSH_LAYERFS_WS` is empty, the project's execution is not active (its machine
  is down, or the session was closed): `file` calls still work, commands don't. Tell
  the user before you need commands. Don't start machines.
- If `$DSH_LAYERFS_SDK` is empty, use the command: no SDK is installed for this build,
  or the app is still starting.

## Two ways in: the command and the SDK

Both make the same calls, with the same arguments in the same order, the same
results and the same refusals. Every call is recorded in the session either way.

**The command**, for single calls. Start every bash call that uses it with this
line, which defines `layerfs` as a shell function (nothing named `layerfs` is on
`PATH`) and the names every example uses:

```bash
layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=$DSH_LAYERFS_PROJECT B=$DSH_LAYERFS_BRANCH SB=${DSH_LAYERFS_WS%%:*}
```

`P` is the project, `B` the session Branch and `SB` the session Sandbox. Shell
variables don't survive between bash calls: repeat the line.

**The SDK**, for loops, many calls and anything that needs to look at a result before
the next call: one Node process instead of one per call. Feed the script to Node on
stdin, so it needs no quoting:

```bash
node --input-type=module <<'EOF'
const { default: layerfs } = await import(process.env.DSH_LAYERFS_SDK);
const P = process.env.DSH_LAYERFS_PROJECT, B = process.env.DSH_LAYERFS_BRANCH;
const SB = process.env.DSH_LAYERFS_WS.split(":")[0];

const page = await layerfs.file.glob(P, B, "/", "src/**/*.ts", { page_size: 1000 });
for (const path of page.items) console.log(path);
EOF
```

Import it only as `await import(process.env.DSH_LAYERFS_SDK)`, never by package name.
It has the six families (`project`, `branch`, `commit`, `file`, `sandbox`,
`workspace`), `LayerFSError`, `table` (the calls) and `close()`. Its Stores close by
themselves when the script ends.
Every SDK example in this skill assumes the names above.

| | Command | SDK |
| --- | --- | --- |
| A call | `layerfs file read "$P" "$B" /a.js --start-line 2` | `await layerfs.file.read(P, B, "/a.js", { start_line: 2 })` |
| Arguments | positionals, then `--kebab-case` options | positionals, then one `{ snake_case }` options object |
| Content | stdin, or `--from <file>` | a string or a `Buffer` argument |
| Result | one line of JSON on stdout, exit 0 | the same value, resolved |
| Refusal | `{"code","message","detail"}` on stderr, exit 125 | throws `LayerFSError` with `code`, `message`, `detail` |
| Wrong arguments | exit 2, nothing ran | throws `InvalidInput` naming the call |

- Add `--text` to a command for a table. `layerfs help <family> [<call>]` shows a
  call's arguments; in the SDK, `layerfs.table` lists every call with its `args` and
  `options`.
- Read `code` before your next call; nothing retries for you. An error without a
  `code` (from your script, not LayerFS) means the outcome is unknown: look first.
- **Paths:** `file` calls take project paths, absolute from the project root
  (`/src/app.js`). Inside a Workspace command, use paths relative to the Workspace
  root (`src/app.js`): each mount gets a new mount path, so never write one into a
  command, a script or a config file.
- **Commit ids** are 66 hex characters. Pass full ids; a short prefix is refused.
- **Pages:** most list calls answer `{ items, has_more, next_page_pos }`: while
  `has_more` is true, call again with `--page-pos <next_page_pos>` (`page_pos`).
  `branch commits` and `file revision` page by number (`--page N`); `sandbox list` and
  `sandbox get` have no `has_more` and end when `next_page_pos` is `null`; the diffs
  continue with `--cursor <next_cursor>`.
- **Messages:** `-m "<text>"` (`message`) names a Commit. Name the change or the step
  and its result, such as `"fewer retries"` or `"npm test (exit 1)"`.

## The places you work with

| Place | What it is | How you use it |
| --- | --- | --- |
| **Session Branch** `$B` | The project as this conversation has it: every saved change, newest on top | Read and change files with `file` calls; mount it to run commands |
| **Workspaces you mount** | A writable view of a Branch, in the session Sandbox `$SB`, where commands run | Mount, exec, commit, unmount. At most 16 per Sandbox, dsh's own included |
| **dsh's Workspace** `$DSH_LAYERFS_WS` | dsh's Workspace on `$B`, which records the checkpoints | Leave it alone: no exec, commit or unmount |
| **`main`** | The project's published version. Not a Branch | Read and fork from it. Changes only through `branch publish` |
| **Side Branches** | Branches you fork | Experiments and parallel work ([parallel work](references/rules/parallel.md)) |
| **Local folder** (your cwd) | The scratch folder the user picked. Not part of the project and never saved into it | Your notes, scripts and temporary files |

**Checkpoints.** At the end of every turn of the main agent in which `$B` moved
(unless the runtime context says checkpoints are off), dsh records a checkpoint: the
point on `$B` the user can restore to. Your `file` writes and Workspace Commits are
already saved on `$B`; the checkpoint only marks the turn. A subagent's turns record
none.

- **A restore or a branch moves the session to a new Branch** (the runtime context
  says the files were restored, and shows the new Branch). Always use `$B` as it is
  now, never a name from earlier. A Workspace still mounted on the old Branch saves
  nothing for the session: commit it, unmount it, and mount `$B` again.
- **When the conversation closes or idles out**, dsh stops `$SB`, and every
  Workspace still mounted there loses its uncommitted changes.

## Which call for which job

| Job | Call |
| --- | --- |
| Read a file, list a folder, find files | `file read`, `file list`, `file glob`, `file stat` on `$B` |
| Search text | `file grep` on `$B` (plain text); for a regular expression, `rg` in a Workspace |
| Change one or a few files | `file edit`, `file write`, `file mkdir`, `file mv`, `file cp`, `file rm` on `$B` ([writing files](#writing-files)) |
| Change many files at once, all or nothing | `file apply` on `$B` |
| A batch change with logic: a codemod, `sed -i` across files, a generator, a formatter | a command in a Workspace ([running commands](#running-commands)) |
| Run a command: build, test, install, git | a Workspace: mount, exec, commit, unmount |
| An older version, another Branch or `main` | `file …` with a Commit id, a Branch name or `main` |
| History of the session | `commit list` on `$B`, `commit get`, `commit diff` |
| History of one file | `file revision`, `file blame` |
| Compare two versions | `file diff` (two files), `branch diff` (two Branches), `commit diff` (two Commits) |
| What `main` holds and its publications | `file …` with `main`, `branch commits` on `main` |
| Try something without touching the session | `branch fork`, then work on that Branch ([parallel work](references/rules/parallel.md)) |
| Run work in parallel with subagents | [parallel work](references/rules/parallel.md); 4 or more at once: [team runs](references/rules/team.md) |
| Publish to `main` | `branch publish`, **only when the user asks** ([publishing](#publishing)) |

`file` calls see what is saved on the Branch: every `file` write and every Workspace
Commit, but not a mounted Workspace's uncommitted changes.

## Writing files

Change files with `file` calls on `$B`. Each one is a Commit, so give it a message.

```bash
layerfs file edit "$P" "$B" /src/cart.js --old 'retries = 3' --new 'retries = 1' -m "one retry"
layerfs file write "$P" "$B" /src/tax.js -m "add the tax table" <<'EOF'
export const TAX = 0.08;
EOF
layerfs file write "$P" "$B" /assets/logo.png --from ./draft/logo.png -m "add the logo"
```

```js
await layerfs.file.edit(P, B, "/src/cart.js", { old: "retries = 3", new: "retries = 1", message: "one retry" });
await layerfs.file.apply(P, B, [
  { op: "mkdir", path: "/src/pricing" },
  { op: "write", path: "/src/pricing/tax.js", content: "export const TAX = 0.08;\n" },
  { op: "rm", path: "/src/old-tax.js" },
], { message: "move the tax table" });
```

- `file edit` replaces one exact, unique piece of text (`NoMatch`, `AmbiguousMatch`
  otherwise). Read the lines first with `file read`.
- A write needs its folder: `file mkdir` first, or `file apply` with a `mkdir` change.
- `file apply` makes one Commit for many changes, all or nothing: use it for a change
  that must land together.
- Use a command in a Workspace instead when it is easier there: many files changed by
  one rule, a codemod, a generator, a formatter, `npm install`. Such a change is
  saved by the Workspace's Commit.
- A Workspace mounted before a `file` write doesn't show that write until its next
  Commit. Make the `file` changes a command needs before you mount for it.

## Running commands

A Workspace is only for running commands. The usual pattern is **one Workspace per
bash call**: mount, exec, commit, unmount, all in that call, leaving nothing mounted.
With `file` calls for edits, every tool call that changes the project is then one
recorded Commit on `$B`.

```bash
ws=$SB:test-cart
layerfs workspace mount "$SB" "$B" --name test-cart >/dev/null || exit 1
trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT
layerfs workspace exec "$ws" 'timeout 110 npm test -- cart 2>&1' --stream; code=$?
layerfs workspace commit "$ws" -m "npm test cart (exit $code)" >/dev/null
```

```js
const { ws } = await layerfs.workspace.mount(SB, B, { name: "test-cart" });
try {
  const run = await layerfs.workspace.exec(ws, "timeout 110 npm test -- cart 2>&1");
  console.log(run.exit_code, run.stdout.slice(-4000));
  await layerfs.workspace.commit(ws, { message: `npm test cart (exit ${run.exit_code})` });
} finally {
  await layerfs.workspace.unmount(ws);
}
```

- **Name each Workspace** for its step (`--name test-cart`): its handle is then
  `$SB:<name>`, known without parsing. Use a name once at a time; `Exists` means it is
  still mounted.
- One bash call may hold several execs (install, build, test) and, when the steps
  should be recorded apart, several Commits. Keep a Workspace across bash calls only
  for work that has to keep running between them (a dev server, a build you collect
  later), and unmount it as soon as that work is done.
- It runs `bash -c` at the Workspace root. Use relative paths (`src/cart.js`), never
  the mount path that `mount` returns: the next mount gets another one.
- **Commit before you unmount**, a failing step too: everything the commands wrote
  inside the Workspace (sources, lockfiles, `node_modules`, build output) is saved by
  that Commit and nothing else. An unmount with changes left is refused `Dirty`.
- **At most 16 Workspaces per Sandbox**, dsh's own included, and you can't create
  Sandboxes. On `Capacity`, unmount Workspaces you're done with; if it stays full,
  stop and tell the user.
- A non-zero exit is a result, not a refusal. The command's `--stream` prints the
  output and exits with the command's exit code (125 still means LayerFS refused);
  without it, and in the SDK, the answer is `{ exit_code, stdout, stderr }`, each
  stream up to 1 MiB.
- **No timeout of its own:** wrap long commands, `timeout 110 <command>`. A native
  macOS Sandbox has no `timeout` (exit 127, `command not found`): there use
  `perl -e 'alarm shift; exec @ARGV' 110 <command>`. Check once with
  `command -v timeout`. A bash call may run up to 600 s; longer work goes in a
  `run_in_background` bash call with an `--exec-id` ([waiting](references/rules/team.md#waiting)).
- **No stdin:** `… | layerfs workspace exec "$ws" 'cat > f'` writes an empty file.
  Change files with `file` calls, or send content as base64 inside the command
  ([workspace exec](references/methods/workspace.md#workspace-exec)).
- The output comes when the command ends, not live. For long logs redirect to a file
  in `/tmp` and read its tail in a second exec. Throwaway files go in `/tmp`, outside
  the Workspace.
- It waits for everything holding its output, background jobs included: start a
  server, probe it and stop it in one exec, with its output sent to `/tmp`.
- Tools come from the Sandbox, not from your local machine. Check with
  `command -v node python3 git rg` before relying on one.

## Installs and caches belong in the Workspace

The project keeps what `.gitignore` would leave out: installed packages, virtualenvs,
build output and tool caches. Install into the Workspace, commit, and the next mount
of the Branch starts with them, with nothing to install or download again. Point each
tool's install and cache folders inside the Workspace, in every exec (exports don't
survive between calls):

| Tool | Inside the Workspace |
| --- | --- |
| npm, pnpm, yarn | `node_modules/` (as usual), plus `npm_config_cache=$PWD/.npm-cache` |
| pip | `python3 -m venv .venv`, then `.venv/bin/pip install …`; `PIP_CACHE_DIR=$PWD/.pip-cache` |
| uv | `UV_CACHE_DIR=$PWD/.uv-cache`, `uv venv .venv` |
| Cargo | `CARGO_HOME=$PWD/.cargo-home`, `CARGO_TARGET_DIR=$PWD/target` ([Rust and Cargo](references/rules/cargo.md)) |
| Go | `GOPATH=$PWD/.go`, `GOCACHE=$PWD/.go-cache` |
| anything else | `XDG_CACHE_HOME=$PWD/.cache` |

```bash
layerfs workspace exec "$ws" 'export npm_config_cache=$PWD/.npm-cache; timeout 300 npm ci 2>&1 | tail -5' --stream
```

- `HOME` and `/tmp` belong to the Sandbox, not the project: what is installed there
  is gone for the next Sandbox and never reaches other Branches. Use them only for
  throwaway files.
- Install once, commit, and later calls only run the tools. Before installing, check
  whether the Branch already has it (`file stat "$P" "$B" /node_modules`).
- Keep these folders in `.gitignore` and `/.lww` holding `%include .gitignore`: they
  are saved like everything else, and merge newest-wins instead of conflicting
  ([/.lww](references/rules/lww.md)).

## Reading files

```bash
layerfs file read "$P" "$B" /src/app.js --text                    # as saved now
layerfs file read "$P" main /src/app.js --start-line 200 --text   # main, from line 200
layerfs file read "$P" "$B" /src/app.js <commit-id> --text        # an older version
layerfs file grep "$P" "$B" /src 'retries'                        # plain text, not a regex
```

```js
let line = 1, text = "";                          // a whole long file, window by window
for (;;) {
  const r = await layerfs.file.read(P, B, "/src/app.js", { start_line: line });
  text += r.text;
  if (r.next_line == null) break;
  line = r.next_line;
}
```

One `file read` answers at most 2000 lines or 48 KiB; `next_line` says where to
continue. Binary files are refused `Binary`: look at them in a Workspace. `file grep`
searches everything under the path, `node_modules` too, so keep it narrow.

## History

```bash
layerfs commit list "$P" "$B" --text                    # the session's Commits, newest first
layerfs commit diff "$P" <older-id> <newer-id> --paths-only
layerfs file revision "$P" "$B" /src/app.js             # the saved changes to one path
layerfs file blame "$P" "$B" /src/app.js                # the Commit of each line
layerfs branch diff "$P" main "$B" --paths-only         # what the session changed against main
```

## Publishing

Publish only when the user asks you to. `branch publish` of `$B` makes `main` show the
session Branch's head: every `file` write and Workspace Commit so far. Uncommitted
changes in a mounted Workspace are not in it. If `main` may have moved since the
session started, check first ([branch publish](references/methods/branch.md#branch-publish)).
Never publish a side Branch the user has not reviewed.

## Rules

- **Leave dsh's setup alone.** Never exec in, commit or unmount dsh's Workspace
  `$DSH_LAYERFS_WS`, and never close the session Sandbox `$SB`. Never name a Branch
  you create `dsh.…`, and never write to a `dsh.…` Branch other than `$B` (forking
  *from* `$B` is fine). dsh owns those Branches: checkpoints, restores and the
  project's identity depend on them.
- **Only this project.** Every call names `$P`. Don't list or touch other projects,
  Stores, machines or backups; they are the user's setup, not part of the task.
- **A Workspace you mount is yours.** Mount it in `$SB`, commit it, unmount it before
  your turn ends. Never `discard` or unmount another agent's Workspace.
- **A refusal is information.** `Busy` means another call is changing LayerFS: wait
  `sleep $((3 + RANDOM % 8))` and run it again, at most 5 times, then report it. `Unknown` or `Failed` means the outcome is uncertain:
  look (`commit list`, `workspace status`, `sandbox get`) before you act again.
- **A merge conflict belongs to whoever merged or committed.** Resolve it or report
  it; never delete markers to make a Commit pass ([conflicts](references/rules/conflicts.md)).
- **Generated files merge by `/.lww`.** In a new project's first step, make sure
  `/.lww` holds `%include .gitignore` ([/.lww](references/rules/lww.md)).
- **Keep secrets out of command lines:** exec command lines are recorded in the
  session's call log.

## Reference pages

Read the page for a call before you use it for the first time. Each gives the
command and SDK forms, results, refusals and examples.

| Page | Calls |
| --- | --- |
| [project](references/methods/project.md) | `get`, `stats` |
| [branch](references/methods/branch.md) | `list`, `get`, `commits`, `get-commit`, `fork`, `merge`, `publish`, `diff` |
| [commit](references/methods/commit.md) | `list`, `get`, `diff` |
| [file](references/methods/file.md) | reads: `read`, `stat`, `list`, `glob`, `grep`, `revision`, `blame`, `diff`; writes: `write`, `edit`, `rm`, `mkdir`, `mv`, `cp`, `apply` |
| [sandbox](references/methods/sandbox.md) | `get`, `list` (sessions can't create or close Sandboxes) |
| [workspace](references/methods/workspace.md) | `mount`, `exec`, `exec-cancel`, `commit`, `unmount`, `status` |
| [parallel work](references/rules/parallel.md) | side Branches, subagents, bringing work in |
| [team runs](references/rules/team.md) | many workers in one Sandbox: slots, Branches, waiting, integrating, reports |
| [conflicts](references/rules/conflicts.md) | Commit conflicts and Branch-merge conflicts |
| [/.lww](references/rules/lww.md) | merge rules for generated files |
| [Rust and Cargo](references/rules/cargo.md) | Cargo state inside a Workspace |
