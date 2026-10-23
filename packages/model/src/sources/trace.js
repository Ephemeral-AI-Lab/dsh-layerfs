// Trace source: replays SDK trace lines (sdk/js/README.md, "Call trace") as
// agent events. A trace holds ids, never content, so ReplayEngine rebuilds
// the project from the lines alone: Branches, Commits, Layers, Sandboxes,
// Workspaces and processes, under the mirror's display ids (C1, L0, sb_01).
// Files and sizes are not in a trace; the Files pane stays empty unless the
// engine is given `files`, which reads saved ids on demand (the dsh Host's
// Files reads, view/src/filesource.js).
import { Mirror } from "../mirror.js";
import { prepare, record } from "../attribution.js";

// No tree is held: the Files pane reads through `files` instead.
const EMPTY = Object.freeze({});
/** A traced call's time: the SDK call as the calling process measured it. */
const timingOf = (line) => ({ totalMs: line.ms || 0, sdkMs: line.ms || 0, traced: true });

/** The `layerfs_trace` lines of a JSONL text; other lines are skipped. */
export function parseTrace(text) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) continue;
    try { const line = JSON.parse(raw); if (line && line.layerfs_trace === 1) out.push(line); } catch { /* not a trace line */ }
  }
  return out;
}

/** End lines in call order (start time, then id), without start lines. */
export function endLines(lines) {
  return lines.filter((l) => l.phase !== "start").sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || seqOf(x) - seqOf(y));
}
const seqOf = (line) => Number(String(line.id).split("-").pop()) || 0;

/** A read-only engine over trace lines, with the surface the views read. */
export class ReplayEngine {
  /**
   * @param {object} [o]
   * @param {string} [o.project] project name for the views
   * @param {object} [o.files] the Files pane's reads by real id (view/src/filesource.js)
   */
  constructor({ project = "project", files = null } = {}) {
    this.m = new Mirror();
    this.m.project = project;
    this.project = project;
    this.live = true;
    this.replay = true;
    this.published = false;
    this.initAlias = null;
    /** Set when the engine starts from the project's history (the chat's History):
     * a call naming a node it already holds never moves a pointer back. */
    this.seeded = false;
    this.onchange = null;
    this.files = files;
  }
  get s() { return this.m.s; }
  // a node's root is its own display id when files can be read: it changes when the head moves
  rootOf(id) { return this.files ? id : null; }

  // ------------------------------------------------------------ ids
  layer(real) {
    if (!real) return null;
    const m = this.m, s = this.s;
    if (m.toLabel.has(real)) return m.toLabel.get(real);
    // Before any publish, the first Layer a line names is main's Init Layer.
    if (this.initAlias && !this.published) {
      const label = this.initAlias; this.initAlias = null;
      m.toLabel.set(real, label); m.toReal.set(label, real);
      return label;
    }
    const id = m.label("L", real);
    if (!s.layers[id]) s.layers[id] = { id, parent: null, root: this.rootOf(id), sourceBranch: null, sourceCommit: null, slot: m.slot++ };
    if (!s.main) s.main = { head: id };
    this.ensureProject();
    return id;
  }
  commit(real) { return real ? this.m.commitLabel(real) : null; }
  sandbox(real) {
    if (!real) return null;
    const id = this.m.label("sb", real), s = this.s;
    if (!s.sandboxes[id]) { s.sandboxes[id] = { id, closed: false, workspaces: {}, wsOrder: [], processes: {}, procOrder: [] }; s.sandboxOrder.push(id); }
    return id;
  }
  ref(real) {
    if (typeof real !== "string") return real;
    return /^[0-9a-f]{64,68}$/.test(real) ? this.m.toLabel.get(real) ?? (real.startsWith("12") ? this.commit(real) : this.layer(real)) : real;
  }
  ensureProject() { this.s.project ||= { name: this.project }; }

