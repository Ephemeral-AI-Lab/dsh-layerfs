// Removes a LayerFS project: a live one through the runtime
// (runtime.project.remove: its Sandbox containers, its Store's volume and its
// home entry, in reverse of Init; one attempt, no retry), then its binding.
// The runtime refuses Busy while a running container (a Sandbox) still uses
// the volume, unless the caller asks to stop them (a demo's Replay: a stopped
// run leaves Workspaces mounted, which keep their Sandboxes from closing
// when idle). The volume is the binding's, named to the runtime for a
// project made before it kept records. The Host's own cached client is
// released first. The workspace folder, session transcripts and line
// journals are untouched; sessions that used the project have no LayerFS
// project afterwards. A project with no home entry whose Store volume Docker
// no longer has (a retired simulator project, or one whose home and volume
// were both lost) is only entries: its binding and the runtime record adopt
// wrote for it are forgotten, with no runtime call.
import { join, relative } from "node:path";
import { openRuntime } from "./config.js";
import { unadopt } from "./init.js";

const refuse = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

/**
 * @param {object} spec resolved Host settings
 * @param {import("./binding.js").BindingStore} bindings
 * @param {import("./trees.js").TreeReader} trees
 * @param {string} name the project
 * @param {{ stopSandboxes?: boolean }} [options] stopSandboxes: stop the running containers on the volume instead of refusing
 * @returns {Promise<{ removed: string, volume: string | null }>} volume: the Store volume deleted, null when there was none
 */
export async function removeProject(spec, bindings, trees, name, { stopSandboxes = false } = {}) {
  const project = bindings.byName(name);
  if (!project) throw refuse("not-found", `no LayerFS project named ${name}`, 404);
  const home = join(spec.home, project.name),
    inside = relative(spec.home, home);
  if (!inside || inside.startsWith("..") || inside.includes("/"))
    throw refuse("invalid-name", `${project.name} is not a project name`);
  await trees.forget(project.name);
  const runtime = await openRuntime(spec);
  const known = (await runtime.project.list()).find((p) => p.name === project.name) ?? null;
  if (!known?.initialized) {
    const volume = known?.volume ?? project.volume ?? null;
    if (!volume || !(await runtime.volume.list()).some((v) => v.name === volume)) {
      unadopt(spec, project.name);
      bindings.remove(project.name);
      return { removed: project.name, volume: null };
    }
  }
  try {
    await runtime.project.remove(project.name, { confirm: project.name, stopSandboxes, volume: project.volume });
  } catch (error) {
    // the route's code for it since before the runtime
    if (error?.code === "Busy") throw refuse("busy", error.message);
    throw error;
  }
  bindings.remove(project.name);
  return { removed: project.name, volume: project.volume };
}
