// @dsh-layerfs/host: the Host half of LayerFS × DSH, a Cordis function
// plugin that uses only public dsh services.
//   ctx.shellEnv     a contributor gives bash calls in sessions bound to a
//                    project the SDK's DSH_LAYERFS_* settings and a trace file;
//                    the layerfs command is a shim on the process's PATH
//   ctx.sessions     each traced call becomes a plugin:layerfs/call record in
//                    the calling agent's own Session (subagents included)
//   session/event    a subagent's descriptor names it
//   ctx.webServer    the /layerfs route, behind ctx.connection's checks
//                    (only where a web server runs: Web and Desktop)
//   ctx.systemPrompt each agent's runtime context names its conversation's
//                    LayerFS project (where a system prompt is assembled)
//   layerfsTraces    a service giving one bash call's trace lines (the
//                    scripted model's live expect check) and a project's
//                    unmount outcomes (counts by stage and abort disposition,
//                    and the journaled records)
// LayerFS itself is @layerfs/runtime's (the worker on macOS and Windows, Init,
// removal, Sandbox upkeep), opened once, and agents' clients are
// @layerfs/agent's (#428), through the Host's wrappers (agent/).
import { UnmountOutcomes } from "@dsh-layerfs/model/unmount-count.js";
import { BindingStore } from "./binding.js";
import { Collector } from "./collector.js";
import { UnmountJournal } from "./unmount-journal.js";
import z from "@deepseek-ai/schemastery";
import { openRuntime, resolveConfig } from "./config.js";
import { contributor, projectContext, shimOnPath } from "./env.js";
import { adopt } from "./init.js";
import { registerRoutes } from "./route.js";
import { TreeReader } from "./trees.js";

export const name = "layerfs-host";
export const inject = ["shellEnv", "sessions"];
/** Host settings; see config.js for each field. */
export const Config = z.object({
  image: z.string().description("LayerFS runtime image digest (sha256:…) that Sandboxes run"),
  daemon: z.string().description("Host path of the built Linux layerfs-daemon"),
  bundle: z.string().description("Folder of a sealed Linux LayerFS build; on macOS and Windows the home's worker runs it and makes every Store call"),
  wslDistribution: z.string().description("Windows: WSL distribution running the Linux SDK and Docker Engine (default Ubuntu)"),
  wslUser: z.string().description("Windows: WSL user owning the Store volumes (default root)"),
  wslHome: z.string().description("Windows: persistent Linux discovery home, separate from the Windows home"),
  wslNode: z.string().description("Windows: absolute Linux Node executable (default /usr/local/bin/node)"),
  containerPrefix: z.string().description("Prefix of this home's container names (default layerfs-): Sandboxes <prefix><project>-<n>, the macOS worker <prefix>worker"),
  docker: z.string().description("Local Docker Engine Unix socket"),
  home: z.string().description("LayerFS home for discovery records (default: <temp>/dsh-layerfs/home)"),
  stateDir: z.string().description("Project bindings and agent names (default: <profile>/dsh-layerfs)"),
  traceDir: z.string().description("Per-agent SDK traces (Windows default: <workspace>/.dsh-layerfs-traces; other platforms: <temp>/dsh-layerfs/traces)"),
  pollMs: z.natural().min(50).max(10_000).default(400).description("How often trace files are read, in milliseconds"),
});

/**
 * @param {object} ctx plugin context
 * @param {import("./config.js").Config} config
 */
export function apply(ctx, config) {
  const spec = resolveConfig(config, ctx.get("profileContext"));
  const warn = (text) => ctx.logger?.warn?.(`layerfs: ${text}`);
  const bindings = new BindingStore(spec.stateDir);
  // projects bound before the runtime kept records get one, so it knows their volumes
  try { adopt(spec, bindings); } catch (error) { warn(`recording older projects for the runtime: ${error.message}`); }
  const opened = openRuntime(spec);
  ctx.effect(() => () => opened.then((runtime) => runtime.close()).catch((error) => warn(error.message)), "layerfs-host: LayerFS runtime");
  // macOS and Windows: the home's worker makes every Store call. It starts with the Host
  const start = () => opened.then((runtime) => runtime.worker.start()).catch((error) => warn(`the worker did not start: ${error.message}`));
  if (spec.worker && spec.bundle && spec.image) start();
  // a call of the Host's or an agent's that finds the worker down or gone starts it again, one start
  // at a time (the runtime's); the failed call keeps its own answer
  // a traced unmount's abort path: counted by the use case, journaled under the state folder
  const outcomes = new UnmountOutcomes(new UnmountJournal(spec.stateDir));
  const collector = new Collector(ctx, spec, bindings, outcomes);
  collector.onUnreachable = spec.worker ? start : null;
  ctx.effect(() => ctx.shellEnv.register(contributor(ctx, spec, bindings, collector)), "layerfs-host: bash environment");
  ctx.effect(() => shimOnPath(), "layerfs-host: layerfs on PATH");
  ctx.effect(() => collector.start(), "layerfs-host: trace collection");
  ctx.provide("layerfsTraces", {
    callLines: (sessionId, step) => collector.callLines(sessionId, step),
    unmountsOf: (project) => collector.unmountsOf(project),
  });
  ctx.on("session/event", (session, event) => collector.observe(session, event));
  const trees = new TreeReader(spec);
  ctx.effect(() => () => trees.dispose(), "layerfs-host: tree clients");
  ctx.inject(["webServer", "connection"], (child) => registerRoutes(child, { spec, bindings, collector, trees }));
  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.context({
      name: "layerfs:project",
      // right after the working directory, the other fact about where the agent works
      order: scope.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 1,
      interpolate: false,
      text: (context) => (context.agent ? projectContext(bindings, collector, context.agent.session) : ""),
    });
  });
}