  // ------------------------------------------------------------ state
  initialize() {
    this.ensureProject();
    if (this.s.main) return this.s.main.head;
    const id = this.m.label("L", `init:${this.project}`);
    this.s.layers[id] = { id, parent: null, root: this.rootOf(id), sourceBranch: null, sourceCommit: null, slot: this.m.slot++ };
    this.s.main = { head: id };
    this.initAlias = id;
    return id;
  }
  branch(name, fields) {
    const s = this.s;
    if (!s.branches[name]) { s.branches[name] = { name, base: null, head: null, from: null, slot: this.m.slot++ }; s.branchOrder.push(name); }
    return Object.assign(s.branches[name], fields);
  }
  /** A new Commit on `branch` (or the known one, for an UpToDate or fast-forward head). */
  addCommit(real, branch, fields) {
    const id = this.commit(real), s = this.s;
    if (!s.commits[id]) {
      const b = s.branches[branch];
      s.commits[id] = { id, parent: b ? b.head : null, root: this.rootOf(id), branch, slot: this.m.slot++, ...fields };
    }
    if (s.branches[branch]) this.advance(s.branches[branch], "head", id);
    return id;
  }
  /** Moves `holder[key]` to node `id`, unless a seeded engine already holds a later node there. */
  advance(holder, key, id) { if (this.forward(holder[key], id)) holder[key] = id; }
  forward(now, next) {
    const s = this.s, slotOf = (x) => (s.commits[x] ?? s.layers[x])?.slot;
    const a = slotOf(now), b = slotOf(next);
    return !this.seeded || a === undefined || b === undefined || b >= a;
  }
  workspace(sb, path) { const box = this.s.sandboxes[sb]; return box && box.workspaces[path]; }

  /** Applies one end line and returns the call's outcome envelope, with display ids. */
  apply(raw) {
    const line = older(raw), a = line.args || {}, s = this.s;
    if (!line.ok) {
      if (line.method === "sandbox.commit" && line.code === "Conflict") {
        const w = this.workspace(this.sandbox(a.sandbox), a.path);
        if (w) w.markers = ["(conflict)"];
      }
      return { ok: false, code: line.code || "Refused", refusal: { message: this.m.text(line.message || ""), conflicts: [] }, replay: true, timing: timingOf(line) };
    }
    const ok = (code, result) => ({ ok: true, code, result, replay: true, timing: timingOf(line) });
    switch (line.method) {
      case "project.init": {
        const head = this.initialize();
        return ok("Initialized", { kind: "Initialized", project: s.project.name, main: { headLayer: head } });
      }
      case "branch.fork": {
        const base = this.layer(line.base), head = this.commit(line.head);
        if (this.seeded && s.branches[line.branch]) return ok("Forked", { kind: "Forked", branch: line.branch, base, head });
        const from = a.from && a.from !== "main" && s.branches[a.from] ? s.branches[a.from].head || "fork:" + a.from : head || base;
        this.branch(line.branch, { base, head, from });
        return ok("Forked", { kind: "Forked", branch: line.branch, base, head });
      }
      case "branch.merge": {
        const left = s.branches[a.branch], right = s.branches[a.with];
        const label = this.m.node(line.head), known = label ? s.commits[label] : null;
        // A merge that needs no Commit (head null) leaves a fresh Branch on the merged Layer.
        if (!line.head) {
          const onto = a.with === "main" || a.branch === "main" ? (s.main && s.main.head) : (right ? right.base : null);
          this.branch(line.branch, { base: onto || (left ? left.base : null), head: null, from: "fork:" + a.branch });
          return ok("Merged", { kind: "Merged", branch: line.branch, head: null, fastForward: false });
        }
        if (!(this.seeded && s.branches[line.branch])) this.branch(line.branch, { base: left ? left.base : null, from: left ? left.head || "fork:" + a.branch : null });
        const head = known ? known.id : this.addCommit(line.head, line.branch, { parent: left ? left.head : null, mergedFrom: right ? right.head : null, message: a.message || `merge ${a.branch} ${a.with}`, via: "merge" });
        this.advance(s.branches[line.branch], "head", head);
        return ok("Merged", { kind: "Merged", branch: line.branch, head, fastForward: !!known });
      }
      case "branch.publish": {
        const commit = this.commit(line.commit), id = this.m.label("L", line.layer);
        s.layers[id] ||= { id, parent: s.main ? s.main.head : null, root: this.rootOf(id), sourceBranch: a.branch, sourceCommit: commit, slot: this.m.slot++ };
        if (!s.main || this.forward(s.main.head, id)) s.main = { head: id };
        this.published = true;
        return ok("Added", { kind: "Added", source: { branch: a.branch, commit }, publishedLayer: { id } });
      }
      case "sandbox.create": {
        const id = this.sandbox(line.sandbox);
        // a name is free again once its Sandbox closes: a new create starts a fresh entry
        if (s.sandboxes[id].closed) s.sandboxes[id] = { id, closed: false, workspaces: {}, wsOrder: [], processes: {}, procOrder: [] };
        return ok("Ready", { kind: "Ready", id });
      }
      case "sandbox.close": {
        const id = this.sandbox(a.sandbox);
        s.sandboxes[id].closed = true;
        return ok("Closed", { kind: "Closed", id });
      }
      case "sandbox.mount": {
        const id = this.sandbox(line.sandbox || a.sandbox), box = s.sandboxes[id], path = line.path;
        const baseCommit = this.commit(line.base), baseLayer = this.layer(line.baseLayer);
        if (!box.workspaces[path]) box.wsOrder.push(path);
        box.workspaces[path] = { sandbox: id, path, branch: line.branch || a.branch, baseCommit, baseLayer, mounted: true, markers: [], dirty: 0, slot: this.m.slot++ };
        return ok("Mounted", { kind: "Mounted", sandbox: id, path, branch: line.branch || a.branch, base: baseCommit || baseLayer });
      }
      case "sandbox.unmount": {
        const w = this.workspace(this.sandbox(a.sandbox), a.path);
        if (w) w.mounted = false;
        return ok("Unmounted", { kind: "Unmounted" });
      }
      case "sandbox.commit": {
        const w = this.workspace(this.sandbox(a.sandbox), a.path);
        if (line.kind !== "Committed" || !w) return ok(line.kind || "UpToDate", { kind: line.kind, head: this.commit(line.commit) });
        const head = this.addCommit(line.commit, w.branch, { message: a.message || "", via: "commit" });
        Object.assign(w, { baseCommit: head, markers: [] });
        return ok("Committed", { kind: "Committed", head });
      }
      case "sandbox.exec":
        return ok(line.kind || "ok", { exitCode: line.exitCode ?? 0 });
      case "operator.process.start": {
        const box = s.sandboxes[this.sandbox(a.sandbox)];
        box.processes[line.process] = { id: line.process, path: a.path, command: a.command, status: "running" };
        box.procOrder.push(line.process);
        return ok("running", { process: line.process });
      }
      case "operator.process.cancel": {
        const box = s.sandboxes[this.sandbox(processSandbox(a))], p = box.processes[a.process];
        if (p) p.status = "stopped";
        return ok("Stopped", { kind: "Stopped", process: a.process, status: "stopped" });
      }
    }
    if (/^fs\.(write|edit|apply|mkdir|rm|cp|mv)$/.test(line.method) && line.commit) {
      if (line.kind === "UpToDate") return ok("UpToDate", { kind: "UpToDate", head: this.commit(line.commit) });
      const head = this.addCommit(line.commit, a.branch, { message: a.message || line.method.slice(3), via: "fs" });
      return ok("Committed", { kind: "Committed", head });
    }
    return ok(line.kind || "ok", {});
  }

