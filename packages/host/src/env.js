// The bash environment of a session bound to a LayerFS project: the
// packages an agent imports (#428: @layerfs/agent and @layerfs/backend), the
// runtime's `lfs` command, the project name, its deployment and the calling
// agent's trace file. dsh may set only DSH_* names in a bash call; the agent
// reads each LAYERFS_ setting from its DSH_LAYERFS_ twin. dsh rebuilds the
// DSH_* namespace for every bash call, so these values always describe the
// agent that runs the command.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { deploymentEnv, isSim } from "./layerfs-client.js";
import { appendProject } from "./records.js";
import { LAYERFS } from "./source.js";

// The LayerFS SDK skill of the LayerFS checkout (LAYERFS_SOURCE, source.js), when it has one.
const SKILL = join(LAYERFS, ".agents/skills/layerfs-js-sdk/SKILL.md");
const skill = existsSync(SKILL) ? realpathSync(SKILL) : null;

const VARIABLES = {
  DSH_LAYERFS_PROJECT: "LayerFS project of this conversation; pass it to LayerFS.open(...)",
  DSH_LAYERFS_SDK: "file URL of @layerfs/agent, the LayerFS JavaScript SDK; import it from Node scripts",
  DSH_LAYERFS_BACKEND: "file URL of @layerfs/backend (background processes, a Workspace's status, Store and file storage)",
  DSH_LAYERFS_SKILL: "path of the LayerFS SDK skill (SKILL.md, its references beside it); read it before the first LayerFS call",
  DSH_LAYERFS_CLI: "path of @layerfs/runtime's lfs command: status, log, ls, cat, grep, diff, fork, write and run, one command each",
  DSH_LAYERFS_HOME: "LayerFS home the SDK reads its project and Sandbox records from",
  DSH_LAYERFS_DOCKER: "Docker Engine socket the SDK starts Sandboxes through",
  DSH_LAYERFS_IMAGE: "Runtime image digest a new LayerFS Sandbox runs; the SDK reads it",
  DSH_LAYERFS_CONTAINER_PREFIX: "Prefix of the project's Sandbox container names (<prefix><project>-<n>)",
  DSH_LAYERFS_VOLUME: "Docker volume holding this project's Store",
  DSH_LAYERFS_DAEMON: "Host path of the LayerFS daemon Sandboxes run",
  DSH_LAYERFS_STORE_PATH: "The project's installed Store file, which its Store calls open",
  DSH_LAYERFS_WORKER_ENDPOINT: "macOS and Windows: endpoint file of the LayerFS home's worker, which makes the Store calls",
  DSH_LAYERFS_WORKER_ADAPTER: "macOS and Windows: dsh, the adapter the worker route is open to",
  DSH_LAYERFS_TRACE: "File the SDK appends one line per call to",
  DSH_LAYERFS_TRACE_STEP: "Label of this bash call on the SDK's trace lines",
  DSH_LAYERFS_TRACE_START: "1: the SDK also writes a line when each call starts",
};

/**
 * The runtime-context line naming the project of `session`'s conversation (a
 * subagent's is its root's), or "" when the conversation has none, so agents
 * know it before their first bash call. Reading it binds nothing: the first
 * bash call that uses the project still locks the choice.
 * @param {import("./binding.js").BindingStore} bindings
 * @param {import("./collector.js").Collector} collector
 */
export function projectContext(bindings, collector, session) {
  if (!session) return "";
  const agent = collector.agentOf(session);
  const project = bindings.projectFor(agent.root, agent.cwd);
  if (!project) return "";
  return `LayerFS project of this conversation: ${project.name} (${isSim(project) ? "simulated" : "live"}). Every bash call has it as DSH_LAYERFS_PROJECT; work on it through the LayerFS SDK (LayerFS.open).`;
}

/**
 * @param {object} ctx plugin context (ctx.sessions)
 * @param {object} spec resolved Host settings
 * @param {import("./binding.js").BindingStore} bindings
 * @param {import("./collector.js").Collector} collector
 */
export function contributor(ctx, spec, bindings, collector) {
  return {
    name: "layerfs",
    variables: Object.fromEntries(Object.entries(VARIABLES).map(([key, description]) => [key, { description }])),
    resolve(execution) {
      const session = execution.agent && execution.agent.session;
      if (!session) return {};
      const agent = collector.agentOf(session);
      const project = bindings.projectFor(agent.root, agent.cwd);
      if (!project) return {};
      const before = bindings.session(agent.root);
      bindings.lock(agent.root, project.name, agent.cwd);
      if (!before || !before.locked) {
        const root = ctx.sessions.get(agent.root);
        if (root) appendProject(root, { project: project.name, folder: agent.cwd, volume: project.volume });
      }
      const deploy = deploymentEnv(spec, project);
      return {
        DSH_LAYERFS_PROJECT: project.name,
        DSH_LAYERFS_SDK: isSim(project) ? spec.simSdk : spec.sdk,
        DSH_LAYERFS_BACKEND: isSim(project) ? spec.simBackend : spec.backend,
        DSH_LAYERFS_CLI: isSim(project) ? spec.simCli : spec.cli,
        ...(skill ? { DSH_LAYERFS_SKILL: skill } : {}),
        ...Object.fromEntries(Object.entries(deploy).filter(([, v]) => v).map(([k, v]) => [`DSH_LAYERFS_${k}`, v])),
        DSH_LAYERFS_TRACE: collector.track(agent, project),
        DSH_LAYERFS_TRACE_STEP: String(execution.rootCallId ?? execution.callId),
        DSH_LAYERFS_TRACE_START: "1",
      };
    },
  };
}
