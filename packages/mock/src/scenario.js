// Loads and checks a scenario (scenarios/<name>/scenario.json) and compiles
// each agent's steps. A scenario is data: every step is one call to a tool of
// the layerfs-dsh-minimalist preset, with that tool's own arguments, and
// dsh's real tools run it; nothing here runs a tool or makes up a result.
//
// scenario.json:
//   { type: "layerfs-scenario", version: 3, title, blurb?, order?,
//     layerfs: ["mocked", "real"] | ["real"], fixture?, lib?,
//     agents: { root: Step[], <child>: Step[], … } }
// `layerfs` lists the backends the scenario runs on: Mocked LayerFS (the
// Host's simulator) and Real LayerFS. `fixture` is the folder its project is
// Inited from; `lib` a module its bash steps call (below).
// A step is one of:
//   { <tool>: args, say?, phase?, note?, expect?, as? }   one tool call
//   { reply: "…", until?: [child, …], phase?, note? }     the agent's text; ends its turn
// Tools and their arguments are the preset's (see TOOLS). Two conveniences:
// `bash.script` names a file under the scenario folder that becomes
// `command` (fed to node on stdin); `bash.run` lists calls [name, ...args] of
// the module `lib` names, and becomes a command that imports it, awaits each
// in turn and then its `done()`. "@name" in an id argument names the child
// started by `subagent` with description `name`, or the background job a bash
// step started with `as: name`.
// After a reply the agent's next turn starts when it is woken: the root by
// the children in `until` finishing (or by a new user message), a child by a
// message from its parent. `say` is said before the call; `phase` names the
// part of the run the Run bar shows; `note` is for readers; `expect` lists the
// LayerFS outcome codes the bash call's trace lines should show in order.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TYPE = "layerfs-scenario";
const BACKENDS = ["mocked", "real"];
const DELIMITER = "JS";
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REF = /^@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const CALL = /^[A-Za-z_$][\w$]*$/;

/** The preset's tools: argument names, and which arguments are agent or job ids. */
export const TOOLS = {
  bash: { args: ["description", "command", "script", "run", "timeoutMs", "workdir", "run_in_background"], required: ["description"] },
  subagent: { args: ["description", "prompt", "cwd"], required: ["description", "prompt"] },
  send_message: { args: ["agent_id", "message"], required: ["agent_id", "message"], agent: "agent_id" },
  interrupt_agent: { args: ["agent_id"], required: ["agent_id"], agent: "agent_id" },
  list_agents: { args: ["scope"], required: [] },
  job_output: { args: ["job_id", "wait", "timeout_ms"], required: ["job_id"], job: "job_id" },
  job_kill: { args: ["job_id", "reason"], required: ["job_id"], job: "job_id" },
  job_list: { args: [], required: [] },
  working_directory: { args: ["cd"], required: [] },
};
const STEP_FIELDS = ["say", "phase", "note", "expect", "as"];

export class ScenarioError extends Error {
  constructor(where, message) { super(`${where}: ${message}`); this.name = "ScenarioError"; }
}

/** Every scenario folder under `dir` that holds a scenario.json, by folder name, in `order`. */
export function loadScenarios(dir) {
  const scenarios = new Map();
  if (!existsSync(dir)) return scenarios;
  const loaded = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "scenario.json");
    if (existsSync(file) && statSync(file).isFile()) loaded.push(loadScenario(join(dir, name)));
  }
  for (const s of loaded.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))) scenarios.set(s.name, s);
  return scenarios;
}

/** One scenario folder, checked and compiled; throws ScenarioError naming the step at fault. */
export function loadScenario(folder) {
  const name = basename(folder), file = join(folder, "scenario.json");
  if (!NAME.test(name)) throw new ScenarioError(file, "the folder name is the model id: lowercase letters, digits and -");
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new ScenarioError(file, error.message); }
  return compileScenario(raw, { name, folder, where: file });
}

/**
 * Checks a parsed scenario and compiles it.
 * @returns {{ name, title, blurb, order, layerfs: string[], fixture, agents: Record<string, object[]>, prompts: Map<string, string>, parents: Map<string, string> }}
 */
