// Host plugin configuration and its resolution into absolute settings: the
// Host's own (bindings, traces, runs) and the deployment it hands
// @layerfs/runtime (runtimeSettings), whose runtime the Host opens once
// (openRuntime). The runtime owns the worker (macOS, Windows), Init, removal
// and Sandbox upkeep; the Host keeps what is dsh's.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { LayerFSRuntime } from "@layerfs/runtime";

/** Docker's volumes directory, in Docker's VM on macOS and Windows. */
export const VOLUMES = "/var/lib/docker/volumes";

/**
 * @typedef {object} Config
 * @property {string} [image] LayerFS runtime image digest (`sha256:…`) Sandboxes run; Init refuses without it.
 * @property {string} [daemon] Host path of the built Linux layerfs-daemon (default: the bundle's).
 * @property {string} [bundle] Folder of a sealed Linux LayerFS build. macOS and Windows need it: the
 *   home's worker runs its worker/server.js and makes every Store call (@layerfs/runtime).
 * @property {string} [containerPrefix] Prefix of this home's container names (default `layerfs-`):
 *   Sandboxes `<prefix><project>-<n>`, the macOS worker `<prefix>worker`. A second home on the
 *   same Docker engine (a test, another checkout) sets its own.
 * @property {string} [docker] Local Docker Engine Unix socket.
 * @property {string} [volumes] Docker's volumes directory on Linux (default `/var/lib/docker/volumes`), for an
 *   engine whose data-root is elsewhere. Init installs the Store into a volume's directory
 *   there, so the Host's user must be able to write it.
 * @property {string} [home] LayerFS home for discovery records, shared by the Host and agents' bash calls.
 * @property {string} [stateDir] Directory for project bindings and agent names.
 * @property {string} [traceDir] Directory for per-agent SDK trace files; bash calls must be able to write it.
 * @property {number} [pollMs] Interval at which trace files are read for new lines.
 * @property {string} [runs] Folder of recorded history replay runs (layerfs #352) for the Runs player.
 * @property {string} [wslDistribution] Windows: WSL2 distribution running Docker and the worker (default Ubuntu).
 * @property {string} [wslUser] Windows: Linux user owning Store volumes (default root).
 * @property {string} [wslHome] Windows: persistent Linux discovery directory (default derived from Windows home).
 * @property {string} [wslNode] Windows: Linux Node executable (default /usr/local/bin/node).
 */

/**
 * @typedef {object} Spec
 * @property {string|null} image
 * @property {string|null} daemon
 * @property {string|null} bundle
 * @property {string} prefix this home's container name prefix
 * @property {boolean} worker Store calls run in the home's worker (macOS, Windows), not in the caller
 * @property {string} docker
 * @property {string} volumes
 * @property {string} home
 * @property {string} stateDir
 * @property {string} traceDir
 * @property {boolean} traceInWorkspace Windows default: traces use the shell's writable workspace.
 * @property {number} pollMs
 * @property {string} runs history replay runs: the setting, else $LFS_HISTORY/runs, else ~/lfs-history/runs (the harness's own default)
 * @property {string} sdk file URL of @layerfs/agent, which Live projects' scripts import
 * @property {string} backend file URL of @layerfs/backend
 * @property {string} cli path of @layerfs/runtime's `lfs` command
 * @property {string} simSdk file URL of the agent on the simulator (sim/sdk.js), for simulated projects
 * @property {string} simBackend file URL of its backend (sim/backend.js)
 * @property {string} simCli path of its `lfs` command (sim/lfs.js)
 * @property {{ distribution: string, user: string, node: string, home: string }} [wsl] Windows: the WSL deployment
 * @property {Promise<LayerFSRuntime>} [runtime] the Host's runtime, once openRuntime has opened it
 */

/**
 * Resolves configured values and defaults into one absolute specification.
 * The LayerFS home and trace files default to the host temp area, which the
 * bash sandbox's workspace-write mode may write; bindings default to the
 * profile directory.
 * @param {Config} config
 * @param {{ dir: string } | undefined} profile the launcher's profile, when present
 * @returns {Spec}
 */
export function resolveConfig(config, profile) {
  const temp = join(realpathSync(tmpdir()), "dsh-layerfs");
  const bundle = config.bundle || null, home = config.home || join(temp, "home");
  const windows = process.platform === "win32";
  const spec = {
    image: config.image || null,
    daemon: config.daemon || (bundle && (windows ? posix.join(bundle, "layerfs-daemon") : join(bundle, "layerfs-daemon"))),
    bundle,
    prefix: config.containerPrefix || "layerfs-",
    // Linux makes Store calls in the caller's process; macOS and Windows in the home's worker
    worker: process.platform !== "linux",
    docker: config.docker || "/var/run/docker.sock",
    volumes: config.volumes || VOLUMES,
    home,
    stateDir: config.stateDir || join(profile ? profile.dir : join(homedir(), ".dsh"), "dsh-layerfs"),
    traceDir: config.traceDir || join(temp, "traces"),
    traceInWorkspace: windows && !config.traceDir,
    pollMs: config.pollMs ?? 400,
    runs: config.runs || join(process.env.LFS_HISTORY || join(homedir(), "lfs-history"), "runs"),
    sdk: import.meta.resolve("@layerfs/agent"),
    backend: import.meta.resolve("@layerfs/backend"),
    cli: fileURLToPath(import.meta.resolve("@layerfs/runtime/cli")),
    simSdk: new URL("./sim/sdk.js", import.meta.url).href,
    simBackend: new URL("./sim/backend.js", import.meta.url).href,
    simCli: fileURLToPath(new URL("./sim/lfs.js", import.meta.url)),
  };
  if (windows) {
    // the Host's default before #428, so an existing WSL home stays where it is
    const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
    spec.wsl = { distribution: config.wslDistribution || "Ubuntu", user: config.wslUser || "root", node: config.wslNode || "/usr/local/bin/node", home: config.wslHome || `/var/lib/dsh-layerfs-windows/${hash}` };
  }
  for (const dir of [spec.stateDir, spec.traceDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(spec.home, { recursive: true, mode: 0o700 });
  return spec;
}

/** Deployment settings Init and bash calls need that are not configured (macOS and Windows: a bundle too). */
export const missingDeployment = (spec) => ["image", "daemon", ...(spec.worker ? ["bundle"] : [])].filter((name) => !spec[name]);

/** What the Host hands LayerFSRuntime.open: its deployment, as the dsh adapter (the worker route is dsh's only). */
export const runtimeSettings = (spec) => ({
  home: spec.home, image: spec.image, daemon: spec.daemon, bundle: spec.bundle, docker: spec.docker, volumes: spec.volumes,
  traceDir: spec.traceDir, containerPrefix: spec.prefix, stateDir: runtimeState(spec), adapter: "dsh", pollMs: spec.pollMs,
  ...(spec.wsl ? { wsl: spec.wsl } : {}),
});

/** The runtime's own records (its default, named so the Host can find them). */
export const runtimeState = (spec) => join(spec.home, ".runtime");

/**
 * The Host's runtime, opened once. With the dsh adapter on macOS and Windows
 * it hands its worker to @layerfs/agent, so every client this process makes
 * after it uses the worker. A test sets `spec.runtime` to a stand-in first.
 * @returns {Promise<LayerFSRuntime>}
 */
export function openRuntime(spec) {
  spec.runtime ??= LayerFSRuntime.open(runtimeSettings(spec));
  return spec.runtime;
}
