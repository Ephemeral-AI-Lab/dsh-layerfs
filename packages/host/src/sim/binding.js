// A LayerFS native binding over the simulator (state.js), for projects Inited
// as simulated. @layerfs/agent loads it as LAYERFS_NATIVE (sdk.js), so their
// bash calls keep the agent's and backend's argument checks, refusals and
// trace lines. It answers the binding's two tables (#428): `call` (the
// agent's methods) and `backendCall` (@layerfs/backend's, and the two
// runtime reads an agent client may make). Answers are
// the real binding's (`{ value }` or `{ refused }`, in the shapes it gives),
// ids in LayerFS's formats; the decisions are the model's. Store sizes are
// estimates from file text. One attempt per call; nothing is retried.
// Sandboxes are numbered and placed as the real binding places them (#373);
// a simulated Sandbox does not close when idle.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Project, Refusal, fileViews, model, readTree, simDir } from "./state.js";
import { runCommand, startCommand, stopCommand } from "./shell.js";

const DEFAULT_MESSAGE = "Apply filesystem changes";
const VIA = { fs: "fs", workspace: "exec", merge: "merge" };
/** Workspaces one Sandbox holds, as the real binding's. */
const WORKSPACES = 16;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const size = (text) => Buffer.byteLength(text ?? "");
const bytes = (tree) => Object.values(tree).reduce((n, e) => n + (e.type === "file" ? size(e.content) : 0), 0);
const inode = (id) => Number(String(id).replace(/^i/, ""));
const refusal = (code, message, detail = null) => ({ refused: { code, message, detail } });

function paged(items, { pageSize = 50, pagePos = 0 }) {
  const more = pagePos + pageSize < items.length;
  return { items: items.slice(pagePos, pagePos + pageSize), hasMore: more, nextPagePos: more ? pagePos + pageSize : null };
}

// ---------------------------------------------------------------- records

/** LayerFS's size counters of a node's tree over its parent's, from file text. */
function sizes(c, root, parentRoot) {
  const tree = c.s.roots[root], parent = parentRoot ? c.s.roots[parentRoot] : {};
  const known = new Set(Object.values(parent).map((e) => e.content));
  const fresh = Object.values(tree).filter((e) => e.type === "file" && !known.has(e.content)).reduce((n, e) => n + size(e.content), 0);
  return { logical: bytes(tree), newCanonical: fresh, newStored: fresh, newMetadata: 64 * model.diffTrees(parent, tree).length };
}

function commitRecord(c, label) {
  const m = c.s.commits[label];
  return {
    id: c.hex(label), branch: m.branch ?? null, parent: c.hex(m.parent ?? null), secondParent: m.by === "merge" ? c.hex(m.mergedFrom ?? null) : null,
    base: c.hex(m.base), root: c.hex(m.root), via: VIA[m.by] ?? m.by, message: m.message ?? DEFAULT_MESSAGE,
    mergedFrom: m.merged ? c.hex(m.merged.from) : null, time: c.at[label],
    ...sizes(c, m.root, m.parent ? c.s.commits[m.parent].root : c.s.layers[m.base].root),
    displaced: c.hex(m.displaced ?? null), lww: c.ids(m.lww ?? m.merged?.lww ?? []), lwwTruncated: false,
  };
}

function layerRecord(c, label) {
  const l = c.s.layers[label];
  return {
    overwrote: (l.overwrote ?? []).map((x) => c.hex(x)), overwroteTruncated: false, logical: bytes(c.s.roots[l.root]),
    id: c.hex(label), parent: c.hex(l.parent), root: c.hex(l.root), sourceBranch: l.sourceBranch, sourceCommit: c.hex(l.sourceCommit),
  };
}

const commitOf = (label) => (typeof label === "string" && label.startsWith("C") ? label : null);
const overlay = (c, ws) => { const n = model.diffTrees(c.s.roots[ws.baseRoot], ws.live).length; return { inodes: n, entries: n, pendingMerge: false }; };
const moved = (c, ws) => (c.s.branches[ws.branch].head ?? null) !== (ws.baseCommit ?? null);

