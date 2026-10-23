// Checks one dsh session's LayerFS tab against LayerFS itself, through a
// running dsh web Host's /layerfs route:
//   - the Branches, their heads and main's Layer that the tab's replay draws
//     equal what inspect.snapshot reports (GET /layerfs/session/<id>/state);
//   - the Sandboxes the agents created are open or closed as LayerFS says;
//   - every line is named for its agent, and each Commit or Layer a line
//     made is drawn as that agent's;
//   - a bash call's lines share one group (the trace step).
// usage: node check-session.mjs '<dsh web URL with ?token=…>' <session id>
// Exit status 0 when every check holds; each failure is printed.
import * as X from "../packages/model/src/index.js";

const [address, sessionId] = process.argv.slice(2);
if (!address || !sessionId) {
  console.error("usage: node check-session.mjs '<dsh web URL with ?token=…>' <session id>");
  process.exit(2);
}

// the token URL sets the browser session cookie; the route accepts it
const login = await fetch(address, { redirect: "manual" });
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const origin = new URL(address).origin;
async function get(path) {
  const res = await fetch(`${origin}/layerfs${path}`, { headers: { cookie } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.code}: ${body.message}`);
  return body;
}

const view = await get(`/session/${encodeURIComponent(sessionId)}`);
if (!view.project) throw new Error(`session ${sessionId} has no LayerFS project`);
const state = await get(`/session/${encodeURIComponent(sessionId)}/state`);

// the tab's replay, as the client plugin builds it
const lines = view.lines.map((line) => ({ ...line, agent: view.agents[line.agentId] ?? line.agent }));
const E = new X.ReplayEngine({ project: view.project.name });
const W = X.storyView(E, { lead: "main" });
for (const step of X.traceSteps(lines, { agent: "main" })) await X.runStep(W, step, {});

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const realOf = Object.fromEntries(Object.entries(state.labels).map(([real, label]) => [label, real]));
const reported = state.s, drawn = E.s;

// Branches and heads
const reportedBranches = Object.keys(reported.branches).sort(), drawnBranches = Object.keys(drawn.branches).sort();
check(JSON.stringify(reportedBranches) === JSON.stringify(drawnBranches), `Branches: LayerFS has ${reportedBranches}, the tab draws ${drawnBranches}`);
for (const name of reportedBranches) {
  const want = realOf[reported.branches[name].head] ?? null, got = drawn.branches[name] ? E.m.real(drawn.branches[name].head) ?? null : undefined;
  check(want === got, `Branch ${name}: LayerFS head ${want}, the tab draws ${got}`);
}
const mainWant = realOf[reported.main.head], mainGot = E.m.real(drawn.main.head);
check(mainWant === mainGot, `main: LayerFS Layer ${mainWant}, the tab draws ${mainGot}`);

// Sandboxes the agents created
for (const box of Object.values(reported.sandboxes)) {
  const real = realOf[box.id] ?? box.real, label = E.m.toLabel.get(real);
  check(label !== undefined, `Sandbox ${real} is not drawn`);
  if (label !== undefined) check(!!drawn.sandboxes[label].closed === !!box.closed, `Sandbox ${real}: LayerFS closed=${!!box.closed}, the tab draws closed=${!!drawn.sandboxes[label].closed}`);
}

// attribution: names, and the nodes each agent made
for (const line of lines) check(view.agents[line.agentId] !== undefined && !/^agent-/.test(line.agent), `line ${line.id} (${line.method}) has no agent name`);
let nodes = 0;
for (const line of lines) {
  const made = line.ok && line.kind === "Committed" ? line.commit : line.ok && line.method === "branch.publish" ? line.layer : null;
  if (!made) continue;
  nodes++;
  const label = E.m.toLabel.get(made);
  check(W.attrib[label] === line.agent, `${line.method} ${made.slice(0, 12)}: made by ${line.agent}, drawn as ${W.attrib[label]}`);
}

// groups: one trace step per bash call, shared by that call's lines
const groups = new Map();
for (const line of lines) {
  check(!!line.step, `line ${line.id} (${line.method}) has no step`);
  const key = `${line.agent} · ${line.step}`;
  groups.set(key, (groups.get(key) ?? 0) + 1);
}
for (const [key, count] of groups) {
  const steps = new Set(lines.filter((l) => `${l.agent} · ${l.step}` === key).map((l) => l.agentId));
  check(steps.size === 1, `group ${key} spans ${steps.size} agent sessions`);
}

const agents = [...new Set(lines.map((l) => l.agent))];
console.log(`${view.project.name}: ${lines.length} lines from ${agents.join(", ")}; ${drawnBranches.length} Branches, ${Object.keys(reported.sandboxes).length} Sandboxes, ${nodes} Commits and Layers attributed, ${groups.size} bash calls (${[...groups.values()].filter((n) => n > 1).length} with several calls)`);
if (failures.length) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}
console.log("PASS the tab draws what LayerFS reports");
