// "Init LayerFS": imports a folder as a new LayerFS project, the dsh
// workspace folder's default project. A live project is the runtime's Init
// (@layerfs/runtime start_init: count the source, make its own Docker volume,
// one LayerFS Init), watched until it ends; the Host names the project, makes
// an empty one's folder and binds the result. A simulated project (backend
// "sim") is imported into the simulator (sim/) instead: no Docker, no
// deployment settings.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { missingDeployment, openRuntime, runtimeState } from "./config.js";
import { isSim } from "./layerfs-client.js";
import { initSim } from "./sim/client.js";

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;
const WATCH_MS = 250;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
/** The demo scenarios (the mock plugin's default folder), for their `live` flag. */
const SCENARIOS = fileURLToPath(new URL("../../../scenarios/", import.meta.url));

const refuse = (code, message) => Object.assign(new Error(message), { code });

/** A project name from a folder name: lowercase, the SDK's alphabet, at most 63 characters. */
export function nameFrom(folder) {
  const base = basename(folder).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 63);
  return NAME.test(base) ? base : "project";
}

const free = (name, taken, home) => !taken.has(name) && !existsSync(join(home, name));
/** The first free name: `base`, then `base-1`, `base-2`, … (the same folder imported again). */
function freeName(base, taken, home) {
  for (let i = 0; ; i++) {
    const name = i === 0 ? base : `${base.slice(0, 60)}-${i}`;
    if (free(name, taken, home)) return name;
  }
}

const ADJECTIVES = ["amber", "brave", "bright", "calm", "clever", "cosy", "gentle", "golden", "happy", "humble", "jolly", "keen", "lively", "lucky", "merry", "misty", "nimble", "quiet", "rapid", "shy", "silver", "sunny", "swift", "tidy", "witty"];
const NOUNS = ["badger", "comet", "coral", "dolphin", "falcon", "fern", "harbor", "heron", "island", "kelp", "lagoon", "lantern", "maple", "meadow", "otter", "pebble", "puffin", "reef", "river", "seal", "shell", "sparrow", "tide", "walrus", "whale"];
/** A new project's random name, adjective-noun (a number added once the pairs run out). */
export function randomName(taken, home, pick = Math.random) {
  const one = (list) => list[Math.floor(pick() * list.length)];
  for (let i = 0; i < 50; i++) { const name = `${one(ADJECTIVES)}-${one(NOUNS)}`; if (free(name, taken, home)) return name; }
  return freeName(`${one(ADJECTIVES)}-${one(NOUNS)}`, taken, home);
}

/**
 * Counts what a simulated Init imports, before it starts: every entry under
 * `source` (links not followed) and the bytes of its regular files. `report`
 * sees the running counts. (A live Init's counts are the runtime's.)
 * @returns {Promise<{ entries: number, files: number, bytes: number }>}
 */
export async function scanSource(source, report = () => {}) {
  const counts = { entries: 1, files: 0, bytes: 0 }, dirs = [source];
  while (dirs.length) {
    const dir = dirs.pop();
    for await (const entry of await opendir(dir)) {
      counts.entries++;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile()) { counts.files++; counts.bytes += (await lstat(path)).size; }
    }
    report({ ...counts });
  }
  return counts;
}

/** Whether `name` is the simulator project of a demo that runs on Live LayerFS only (`live` in its scenario). */
export function liveOnlyDemo(name, scenarios = SCENARIOS) {
  const id = /^demo-(.+)-sim$/.exec(name ?? "")?.[1];
  if (!id) return false;
  try { return JSON.parse(readFileSync(join(scenarios, id, "scenario.json"), "utf8")).live === true; } catch { return false; }
}

/**
 * Checks an Init request and names its project, without changing anything.
 * `image` gives the project's Sandboxes their own runtime image (a replayed
 * demo's), instead of the Host's. Whether this process may install a Store
 * (Linux: Docker's volumes directory, the home's owner) the runtime checks
 * when the Init starts.
 * @param {object} spec resolved Host settings
 * @param {import("./binding.js").BindingStore} bindings
 * @param {{ folder: string, source?: string, name?: string, backend?: "sim", image?: string, empty?: boolean }} request
 *   `empty`: a project with nothing in it (an empty folder made here, removed after Init), named at random unless `name` is given
 * @param {Set<string>} [pending] names of Inits still running
 */