function workspaceView(c, ws) {
  const { inodes, entries } = overlay(c, ws);
  return {
    directory: ws.path, mounted: ws.mounted, branch: ws.branch, base: c.hex(ws.baseCommit ?? null), baseLayer: c.hex(ws.baseLayer),
    root: c.hex(ws.baseRoot), dirty: { inodes, entries }, pendingMerge: false, headMovedSinceMount: moved(c, ws), activity: "idle",
  };
}

/** The `snapshot` a read names: main@<layer>, <branch>@<head>, or a saved id. */
function seen(c, ref) {
  const v = c.sim.resolve(ref), short = (label) => c.hex(label).slice(2, 14);
  if (v.kind === "main") return `main@${short(v.layer)}`;
  if (v.kind === "branch") { const b = c.s.branches[ref]; return `${ref}@${short(b.head ?? b.base)}`; }
  return short(v.commit ?? v.layer);
}

function branchList(c) {
  const id = (name) => `11${sha(`${c.project.name}/branch/${name}`).slice(0, 32)}`;
  const others = c.s.branchOrder.map((name) => {
    const b = c.s.branches[name];
    return { name, id: id(name), base: c.hex(b.base), head: c.hex(b.head ?? null), forkedFrom: c.hex(b.from ?? null) };
  });
  return [{ name: "main", id: id("main"), base: c.hex(c.s.main.head), head: null, forkedFrom: null }, ...others];
}

function storeStats(c) {
  const contents = new Map();
  let entries = 0;
  for (const tree of Object.values(c.s.roots)) for (const e of Object.values(tree)) { entries++; if (e.type === "file") contents.set(e.content, size(e.content)); }
  const canonical = [...contents.values()].reduce((a, b) => a + b, 0);
  const logical = [...Object.values(c.s.commits), ...Object.values(c.s.layers)].reduce((n, x) => n + bytes(c.s.roots[x.root]), 0);
  return { logical, canonical, stored: canonical, metadata: 64 * entries, file: canonical + 64 * entries, free: 0, dedupe: (logical ? canonical / logical : 0).toFixed(6), compression: "1.000000", init: c.init };
}

/** The project's history (backend.store.project.get_history) and one Sandbox's Workspaces. */
function snapshot(c, sandbox) {
  const commits = Object.keys(c.s.commits).sort((a, b) => c.at[b] - c.at[a]).map((label) => commitRecord(c, label));
  const layers = [];
  for (let id = c.s.main.head; id; id = c.s.layers[id].parent) layers.push(layerRecord(c, id));
  const sb = c.s.sandboxes[sandbox];
  return {
    kind: "ok", version: sha(JSON.stringify(c.s)).slice(0, 16), store: { stats: storeStats(c) }, project: c.project.name,
    branches: branchList(c).map(({ id, ...b }) => b), moreBranches: false, commits, more: {}, layers, moreLayers: false,
    workspaces: sb && !sb.closed ? sb.wsOrder.map((path) => sb.workspaces[path]).filter((ws) => ws.mounted).map((ws) => workspaceView(c, ws)) : [],
  };
}

// ---------------------------------------------------------------- refusal details

const withHunks = (x) => ({ blocks: 0, hunksOmitted: false, hunks: [], ...x });
const commitConflict = (d) => d.conflicts ? {
  head: d.head, base: commitOf(d.base), markers: !!d.markers, conflicts: d.conflicts.map(withHunks), lww: d.lww ?? [],
  conflictsTruncated: false, lwwTruncated: false, written: d.written ?? [], truncated: false,
} : d;
const mergeConflict = (d) => d.conflicts ? { ...d, conflicts: d.conflicts.map(withHunks), conflictsTruncated: false, lwwTruncated: false } : d;

