// The Host's reads of a project, through one SDK client per project: the
// project's state (inspect.snapshot), its storage (storage.js) and the Files
// pane's reads of saved ids (reads.js). One client keeps the project's Store
// and its daemon connections open across reads; it is released after a quiet
// minute. Reads start no Sandbox, and open connections do not keep an idle
// Sandbox from closing (#373). Saved ids never change, so a Files read is
// kept (the newest KEEP_READS of them). A read that asks the project's
// Sandboxes runs once at a time (once): a reader while it runs shares its
// answer, so a Sandbox that stops answering gets no pile of requests, and
// readers wait for it only SANDBOX_MS (within).
import { clientFor, release, SANDBOX_MS, stateOf, within } from "./layerfs-client.js";
import { READS } from "./reads.js";
import { storageOf } from "./storage.js";

const IDLE_MS = 60_000;
/** Files reads kept (reads.js): each at most a page of 1000 names or a 48 KiB window. */
const KEEP_READS = 500;

export class TreeReader {
  /** @param {object} spec @param {(project: object) => Promise<object>} [open] a project's SDK client */
  constructor(spec, open = (project) => clientFor(spec, project)) {
    this.spec = spec;
    this.open = open;
    /** project name -> { client: Promise, users, timer } */
    this.clients = new Map();
    /** `${project}\n${kind}\n${args}` -> Promise of a Files read */
    this.reads = new Map();
    /** `${project}\n${name}` -> Promise of the read of the project's Sandboxes running now */
    this.running = new Map();
    /** how long a reader waits for the project's Sandboxes (SANDBOX_MS) */
    this.sandboxMs = SANDBOX_MS;
  }

  /**
   * One `name` read of the project at a time: a caller while it runs gets
   * the same Promise. It holds the project's client until it ends, however
   * long a caller waits for it.
   */
  once(project, name, fn) {
    const key = `${project.name}\n${name}`;
    let reading = this.running.get(key);
    if (!reading) {
      reading = this.use(project, fn).finally(() => this.running.delete(key));
      reading.catch(() => {}); // a caller that stopped waiting leaves no unhandled failure
      this.running.set(key, reading);
    }
    return reading;
  }

  /** The project's snapshot (History from its Store, Workspaces from its Sandboxes), once at a time. */
  snapshot(project) {
    return this.once(project, "snapshot", (client) => client.operator.inspect.snapshot());
  }

  /** The project's background processes (asks its Sandboxes), once at a time. */
  processes(project) {
    return this.once(project, "processes", (client) => client.operator.process.list());
  }

  /** One Files read of saved ids (reads.js: list, read, changes, diff); kept, unless it fails. */
  files(project, kind, query) {
    const r = READS[kind], args = r.args(query), key = `${project.name}\n${kind}\n${JSON.stringify(args)}`;
    const kept = this.reads.get(key);
    if (kept) { this.reads.delete(key); this.reads.set(key, kept); return kept; }
    const reading = this.use(project, (client) => r.run(client, args));
    this.reads.set(key, reading);
    reading.catch(() => this.reads.delete(key));
    while (this.reads.size > KEEP_READS) this.reads.delete(this.reads.keys().next().value);
    return reading;
  }

  /**
   * The project's state as the views draw it; see stateOf. Its Sandboxes get
   * SANDBOX_MS to answer: after that History is drawn from the Store alone,
   * without Workspaces (`late`), while the snapshot runs on.
   */
  async state(project) {
    const reading = this.snapshot(project);
    const quick = await within(reading, this.sandboxMs);
    return this.use(project, async (client) => {
      if (!quick.late) return stateOf(client, quick.value);
      // the simulator has no Store read of its own; its snapshot answers quickly anyway
      if (!client.history) return stateOf(client, await reading);
      return { ...(await stateOf(client, { ...(await client.history()), sandboxes: [], gone: [] })), late: true };
    });
  }

  /** The project's History alone, from its Store: no Sandbox is asked (a chat's History starts from it). */
  history(project) {
    return this.use(project, async (client) => {
      // the simulator has no Store read of its own; its snapshot answers quickly anyway
      if (!client.history) return stateOf(client, await client.operator.inspect.snapshot());
      return stateOf(client, { ...(await client.history()), sandboxes: [], gone: [] });
    });
  }

  /** What the project's Store holds and what made it; see storageOf. */
  storage(project) {
    return this.use(project, storageOf);
  }

  async use(project, fn) {
    let entry = this.clients.get(project.name);
    if (!entry) {
      entry = { client: this.open(project), users: 0, timer: null };
      this.clients.set(project.name, entry);
      entry.client.catch(() => { if (this.clients.get(project.name) === entry) this.clients.delete(project.name); });
    }
    clearTimeout(entry.timer);
    entry.users++;
    try {
      return await fn(await entry.client);
    } finally {
      if (--entry.users === 0 && this.clients.get(project.name) === entry) {
        entry.timer = setTimeout(() => this.drop(project.name, entry), IDLE_MS);
        entry.timer.unref?.();
      }
    }
  }

  async drop(name, entry) {
    if (this.clients.get(name) !== entry || entry.users) return;
    this.clients.delete(name);
    await release(await entry.client).catch(() => {});
  }

  /** Drops a project's kept reads and releases its client now (before removal). */
  async forget(name) {
    for (const key of [...this.reads.keys()]) if (key.startsWith(`${name}\n`)) this.reads.delete(key);
    const entry = this.clients.get(name);
    if (!entry) return;
    this.clients.delete(name);
    clearTimeout(entry.timer);
    await entry.client.then(release).catch(() => {});
  }

  /** Releases every client; runs with the plugin fiber. */
  async dispose() {
    const entries = [...this.clients.entries()];
    this.clients.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      await entry.client.then(release).catch(() => {});
    }
  }
}