export function prepareInit(spec, bindings, { folder, source = folder, name, backend, image, empty = false }, pending = new Set()) {
  if (backend !== undefined && backend !== "sim") throw refuse("invalid-backend", "backend is \"sim\" or omitted");
  if (image !== undefined && (backend === "sim" || !IMAGE.test(image))) throw refuse("invalid-image", "image is a runtime image digest sha256:<64 hex>, for a Live project");
  if (backend === "sim" && liveOnlyDemo(name)) throw refuse("live-only", `${name} is a demo that runs on Live LayerFS only`);
  const missing = backend === "sim" ? [] : missingDeployment(spec);
  if (missing.length) throw refuse("not-configured", `LayerFS is not configured: set ${missing.join(" and ")} for layerfs-host in the profile patch`);
  for (const path of empty ? [folder] : [folder, source]) {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw refuse("invalid-folder", `${path} is not an absolute directory`);
  }
  if (name !== undefined && !NAME.test(name)) throw refuse("invalid-name", "a project name is 1-63 lowercase letters, digits, _ . - and starts and ends alphanumeric");
  const taken = new Set([...bindings.allNames(), ...pending]);
  const project = { name: name ?? (empty ? randomName(taken, spec.home) : freeName(nameFrom(source), taken, spec.home)), source, created: Date.now() };
  if (taken.has(project.name) || existsSync(join(spec.home, project.name))) throw refuse("name-taken", `a LayerFS project named ${project.name} exists`);
  if (image) project.image = image;
  if (backend === "sim") Object.assign(project, { backend, volume: `sim-${project.name}` });
  if (empty) Object.assign(project, { source: mkdtempSync(join(tmpdir(), "dsh-layerfs-empty-")), empty: true });
  return { folder, project };
}

/**
 * Runs a prepared Init and makes the project `folder`'s default. `report`
 * sees each step (scan, volume, import), the counts as `scanned` and
 * `totals`, and LayerFS's own counts while it imports as `imported`. A live
 * Init is the runtime's job, read every WATCH_MS until it ends; one attempt,
 * and what a failed Init made the runtime removes (an uncertain one it keeps
 * and records). An empty project's folder is removed once Init ends.
 */
export async function runInit(spec, bindings, { folder, project }, report = () => {}) {
  try {
    const made = isSim(project) ? await initSimulated(spec, project, report) : await initLive(spec, project, report);
    bindings.addProject(folder, made);
    return made;
  } finally {
    if (project.empty) rmSync(project.source, { recursive: true, force: true });
  }
}

async function initSimulated(spec, project, report) {
  report({ step: "scan" });
  const totals = await scanSource(project.source, (counts) => report({ scanned: counts }));
  report({ step: "volume", totals });
  report({ step: "import" });
  await initSim(spec.home, project.name, project.source);
  return project;
}

async function initLive(spec, project, report) {
  const runtime = await openRuntime(spec);
  let job = await runtime.project.start_init(project.name, project.source, project.image ? { image: project.image } : {});
  for (;;) {
    const { step, scanned, totals, imported } = job;
    if (step !== "done" && step !== "failed") report({ step, scanned, totals, imported });
    if (job.ended) break;
    await pause(WATCH_MS);
    job = (await runtime.project.get_init(job.id)) ?? { ...job, step: "failed", ended: Date.now(), error: { code: "Unknown", message: "the runtime no longer has this Init's job" } };
  }
  if (job.step !== "done") throw refuse(job.error?.code ?? "Failed", job.error?.message ?? "Init failed");
  // the runtime's record: its volume and creation time
  return { ...project, ...job.project, ...(project.empty ? { empty: true } : {}) };
}

/** Imports `source` (default: the workspace folder) as a LayerFS project, `folder`'s default. */
export const initProject = (spec, bindings, request, report) => runInit(spec, bindings, prepareInit(spec, bindings, request), report);

/**
 * Gives every live project the Host bound before it used the runtime its
 * runtime record (<home>/.runtime/projects/<name>.json: name, volume, image,
 * source, created), so runtime.project.get_state, sandbox.reclaim and remove
 * know its volume. The runtime has no call for this (a gap reported to
 * LayerFS); the record is written in the runtime's documented format, never
 * over one it has. Answers the names given a record.
 */
export function adopt(spec, bindings) {
  const dir = join(runtimeState(spec), "projects"), adopted = [];
  for (const project of bindings.projects()) {
    if (isSim(project) || !NAME.test(project.name) || !project.volume) continue;
    const file = join(dir, `${project.name}.json`);
    if (existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    const { name, volume, image, source, created } = project;
    writeFileSync(`${file}.new`, JSON.stringify({ name, volume, ...(image ? { image } : {}), source: source ?? null, created: created ?? null }));
    renameSync(`${file}.new`, file);
    adopted.push(name);
  }
  return adopted;
}
