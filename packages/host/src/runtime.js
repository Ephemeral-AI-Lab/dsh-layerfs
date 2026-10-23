// Sandbox management for the LayerFS page (#373): what runs, and the few
// actions on it.
//   one project   its Sandboxes from one state read (which starts none),
//                 each mounted Workspace with its Branch, uncommitted changes,
//                 background processes, and who mounted it (the agents' traces)
//   all projects  Docker, the home's worker (macOS, Windows) and the older
//                 Store container, free disk, the last sweep, Sandbox
//                 containers with their scratch, Store volumes and leftovers,
//                 all from @layerfs/runtime (status, sandbox.list,
//                 volume.list, sandbox.list_leftovers); each running
//                 Sandbox's daemon pinged (a TCP connect) and its Workspaces
//                 from the agents' traces: no daemon is asked for its state
//                 (quickSandboxes). The Host runs no Docker command itself.
// A read starts nothing, and waits for a project's Sandboxes only
// trees.sandboxMs: after that the tab shows the quick view (`pending`) while
// the daemons' answer is read on. An action is one SDK, runtime or Docker
// call, never repeated; one that would cut off an agent's call running in
// that Workspace is refused.
import { connect } from "node:net";
import { openRuntime } from "./config.js";
import { within } from "./layerfs-client.js";

/** Workspaces one Sandbox's daemon admits (the SDK's daemon setup, `namespaces`). */
export const CAPACITY = 16;
/** A Workspace with uncommitted changes and no call for this long is flagged. */
export const LEFT_MS = 10 * 60_000;
const PING_MS = 1_000;
/** Docker's free disk below these is degraded, then down (the host disk policy's 20 and 10 GiB). */
export const DOCKER_LOW = 20 * 2 ** 30, DOCKER_CRITICAL = 10 * 2 ** 30;
const RANK = { down: 0, degraded: 1, ok: 2 };

const key = (sandbox, path) => `${sandbox}\n${path}`;
const worst = (levels) => levels.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "ok");
const refuse = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * One project's Sandboxes, as its Sandboxes tab draws them: each daemon's
 * Workspaces and processes. When the daemons take longer than
 * trees.sandboxMs, the quick view (`pending: true`) is drawn and the read runs on.
 */
export async function projectRuntime(trees, collector, project, now = Date.now()) {
  {
    const [read, listed] = await Promise.all([within(trees.snapshot(project), trees.sandboxMs), within(trees.processes(project), trees.sandboxMs)]);
    if (read.late || listed.late) {
      const sandboxes = await quickSandboxes(collector, project, containersOf(await (await openRuntime(trees.spec)).sandbox.list()), now);
      return { project: project.name, sandboxes, gone: [], pending: true, level: worst(sandboxes.map((s) => s.level)) };
    }
    const snap = read.value, processes = listed.value.items ?? [];
    const busy = collector.busyOf(project.name), mounts = collector.mountsOf(project.name);
    const sandboxes = (snap.sandboxes ?? []).map((sb) => {
      const workspaces = sb.workspaces.filter((w) => w.mounted && w.directory).map((w) => {
        const by = mounts[key(sb.id, w.directory)], inUse = busy.has(key(sb.id, w.directory));
        const uncommitted = w.dirty ? Math.max(w.dirty.inodes, w.dirty.entries) : 0;
        const idleMs = by && !inUse ? Math.max(0, now - by.lastAt) : null;
        return {
          path: w.directory, branch: w.branch ?? null, activity: w.activity ?? null, uncommitted,
          stale: w.headMovedSinceMount === true, pendingMerge: !!w.pendingMerge,
          agent: by?.agent ?? null, mountedAt: by?.at ?? null, idleMs, busy: inUse,
          processes: processes.filter((p) => p.sandbox === sb.id && p.path === w.directory).map(({ id, command, status }) => ({ id, command, status })),
          // left with uncommitted changes: worth a look, never acted on by itself
          level: uncommitted && idleMs !== null && idleMs >= LEFT_MS ? "degraded" : "ok",
        };
      });
      const full = workspaces.length >= CAPACITY;
      return { id: sb.id, name: sb.name ?? null, image: sb.image ?? null, capacity: CAPACITY, workspaces, level: worst([full ? "degraded" : "ok", ...workspaces.map((w) => w.level)]) };
    });
    const gone = (snap.gone ?? []).map(({ id, name, image }) => ({ id, name: name ?? null, image: image ?? null }));
    return { project: project.name, sandboxes, gone, level: worst([...sandboxes.map((s) => s.level), gone.length ? "degraded" : "ok"]) };
  }
}

