// A simulated LayerFS project: dsh/sim's model (model.js `Sim`) kept in
// <home>/<project>/sim/state.json and changed by one call at a time under a
// lock file. A mounted Workspace's files are a real folder,
// <home>/<project>/sim/ws/<sandbox>/<n>, where its commands run: each call
// first reads the open Workspaces' folders into the model, and afterwards
// writes back the Workspaces it changed (a mount, a conflict's merge) and
// removes the folders of unmounted ones. Ids leave in LayerFS's formats.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { alive } from "./shell.js";

export const model = createRequire(import.meta.url)("../../../../sim/simulation_engine/model.js");
/** The simulator's read-side helpers (blame over saved versions). */
export const fileViews = createRequire(import.meta.url)("../../../../sim/simulation_engine/files.js");
export const { Refusal } = model;

const LOCK_MS = 30_000;
const STALE_LOCK_MS = 120_000;
const sha = (text) => createHash("sha256").update(text).digest("hex");

export const simDir = (home, project) => join(home, project, "sim");
/** Whether `project` under `home` is simulated: its state file exists. */
export const isSimulated = (home, project) => existsSync(join(simDir(home, project), "state.json"));

/** Files under `dir` as the model's tree, without inodes: `{ "/a/b": { type, content? } }`.
 * A process may still be writing there (a background dev server), so an
 * entry removed or renamed between the listing and its read is not there. */
export function readTree(dir, base = "", tree = {}) {
  let names;
  try { names = readdirSync(dir).sort(); } catch (error) { if (error.code === "ENOENT" && base) return tree; throw error; }
  for (const name of names) {
    const file = join(dir, name), path = `${base}/${name}`;
    try {
      const stat = lstatSync(file);
      if (stat.isDirectory()) { tree[path] = { type: "dir" }; readTree(file, path, tree); }
      else if (stat.isSymbolicLink()) tree[path] = { type: "file", content: `→ ${readlinkSync(file)}` };
      else if (stat.isFile()) tree[path] = { type: "file", content: readFileSync(file, "utf8") };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return tree;
}

/** Makes `dir` hold exactly `tree`, changing only what differs. */
function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true });
  const current = readTree(dir);
  for (const path of Object.keys(current).sort().reverse()) {
    if (!tree[path] || tree[path].type !== current[path].type) rmSync(join(dir, path), { recursive: true, force: true });
  }
  for (const path of Object.keys(tree).sort()) {
    const entry = tree[path], file = join(dir, path);
    if (entry.type === "dir") mkdirSync(file, { recursive: true });
    else if (current[path]?.content !== entry.content || current[path]?.type !== "file") writeFileSync(file, entry.content ?? "");
  }
}

/** One call's view of a project: the model, its ids and the Host-side extras. */
export class Call {
  constructor(project, state) {
    this.project = project;
    this.sim = new model.Sim();
    this.sim.s = state.sim;
    this.s = this.sim.s;
    /** label -> wall-clock ms of the Commits and Layers */
    this.at = state.at;
    this.init = state.init;
    this.labels = new Map();
    for (const kind of ["commits", "layers", "roots"]) for (const label of Object.keys(this.s[kind])) this.labels.set(this.hex(label), label);
  }

  state() { return { sim: this.s, at: this.at, init: this.init }; }