// The real binding's messages for the refusals the demos print.
const files = (n) => `${n} file(s)`;
const WORDS = {
  "sandbox.commit": (code, d) => code !== "Conflict" ? null : d.markers ? `${files(d.conflicts.length)} still contain conflict markers; nothing committed`
    : `the head moved and ${files(d.conflicts.length)} conflict with this Workspace; markers are written and nothing was committed`,
  "sandbox.unmount": (code, d) => (code === "Dirty" ? `${d.changed.length} uncommitted change(s); unmount with discard to drop them` : null),
  "branch.merge": (code, d, a) => (code === "Conflict" ? `${a.branch} + ${a.with} conflict in ${files(d.conflicts.length)}; nothing was created` : null),
};
const words = (op, a) => (code, d) => WORDS[op](code, d, a);

/** Conflict markers name the head as `<branch>@<Commit id>`, not the model's label. */
function markerIds(c, ws) {
  for (const entry of Object.values(ws.live)) {
    if (entry.type === "file" && entry.content?.includes("@")) entry.content = entry.content.replace(/^(<<<<<<< |>>>>>>> )(.*@)([CL]\d+)$/gm, (_, mark, side, label) => `${mark}${side}${c.hex(label)}`);
  }
}

// ---------------------------------------------------------------- operations

/** The project's open numbered Sandboxes, lowest first. */
const numbered = (c) => c.s.sandboxOrder.filter((id) => /^\d+$/.test(id) && !c.s.sandboxes[id].closed).sort((x, y) => x - y);
const nameOf = (c, id) => `layerfs-${c.project.name}-${id}`;

/** The Sandbox for a new Workspace: the lowest-numbered open one of `image` (a state saved before images matches any) with a free slot, else the next number, started on it. */
function place(c, image) {
  const free = numbered(c).find((id) => (c.s.sandboxes[id].image ?? image) === image && Object.values(c.s.sandboxes[id].workspaces).filter((w) => w.mounted).length < WORKSPACES);
  if (free) return free;
  let n = 1;
  while (c.s.sandboxes[n] && !c.s.sandboxes[n].closed) n++;
  const id = String(n);
  c.s.sandboxes[id] = { id, image, closed: false, nextWs: 1, workspaces: {}, wsOrder: [], processes: {}, procOrder: [] };
  if (!c.s.sandboxOrder.includes(id)) c.s.sandboxOrder.push(id);
  return id;
}
/** The Sandbox a process id names (`proc_<sandbox>_<hex>`). */
const sandboxOfProcess = (id) => /^proc_(\d+)_/.exec(String(id))?.[1] ?? null;

function changed(c, r) {
  if (r.kind !== "Committed") return { kind: r.kind, branch: r.branch, head: c.hex(r.head ?? null) };
  return { kind: "Committed", branch: r.branch, head: c.hex(r.head), commit: commitRecord(c, r.head) };
}

/** An fs write on a Branch: one Commit, or UpToDate. */
const mutate = (op, args) => (p, a) => p.with((c) => {
  if (a.branch === "main") throw new Refusal("ReadOnly", "main changes only through publish", { branch: "main" });
  return changed(c, c.run(op, { ...a, ...args(a) }));
});

function initProject(p, a) {
  if (typeof a.path !== "string" || !existsSync(a.path) || !statSync(a.path).isDirectory()) throw new Refusal("NoSuchPath", `${a.path} is not a directory`, { path: a.path });
  const started = Date.now(), files = {};
  let entries = 1, count = 0, total = 0;
  for (const [path, e] of Object.entries(readTree(a.path))) {
    entries++;
    if (e.type === "dir") files[path] = null;
    else { files[path] = e.content; count++; total += size(e.content); }
  }
  return p.with((c) => {
    const r = c.run("project.init", { name: p.name, files });
    c.init = { entries, files: count, bytes: total, canonical: total, stored: total, metadata: 64 * entries, millis: Date.now() - started };
    return { kind: "Initialized", project: p.name, layer: c.hex(r.main.headLayer), root: c.hex(r.main.root), store: p.file };
  }, { sim: new model.Sim().s, at: {}, init: null });
}

