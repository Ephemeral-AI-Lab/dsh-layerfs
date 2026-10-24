// @dsh-layerfs/mock: the LayerFS scripted model, a Cordis function plugin
// for testing and showing the LayerFS UI without a language model. The
// dsh-layerfs bundle ships it switched on; dsh's Plugins page turns it off.
// It registers the "layerfs-mock" provider with one model per scenario
// folder, and, where a web server runs, the /layerfs-mock route the client's
// Tests tab and Run bar read (routes.js). The LayerFS Host's
// layerfsTraces service gives it each bash call's trace lines. Each run's Session goes in the
// Scenarios workspace, <stateDir>/Scenarios.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { createAdapter, PROVIDER } from "./adapter.js";
import { keepDefaultModel } from "./default-model.js";
import { Progress } from "./progress.js";
import { registerRoutes } from "./routes.js";
import { loadScenarios } from "./scenario.js";
import { writeSeed } from "./seed.js";

export const name = "layerfs-mock";
export const inject = ["llm"];
export const Config = z.object({
  scenarios: z.string().description("Folder of scenario folders (default: the scenarios folder of this checkout)"),
  stateDir: z
    .string()
    .description("Each scenario's latest runs and the Scenarios workspace (default: <profile>/dsh-layerfs-mock)"),
  preset: z.string().default("layerfs-scenarios").description("Agent preset of the runs' Sessions"),
  prompt: z.string().default("Run the scenario.").description("The message that starts a run"),
});

export function apply(ctx, config) {
  const dir = config.scenarios || fileURLToPath(new URL("../../../scenarios/", import.meta.url));
  // an invalid scenario stops the plugin with the step at fault named
  const scenarios = loadScenarios(dir);
  const profile = ctx.get("profileContext");
  const stateDir = config.stateDir || join(profile ? profile.dir : join(homedir(), ".dsh"), "dsh-layerfs-mock");
  const workspace = join(stateDir, "Scenarios");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  // a scenario whose fixture is a seed file Inits from the seed written out here
  for (const s of scenarios.values()) if (s.seed) s.fixture = writeSeed(s.seed, join(stateDir, "seeds", s.name));
  const progress = new Progress(scenarios, stateDir);
  const scripts = process.platform === "win32" ? join(workspace, ".commands") : null;
  ctx.effect(
    () =>
      ctx.llm.registerAdapter(
        [PROVIDER],
        createAdapter(LlmAdapter, scenarios, progress, () => ctx.get("layerfsTraces"), scripts),
      ),
    "layerfs-mock: model",
  );
  const options = { scenarios, progress, workspace, preset: config.preset, provider: PROVIDER, prompt: config.prompt };
  ctx.inject(["webServer", "connection"], (child) => registerRoutes(child, options));
  ctx.inject(["agentDefaultModel"], (child) => keepDefaultModel(child));
}