export function compileScenario(raw, { name, folder, where = name }) {
  const fail = (path, message) => { throw new ScenarioError(`${where} ${path}`, message); };
  if (!isObject(raw)) fail("", "must be an object");
  only(raw, ["type", "version", "title", "blurb", "order", "layerfs", "fixture", "lib", "agents"], "", fail);
  if (raw.type !== TYPE) fail("type", `must be "${TYPE}"`);
  if (raw.version !== 3) fail("version", "must be 3");
  if (typeof raw.title !== "string" || !raw.title) fail("title", "must be a non-empty string");
  if (raw.blurb !== undefined && typeof raw.blurb !== "string") fail("blurb", "must be a string");
  if (raw.order !== undefined && !Number.isInteger(raw.order)) fail("order", "must be an integer");
  if (!Array.isArray(raw.layerfs) || !raw.layerfs.length || !raw.layerfs.every((b) => BACKENDS.includes(b)) || new Set(raw.layerfs).size !== raw.layerfs.length) {
    fail("layerfs", `lists the backends it runs on: ${BACKENDS.join(", ")}`);
  }
  let lib = null;
  if (raw.lib !== undefined) {
    lib = resolve(folder, String(raw.lib));
    if (!existsSync(lib) || !statSync(lib).isFile()) fail("lib", `${raw.lib} is not a file`);
  }
  let fixture = null;
  if (raw.fixture !== undefined) {
    fixture = resolve(folder, String(raw.fixture));
    if (!existsSync(fixture) || !statSync(fixture).isDirectory()) fail("fixture", `${raw.fixture} is not a folder`);
  }
  if (!isObject(raw.agents) || !Array.isArray(raw.agents.root)) fail("agents", "must hold a root agent's steps");

  const prompts = new Map(), parents = new Map();
  const agents = {};
  for (const [agent, steps] of Object.entries(raw.agents)) {
    if (!NAME.test(agent)) fail(`agents.${agent}`, "an agent name is lowercase letters, digits and -");
    if (!Array.isArray(steps) || !steps.length) fail(`agents.${agent}`, "must be a non-empty list of steps");
    agents[agent] = compileSteps(steps, `agents.${agent}`, { agent, folder, lib, fail, prompts, parents });
  }
  for (const [child, parent] of parents) {
    if (!agents[child]) fail(`agents.${parent}`, `starts ${child}, which has no steps under agents`);
    if (child === "root") fail(`agents.${parent}`, "root is the conversation's own agent and cannot be started");
  }
  for (const agent of Object.keys(agents)) {
    if (agent !== "root" && !parents.has(agent)) fail(`agents.${agent}`, "no subagent step starts this agent");
  }
  return { name, title: raw.title, blurb: raw.blurb ?? "", order: raw.order ?? null, layerfs: [...raw.layerfs], fixture, agents, prompts, parents };
}