  // ------------------------------------------------------------ the views' engine surface
  markersIn(ws) { return ws.markers || []; }
  dirtyOf(ws) { return ws.dirty || 0; }
  storage() { return null; }
  overlayOf() { return null; }
  storedSize() { return null; }
  fileReport() { return { rows: [], revisions: null, logical: null, unique: null, stored: null, metadata: null, pending: false, replay: true }; }
  async poll() { return false; }
  liveMountsOf(branch) {
    const s = this.s, out = [];
    for (const id of s.sandboxOrder) {
      const sb = s.sandboxes[id];
      if (sb.closed) continue;
      for (const p of sb.wsOrder) if (sb.workspaces[p].mounted && sb.workspaces[p].branch === branch) out.push(`${id}:${p}`);
    }
    return out;
  }
  resolve(ref) {
    const s = this.s, refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
    if (ref === "main") { const l = s.layers[s.main.head]; return { label: `main @ ${l.id}`, kind: "main", root: l.root, tree: EMPTY, layer: l.id }; }
    if (s.commits[ref]) return { label: ref, kind: "commit", root: s.commits[ref].root, tree: EMPTY, commit: ref };
    if (s.layers[ref]) return { label: ref, kind: "layer", root: s.layers[ref].root, tree: EMPTY, layer: ref };
    if (ref.includes(":/")) return { label: `${ref} (live)`, kind: "live", root: null, tree: EMPTY, workspace: ref };
    const b = s.branches[ref] || refuse("NoSuchBranch", `no Branch named ${ref}`);
    const node = b.head || b.base;
    return { label: `${b.name} @ ${node}`, kind: "branch", root: this.rootOf(node), tree: EMPTY, head: b.head };
  }
}

/**
 * A line of the Workspace API (#373) under the older SDK's call names, which
 * the model draws: `workspace.mount` is `sandbox.mount` and so on. Lines name
 * the Workspace's Sandbox as before (the mount's result, the others' args).
 */
