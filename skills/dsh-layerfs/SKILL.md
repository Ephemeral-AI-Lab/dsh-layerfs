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
3. **Look at history** with `commit`, `branch` and `file history` calls.

You never set anything up: the project, its machine and its Sandbox are ready before
your first call.

**Write project files straight onto the Branch**, one `file write` / `file edit` per
file or one `file apply` per group that belongs together, each with a message. Don't
draft them in the local folder and upload them later, and don't compile or test on the
local machine: its toolchain, paths and OS are not the Sandbox's, and nothing there is
saved or seen by anyone else. Build and test in a Workspace; fix what fails with
`file edit` on the Branch and build again.

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
line, which defines `layerfs` as a shell function and the names every example
uses. Never run a bare `layerfs` from `PATH` or a path of your own: it may be
another build, bound to another LayerFS home.

```bash
layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=$DSH_LAYERFS_PROJECT B=$DSH_LAYERFS_BRANCH SB=${DSH_LAYERFS_WS%%:*}
```

`P` is the project, `B` the session Branch and `SB` the session Sandbox. Shell
variables don't survive between bash calls: repeat the line.

**The SDK**, for loops, many calls and anything that needs to look at a result before
the next call: one Node process instead of one per call. Feed the script to Node as
ESM (`--input-type=module` or `.mjs`), so it needs no quoting:

```bash
node --input-type=module <<'EOF'
const { default: layerfs } = await import(process.env.DSH_LAYERFS_SDK);
const P = process.env.DSH_LAYERFS_PROJECT, B = process.env.DSH_LAYERFS_BRANCH;
const SB = process.env.DSH_LAYERFS_WS.split(":")[0];

const page = await layerfs.file.glob(P, B, "src/**/*.ts", "/", { limit: 1000 });
for (const path of page.items) console.log(path);
EOF
```

Load it **only** with `await import(process.env.DSH_LAYERFS_SDK)` in ESM
(`--input-type=module` or `.mjs`) — **never** `require(...)` (the generated module
uses top-level `await` and throws `ERR_REQUIRE_ASYNC_MODULE` in Node 24), and never
import by package name. It exposes the six agent-facing families (`project`,
`branch`, `commit`, `file`, `sandbox`, `workspace`), `LayerFSError`, `table` (the
calls), `commit_id` and `close()`. Its Stores close by themselves when the script
ends. Every SDK example in this skill assumes the names above.

| | Command | SDK |
| --- | --- | --- |
| A call | `layerfs file read "$P" "$B" /a.js --line 2` | `await layerfs.file.read(P, B, "/a.js", { line: 2 })` |
| Arguments | positionals, then `--kebab-case` options | positionals, then one trailing `{ snake_case }` options object |
| Content | stdin, or `--from <file>` (`--old-string-from <file>`, etc.) | a string or a `Buffer` / `Uint8Array` |
| Result | one line of JSON on stdout when piped (`--text` is default on TTY; `--text --json` exits 2), exit 0 | the same value, resolved (short form by default; `{ detail: true }` for long form) |
| Refusal | `{"error","message","fix?",...}` on stderr (`--json`/pipe), exit 125 (`detail` only with `--detail`) | throws `LayerFSError` with `error` (`code`), `message`, `fix`, `detail` (`null` unless `detail: true`), plus flat extra fields |
| Wrong arguments | exit 2, nothing ran | throws `InvalidInput` naming the call |

- Short form omits `null`, `false`, empty strings/arrays/objects and default states;
  pass `--detail` (`{ detail: true }`) for every declared field in fixed order (and
  `detail` on refusals, including the folded internal `detail.code`).
- Add `--text` on a piped command for a table. `layerfs help <family> [<call>]`
  shows a call's arguments; in the SDK, `layerfs.table` lists every call with its
  `args`, `options`, `with` sections and forms.
- Read `e.error` (`e.code` is an alias) before your next call; nothing retries for
  you. An error without a LayerFS `error` code (from your script, not LayerFS) means
  the outcome is unknown: look first.
- **Paths:** `file` calls take project paths, absolute from the project root
  (`/src/app.js`). Inside a Workspace command, use paths relative to the Workspace
  root (`src/app.js`): each mount gets a new mount path, so never write one into a
  command, a script or a config file.