async function exec(p, a) {
  const dir = await p.with((c) => { c.sim.workspace(a.sandbox, a.path); return p.wsDir(a.sandbox, a.path); });
  const r = await runCommand(dir, a.command);
  await p.with(() => {}); // reads the Workspace's files back into the model
  return { kind: `exit:${r.exitCode}`, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, message: null, truncated: r.truncated };
}

function read(c, a) {
  const ref = c.label(a.branch), r = c.run("fs.read", { ref, path: a.path });
  const ends = r.text.endsWith("\n"), lines = r.text === "" ? [] : (ends ? r.text.slice(0, -1) : r.text).split("\n");
  const start = a.startLine ?? 1, end = Math.min(a.endLine ?? lines.length, lines.length);
  const text = lines.slice(start - 1, end).join("\n") + (end > start - 1 && (end < lines.length || ends) ? "\n" : "");
  return {
    kind: "ok", snapshot: seen(c, ref), root: c.hex(r.root), path: a.path, text, startLine: start, endLine: end,
    lineTruncated: false, truncated: false, nextLine: end < lines.length ? end + 1 : null, size: size(r.text),
  };
}

const change = (d) => ({ path: d.path, kind: d.kind, type: d.type, contentChanged: d.content ?? d.kind !== "Modified", identityChanged: d.identity ?? false });

/** One open Sandbox of the project, else NoSuchSandbox (a closed one is not running). */
function openSandbox(c, id) {
  const sb = /^\d+$/.test(String(id)) && c.s.sandboxes[id];
  if (!sb || sb.closed) throw new Refusal("NoSuchSandbox", `the project has no running Sandbox ${id}`, { sandbox: id });
  return sb;
}

