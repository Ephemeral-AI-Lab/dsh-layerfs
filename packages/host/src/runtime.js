// Sandbox management for the LayerFS page (#373): what runs, and the few
// actions on it.
//   one project   its Sandboxes from one state read (which starts none),
//                 each mounted Workspace with its Branch, uncommitted changes,
//                 background processes, and who mounted it (the agents' traces)
//   all projects  Docker, the home's worker (macOS, Windows) and the older
//                 Store container, free disk and leftovers from the runtime
//                 (@layerfs/runtime status and sandbox calls); each project's
//                 Sandbox containers from one `docker ps`, each daemon pinged
//                 (a TCP connect) and its Workspaces from the agents' traces:
//                 no daemon is asked for its state (quickSandboxes)
// A read starts nothing, and waits for a project's Sandboxes only
// trees.sandboxMs: after that the tab shows the quick view (`pending`) while
// the daemons' answer is read on. An action is one SDK, runtime or Docker
// call, never repeated; one that would cut off an agent's call running in
// that Workspace is refused.
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { openRuntime } from "./config.js";
import { isSim, within } from "./layerfs-client.js";

const run = promisify(execFile);
/** Workspaces one Sandbox's daemon admits (the SDK's daemon setup, `namespaces`). */
export const CAPACITY = 16;
/** A Workspace with uncommitted changes and no call for this long is flagged. */
export const LEFT_MS = 10 * 60_000;
const DOCKER_MS = 5_000, PING_MS = 1_000;
const RANK = { down: 0, degraded: 1, ok: 2 };

// Docker of this home: on Windows, the WSL distribution's engine
const docker = (spec, ...args) => (spec.wsl
  ? run("wsl.exe", ["--distribution", spec.wsl.distribution, "--user", spec.wsl.user, "--exec", "docker", "-H", `unix://${spec.docker}`, ...args], { timeout: DOCKER_MS, windowsHide: true })
  : run("docker", ["-H", `unix://${spec.docker}`, ...args], { timeout: DOCKER_MS })).then((r) => r.stdout.trim());
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
      const sandboxes = isSim(project) ? [] : await quickSandboxes(collector, project, await containersOf(trees.spec), now);
      return { project: project.name, simulated: isSim(project), sandboxes, gone: [], pending: true, level: worst(sandboxes.map((s) => s.level)) };
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
    return { project: project.name, simulated: isSim(project), sandboxes, gone, level: worst([...sandboxes.map((s) => s.level), gone.length ? "degraded" : "ok"]) };
  }
}

/**
 * A project's running Sandbox containers (`containers`, from containersOf),
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
    return { id: c.sandbox, name: c.name, image: c.image || null, capacity: CAPACITY, workspaces, answers, level: answers ? "ok" : "down" };
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

/** Every project's Sandboxes and the shared parts, as the All projects page draws them. */
export async function overview(spec, bindings, trees, collector) {
  const runtime = await openRuntime(spec), status = await runtime.status();
  const engine = status.docker;
  // Docker answered the runtime; a listing that fails now draws no containers rather than no page
  const containers = engine.level === "ok" ? await containersOf(spec).catch(() => []) : [];
  const store = workerCard(status.worker);
  const disk = { host: status.disk.home, vm: spec.worker ? status.disk.volumes : null };
  const projects = bindings.projects();
  const cards = await Promise.all(projects.map(async (p) => {
    const own = containers.filter((c) => c.project === p.name);
    const card = { name: p.name, simulated: isSim(p), containers: own.length, sandboxes: [], workspaces: 0, level: "ok", note: null };
    // a project with nothing running is read from Docker alone: no client, no Store opened
    if (!own.some((c) => c.running) && !card.simulated) return card;
    // the simulator's Sandboxes are its own state, read at once; a real project's from Docker and pings
    let sandboxes;
    try {
      sandboxes = card.simulated ? (await projectRuntime(trees, collector, p)).sandboxes : await quickSandboxes(collector, p, own);
    } catch (error) {
      return { ...card, level: "down", note: error.message };
    }
    card.sandboxes = sandboxes.map((s) => ({ id: s.id, name: s.name, image: s.image, used: s.workspaces.length, capacity: s.capacity, level: s.level }));
    card.workspaces = sandboxes.reduce((n, s) => n + s.workspaces.length, 0);
    card.level = worst(sandboxes.map((s) => (s.level === "ok" && s.workspaces.length >= CAPACITY ? "degraded" : s.level)));
    const silent = sandboxes.filter((s) => s.answers === false);
    card.note = silent.length ? `${silent.map((s) => s.name).join(", ")} does not accept a connection` : null;
    return card;
  }));
  cards.sort((a, b) => RANK[a.level] - RANK[b.level] || b.workspaces - a.workspaces || a.name.localeCompare(b.name));
  // a Sandbox container of no project of this home, or one left stopped
  const leftovers = engine.level === "ok" ? await runtime.sandbox.list_leftovers().catch(() => []) : [];
  if (engine.level === "ok") await nameImages(spec, cards.flatMap((c) => c.sandboxes));
  const sandboxes = cards.reduce((n, c) => n + c.sandboxes.length, 0), workspaces = cards.reduce((n, c) => n + c.workspaces, 0);
  // macOS: the older Store container, while it exists; a running one keeps the worker from starting
  const oldStore = status.oldStore ?? null;
  return {
    level: worst([engine.level, store?.level ?? "ok", leftovers.length || oldStore?.state === "running" ? "degraded" : "ok"]),
    // agents' calls running now in any project: a worker restart cuts them off
    engine, store, oldStore, calls: collector.runningCalls(), disk, projects: cards, leftovers, totals: { projects: cards.length, sandboxes, workspaces },
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

/** Gives each Sandbox (`{ image }`, an exact digest; one project's may differ) its `imageName`: the
 * image's first tag, else null. One `docker image inspect` for all; an image Docker no longer has stays unnamed. */
export async function nameImages(spec, sandboxes) {
  const digests = [...new Set(sandboxes.map((s) => s.image).filter(Boolean))];
  const names = new Map();
  if (digests.length) {
    let out;
    // a missing image fails the command, yet the found ones are on stdout
    try { out = await docker(spec, "image", "inspect", "-f", "{{.Id}}\t{{join .RepoTags \",\"}}", ...digests); } catch (error) { out = String(error.stdout ?? ""); }
    for (const row of out.split("\n").filter(Boolean)) {
      const [id, tags] = row.split("\t");
      names.set(id, tags?.split(",").filter(Boolean)[0] ?? null);
    }
  }
  for (const s of sandboxes) s.imageName = names.get(s.image) ?? null;
  return sandboxes;
}

/** This home's Sandbox containers (named `<prefix><project>-<n>`), running or not. */
async function containersOf(spec) {
  const out = await docker(spec, "ps", "-a", "--no-trunc", "--filter", "label=layerfs.role=sandbox", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label \"layerfs.project\"}}\t{{.Label \"layerfs.sandbox\"}}\t{{.Image}}\t{{.Ports}}");
  return out.split("\n").filter(Boolean).map((row) => {
    const [name, state, status, project, sandbox, image, ports] = row.split("\t");
    // the daemon's port, published on the host's loopback
    const port = Number(/127\.0\.0\.1:(\d+)->/.exec(ports ?? "")?.[1]) || null;
    return { name, running: state === "running", status, project, sandbox, image, port };
  }).filter((c) => c.name.startsWith(spec.prefix));
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
