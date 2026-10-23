// LayerFS clients the Host uses for a project, and the deployment a
// project's clients use, the Host's and its agents' alike. A live project's
// client is an @layerfs/agent client opened as an agent script opens one
// (LayerFS.open), with @layerfs/backend beside it; its state, the views'
// whole project, is the runtime's get_state. The agent reads its deployment
// from the environment when a client is made, so the project's settings are
// set for that synchronous step only. A simulated project (backend "sim") has
// a client of the simulator instead (sim/).
import { join } from "node:path";
import { LayerFS } from "@layerfs/agent";
import { LayerFSBackend } from "@layerfs/backend";
import { Mirror } from "@dsh-layerfs/model/mirror.js";
import { openRuntime, VOLUMES } from "./config.js";
import { simClient } from "./sim/client.js";

export const isSim = (project) => project.backend === "sim";

/**
 * The LAYERFS_<name> deployment of one project (DSH_LAYERFS_<name> in its
 * agents' bash calls), as the @layerfs/agent README states it: the home, the
 * Sandboxes' Docker, image, daemon and volume, the installed Store
 * (global/store.sqlite in the volume) and, on macOS and Windows, the home's
 * worker (<home>/worker/endpoint.json, the dsh adapter).
 */
export function deploymentEnv(spec, project) {
  // the agent asks for every deployment setting and a Store path; a simulated project uses none of them
  if (isSim(project)) return { HOME: spec.home, DOCKER: "sim", IMAGE: "sim", DAEMON: "sim", VOLUME: project.volume, STORE_PATH: "sim" };
  return {
    HOME: spec.wsl?.home ?? spec.home,
    DOCKER: spec.docker,
    IMAGE: project.image ?? spec.image ?? "",
    DAEMON: spec.daemon ?? "",
    VOLUME: project.volume,
    // the worker opens it in Docker's VM; Linux, under this engine's volumes directory
    STORE_PATH: `${spec.worker ? VOLUMES : spec.volumes}/${project.volume}/_data/global/store.sqlite`,
    // the project's Sandboxes are <prefix><project>-<n>
    CONTAINER_PREFIX: spec.prefix,
    ...(spec.worker ? { WORKER_ENDPOINT: join(spec.home, "worker", "endpoint.json"), WORKER_ADAPTER: "dsh" } : {}),
  };
}

/** Runs `make` with LAYERFS_<name> set from `env`, restoring them before it returns. */
function withEnv(env, make) {
  const saved = {};
  for (const [name, value] of Object.entries(env)) { saved[name] = process.env[`LAYERFS_${name}`]; process.env[`LAYERFS_${name}`] = value; }
  try {
    return make();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[`LAYERFS_${name}`];
      else process.env[`LAYERFS_${name}`] = value;
    }
  }
}

/**
 * A project's client: `{ layerfs, backend, state(), close() }`. `layerfs` is
 * the agent client, `backend` its LayerFSBackend and `state` the project as
 * runtime.project.get_state answers it. The runtime opens first, so on macOS
 * and Windows the client uses the home's worker.
 */
export async function clientFor(spec, project) {
  if (isSim(project)) return simClient(spec.home, project.name);
  const runtime = await openRuntime(spec);
  // LayerFS.open reads the environment before its first await
  const layerfs = await withEnv(deploymentEnv(spec, project), () => LayerFS.open(project.name));
  return { layerfs, backend: LayerFSBackend.of(layerfs), state: () => runtime.project.get_state(project.name), close: () => layerfs.close() };
}

/** How long a reader waits for a project's Sandboxes to answer (their daemons); the read runs on. */
export const SANDBOX_MS = 4_000;

/** `{ value }` when `promise` settles within `ms`, `{ late: true }` otherwise; a failure within `ms` is thrown. */
export function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); });
  return Promise.race([promise.then((value) => ({ value })), late]).finally(() => clearTimeout(timer));
}

/** Releases a Host client: its Store. The project's Sandboxes close themselves when idle (#373). */
export async function release(client) {
  await client.close?.();
}

/**
 * The project as the views draw it: the mirror of one state read
 * (runtime.project.get_state). History comes from the Store and Workspaces
 * from the project's running Sandboxes, found from their records, so reading
 * starts no Sandbox. A recorded Sandbox found stopped or gone is drawn
 * closed. Read through the Host's shared client for the project
 * (TreeReader.use).
 * @param {object} client a project's client
 */
export async function stateOf(client, snapshot) {
  return drawState(await allCommits(client.layerfs, snapshot));
}

/** The mirror of a snapshot that already holds every Commit (allCommits). */
export function drawState(snap) {
  const m = new Mirror();
  m.project = snap.project;
  const boxes = [
    ...(snap.sandboxes || []).map((x) => ({ label: m.label("sb", x.id), real: x.id, closed: false, workspaces: {}, processes: [] })),
    ...(snap.gone || []).map((x) => ({ label: m.label("sb", x.id), real: x.id, closed: true, workspaces: {}, processes: [] })),
  ];
  m.absorb(snap, boxes);
  return { s: { ...m.s, roots: {} }, labels: Object.fromEntries(m.toLabel) };
}

/**
 * The state holds only each Branch's newest Commits (a few per Branch, to
 * fit one answer) and names in `more` every Branch it cut short; the rest come
 * from branch.list_commits, so History shows every Commit and links each to
 * its parent. A Commit another Branch already listed comes once.
 *
 * `known` (id -> Commit) holds the Commits of an earlier read of the same
 * project. A Commit never changes, and list_commits walks a Branch's first
 * parents newest first, so a Branch whose head is known is not listed, and a
 * listing stops at its first known Commit. The answer then holds the Commits
 * on each Branch head's first-parent chain, as a full listing would (a forced
 * Commit's displaced head drops out); if a chain reaches a Commit neither read
 * has, the Branches are listed in full instead.
 */
export async function allCommits(layerfs, snap, known) {
  const cut = Object.keys(snap.more || {});
  if (!cut.length) return snap;
  if (known?.size) {
    const chains = reachable(snap.branches, await listCut(layerfs, snap, cut, known), known);
    if (chains) return { ...snap, commits: chains, more: {} };
  }
  return { ...snap, commits: await listCut(layerfs, snap, cut), more: {} };
}

/** snap's Commits and those its cut Branches list (each up to a `known` Commit). */
async function listCut(layerfs, snap, cut, known) {
  const commits = [...snap.commits], seen = new Set(commits.map((c) => c.id));
  const heads = new Map((snap.branches || []).map((b) => [b.name, b.head]));
  for (const branch of cut) {
    if (known?.has(heads.get(branch))) continue;
    for (let pos = 0; pos !== null;) {
      const page = await layerfs.branch.list_commits(branch, LIST_PAGE, pos);
      let reached = false;
      for (const c of page.items) {
        if (known?.has(c.id)) { reached = true; break; }
        if (!seen.has(c.id)) { seen.add(c.id); commits.push(c); }
      }
      pos = !reached && page.hasMore ? page.nextPagePos : null;
    }
  }
  return commits;
}

/** The Commits on the Branch heads' first-parent chains, from `listed` or `known`; null when one is in neither. */
function reachable(branches, listed, known) {
  const byId = new Map(listed.map((c) => [c.id, c])), out = new Map();
  for (const branch of branches || []) {
    for (let id = branch.head; id && !out.has(id);) {
      const c = byId.get(id) ?? known.get(id);
      if (!c) return null;
      out.set(id, c);
      id = c.parent;
    }
  }
  return [...out.values()];
}
const LIST_PAGE = 50;