const CALLS = {
  "project.init": initProject,
  "project.list_branches": (p, a) => p.with((c) => paged(branchList(c).sort((x, y) => x.name.localeCompare(y.name)), a)),
  "project.list_sandboxes": (p) => p.with((c) => ({
    kind: "ok",
    items: numbered(c).map((id) => ({ sandbox: id, name: nameOf(c, id), image: c.s.sandboxes[id].image ?? null, workspaces: Object.values(c.s.sandboxes[id].workspaces).filter((w) => w.mounted).length })),
  })),
  "sandbox.list_workspaces": (p, a) => p.with((c) => {
    const sb = openSandbox(c, a.sandbox);
    return {
      kind: "ok", version: sha(JSON.stringify(sb)).slice(0, 16),
      workspaces: sb.wsOrder.map((path) => sb.workspaces[path]).filter((ws) => ws.mounted).map((ws) => ({ ...workspaceView(c, ws), workspace: sha(`${p.name}/${a.sandbox}/${ws.path}/${ws.slot}`) })),
    };
  }),

  "workspace.mount": (p, a) => p.with((c) => {
    const sandbox = place(c, a.deploy?.image ?? null), r = c.run("sandbox.mount", { sandbox, branch: a.branch }), ws = c.s.sandboxes[sandbox].workspaces[r.path];
    return {
      kind: "Mounted", path: r.path, workspace: sha(`${p.name}/${sandbox}/${r.path}/${ws.slot}`), namespace: Number(r.path.slice(r.path.lastIndexOf("/") + 1)),
      branch: r.branch, base: c.hex(ws.baseCommit ?? null), baseLayer: c.hex(ws.baseLayer), root: c.hex(ws.baseRoot), sandbox, container: nameOf(c, sandbox), image: c.s.sandboxes[sandbox].image ?? null,
    };
  }),
  "workspace.exec": exec,
  "workspace.commit": (p, a) => p.with((c) => {
    const ws = c.sim.workspace(a.sandbox, a.path);
    let r;
    try { r = c.run("sandbox.commit", { sandbox: a.sandbox, path: a.path, message: a.message, force: !!a.force }, commitConflict, words("sandbox.commit", a)); }
    finally { markerIds(c, ws); }
    const merged = r.merged ? { from: c.hex(commitOf(r.merged.from)), head: c.hex(r.merged.head) } : null;
    const lww = c.ids(r.merged?.lww ?? []);
    if (r.kind !== "Committed") return { kind: r.kind, head: c.hex(r.head ?? null), commit: null, displacedHead: null, merged, lww, lwwTruncated: false };
    if (r.displacedHead) c.s.commits[r.head].displaced = r.displacedHead;
    return { kind: "Committed", head: c.hex(r.head), commit: commitRecord(c, r.head), displacedHead: c.hex(r.displacedHead), merged, lww, lwwTruncated: false };
  }),
  "workspace.unmount": (p, a) => p.with((c) => {
    c.run("sandbox.unmount", { sandbox: a.sandbox, path: a.path, discard: !!a.discard }, (d) => (d.changed ? { changed: d.changed, pendingMerge: false, truncated: false } : d), words("sandbox.unmount", a));
    return { kind: "Unmounted" };
  }),

  "branch.fork": (p, a) => p.with((c) => {
    const from = c.label(a.from ?? "main");
    let r;
    if (from === "main") r = c.run("main.fork", { name: a.name });
    else if (c.s.commits[from]) r = c.run("branch.fork", { branch: c.s.commits[from].branch, name: a.name, fromCommit: from });
    else if (c.s.layers[from]) throw new Refusal("InvalidInput", "a Branch forks from main, a Branch or a Commit", { from: a.from });
    else r = c.run("branch.fork", { branch: from, name: a.name });
    return { kind: "Forked", branch: r.branch, base: c.hex(r.base), head: c.hex(r.head ?? null) };
  }),
  "branch.list_commits": (p, a) => p.with((c) => paged(c.run("branch.list_commits", { branch: a.branch }).items.map((x) => commitRecord(c, x.id)), a)),
  "branch.diff_commits": (p, a) => p.with((c) => {
    const r = c.run("branch.diff_commits", { from: c.label(a.from), to: c.label(a.to) });
    return { kind: "ok", from: c.ids(r.from), to: c.ids(r.to), ...paged(r.items.map(change), a) };
  }),
  "branch.diff_branches": (p, a) => p.with((c) => {
    const r = c.run("branch.diff_branches", { from: a.from, to: a.to });
    return { kind: "ok", from: c.ids(r.from), to: c.ids(r.to), ...paged(r.items.map(change), a) };
  }),
  "branch.merge": (p, a) => p.with((c) => {
    const r = c.run("branch.merge", { branch: c.label(a.branch), with: c.label(a.with), name: a.name, message: a.message }, mergeConflict, words("branch.merge", a));
    return {
      kind: "Merged", fastForward: !!r.fastForward, branch: r.branch, head: c.hex(r.head), root: c.hex(r.root), sources: c.ids(r.sources),
      mergeBase: c.hex(r.mergeBase), conflicts: [], lww: c.ids(r.lww ?? []), conflictsTruncated: false, lwwTruncated: false,
    };
  }),
  "branch.publish": (p, a) => p.with((c) => {
    const r = c.run("branch.publish", { branch: a.branch, commit: c.label(a.commit) });
    if (r.kind === "UpToDate") return { kind: "UpToDate", layer: c.hex(r.layer) };
    if (r.kind !== "Added") return { kind: r.kind, layer: c.hex(r.main.headLayer) };
    const layer = c.s.layers[r.publishedLayer.id];
    layer.overwrote = r.overwrote ? [r.overwrote] : [];
    return {
      kind: "Added", source: { branch: r.source.branch, commit: c.hex(r.source.commit) }, publishedLayer: layerRecord(c, layer.id),
      basedOn: c.hex(r.basedOn), overwrote: layer.overwrote.map((x) => c.hex(x)),
    };
  }),

  "fs.read": (p, a) => p.with((c) => read(c, a)),
  "fs.blame": (p, a) => p.with((c) => {
    const ref = c.label(a.branch);
    c.run("fs.read", { ref, path: a.path });
    const b = fileViews.blame(c.sim, ref, a.path), from = a.fromLine ?? 1;
    const lines = b.lines.slice(from - 1).map((l) => ({ n: l.n, text: l.text, lineTruncated: false, clipped: false, commit: c.hex(l.origin?.id ?? null), message: c.s.commits[l.origin?.id]?.message ?? "" }));
    return { kind: "ok", snapshot: seen(c, ref), path: a.path, lines, origins: [], versions: b.versions, comparisonCoarse: false, nextLine: null };
  }),
  "fs.list": (p, a) => p.with((c) => {
    const ref = c.label(a.branch), r = c.run("fs.list", { ref, path: a.path });
    return { kind: "ok", snapshot: seen(c, ref), root: c.hex(r.root), path: a.path ?? "/", ...paged(r.items.map((x) => ({ ...x, inode: inode(x.inode) })), a) };
  }),
  "fs.stat": (p, a) => p.with((c) => {
    const ref = c.label(a.branch), r = c.run("fs.stat", { ref, path: a.path });
    return { kind: "ok", snapshot: seen(c, ref), path: r.path, type: r.type, inode: inode(r.inode), size: r.size };
  }),
  "fs.grep": (p, a) => p.with((c) => {
    const ref = c.label(a.branch), r = c.run("fs.grep", { ref, pattern: a.pattern, path: a.path });
    return { kind: "ok", snapshot: seen(c, ref), root: c.hex(r.root), ...paged(r.items, a) };
  }),
  "fs.diff_files": (p, a) => p.with((c) => {
    const side = (s) => ({ commit: c.label(s.commit), path: s.path });
    return c.ids(c.run("fs.diff_files", { ref: c.label(a.branch), left: side(a.left), right: side(a.right) }));
  }),
  "fs.write": mutate("fs.write", (a) => ({ content: a.content ?? Buffer.from(a.bytes ?? []).toString("utf8") })),
  "fs.edit": mutate("fs.edit", () => ({})),
  "fs.mkdir": mutate("fs.mkdir", () => ({ recursive: true })),
  "fs.rm": mutate("fs.rm", () => ({ recursive: true })),
  "fs.cp": mutate("fs.cp", () => ({ recursive: true })),
  "fs.mv": mutate("fs.mv", () => ({})),
  "fs.apply": mutate("fs.apply", (a) => ({
    changes: (a.changes ?? []).map(({ op, ...rest }) => ({ kind: op === "rm" ? "remove" : op, ...(["mkdir", "rm", "cp"].includes(op) ? { recursive: true } : {}), ...rest })),
  })),
};