- **Commit ids** are 66 hex characters. A full id **or a prefix of 8 or more
  characters** is accepted everywhere a Commit is taken (an ambiguous prefix is
  refused `InvalidInput` with `matches`).
- **Pages:** list calls (`project list`, `branch list`, `commit list`, `commit diff`,
  `file list`, `file glob`, `file grep`, `file history`, `sandbox list`,
  `sandbox files`, `sandbox log`, `workspace list`) take `--limit` (1..1000, default
  100; 200 for `sandbox log`) and `--cursor` (`{ limit, cursor }`), and answer
  `{ items, next_cursor? }`: while `next_cursor` is present, call again with
  `--cursor "$next"` (`{ cursor: page.next_cursor }`). `sandbox get` is unpaged.
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
| **Local folder** (your cwd) | The scratch folder the user picked. Not part of the project and never saved into it | Your notes, plans and the ledger. **Never project files**: don't draft code there to upload later, and don't build or test the project on the local machine |

**Checkpoints.** At the end of every turn of the main agent in which `$B` moved
(unless the runtime context says checkpoints are off), dsh records a checkpoint: the
point on `$B` the user can restore to. Your `file` writes and Workspace Commits are
already saved on `$B`; the checkpoint only marks the turn. A subagent's turns record
none. Keep `$DSH_LAYERFS_WS` quiet — never edit or exec in it, and during a team run
keep `$B` clean of concurrent writes so checkpoints never conflict with `$B` moves.

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
| An older version, another Branch or `main` | `file …` with `--at <commit>`, a Branch name or `main` |
| History of the session | `commit list` on `$B`, `commit get`, `commit diff` |
| History of one file | `file history`, `file blame` |
| Compare two versions | `commit diff` (two Commits, two Branches, or one path via `--path` and `--with patch`) |
| What `main` holds and its publications | `file …` with `main`, `commit list` on `main` |
| Try something without touching the session | `branch fork`, then work on that Branch ([parallel work](references/rules/parallel.md)) |
| Run work in parallel with subagents | [parallel work](references/rules/parallel.md); 4 or more at once: [team runs](references/rules/team.md) |
| Publish to `main` | `branch publish`, **only when the user asks** ([publishing](#publishing)) |

`file` calls see what is saved on the Branch: every `file` write and every Workspace
Commit, but not a mounted Workspace's uncommitted changes.

## Writing files

Change files with `file` calls on `$B`. Each one is a Commit, so give it a message.

```bash
layerfs file edit "$P" "$B" /src/cart.js --old-string 'retries = 3' --new-string 'retries = 1' -m "one retry"
layerfs file write "$P" "$B" /src/tax.js -m "add the tax table" <<'EOF'
export const TAX = 0.08;
EOF
layerfs file write "$P" "$B" /assets/logo.png --from ./draft/logo.png -m "add the logo"
```

```js
await layerfs.file.edit(P, B, "/src/cart.js", { old_string: "retries = 3", new_string: "retries = 1", message: "one retry" });
await layerfs.file.apply(P, B, [
  { op: "mkdir", path: "/src/pricing" },
  { op: "write", path: "/src/pricing/tax.js", content: "export const TAX = 0.08;\n", mode: "0644" },
  { op: "mv", from: "/src/old-tax.js", to: "/src/legacy-tax.js" },
  { op: "rm", path: "/src/legacy-tax.js" },
], { message: "move the tax table" });
```

- `file edit` replaces one exact, unique piece of text (`NotFound` when absent;
  `InvalidInput` with `matches` and a `--replace-all` `fix` when ambiguous). Read
  the lines first with `file read`.
- A write needs its folder: `file mkdir` first, or `file apply` with a `mkdir` change.
- `file apply` makes one Commit for many changes, all or nothing: use it for a change
  that must land together. `mode` values are 4-digit octal strings (`"0644"`, `"0755"`).
- Use a command in a Workspace instead when it is easier there: many files changed by
  one rule, a codemod, a generator, a formatter, `npm install`. Such a change is
  saved by the Workspace's Commit.
- A Workspace mounted before a `file` write doesn't show that write until its next
  Commit (`workspace status` sets `branch_moved: true`). Make the `file` changes a
  command needs before you mount for it.

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
const { workspace } = await layerfs.workspace.mount(SB, B, { name: "test-cart" });
try {
  const run = await layerfs.workspace.exec(workspace, "timeout 110 npm test -- cart 2>&1");
  console.log(run.exit_code, (run.stdout ?? "").slice(-4000));
  await layerfs.workspace.commit(workspace, { message: `npm test cart (exit ${run.exit_code})` });
} finally {
  await layerfs.workspace.unmount(workspace);
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
- **At most 16 Workspaces per Sandbox**, dsh's own included. On `Capacity`, unmount
  Workspaces you're done with. For more at once, create a Sandbox of your own on the
  project's machine and mount there ([sandbox](references/methods/sandbox.md#sandbox-create)).
  Remove it (`sandbox remove`) when its work is done.
- A non-zero exit is a result, not a refusal. The command's `--stream` prints the
  output and exits with the command's exit code (125 still means LayerFS refused);
  without it, and in the SDK, the answer is `{ exit_code }` with `stdout`/`stderr`
  when non-empty, each stream up to 1 MiB (`stdout_file`/`stderr_file` when longer).
- **No timeout of its own:** wrap long commands, `timeout 110 <command>`. A native
  macOS Sandbox has no `timeout` (exit 127, `command not found`): there use
  `perl -e 'alarm shift; exec @ARGV' 110 <command>`. Check once with
  `command -v timeout`. A bash call may run up to 600 s; longer work goes in a
  `run_in_background` bash call (LayerFS generates an `exec-...` id emitted in
  `--progress` / `--detail`, and you can stop it with `workspace cancel "$ws"` or
  `--exec <id>`; see [waiting](references/rules/team.md#waiting)).
- **Stdin:** pass `--stdin` in the command (reads the command's stdin) or `{ stdin }`
  in the SDK. Without `--stdin`/`stdin`, the command reads `/dev/null`.
- Output is delivered after the command ends, never live. For long logs redirect to
  a file in `/tmp` and read its tail in a second exec. Throwaway files go in `/tmp`,
  outside the Workspace.
- It waits for everything holding its output, background jobs included: start a
  server, probe it and stop it in one exec, with its output sent to `/tmp`.
- Tools come from the Sandbox, not from your local machine. Check with
  `command -v node python3 git rg` before relying on one.
- **On a `docker` (Linux) Sandbox the image's environment is not applied:** `PATH` is
  the plain system one, so a tool installed under its own prefix is "not found" there.
  Rust is in `/usr/local/cargo/bin`: start every exec that uses it with
  `export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH` and keep
  `CARGO_BUILD_JOBS=2`. Look for other tools with `ls /usr/local/*/bin`. You are not
  root: install into the Workspace.
- **`/tmp` is small there:** a memory-backed tmpfs (about half the machine's RAM),
  shared by every Workspace in the Sandbox. Keep logs and exit codes there; put large
  temporary data (test databases, sorter spills, link temp files) under
  `$HOME/tmp/$ME` (or `$HOME/tmp/<your workspace name>`; `$HOME` is on the machine's
  disk): set `TMPDIR` to it, `mkdir -p` it, and clear it at the end of the step.

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
| Cargo | `CARGO_HOME=$PWD/.cargo-home`, `CARGO_TARGET_DIR=$PWD/target`, `CARGO_BUILD_JOBS=2` ([Rust and Cargo](references/rules/cargo.md)) |
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
layerfs file read "$P" main /src/app.js --line 200 --text         # main, from line 200
layerfs file read "$P" "$B" /src/app.js --at <commit-id> --text   # an older version (full id or >=8-char prefix)
layerfs file grep "$P" "$B" 'retries' /src                        # plain text (pattern first, then optional path)
```

```js
let line = 1, text = "";                          // a whole long file, window by window
for (;;) {
  const r = await layerfs.file.read(P, B, "/src/app.js", { line });
  if (r.binary) throw new Error(`binary file (${r.size} bytes): inspect in a Workspace`);
  text += r.text ?? "";
  if (r.next_line == null) break;
  line = r.next_line;
}
```

One `file read` answers at most 2000 lines or 48 KiB; `next_line` says where to
continue. Binary files do **not** error: `file read` returns `{ binary: true, size }`
(look at their bytes in a Workspace). `file grep` searches everything under `path`,
`node_modules` too, so pass a narrow path or `--exclude node_modules`.

## History

```bash
layerfs commit list "$P" "$B" --text                    # the session's Commits, newest first
layerfs commit diff "$P" <newer-id> --from <older-id>   # changed paths between two Commits
layerfs file history "$P" "$B" /src/app.js              # the saved changes to one path
layerfs file blame "$P" "$B" /src/app.js                # the Commit of each line
layerfs commit diff "$P" "$B" --from main               # what the session changed against main
```

## Publishing

Publish only when the user asks you to. `branch publish` of `$B` makes `main` show the
session Branch's head: every `file` write and Workspace Commit so far. Uncommitted
changes in a mounted Workspace are not in it. If `main` may have moved since the
session started, check first ([branch publish](references/methods/branch.md#branch-publish)).
Never publish a side Branch the user has not reviewed.

## Rules

- **Leave dsh's setup alone.** Never exec in, commit or unmount dsh's Workspace
  `$DSH_LAYERFS_WS`, and never remove the session Sandbox `$SB`. Never name a Branch
  you create `dsh.…`, and never write to a `dsh.…` Branch other than `$B` (forking
  *from* `$B` is fine). dsh owns those Branches: checkpoints, restores and the
  project's identity depend on them.
- **Only this project.** Every call names `$P`. Don't list or touch other projects,
  Stores, machines or backups; they are the user's setup, not part of the task.
- **A Workspace you mount is yours.** Mount it in `$SB`, commit it, unmount it before
  your turn ends. Never `discard` or unmount another agent's Workspace.
- **A refusal is information.** The 13 public refusal codes are `NotFound`, `Exists`,
  `InUse`, `Busy`, `Unresolved`, `Conflict`, `Dirty`, `Capacity`, `InvalidInput`,
  `Unsupported`, `Unavailable`, `Failed`, `Unknown` (pass `--detail` / `{ detail: true }`
  for `detail.code`). The project's Store takes one writer at a time, and on a macOS
  host a second writer is refused at once instead of waiting. So a write (`file`
  writes, Workspace Commits, merges, forks) can be refused while dsh or another
  agent writes:
  - `Busy`, or `Failed` whose message says `busy before effect` or `Storage(Busy)`:
    nothing happened. Wait `sleep $((2 + RANDOM % 6))` and run it again, at most 5
    times, then report it.
  - `Unknown` (outcome uncertain — e.g. a lost reply; daemon calls carry `attempted: true`,
    `workspace.exec` carries `exec` & `fix`): it may or may not have happened! Inspect
    state first (`commit list`, `file read`/`file stat`, `workspace status`, `sandbox get`)
    and act again only if it did not land.
  - `Unresolved`: an earlier `Unknown` operation on that entity is still open (`op`/`fix`),
    and this call did nothing. Inspect state and clear it via `fix` before acting again.
  - `Failed` whose message is `Os { code: 2, kind: NotFound, … }` on a write: seen on
    `docker` Stores when several writers land at once (about 1 in 70). So far it has
    always been before effect, but check: `file stat` the path or `commit list` the
    Branch; if your change is not there, wait `sleep $((2 + RANDOM % 6))` and run it
    again (at most 5 times).
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
| [branch](references/methods/branch.md) | `list`, `get`, `fork`, `merge`, `publish`, `remove` |
| [commit](references/methods/commit.md) | `list`, `get`, `diff` |
| [file](references/methods/file.md) | reads: `read`, `stat`, `list`, `glob`, `grep`, `history`, `blame`; writes: `write`, `edit`, `rm`, `mkdir`, `mv`, `cp`, `apply` |
| [sandbox](references/methods/sandbox.md) | `get`, `list`, `create`, `remove` (only Sandboxes you created), `files`, `log`, `doctor` |
| [workspace](references/methods/workspace.md) | `list`, `mount`, `exec`, `cancel`, `commit`, `unmount`, `status` |
| [parallel work](references/rules/parallel.md) | side Branches, subagents, bringing work in |
| [team runs](references/rules/team.md) | many workers in one Sandbox: slots, Branches, waiting, integrating, reports |
| [conflicts](references/rules/conflicts.md) | Commit conflicts and Branch-merge conflicts |
| [/.lww](references/rules/lww.md) | merge rules for generated files |
| [Rust and Cargo](references/rules/cargo.md) | Cargo state inside a Workspace |
