// The plugin owns only references to runtime.native's original instance handles.
// Reading starts nothing. No restart/retry/implicit discard or cross-process RPC.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openRuntime } from "./config.js";
import { clientFor } from "./layerfs-client.js";

const owners = new WeakMap();
const fail = (code, message, detail = null) => Object.assign(new Error(message), { code, detail, status: 409 });
const errorOf = (e) => ({ code: e?.code ?? "Unknown", message: e?.message ?? String(e), detail: e?.detail ?? null });
// HTTP-safe projection only: retain original SDK/Session objects in this owner.
export const nativeValue = (value) => JSON.parse(JSON.stringify(value, (_, x) => typeof x === "bigint" ? x.toString() : x));
export function nativeOwner(spec) {
  let owner = owners.get(spec);
  if (!owner) { owner = new NativeOwner(spec); owners.set(spec, owner); }
  return owner;
}

export class NativeOwner {
  #spec;
  #open;
  #entries = new Map();
  constructor(spec, open = (project) => clientFor(spec, project)) { this.#spec = spec; this.#open = open; }
  #enabled() {
    if (!this.#spec.native) throw fail("Unsupported", "native instance ownership requires the Windows-native route");
  }
  #deployment() {
    const options = this.#spec.nativeWorkspace;
    if (!options || ["executable", "host", "winfsp", "restrictedLauncher", "workRoot"].some((k) => typeof options[k] !== "string" || !isAbsolute(options[k])))
      throw fail("NotConfigured", "configure nativeWorkspace product executable, host, WinFsp, restrictedLauncher and absolute workRoot before creating an instance");
    return options;
  }
  async create(project) {
    this.#enabled();
    const o = this.#deployment(), runtime = await openRuntime(this.#spec);
    // A unique fresh work path per explicit request; an unknown request is never resent.
    mkdirSync(o.workRoot, { recursive: true, mode: 0o700 });
    const id = randomUUID(), entry = { id, project: project.name, work: join(o.workRoot, id), phase: "starting", handle: null, client: null, registration: null, busy: true, error: null };
    this.#entries.set(id, entry);
    try {
      entry.handle = await runtime.native.create({ project: project.name, executable: o.executable, host: o.host, winfsp: o.winfsp, restrictedLauncher: o.restrictedLauncher, work: entry.work });
      entry.client = await this.#open(project);
      entry.registration = await runtime.native.bindClient(entry.client.layerfs, entry.handle, { commitScope: "published" });
      entry.phase = "running";
      return { id, nativeId: entry.handle.id, mode: entry.registration.mode };
    } catch (e) {
      // The runtime owns custody even when create did not return a handle.
      entry.phase = "failed"; entry.error = errorOf(e); throw e;
    } finally { entry.busy = false; }
  }
  async list(project) {
    this.#enabled();
    const runtime = await openRuntime(this.#spec), observations = (await runtime.native.instances()).filter((r) => r.project === project.name);
    const instances = [];
    for (const entry of this.#entries.values()) {
      if (entry.project !== project.name) continue;
      const observed = observations.find((r) => r.id === entry.handle?.id || r.work === entry.work);
      let workspaces = [], error = null;
      if (entry.registration && !entry.busy && observed?.state === "running") {
        try { workspaces = (await entry.client.layerfs.sandbox.list_workspaces(entry.registration.sandbox)).items; }
        catch (e) { error = errorOf(e); }
      }
      instances.push({ id: entry.id, nativeId: entry.handle?.id ?? observed?.id ?? null, state: observed?.state ?? entry.phase, mode: "windows-restricted", busy: entry.busy,
        sessions: observed?.sessions ?? null, retainedSessions: observed?.retainedSessions ?? null, workspaces, workspacesKnown: !!entry.registration && !entry.busy && observed?.state === "running" && !error, error: error ?? entry.error });
    }
    // An original owner not registered here is visible, never impersonated/adopted.
    for (const row of observations) if (!instances.some((i) => i.nativeId === row.id))
      instances.push({ id: row.id, nativeId: row.id, state: row.state, mode: row.mode, busy: false, sessions: row.sessions, retainedSessions: row.retainedSessions, workspaces: [], error: { code: "Unregistered", message: "runtime retains this original instance; no plugin handle was returned", detail: null } });
    return nativeValue({ scope: "this-host-runtime", configured: !!this.#spec.nativeWorkspace, instances });
  }
  async action(project, input) {
    this.#enabled();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !["action", "instance", "path", "branch", "message", "discard", "confirm"].includes(k)))
      throw fail("InvalidInput", "native action takes action, instance and its operation's fields only");
    if (input.action === "create") {
      if (Object.keys(input).some((k) => k !== "action")) throw fail("InvalidInput", "instance creation uses configured product paths only");
      return this.create(project);
    }
    const operations = { mount: ["branch"], status: ["path"], commit: ["path", "message"], unmount: ["path", "discard", "confirm"], close: [] };
    const fields = Object.hasOwn(operations, input.action) ? operations[input.action] : null;
    if (!fields || Object.keys(input).some((k) => !["action", "instance", ...fields].includes(k))) throw fail("InvalidInput", "unsupported native action or fields");
    const entry = this.#entries.get(input.instance);
    if (!entry || entry.project !== project.name) throw fail("NoSuchSandbox", "this project has no original native instance with that id");
    if (entry.busy) throw fail("Busy", "an explicit native operation is still in flight; it is not replayed");
    if (!entry.handle) throw fail("Unknown", "instance creation did not return a handle; original runtime custody is retained");
    if (input.action !== "close" && !entry.registration) throw fail("Unknown", "native SDK binding was not completed; original instance retained");
    if (input.action === "unmount" && input.discard !== undefined && typeof input.discard !== "boolean") throw fail("InvalidInput", "discard must be boolean");
    if (input.discard === true && input.confirm !== input.path) throw fail("InvalidInput", "confirm discard with the original Workspace path");
    // Resolve by the original handle, not a host-supplied filesystem path.
    if (["status", "commit", "unmount"].includes(input.action)) entry.handle.workspace(input.path);
    entry.busy = true;
    try {
      let value;
      const lf = entry.client?.layerfs, sandbox = entry.registration?.sandbox;
      if (input.action === "mount") value = await lf.workspace.mount(sandbox, input.branch);
      if (input.action === "status") value = await entry.client.backend.daemon.workspace.status({ sandbox, path: input.path });
      if (input.action === "commit") value = await lf.workspace.commit({ sandbox, path: input.path }, input.message);
      if (input.action === "unmount") value = await lf.workspace.unmount({ sandbox, path: input.path }, input.discard === true);
      if (input.action === "close") {
        value = await entry.handle.close();
        entry.phase = "closed";
        // Runtime close was acknowledged before releasing only the Store client.
        await entry.client?.close();
        this.#entries.delete(entry.id);
      }
      entry.error = null;
      return nativeValue(value);
    } catch (e) { entry.error = errorOf(e); throw e; }
    finally { entry.busy = false; }
  }
}