/**
 * A project's running Sandbox containers (`containers`, from containersOf),
 * each with its scratch (the container's writable layer, from the runtime),
 * each daemon pinged (it accepts a connection within PING_MS), with the
 * Workspaces the agents' traces mounted there. No daemon is asked anything,
 * so a busy or stuck one cannot hold the read; uncommitted changes and
 * processes are not known here.
 */
export async function quickSandboxes(collector, project, containers, now = Date.now()) {
  const mounts = collector.mountsOf(project.name), busy = collector.busyOf(project.name);
  return Promise.all(containers.filter((c) => c.project === project.name && c.running).map(async (c) => {
    const answers = c.port ? await reachable(c.port) : false;
    const workspaces = Object.entries(mounts).filter(([k]) => k.split("\n")[0] === c.sandbox).map(([k, by]) => {
      const inUse = busy.has(k);
      return {
        path: k.split("\n")[1], branch: null, activity: null, uncommitted: 0, stale: false, pendingMerge: false,
        agent: by.agent ?? null, mountedAt: by.at, idleMs: inUse ? null : Math.max(0, now - by.lastAt), busy: inUse, processes: [], level: "ok",
      };
    });
    return { id: c.sandbox, name: c.name, image: c.image || null, scratch: c.scratch, capacity: CAPACITY, workspaces, answers, level: answers ? "ok" : "down" };
  }));
}

/**
 * The home's worker as the page draws it (the Store container before #428):
 * ok when it runs, answers and is of the configured build; null on Linux,
 * where Store calls run in-process.
 */
function workerCard(worker) {
  if (!worker) return null;
  const { name, state, build, expected, startedAt, answering } = worker;
  const level = state !== "running" || answering === false ? "down" : expected && build !== expected ? "degraded" : "ok";
  return { level, state: ["running", "stopped", "missing"].includes(state) ? state : "unknown", name, ...(build ? { build } : {}), ...(expected ? { expected } : {}), ...(startedAt ? { startedAt } : {}), ...(answering === undefined ? {} : { answering }) };
}

/**
 * Every project's Sandboxes and the shared parts, as the All projects page
 * draws them. A project with a running Sandbox gets a card (problems first);
 * the others are listed idle with their Store volume's size. Leftovers are
 * stopped or ownerless Sandbox containers and this home's Store volumes no
 * project uses; volumes of unknown owner are only counted. `reasons` names
 * every warning, worst first; none when all is well.
 */