/** @layerfs/backend's calls, and the runtime reads an agent client may make.
 * Store ratios are decimal strings, as the real binding answers them. */
const BACKEND = {
  "backend.store.project.get_history": (p, a) => p.with((c) => {
    const { workspaces, ...history } = snapshot(c, null);
    return a.since === history.version ? { kind: "unchanged", version: history.version } : history;
  }),
  "backend.store.project.get_storage": (p) => p.with((c) => storeStats(c)),
  "backend.daemon.workspace.get_storage": (p, a) => p.with((c) => overlay(c, c.sim.workspace(a.sandbox, a.path))),
  "backend.daemon.workspace.status": (p, a) => p.with((c) => {
    const ws = c.sim.workspace(a.sandbox, a.path), sb = c.s.sandboxes[a.sandbox];
    const running = Object.values(sb.processes).some((x) => x.status === "running" && x.path === a.path);
    return {
      kind: "ok", base: c.hex(ws.baseCommit ?? null), baseLayer: c.hex(ws.baseLayer), branchHead: c.hex(c.s.branches[ws.branch].head ?? null),
      headMovedSinceMount: moved(c, ws), activity: running ? "Running" : "Idle", overlay: overlay(c, ws), branch: ws.branch,
    };
  }),
  "backend.daemon.process.start": (p, a) => p.with((c) => {
    c.sim.workspace(a.sandbox, a.path);
    const id = `proc_${a.sandbox}_${randomBytes(12).toString("hex")}`, sb = c.s.sandboxes[a.sandbox];
    const pid = startCommand(p.wsDir(a.sandbox, a.path), a.command, p.procFile(id, "log"), p.procFile(id, "code"));
    sb.processes[id] = { id, path: a.path, command: a.command, status: "running", pid };
    sb.procOrder.push(id);
    return { kind: "running", process: id, command: a.command };
  }),
  "backend.daemon.process.list": (p) => p.with((c) => ({
    kind: "ok",
    items: numbered(c).flatMap((sandbox) => { const sb = c.s.sandboxes[sandbox]; return sb.procOrder.map((id) => { const x = sb.processes[id]; return { id, sandbox, path: x.path, command: x.command, status: x.status }; }); }),
  })),
  "backend.daemon.process.cancel": (p, a) => p.with((c) => {
    const sandbox = sandboxOfProcess(a.process);
    if (!sandbox || !c.s.sandboxes[sandbox]) throw new Refusal("NoSuchProcess", `${a.process} is not a process id`, { process: a.process });
    const proc = c.sandbox(sandbox).processes[a.process];
    if (proc?.status === "running") stopCommand(proc.pid);
    const r = c.run("process.cancel", { sandbox, process: a.process });
    return { kind: "Stopped", process: r.process, status: r.status };
  }),
  // Init runs at once here, so it has no counts to read; a simulated Sandbox never closes, so none is reclaimed
  "runtime.project.get_init": async () => null,
  "runtime.sandbox.reclaim": async () => ({ reclaimed: [] }),
};