  /** A model label (C3, L1, R2) in LayerFS's id format; anything else as it is. */
  hex(label) {
    if (label === null || label === undefined) return null;
    const kind = /^([CLR])\d+$/.exec(label)?.[1];
    if (!kind) return label;
    const digest = sha(`${this.project.name}/${label}`);
    return kind === "C" ? `12${digest}` : kind === "L" ? `32${digest}` : digest;
  }
  /** A ref or id from a caller as the model knows it. */
  label(id) { return typeof id === "string" ? this.labels.get(id) ?? id : id; }
  /** Text with every known label shown as its id. */
  text(message) {
    return String(message).replace(/\b[CLR]\d+\b/g, (label) => (this.s.commits[label] || this.s.layers[label] || this.s.roots[label] ? this.hex(label) : label));
  }
  /** `value` with every string that is exactly a known label as its id. */
  ids(value) {
    if (Array.isArray(value)) return value.map((v) => this.ids(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.ids(v)]));
    return typeof value === "string" && /^[CLR]\d+$/.test(value) ? this.text(value) : value;
  }

  /**
   * Runs one model operation: its result, or a Refusal with ids in LayerFS's
   * formats; `detail` reshapes the refusal's detail and `words` may give the
   * real binding's message for it.
   */
  run(op, args, detail = (d) => d, words = () => null) {
    const outcome = this.sim.run(op, args);
    this.stamp();
    if (outcome.ok) return outcome.result;
    const { code, message, ...rest } = outcome.refusal;
    throw new Refusal(code, words(code, rest) ?? this.text(message), this.ids(detail(rest)));
  }
  /** Gives every new Commit and Layer its time, in the order made. */
  stamp() {
    let last = Math.max(0, ...Object.values(this.at));
    for (const label of [...Object.keys(this.s.layers), ...Object.keys(this.s.commits)]) {
      if (this.at[label] === undefined) this.at[label] = last = Math.max(Date.now(), last + 1);
    }
  }

  /** The open Sandbox `id`, or its refusal. */
  sandbox(id) { return this.sim.sandbox(id); }
  *workspaces() {
    for (const id of this.s.sandboxOrder) {
      const sb = this.s.sandboxes[id];
      for (const path of sb.wsOrder) yield [sb, sb.workspaces[path]];
    }
  }

  /** Reads the open Workspaces' folders into the model and ends the processes that ended. */
  readIn() {
    for (const [sb, ws] of this.workspaces()) {
      if (sb.closed || !ws.mounted) continue;
      const dir = this.project.wsDir(sb.id, ws.path);
      if (!existsSync(dir)) continue;
      const found = readTree(dir), live = {};
      for (const [path, entry] of Object.entries(found)) {
        const known = ws.live[path];
        live[path] = { ...entry, inode: known && known.type === entry.type ? known.inode : this.sim.newInode() };
      }
      const changed = model.diffTrees(ws.live, live).map((d) => d.path);
      if (!changed.length) continue;
      ws.live = live;
      const tick = this.sim.tick();
      for (const path of changed) ws.times[path] = tick;
    }
    for (const id of this.s.sandboxOrder) {
      for (const proc of Object.values(this.s.sandboxes[id].processes)) {
        if (proc.status !== "running") continue;
        const code = this.project.procFile(proc.id, "code");
        if (existsSync(code)) Object.assign(proc, { status: "exited", exitCode: Number(readFileSync(code, "utf8").trim()) });
        else if (!alive(proc.pid)) proc.status = "exited";
      }
    }
  }
  /** Each Workspace's files, to see after a call which ones it changed. */
  liveKeys() {
    const keys = new Map();
    for (const [sb, ws] of this.workspaces()) keys.set(`${sb.id}:${ws.path}`, ws.mounted ? JSON.stringify(ws.live) : null);
    return keys;
  }
  /** Writes the Workspaces this call changed to their folders; removes unmounted ones'. */
  writeOut(before) {
    for (const [sb, ws] of this.workspaces()) {
      const dir = this.project.wsDir(sb.id, ws.path), open = ws.mounted && !sb.closed;
      if (open && (before.get(`${sb.id}:${ws.path}`) !== JSON.stringify(ws.live) || !existsSync(dir))) writeTree(dir, ws.live);
      else if (!open && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** One simulated project under a LayerFS home. */
export class Project {
  constructor(home, name) {
    this.home = home;
    this.name = name;
    this.dir = simDir(home, name);
    this.file = join(this.dir, "state.json");
  }
  wsDir(sandbox, path) { return join(this.dir, "ws", sandbox, path.slice(path.lastIndexOf("/") + 1)); }
  procFile(id, ext) { return join(this.dir, "proc", `${id}.${ext}`); }

  /**
   * Runs `fn(call)` with the project locked and its Workspaces read in, then
   * writes out what changed and saves, also when `fn` refuses (a refused
   * Commit can still write its merge into the Workspace).
   * @param {(call: Call) => any} fn
   * @param {object} [fresh] a new project's state (project.init); refused if one exists
   */
  async with(fn, fresh) {
    if (!fresh && !existsSync(this.file)) throw new Refusal("NoSuchProject", `no simulated LayerFS project named ${this.name}`, { project: this.name });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const unlock = await this.lock();
    try {
      if (fresh && existsSync(this.file)) throw new Refusal("Exists", `a LayerFS project named ${this.name} exists`, { project: this.name });
      const call = new Call(this, fresh ?? JSON.parse(readFileSync(this.file, "utf8")));
      call.readIn();
      const before = call.liveKeys();
      const save = () => {
        call.writeOut(before);
        writeFileSync(`${this.file}.tmp`, JSON.stringify(call.state()));
        renameSync(`${this.file}.tmp`, this.file);
      };
      let result;
      try { result = await fn(call); } catch (error) {
        if (error instanceof Refusal) save();
        throw error;
      }
      save();
      return result;
    } finally {
      unlock();
    }
  }

  /** Takes the project's lock file, waiting for another call's; a dead holder's lock is taken over. */
  async lock() {
    const file = join(this.dir, "lock"), until = Date.now() + LOCK_MS;
    for (;;) {
      try {
        writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => rmSync(file, { force: true });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let holder = null, age = 0;
      try { holder = Number(readFileSync(file, "utf8")); age = Date.now() - lstatSync(file).mtimeMs; } catch { continue; }
      if ((holder && !alive(holder)) || age > STALE_LOCK_MS) { rmSync(file, { force: true }); continue; }
      if (Date.now() > until) throw new Refusal("Busy", `the simulated project ${this.name} is busy with another call`, {});
      await pause(10);
    }
  }
}
