// The Host's reads of a project, through one client per project
// (layerfs-client.js: an @layerfs/agent client with its backend): the
// project's state (runtime.project.get_state), its storage (storage.js) and
// the Files pane's reads of saved ids (reads.js). One client keeps the project's Store
// and its daemon connections open across reads; it is released after a quiet
// minute. Reads start no Sandbox, and open connections do not keep an idle
// Sandbox from closing (#373). Saved ids never change, so a Files read is
// kept (the newest KEEP_READS of them). A read that asks the project's
// Sandboxes runs once at a time (once): a reader while it runs shares its
// answer, so a Sandbox that stops answering gets no pile of requests, and
// readers wait for it only SANDBOX_MS (within). A project's last History is
// kept with its Store `version`: the next History read asks the Store
// whether it changed (get_history(since)) and, if not, answers the kept one
// without listing a Commit. Every read keeps the project's Commits, so a
// changed History lists only the Commits it has not seen (allCommits).
import { allCommits, clientFor, drawState, release, SANDBOX_MS, within } from "./layerfs-client.js";
import { READS } from "./reads.js";
import { storageOf } from "./storage.js";

const IDLE_MS = 60_000;
/** The largest page of background processes the backend lists. */
const PROCESSES = 1000;
/** Files reads kept (reads.js): each at most a page of 1000 names or a 48 KiB window. */
const KEEP_READS = 500;
/** Projects whose last History and Commits are kept, the most recently read. */
const KEEP_PROJECTS = 8;

/** Sets `key` in `map` as its newest entry, dropping the oldest past `most`. */
function keep(map, key, value, most) {
  map.delete(key);
  map.set(key, value);
  while (map.size > most) map.delete(map.keys().next().value);
}

export class TreeReader {
  /** @param {object} spec @param {(project: object) => Promise<object>} [open] a project's client, { layerfs, backend, state, close } */
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
    /** project name -> { version, state }: the last History read from the Store */
    this.histories = new Map();
    /** project name -> Map(id -> Commit): the Commits of the project's last read */
    this.commits = new Map();
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

  /** The project's state (History from its Store, Workspaces from its Sandboxes), once at a time. */
  snapshot(project) {
    return this.once(project, "snapshot", (client) => client.state());
  }

  /** The project's background processes (asks its Sandboxes), once at a time: one page of the most. */
  processes(project) {
    return this.once(project, "processes", (client) => client.backend.daemon.process.list(PROCESSES, 0));
  }

  /** One Files read of saved ids (reads.js: list, read, changes, diff); kept, unless it fails. */
  files(project, kind, query) {
    const r = READS[kind],
      args = r.args(query),
      key = `${project.name}\n${kind}\n${JSON.stringify(args)}`;
    const kept = this.reads.get(key);
    if (kept) {
      this.reads.delete(key);
      this.reads.set(key, kept);
      return kept;
    }
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
    const quick = await within(this.snapshot(project), this.sandboxMs);
    if (quick.late) return { ...(await this.history(project)), late: true };
    return this.use(project, (client) => this.draw(project, client, quick.value));
  }

  /**
   * The project's History alone, from its Store, with its `version`: no
   * Sandbox is asked (a chat's History starts from it). Unchanged since the
   * kept one, it is the kept one. One read at a time per project.
   */
  history(project) {
    return this.once(project, "history", async (client) => {
      const kept = this.histories.get(project.name);
      const answer = await client.backend.store.project.get_history(kept?.version);
      if (kept && answer.kind === "unchanged" && answer.version === kept.version) {
        keep(this.histories, project.name, kept, KEEP_PROJECTS);
        return kept.state;
      }
      const state = {
        ...(await this.draw(project, client, { ...answer, sandboxes: [], gone: [] })),
        version: answer.version,
      };
      if (answer.version) keep(this.histories, project.name, { version: answer.version, state }, KEEP_PROJECTS);
      return state;
    });
  }

  /** A snapshot drawn with every Commit, listing only those the project's last read did not have. */
  async draw(project, client, snapshot) {
    const snap = await allCommits(client.layerfs, snapshot, this.commits.get(project.name));
    keep(this.commits, project.name, new Map(snap.commits.map((c) => [c.id, c])), KEEP_PROJECTS);
    return drawState(snap);
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
      entry.client.catch(() => {
        if (this.clients.get(project.name) === entry) this.clients.delete(project.name);
      });
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
    this.histories.delete(name);
    this.commits.delete(name);
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