export async function overview(spec, bindings, trees, collector) {
  const runtime = await openRuntime(spec), status = await runtime.status();
  const engine = status.docker, up = engine.level === "ok";
  // Docker answered the runtime; a listing that fails now draws less, not no page (null: not read)
  const [listed, volumes, leftovers] = up
    ? await Promise.all([runtime.sandbox.list().catch(() => null), runtime.volume.list().catch(() => null), runtime.sandbox.list_leftovers().catch(() => [])])
    : [null, null, []];
  // the home's projects: one with no home entry (project.record) cannot open its Store
  const homes = await runtime.project.list().then((all) => new Map(all.map((p) => [p.name, p])), () => null);
  const containers = containersOf(listed ?? []);
  const store = workerCard(status.worker);
  const disk = { host: status.disk?.home ?? null, docker: status.disk?.volumes ?? null };
  disk.dockerLevel = disk.docker === null ? null : disk.docker < DOCKER_CRITICAL ? "down" : disk.docker < DOCKER_LOW ? "degraded" : "ok";
  const cards = [], idle = [];
  for (const p of bindings.projects()) {
    const own = containers.filter((c) => c.project === p.name);
    const card = { name: p.name, sandboxes: [], workspaces: 0, level: "ok", note: null, removable: false };
    if (!own.some((c) => c.running)) {
      const volume = volumes?.find((v) => v.name === p.volume) ?? null;
      const noStore = volumes !== null && !volume, noRecord = homes !== null && !homes.get(p.name)?.initialized;
      // nothing of it left but this entry: the page may remove it from the list
      if (noStore && noRecord) cards.push({ ...card, level: "down", note: `it has no record and no Store volume${p.volume ? ` (${p.volume})` : ""}: nothing to recover`, removable: true });
      else if (noRecord) cards.push({ ...card, level: "down", note: "its record is missing; see layerfs-home.md" });
      else if (noStore) cards.push({ ...card, level: "down", note: `its Store volume ${p.volume} is missing` });
      else idle.push({ name: p.name, volume: volume?.size ?? null });
      continue;
    }
    let sandboxes;
    try {
      sandboxes = await quickSandboxes(collector, p, own);
    } catch (error) {
      cards.push({ ...card, level: "down", note: error.message });
      continue;
    }
    card.sandboxes = sandboxes.map((s) => ({ id: s.id, name: s.name, image: s.image, scratch: s.scratch, used: s.workspaces.length, capacity: s.capacity, level: s.level }));
    card.workspaces = sandboxes.reduce((n, s) => n + s.workspaces.length, 0);
    card.level = worst(sandboxes.map((s) => (s.level === "ok" && s.workspaces.length >= CAPACITY ? "degraded" : s.level)));
    const silent = sandboxes.filter((s) => s.answers === false);
    card.note = silent.length ? `${silent.map((s) => s.name).join(", ")} does not accept a connection` : null;
    cards.push(card);
  }
  cards.sort((a, b) => RANK[a.level] - RANK[b.level] || b.workspaces - a.workspaces || a.name.localeCompare(b.name));
  // this home's Store volumes no project uses; volumes no LayerFS home claims are only counted
  const orphans = (volumes ?? []).filter((v) => v.owner === "this" && !v.live).map(({ name, size, project, containers: users, removable }) => ({ name, size, project, containers: users, removable }));
  const unknown = (volumes ?? []).filter((v) => v.owner === "unknown");
  const sandboxes = cards.reduce((n, c) => n + c.sandboxes.length, 0), workspaces = cards.reduce((n, c) => n + c.workspaces, 0);
  // macOS: the older Store container, while it exists; a running one keeps the worker from starting
  const oldStore = status.oldStore ?? null;
  const sweep = status.sweep ?? null;
  const reasons = [];
  if (!up) reasons.push({ level: "down", text: "Docker not answering" });
  if (oldStore?.state === "running") reasons.push({ level: "degraded", text: "Store calls wait for an upgrade" });
  else if (store && store.level !== "ok") reasons.push({ level: store.level, text: store.state !== "running" ? "Store calls stopped" : store.answering === false ? "Store calls not answering" : "Store calls run an older build" });
  if (disk.dockerLevel && disk.dockerLevel !== "ok") reasons.push({ level: disk.dockerLevel, text: disk.dockerLevel === "down" ? "Docker disk nearly full" : "Docker disk low" });
  const troubled = cards.filter((c) => c.level !== "ok").length;
  if (troubled) reasons.push({ level: worst(cards.map((c) => c.level)), text: `${troubled} project${troubled === 1 ? " needs" : "s need"} a look` });
  const left = leftovers.length + orphans.length;
  if (left) reasons.push({ level: "degraded", text: `${left} leftover${left === 1 ? "" : "s"}` });
  if (sweep?.state === "failed" || sweep?.failed?.length) reasons.push({ level: "degraded", text: "The last sweep failed" });
  reasons.sort((a, b) => RANK[a.level] - RANK[b.level]);
  return {
    level: worst(reasons.map((r) => r.level)), reasons,
    // agents' calls running now in any project: a worker restart cuts them off
    engine, store, oldStore, calls: collector.runningCalls(), disk, sweep,
    projects: cards, idle, leftovers,
    volumes: volumes ? { orphans, unknown: { count: unknown.length, size: unknown.reduce((n, v) => n + (v.size ?? 0), 0) } } : null,
    totals: { projects: cards.length + idle.length, sandboxes, workspaces },
  };
}