function compileSteps(steps, path, context) {
  const { agent, fail } = context;
  const out = [], children = new Set(), jobs = new Set();
  steps.forEach((step, index) => {
    const at = `${path}[${index}]`;
    if (!isObject(step)) fail(at, "a step is an object");
    if ("reply" in step) {
      only(step, ["reply", "until", "phase", "note"], at, fail);
      if (typeof step.reply !== "string" || !step.reply) fail(at, "reply is a non-empty string");
      if (out[out.length - 1]?.kind === "reply") fail(at, "two replies in a row: a turn holds at least one call");
      let until = [];
      if (step.until !== undefined) {
        if (!Array.isArray(step.until) || !step.until.length) fail(`${at}.until`, "lists the children to wait for");
        for (const child of step.until) if (!children.has(child)) fail(`${at}.until`, `${child} is not started by an earlier step of ${agent}`);
        if (index === steps.length - 1) fail(`${at}.until`, "the last reply has nothing to wait for");
        until = [...step.until];
      }
      out.push({ kind: "reply", text: step.reply, until, at, phase: step.phase ?? null, note: step.note ?? null });
      return;
    }
    const tools = Object.keys(TOOLS).filter((tool) => tool in step);
    if (tools.length !== 1) fail(at, `a step is one call to one of ${Object.keys(TOOLS).join(", ")}, or a reply`);
    const [tool] = tools;
    only(step, [tool, ...STEP_FIELDS], at, fail);
    const args = step[tool];
    if (!isObject(args)) fail(`${at}.${tool}`, "the tool's arguments are an object");
    const spec = TOOLS[tool];
    only(args, spec.args, `${at}.${tool}`, fail);
    for (const key of spec.required) if (args[key] === undefined) fail(`${at}.${tool}.${key}`, "is required");
    const call = { name: tool, args: { ...args } };

    if (tool === "bash") {
      if (["script", "command", "run"].filter((key) => key in args).length !== 1) fail(`${at}.bash`, "has exactly one of script, run and command");
      if ("script" in args) call.args.command = scriptCommand(args.script, `${at}.bash.script`, context);
      if ("run" in args) call.args.command = runCommand(args.run, `${at}.bash.run`, context);
      delete call.args.script;
      delete call.args.run;
      if (typeof call.args.command !== "string" || !call.args.command) fail(`${at}.bash.command`, "must be a non-empty string");
      if (step.as !== undefined) {
        if (args.run_in_background !== true) fail(`${at}.as`, "names a background job: set run_in_background");
        if (!NAME.test(step.as) || jobs.has(step.as)) fail(`${at}.as`, "is a new job name: lowercase letters, digits and -");
        jobs.add(step.as);
        call.job = step.as;
      }
    } else if (step.as !== undefined) fail(`${at}.as`, "only a background bash step names a job");
    if (step.expect !== undefined) {
      if (tool !== "bash") fail(`${at}.expect`, "only a bash step's LayerFS calls are traced");
      if (!Array.isArray(step.expect) || !step.expect.every((c) => typeof c === "string" && c)) fail(`${at}.expect`, "lists outcome codes");
    }

    if (tool === "subagent") {
      const child = args.description;
      if (typeof child !== "string" || !NAME.test(child)) fail(`${at}.subagent.description`, "names the child agent: one of this scenario's agents");
      if (typeof args.prompt !== "string" || !args.prompt) fail(`${at}.subagent.prompt`, "must be a non-empty string");
      if (context.parents.has(child)) fail(`${at}.subagent`, `${child} is already started by ${context.parents.get(child)}`);
      for (const [other, prompt] of context.prompts) {
        if (prompt.includes(args.prompt) || args.prompt.includes(prompt)) fail(`${at}.subagent.prompt`, `must not contain or be contained in ${other}'s prompt: a child is known by its prompt`);
      }
      context.prompts.set(child, args.prompt);
      context.parents.set(child, agent);
      children.add(child);
      call.child = child;
    }
    if (spec.agent) {
      const ref = String(args[spec.agent]).match(REF)?.[1];
      if (!ref || !children.has(ref)) fail(`${at}.${tool}.${spec.agent}`, `is "@<child>" for a child ${agent} started earlier`);
      call.refs = { [spec.agent]: { agent: ref } };
    }
    if (spec.job) {
      const ref = String(args[spec.job]).match(REF)?.[1];
      if (!ref || !jobs.has(ref)) fail(`${at}.${tool}.${spec.job}`, `is "@<job>" for a background bash step of ${agent} named with as`);
      call.refs = { [spec.job]: { job: ref } };
    }

    if (step.say !== undefined && (typeof step.say !== "string" || !step.say)) fail(`${at}.say`, "must be a non-empty string");
    out.push({ kind: "call", call, say: step.say ?? null, expect: step.expect ?? null, at, phase: step.phase ?? null, note: step.note ?? null });
  });
  if (out[out.length - 1].kind !== "reply") out.push({ kind: "reply", text: "Done.", until: [], at: `${path} (end)`, phase: null, note: null });
  return out;
}

/** A script file under the scenario folder, as a bash command that feeds it to node on stdin. */
function scriptCommand(script, at, { folder, fail }) {
  const file = resolve(folder, String(script));
  if (relative(folder, file).startsWith("..")) fail(at, "must be a file inside the scenario folder");
  if (!existsSync(file) || !statSync(file).isFile()) fail(at, `${script} does not exist`);
  const source = readFileSync(file, "utf8");
  if (source.split("\n").includes(DELIMITER)) fail(at, `a line may not read ${DELIMITER}`);
  return `node --input-type=module <<'${DELIMITER}'\n${source.replace(/\n?$/, "\n")}${DELIMITER}`;
}

/** Calls of the scenario's lib as a bash command: node imports it, awaits each, then its done(). */
function runCommand(calls, at, { lib, fail }) {
  if (!lib) fail(at, "needs the scenario's lib");
  if (!Array.isArray(calls) || !calls.length) fail(at, "lists calls [name, ...args]");
  const lines = calls.map((c, k) => {
    if (!Array.isArray(c) || typeof c[0] !== "string" || !CALL.test(c[0])) fail(`${at}[${k}]`, "is [name, ...args] with name an export of lib");
    return `await t.${c[0]}(${c.slice(1).map((a) => JSON.stringify(a)).join(", ")});`;
  });
  return [`node --input-type=module <<'${DELIMITER}'`, `const t = await import(${JSON.stringify(pathToFileURL(lib).href)});`, ...lines, "await t.done?.();", DELIMITER].join("\n");
}

function only(value, keys, at, fail) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(at, `unknown field ${key}`);
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