const WORKSPACE = new Set(["workspace.mount", "workspace.exec", "workspace.status", "workspace.commit", "workspace.unmount"]);
const older = (line) => (WORKSPACE.has(line.method) ? { ...line, method: `sandbox.${line.method.slice("workspace.".length)}` } : line);
/** The Sandbox of a process call: its args', or the one its id names (`proc_<sandbox>_<hex>`). */
const processSandbox = (a) => a.sandbox ?? /^proc_(\d+)_/.exec(String(a.process))?.[1];

/** Calls that only the client makes for itself, or reads with no line of their own. */
const SKIP = (method) => method === "sandbox.service" || (method.startsWith("operator.") && method !== "operator.process.start" && method !== "operator.process.cancel");

/** The agent step a trace line stands for, in the story's call names, with
 * its Workspace bound by the ids on the line; null for a line not drawn. */
export function stepOf(E, raw, agent) {
  const line = older(raw);
  if (SKIP(line.method)) return null;
  const a = line.args || {}, base = { a: line.agent || agent, group: line.step || null };
  const bind = (path) => ({ sandbox: E.m.toLabel.get(a.sandbox) ?? E.sandbox(a.sandbox), path });
  switch (line.method) {
    case "project.init": return { ...base, call: "project.init", args: { name: E.project, path: a.path } };
    case "branch.fork": return a.from && a.from !== "main" ? { ...base, call: "branch.fork", args: { name: a.name, branch: E.ref(a.from) } } : { ...base, call: "main.fork", args: { name: a.name } };
    case "sandbox.create": return { ...base, call: "sandbox.create", args: { name: a.name, project: E.project, image: a.image } };
    case "sandbox.mount": return { ...base, call: "sandbox.mount", args: { branch: a.branch, sandbox: E.sandbox(a.sandbox ?? line.sandbox) } };
    case "sandbox.close": return { ...base, call: "sandbox.close", args: { sandbox: E.sandbox(a.sandbox) } };
    case "sandbox.exec": return { ...base, sh: a.command, args: {}, bind: bind(a.path) };
    case "operator.process.start": return { ...base, sh: a.command, args: { background: true }, bind: bind(a.path) };
    case "operator.process.cancel": {
      const id = E.sandbox(processSandbox(a)), p = E.s.sandboxes[id].processes[a.process];
      return { ...base, call: "process.cancel", args: { process: a.process }, bind: { sandbox: id, path: p ? p.path : a.path } };
    }
    case "sandbox.commit": case "sandbox.unmount": case "sandbox.status":
      return { ...base, call: line.method, args: { message: a.message, force: a.force, discard: a.discard }, bind: bind(a.path) };
  }
  const args = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "ref" || k === "from" || k === "to" || k === "commit" ? E.ref(v) : v]));
  return { ...base, call: line.method, args };
}

/** Replays one end line into view `W` (whose engine is a ReplayEngine):
 * the engine state first, then the agent's terminal line and place. */
export function replayLine(W, line, { agent = W.lead, t0 = null } = {}) {
  const E = W.engine;
  // whole seconds since the first call, like the story clock
  if (t0 !== null) W.clock = Math.max(W.clock, Math.round((Date.parse(line.start) - t0 + (line.ms || 0)) / 1000));
  const st = stepOf(E, line, agent);
  const p = st && prepare(W, st);
  const o = E.apply(line);
  // the SDK's own Sandbox for an agent's fs and branch calls is not a step;
  // it is drawn, as that agent's, once a call names it (closing it, say)
  const services = (W.services ||= {}), real = line.args && line.args.sandbox;
  if (line.method === "sandbox.service" && line.ok && line.sandbox) services[line.sandbox] = line.agent || agent;
  if (real && services[real] && E.m.toLabel.has(real)) W.sbBy[E.m.toLabel.get(real)] ||= { made: services[real], service: true };
  if (!st) return null;
  record(W, st, p, o, null, [{ call: p.call, code: o.code, timing: timingOf(line) }]);
  return o;
}

/** Story steps for trace lines: one step per drawn end line. */
export function traceSteps(lines, { agent = "main", label = (line) => `${line.method}${line.step ? " · " + line.step : ""}` } = {}) {
  const ends = endLines(lines), t0 = ends.length ? Date.parse(ends[0].start) : 0, steps = [];
  let pending = [];
  for (const line of ends) {
    pending.push(line);
    if (SKIP(line.method)) continue;
    const batch = pending; pending = [];
    steps.push({ a: line.agent || agent, label: label(line), line, replay: (W) => { for (const l of batch) replayLine(W, l, { agent, t0 }); } });
  }
  return steps;
}
