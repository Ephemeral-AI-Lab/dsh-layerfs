// Checks a finished scripted run from what dsh web left in its profile:
//   node tools/checks/run.mjs <profile dir> <root session id> [--scenarios <dir>]
// <profile dir> is a dsh home's profile (<dsh home>/profiles/web). The run's
// scenario comes from <profile>/dsh-layerfs-mock/runs.json, which
// the scripted model keeps for every run's root Session; the scenario is
// loaded from --scenarios (default: this checkout's scenarios/). The trace
// lines are the Host's journal for the root Session,
// <profile>/dsh-layerfs/lines/<root id>.jsonl, which holds its subagents'
// lines too: a line of the root has the root's agentId, a subagent's line its
// own agentId and the name its parent's subagent call gave it, which is the
// scenario's agent name.
// Checks: the run's own state (passed, or why not), and each bash step's
// `expect` (gates.mjs expectedOutcomes). When the scenario folder holds a
// recorded final.json, the order and final-tree checks are reported NOT_RUN:
// they need a LayerFS client on the run's project, which this command does not
// open (see `missing` below). Reads files only; opens no Store.
// Exit status 0 when every check that ran holds, 1 when one fails, 2 on a
// wrong command line or a run it cannot find.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../packages/mock/src/scenario.js";
import { expectedOutcomes } from "./gates.mjs";

const USAGE = "usage: node tools/checks/run.mjs <dsh home profile dir> <root session id> [--scenarios <dir>]";

/** Why the order and final-tree checks do not run here. */
export const MISSING = [
  "a LayerFS client on the run's project from outside dsh web: on macOS and Windows its Store calls go through the home's worker, whose endpoint the Host gives agents (DSH_LAYERFS_WORKER_ENDPOINT), not this command",
  "a read-only byte hash of main's files: fs.read refuses binary files, so tree.mjs forks a Branch and mounts a Workspace to run sha256sum, which writes to the project",
  "main's Layers for the order check: backend.store.project.get_history, which the layerfs command does not offer",
];

/** The run's lines by scenario agent: the root's by its Session id, a subagent's by its name. */
export function linesByAgent(scenario, rootId, lines) {
  const out = new Map(Object.keys(scenario.agents).map((a) => [a, []]));
  const unknown = new Map();
  for (const line of lines) {
    const agent = line.agentId === rootId ? "root" : line.agent;
    if (agent !== "root" && (agent === "main" || !out.has(agent))) {
      unknown.set(agent, (unknown.get(agent) ?? 0) + 1);
      continue;
    }
    out.get(agent).push(line);
  }
  return { byAgent: out, unknown };
}

/** Reads a JSON-lines file; a line that does not parse is counted, not used. */
function readLines(file) {
  const lines = [];
  let bad = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

/**
 * Checks the run whose root Session is `rootId` in `profile`.
 * @returns {{ scenario: string, failures: string[], notes: string[], notRun: string[] }}
 */
export function checkRun(profile, rootId, scenariosDir) {
  const runsFile = join(profile, "dsh-layerfs-mock", "runs.json");
  if (!existsSync(runsFile))
    throw Object.assign(new Error(`${runsFile} does not exist: no scripted run was made in this profile`), {
      usage: true,
    });
  const runs = JSON.parse(readFileSync(runsFile, "utf8"));
  const id = runs.sessions?.[rootId] ? rootId : runs.sessions?.[`session-${rootId}`] ? `session-${rootId}` : null;
  if (!id)
    throw Object.assign(new Error(`${rootId} is no scripted run's root Session in ${runsFile}`), { usage: true });
  const { scenario: name } = runs.sessions[id];
  const folder = join(scenariosDir, name);
  if (!existsSync(join(folder, "scenario.json")))
    throw Object.assign(new Error(`the run played ${name}, and ${folder} holds no scenario.json`), { usage: true });
  const scenario = loadScenario(folder);
  const failures = [],
    notes = [],
    notRun = [];

  const run = runs.runs?.[name];
  if (run?.sessionId !== id)
    notes.push(`run: a newer run of ${name} replaced this one's record, so its state is unknown`);
  else if (run.state === "passed") notes.push(`run: passed in ${((run.ended - run.started) / 1000).toFixed(1)} s`);
  else failures.push(`run: ${run.state}${run.error ? ` (${run.error})` : ""}`);

  const file = join(profile, "dsh-layerfs", "lines", `${encodeURIComponent(id)}.jsonl`);
  const { lines, bad } = existsSync(file) ? readLines(file) : { lines: [], bad: 0 };
  if (!existsSync(file)) notes.push(`lines: ${file} does not exist (no LayerFS call was traced)`);
  if (bad) failures.push(`lines: ${bad} line(s) of ${file} do not parse`);
  const { byAgent, unknown } = linesByAgent(scenario, id, lines);
  for (const [agent, count] of unknown)
    failures.push(`lines: ${count} line(s) of an agent named ${agent}, which ${name} does not have`);
  const expected = expectedOutcomes(scenario, (agent) => byAgent.get(agent) ?? []);
  failures.push(...expected.failures);
  notes.push(`lines: ${lines.length} from ${file}`, ...expected.notes);

  if (existsSync(join(folder, "final.json"))) {
    notRun.push(`order and final tree against ${join(folder, "final.json")}: NOT_RUN, missing ${MISSING.join("; ")}`);
  }
  return {
    scenario: name,
    project: run?.sessionId === id ? (run.project ?? `mock-${name}`) : `mock-${name} (older run; project not recorded)`,
    failures,
    notes,
    notRun,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let scenarios = fileURLToPath(new URL("../../scenarios/", import.meta.url));
  const at = args.indexOf("--scenarios");
  if (at >= 0) {
    scenarios = resolve(args[at + 1] ?? "");
    args.splice(at, 2);
  }
  if (args.length !== 2) {
    console.error(USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = checkRun(resolve(args[0]), args[1], scenarios);
  } catch (error) {
    console.error(`run check: ${error.message}`);
    if (error.usage) console.error(USAGE);
    process.exit(2);
  }
  console.log(`${result.scenario} (project ${result.project})`);
  for (const note of result.notes) console.log(`  ${note}`);
  for (const line of result.notRun) console.log(`  ${line}`);
  for (const failure of result.failures) console.log(`  FAIL ${failure}`);
  console.log(
    result.failures.length ? `FAIL: ${result.failures.length} failure(s)` : "PASS: every check that ran holds",
  );
  process.exit(result.failures.length ? 1 : 0);
}
