// "Init LayerFS": imports a folder as a new LayerFS project, the dsh
// workspace folder's default project. A project is the runtime's Init
// (@layerfs/runtime start_init: count the source, make its own Docker volume,
// one LayerFS Init), watched until it ends; the Host names the project, makes
// an empty one's folder and binds the result.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { missingDeployment, openRuntime, runtimeState } from "./config.js";

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;
const WATCH_MS = 250;
const IMAGE = /^sha256:[0-9a-f]{64}$/;

const refuse = (code, message, status = undefined) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });

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
 * Checks an Init request and names its project, without changing anything.
 * `image` gives the project's Sandboxes their own runtime image (a replayed
 * demo's), instead of the Host's. `timeout` (milliseconds, a positive whole
 * number) bounds the Init; omitted, LayerFS's default (INIT_TIMEOUT_MS,
 * 300 s) applies. It stays on the prepared Init, not in the project's record. Whether this process may install a Store
 * (Linux: Docker's volumes directory, the home's owner) the runtime checks
 * when the Init starts.
 * @param {object} spec resolved Host settings
 * @param {import("./binding.js").BindingStore} bindings
 * @param {{ folder: string, source?: string, name?: string, image?: string, timeout?: number, empty?: boolean }} request
 *   `empty`: a project with nothing in it (an empty folder made here, removed after Init), named at random unless `name` is given
 * @param {Set<string>} [pending] names of Inits still running
 */
export function prepareInit(spec, bindings, { folder, source = folder, name, image, timeout, empty = false }, pending = new Set()) {
  if (image !== undefined && !IMAGE.test(image)) throw refuse("invalid-image", "image is a runtime image digest sha256:<64 hex>");
  if (timeout !== undefined && !(Number.isSafeInteger(timeout) && timeout > 0)) throw refuse("invalid-timeout", "timeout is a positive whole number of milliseconds", 400);
  const missing = missingDeployment(spec);
  if (missing.length) throw refuse("not-configured", `LayerFS is not configured: set ${missing.join(" and ")} for layerfs-host in the profile patch`);
  for (const path of empty ? [folder] : [folder, source]) {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw refuse("invalid-folder", `${path} is not an absolute directory`);
  }
  if (name !== undefined && !NAME.test(name)) throw refuse("invalid-name", "a project name is 1-63 lowercase letters, digits, _ . - and starts and ends alphanumeric");
  const taken = new Set([...bindings.allNames(), ...pending]);
  const project = { name: name ?? (empty ? randomName(taken, spec.home) : freeName(nameFrom(source), taken, spec.home)), source, created: Date.now() };
  if (taken.has(project.name) || existsSync(join(spec.home, project.name))) throw refuse("name-taken", `a LayerFS project named ${project.name} exists`);
  if (image) project.image = image;
  if (empty) Object.assign(project, { source: mkdtempSync(join(tmpdir(), "dsh-layerfs-empty-")), empty: true });
  return { folder, project, ...(timeout !== undefined ? { timeout } : {}) };
}

/**
 * Runs a prepared Init and makes the project `folder`'s default. `report`
 * sees each step (scan, volume, import), the counts as `scanned` and
 * `totals`, and LayerFS's own counts while it imports as `imported`. A live
 * Init is the runtime's job, read every WATCH_MS until it ends; one attempt,
 * and what a failed Init made the runtime removes (an uncertain one it keeps
 * and records). An empty project's folder is removed once Init ends.
 */
export async function runInit(spec, bindings, { folder, project, timeout }, report = () => {}) {
  try {
    const made = await initLayerFS(spec, project, timeout, report);
    bindings.addProject(folder, made);
    return made;
  } finally {
    if (project.empty) rmSync(project.source, { recursive: true, force: true });
  }
}

async function initLayerFS(spec, project, timeout, report) {
  const runtime = await openRuntime(spec);
  const options = { ...(project.image ? { image: project.image } : {}), ...(timeout !== undefined ? { timeout } : {}) };
  let job = await runtime.project.start_init(project.name, project.source, options);
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
 * Gives every project the Host bound before it used the runtime its
 * runtime record (<home>/.runtime/projects/<name>.json: name, volume, image,
 * source, created), so runtime.project.get_state, sandbox.reclaim and remove
 * know its volume. The runtime has no call for this (a gap reported to
 * LayerFS); the record is written in the runtime's documented format, never
 * over one it has. Answers the names given a record.
 */
export function adopt(spec, bindings) {
  const dir = join(runtimeState(spec), "projects"), adopted = [];
  for (const project of bindings.projects()) {
    if (!NAME.test(project.name) || !project.volume) continue;
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