/** One action on a project's Workspace or process: unmount, discard (unmount dropping its changes) or stop. */
export async function projectAction(trees, collector, project, body) {
  const { action } = body;
  if (action === "unmount" || action === "discard") {
    const { sandbox, path } = body;
    if (typeof sandbox !== "string" || typeof path !== "string") throw refuse(400, "invalid-workspace", "a Workspace is { sandbox, path }");
    if (collector.busyOf(project.name).has(key(sandbox, path))) throw refuse(409, "busy", `an agent's call is running in ${path}; wait for it to end`);
    if (action === "discard" && body.confirm !== path) throw refuse(400, "not-confirmed", `confirm with the Workspace's path, ${path}`);
    return trees.use(project, ({ layerfs }) => layerfs.workspace.unmount({ sandbox, path }, action === "discard"));
  }
  if (action === "stop") {
    if (typeof body.process !== "string") throw refuse(400, "invalid-process", "a process is its id");
    return trees.use(project, ({ backend }) => backend.daemon.process.cancel(body.process));
  }
  throw refuse(400, "invalid-action", "the action is unmount, discard or stop");
}

/** Starts the home's worker when it is stopped or missing (runtime.worker.start); a running one is left alone. */
export async function startStore(spec) {
  if (!spec.worker) throw refuse(409, "no-store", "this Host runs no worker (Linux runs Store calls in-process)");
  const runtime = await openRuntime(spec);
  const before = workerCard((await runtime.status()).worker);
  if (before?.state === "running" && before.answering) throw refuse(409, "running", `${before.name} is running and answering`);
  await runtime.worker.start();
  return workerCard((await runtime.status()).worker);
}

/**
 * Restarts the home's worker (runtime.worker.restart): every project's Store
 * calls fail while it restarts, so `confirm` must be "restart". On macOS,
 * with the older Store container running, the same confirm stops and
 * removes it, then starts the worker.
 */
export async function restartStore(spec, body) {
  if (!spec.worker) throw refuse(409, "no-store", "this Host runs no worker (Linux runs Store calls in-process)");
  if (body?.confirm !== "restart") throw refuse(409, "not-confirmed", "a restart cuts off every project's Store calls; confirm it");
  const runtime = await openRuntime(spec);
  await runtime.worker.restart({ confirm: "restart" });
  return workerCard((await runtime.status()).worker);
}

/** Removes the stopped leftover containers named in `names` (runtime.sandbox.clean_leftovers); a running one is refused. */
export async function cleanLeftovers(spec, names) {
  if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== "string")) throw refuse(400, "invalid-names", "names lists the leftover containers to remove");
  return (await openRuntime(spec)).sandbox.clean_leftovers(names);
}

/** Removes this home's Store volumes named in `names` that no project uses (runtime.volume.remove); anything else is refused by name. */
export async function removeVolumes(spec, names) {
  if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== "string")) throw refuse(400, "invalid-names", "names lists the volumes to remove");
  return (await openRuntime(spec)).volume.remove(names);
}

/** This home's Sandbox containers from runtime.sandbox.list, with each one's daemon port on the host's loopback. */
function containersOf(listed) {
  return listed.map((c) => ({ ...c, port: c.ports?.find((p) => p.host === "127.0.0.1")?.port ?? null }));
}

/** Whether something accepts a TCP connection on the host's loopback `port` within PING_MS. */
export function reachable(port, ms = PING_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), ms);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}
