// SDK to CLI: the one table that says, for every call an agent can make,
// which terminal prints it and the command line it prints there.
//
// Terminals
//   project    one per project: the project and its Branches (init, fork,
//              merge, publish, history reads; an older trace's Sandbox
//              create and close)
//   fs         one per Branch: every fs.* call on that Branch
//   workspace  one pane per mounted Workspace (sandbox:path): mount, the
//              commands run in it, status, commit, unmount, process control
//   null       not drawn: operator reads (and an older client's service lookup)
//
// CLI form: `<group> <method> <required args…> [--optional value…]`
//   - group and method are the SDK's own names (`branch list_commits`).
//   - A terminal hides the group it implies: the fs terminal prints
//     `read /a.txt`, a Workspace pane `commit -m "…"`. The project terminal
//     prints every group (`branch merge …`).
//   - Required arguments are positional, in SDK order. Optional ones are
//     `--kebab-name value` and print only when they differ from the SDK
//     default; a true boolean is a bare `--force` / `--discard`.
//   - A message is `-m "<message>"`. File content is never printed.
//   - What the terminal already names is not repeated: an fs line drops its
//     Branch or ref, a workspace line drops its Sandbox and path.
//   - A command run in a Workspace prints as the shell command itself (the
//     pane is that Workspace's shell); a background start ends with ` &`.
// A failed mount has no pane, so it prints in the project terminal.
//
// `dim` lines are reads or bookkeeping, drawn quieter than changes.