async function answer(table, op, args = {}) {
  const handler = table[op];
  if (!handler) return refusal("UnknownMethod", `${op} is not simulated`);
  const home = args.home || process.env.LAYERFS_HOME || process.env.DSH_LAYERFS_HOME;
  if (!home || typeof args.project !== "string") return refusal("InvalidInput", "a project and a LayerFS home are required");
  try {
    return { value: await handler(new Project(home, args.project), args) };
  } catch (error) {
    if (error instanceof Refusal) return refusal(error.code, error.message, error.detail);
    throw error;
  }
}

/** The binding's entry points, as @layerfs/agent's transport calls them. The
 * simulator keeps its Store in its own records, so opening and releasing a
 * client's Store (#352 F-020) only checks the project and home. */
export const call = (op, args) => answer(CALLS, op, args);
export const backendCall = (op, args) => answer(BACKEND, op, args);
const STORE = { open: async () => null, close: async () => null };
export const storeOpen = (args) => answer(STORE, "open", args);
export const storeClose = (args) => answer(STORE, "close", args);

/** The project's state over every open Sandbox, as runtime.project.get_state answers it, for the Host's views. */
export function snapshotAll(home, name) {
  return new Project(home, name).with((c) => {
    const ids = c.s.sandboxOrder.filter((id) => !c.s.sandboxes[id].closed);
    const { workspaces, ...history } = snapshot(c, null);
    return {
      ...history,
      sandboxes: ids.map((id) => ({ id, name: nameOf(c, id), image: c.s.sandboxes[id].image ?? null, status: "Ready", workspaces: snapshot(c, id).workspaces.map((w) => ({ ...w, sandbox: id, path: w.directory, overlay: overlay(c, c.s.sandboxes[id].workspaces[w.directory]) })) })),
      gone: [],
    };
  });
}

/** Stops every background process of a simulated project (before its removal). */
export function stopProcesses(home, name) {
  const file = `${simDir(home, name)}/state.json`;
  if (!existsSync(file)) return 0;
  let stopped = 0;
  for (const sb of Object.values(JSON.parse(readFileSync(file, "utf8")).sim.sandboxes)) {
    for (const proc of Object.values(sb.processes)) if (proc.status === "running") { stopCommand(proc.pid); stopped++; }
  }
  return stopped;
}