const kebab = (name) => name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const quote = (v) => (/^[^\s"'\\]+$/.test(String(v)) ? String(v) : JSON.stringify(String(v)));
const shortImage = (image) => String(image).replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1");

/**
 * One command line: `head`, then the positional values, then each optional
 * `[name, value, sdkDefault]` that is set and not its default, then `-m`.
 */
function line(head, positional = [], optional = [], message) {
  const parts = [head, ...positional.filter((v) => v !== undefined && v !== null && v !== "").map(quote)];
  for (const [name, value, fallback] of optional) {
    if (value === undefined || value === null || value === fallback || value === false) continue;
    parts.push(value === true ? `--${kebab(name)}` : `--${kebab(name)} ${quote(value)}`);
  }
  if (message !== undefined && message !== null) parts.push(`-m ${JSON.stringify(String(message))}`);
  return parts.join(" ");
}
const page = (a) => [["pageSize", a.pageSize, 50], ["pagePos", a.pagePos, 0]];
const count = (changes) => (Array.isArray(changes) ? changes.length : changes);

/** call name -> { at: terminal, dim?: true, cli: (args, sh?) => command line } */
export const CLI = {
  // ------------------------------------------------------------- project
  "project.init": { at: "project", cli: (a) => line("project init", [a.path ?? `./${a.name}`]) },
  "project.list_branches": { at: "project", dim: true, cli: (a) => line("project list_branches", [], page(a)) },

  // ------------------------------------------------------------- branch
  "branch.fork": { at: "project", cli: (a) => line("branch fork", [a.name], [["fromRef", a.fromRef ?? a.from ?? a.branch, "main"]]) },
  // the simulator's name for a fork of main
  "main.fork": { at: "project", cli: (a) => line("branch fork", [a.name]) },
  "branch.list_commits": { at: "project", dim: true, cli: (a) => line("branch list_commits", [a.branch], page(a)) },
  "branch.diff_commits": { at: "project", dim: true, cli: (a) => line("branch diff_commits", [a.from, a.to], page(a)) },
  "branch.diff_branches": { at: "project", dim: true, cli: (a) => line("branch diff_branches", [a.from, a.to], page(a)) },
  "branch.merge": { at: "project", cli: (a) => line("branch merge", [a.branch, a.with, a.name], [], a.message) },
  "branch.publish": { at: "project", cli: (a) => line("branch publish", [a.branch], [["commit", a.commit]]) },

  // ------------------------------------------------------------- fs (the Branch is the terminal's)
  "fs.read": { at: "fs", dim: true, cli: (a) => line("fs read", [a.path], [["startLine", a.startLine, 1], ["endLine", a.endLine]]) },
  "fs.list": { at: "fs", dim: true, cli: (a) => line("fs list", [a.path && a.path !== "/" ? a.path : undefined], page(a)) },
  "fs.stat": { at: "fs", dim: true, cli: (a) => line("fs stat", [a.path]) },
  "fs.grep": { at: "fs", dim: true, cli: (a) => line("fs grep", [a.pattern, a.path && a.path !== "/" ? a.path : undefined], page(a)) },
  "fs.glob": { at: "fs", dim: true, cli: (a) => line("fs glob", [a.pattern, a.path && a.path !== "/" ? a.path : undefined], page(a)) },
  "fs.blame": { at: "fs", dim: true, cli: (a) => line("fs blame", [a.path], [["fromLine", a.fromLine, 1]]) },
  // two refs, so both are printed
  "fs.diff_files": { at: "fs", dim: true, cli: (a) => line("fs diff_files", [a.leftRef ?? a.left?.commit ?? a.ref, a.leftPath ?? a.left?.path ?? a.path, a.rightRef ?? a.right?.commit ?? a.ref, a.rightPath ?? a.right?.path]) },
  "fs.write": { at: "fs", cli: (a) => line("fs write", [a.path], [], a.message) },
  "fs.edit": { at: "fs", cli: (a) => line("fs edit", [a.path], [], a.message) },
  // the changes are summarized by their count
  "fs.apply": { at: "fs", cli: (a) => line(count(a.changes) !== undefined ? `fs apply ${count(a.changes)} changes` : "fs apply", [], [], a.message) },
  "fs.mkdir": { at: "fs", cli: (a) => line("fs mkdir", [a.path], [], a.message) },
  "fs.rm": { at: "fs", cli: (a) => line("fs rm", [a.path], [], a.message) },
  "fs.cp": { at: "fs", cli: (a) => line("fs cp", [a.from, a.to], [], a.message) },
  "fs.mv": { at: "fs", cli: (a) => line("fs mv", [a.from, a.to], [], a.message) },

  // ------------------------------------------------------------- workspace
  // LayerFS places a Workspace in one of the project's Sandboxes (#373)
  "workspace.mount": { at: "workspace", dim: true, cli: (a) => line("workspace mount", [a.branch]) },
  "workspace.exec": { at: "workspace", cli: (a, sh) => (sh ?? a.command) + (a.background && !/&\s*$/.test(sh ?? a.command) ? " &" : "") },
  "workspace.status": { at: "workspace", dim: true, cli: () => "workspace status" },
  "workspace.commit": { at: "workspace", cli: (a) => line("workspace commit", [], [["force", a.force]], a.message) },
  "workspace.unmount": { at: "workspace", cli: (a) => line("workspace unmount", [], [["discard", a.discard]]) },
  // The simulator, the scenarios and older traces name these calls by the
  // older SDK's names; they print as the Workspace calls. Sandbox create and
  // close are both the older SDK's named Sandboxes and #428's numbered ones
  // (`deploy.image`); a placed Workspace's Sandbox closes when idle.
  "sandbox.create": { at: "project", cli: (a) => { const image = a.image ?? a.deploy?.image; return line("sandbox create", [a.name, a.project, image && shortImage(image)]); } },
  "sandbox.close": { at: "project", cli: (a) => line("sandbox close", [a.sandbox]) },
  // #428's reads of a project's Sandboxes
  "project.list_sandboxes": { at: null },
  "sandbox.list_workspaces": { at: null },

  // ------------------------------------------------------------- operator
  // process start and cancel are the only operator calls drawn; the rest are reads
  "process.start": { at: "workspace", cli: (a, sh) => CLI["workspace.exec"].cli({ ...a, background: true }, sh) },
  "process.cancel": { at: "workspace", cli: (a) => line("process cancel", [a.process]) },
  // the simulator's names for a Sandbox's process list and the Layer snapshot
  "sandbox.list_processes": { at: "project", dim: true, cli: (a) => line("process list", [a.sandbox]) },
  "main.list_layers": { at: "project", dim: true, cli: () => "inspect snapshot" },
  "sandbox.service": { at: null },
  "sandbox.list": { at: null },
  "project.progress": { at: null },
  "store.stats": { at: null },
  "store.commits": { at: null },
  "store.overwritten": { at: null },
  "files.stats": { at: null },
  "files.history": { at: null },
  "workspace.overlay": { at: null },
  "workspace.changes": { at: null },
  "inspect.snapshot": { at: null },
  "process.list": { at: null },

  // v2 (the 2.0 call table): @layerfs/node, nine families, 66 calls
  "project.init": { at: "project", cli: (a) => line("project init", [a.path]) },
  "project.list": { at: null },
  "project.get": { at: null },
  "project.stats": { at: null },
  "project.export": { at: "project", dim: true, cli: (a) => line("project export", [a.name]) },
  "project.remove": { at: "project", cli: (a) => line("project remove", [a.name]) },
  "branch.list": { at: "project", dim: true, cli: (a) => line("branch list", [a.project], page(a)) },
  "branch.get": { at: null },
  "branch.commits": { at: "project", dim: true, cli: (a) => line("branch commits", [a.branch], page(a)) },
  "branch.get_commit": { at: null },
  "branch.fork": { at: "project", cli: (a) => a.project ? line("branch fork", [a.project, a.name, a.from]) : line("branch fork", [a.name], [["from", a.from ?? a.branch, "main"]]) },
  "branch.merge": { at: "project", cli: (a) => line("branch merge", [a.branch, a.with, a.name], [], a.message) },
  "branch.publish": { at: "project", cli: (a) => line("branch publish", [a.branch]) },
  "branch.diff": { at: "project", dim: true, cli: (a) => line("branch diff", [a.from, a.to], page(a)) },
  "commit.list": { at: null },
  "commit.get": { at: null },
  "commit.diff": { at: "project", dim: true, cli: (a) => line("commit diff", [a.left, a.right]) },
  "file.read": { at: "fs", dim: true, cli: (a) => line("file read", [a.path]) },
  "file.stat": { at: "fs", dim: true, cli: (a) => line("file stat", [a.path]) },
  "file.list": { at: "fs", dim: true, cli: (a) => line("file list", [a.path], page(a)) },
  "file.glob": { at: "fs", dim: true, cli: (a) => line("file glob", [a.pattern, a.path], page(a)) },
  "file.grep": { at: "fs", dim: true, cli: (a) => line("file grep", [a.pattern, a.path], page(a)) },
  "file.revision": { at: null },
  "file.blame": { at: "fs", dim: true, cli: (a) => line("file blame", [a.path]) },
  "file.diff": { at: "fs", dim: true, cli: (a) => line("file diff", [a.left, a.right]) },
  "file.write": { at: "fs", cli: (a) => line("file write", [a.path], [], a.message) },
  "file.edit": { at: "fs", cli: (a) => line("file edit", [a.path], [], a.message) },
  "file.rm": { at: "fs", cli: (a) => line("file rm", [a.path], [], a.message) },
  "file.mkdir": { at: "fs", cli: (a) => line("file mkdir", [a.path], [], a.message) },
  "file.mv": { at: "fs", cli: (a) => line("file mv", [a.from, a.to], [], a.message) },
  "file.cp": { at: "fs", cli: (a) => line("file cp", [a.from, a.to], [], a.message) },
  "file.apply": { at: "fs", cli: (a) => line("file apply", [], [], a.message) },
  "sandbox.create": { at: "project", cli: (a) => { const image = a.image ?? a.deploy?.image; return line("sandbox create", [a.name, a.project, image && shortImage(image)]); } },
  "sandbox.list": { at: null },
  "sandbox.get": { at: null },
  "sandbox.close": { at: "project", cli: (a) => line("sandbox close", [a.sandbox]) },
  "workspace.mount": { at: "workspace", dim: true, cli: (a) => line("workspace mount", [a.branch]) },
  "workspace.exec": { at: "workspace", cli: (a, sh) => (sh ?? a.command) + (a.background && !/\s*&\s*$/.test(sh ?? a.command) ? " &" : "") },
  "workspace.exec_cancel": { at: "workspace", cli: (a) => line("workspace exec_cancel", [a.exec]) },
  "workspace.commit": { at: "workspace", cli: (a) => line("workspace commit", [], [["force", a.force]], a.message) },
  "workspace.unmount": { at: "workspace", cli: (a) => line("workspace unmount", [a.branch], [["discard", a.discard]]) },
  "workspace.status": { at: "workspace", dim: true, cli: () => "workspace status" },
  "machine.list": { at: "project", dim: true, cli: (a) => line("machine list", [], page(a)) },
  "machine.platforms": { at: "project", dim: true, cli: () => "machine platforms" },
  "machine.get": { at: null },
  "machine.status": { at: "project", dim: true, cli: (a) => line("machine status", [a.name]) },
  "machine.start": { at: "project", cli: (a) => line("machine start", [a.name]) },
  "machine.stop": { at: "project", cli: (a) => line("machine stop", [a.name]) },
  "machine.create": { at: "project", cli: (a) => line("machine create", [a.name, a.platform]) },
  "machine.remove": { at: "project", cli: (a) => line("machine remove", [a.name]) },
  "machine.update": { at: "project", cli: (a) => line("machine update", [a.name]) },
  "store.list": { at: "project", dim: true, cli: (a) => line("store list", [], page(a)) },
  "store.get": { at: null },
  "store.status": { at: null },
  "store.stats": { at: null },
  "store.create": { at: "project", cli: (a) => line("store create", [a.name]) },
  "store.connect": { at: "project", cli: (a) => line("store connect", [a.name]) },
"store.attach": { at: "project", cli: (a) => line("store attach", [a.name, a.machine]) },

  // logs (the 2.0 call log, #659; Windows answers Unsupported until the port)
"logs.list": { at: "project", dim: true, cli: (a) => line("logs list", [a.op], page(a)) },
"logs.reset": { at: "project", cli: () => "logs reset" },
"store.detach": { at: "project", cli: (a) => line("store detach", [a.name, a.machine]) },
  "store.push": { at: "project", cli: (a) => line("store push", [a.name]) },
  "store.pull": { at: "project", cli: (a) => line("store pull", [a.name]) },
  "store.remove": { at: "project", cli: (a) => line("store remove", [a.name]) },
  "store.disconnect": { at: "project", cli: (a) => line("store disconnect", [a.name]) },
  "backup.connect": { at: "project", cli: (a) => line("backup connect", [a.name]) },
  "backup.disconnect": { at: "project", cli: (a) => line("backup disconnect", [a.name]) },
  "backup.list": { at: "project", dim: true, cli: (a) => line("backup list", [], page(a)) },
  "backup.create": { at: "project", cli: (a) => line("backup create", [a.name]) },
  "backup.restore": { at: "project", cli: (a) => line("backup restore", [a.name]) },
};


for (const name of ["mount", "exec", "status", "commit", "unmount"]) CLI[`sandbox.${name}`] = CLI[`workspace.${name}`];
// @layerfs/backend (#428): a background process and a Workspace's status are
// drawn as before; its other calls are reads, with no line of their own
for (const name of ["store.project.get_history", "store.project.get_storage", "store.project.get_comparable", "store.project.list_overwritten",
  "store.branch.list_commit_storage", "store.fs.get_storage", "store.fs.list_revisions", "daemon.workspace.list_changes", "daemon.workspace.get_storage",
  "daemon.process.list", "daemon.sandbox.get_log"]) CLI[`backend.${name}`] = { at: null };
Object.assign(CLI, { "backend.daemon.process.start": CLI["process.start"], "backend.daemon.process.cancel": CLI["process.cancel"], "backend.daemon.workspace.status": CLI["workspace.status"] });

/** The route of `call`; a call missing from the table prints its own name, dimmed, in the project terminal. */
export const routeOf = (call) => CLI[call] ?? { at: "project", dim: true, cli: () => call };

/** The group each terminal implies, hidden from its lines. */
const IMPLIED = { fs: ["fs ", "file "], file: "file ", workspace: "workspace " };

/** The full command line of `call` with `args` (and, for a Workspace command, its shell text `sh`). */
export const commandOf = (call, args = {}, sh) => routeOf(call).cli?.(args, sh) ?? call;

/** The line `call` prints in its terminal: the command line without the group the terminal implies. */
export function cliOf(call, args = {}, sh) {
  const text = commandOf(call, args, sh), implied = IMPLIED[routeOf(call).at];
  if (!implied) return text;
  for (const prefix of [].concat(implied)) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}
