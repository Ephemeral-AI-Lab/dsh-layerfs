// The LayerFS scripted model without dsh: every scenario in scenarios/ loads;
// a scenario's replies follow its conversation (plan.js), a failed bash call
// stops it; a run's progress, its 15-minute limit and a restart (progress.js);
// the /layerfs-mock route (routes.js); the adapter's replies (adapter.js);
// and the client's queue and run text (client scenarios.ts).
//   node packages/mock/tests/mock.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/adapter.js";
import { agentOf, nextReply } from "../src/plan.js";
import { LIMIT_MS, Progress } from "../src/progress.js";
import { registerRoutes } from "../src/routes.js";
import { compileScenario, loadScenarios, ScenarioError } from "../src/scenario.js";
import { isScenarioProject, nextStarts, projectOf, runText } from "../../client/src/client/scenarios.ts";

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-mock-"));
try {
  // Every shipped scenario loads, in order, on the backends it names; Real-only ones exist
  const shipped = loadScenarios(fileURLToPath(new URL("../../../scenarios/", import.meta.url)));
  assert.ok(shipped.size >= 7, `${shipped.size} scenarios`);
  for (const [id, s] of shipped) {
    assert.ok(s.layerfs.length && s.fixture, `${id} names its backends and fixture`);
    for (const steps of Object.values(s.agents)) for (const st of steps) {
      if (st.kind === "call" && st.call.name === "bash") assert.ok(!/\blf\.workspace\.mount\("/.test(st.call.args.command), `${st.at} mounts without naming a Sandbox`);
    }
  }
  assert.throws(() => compileScenario({ type: "layerfs-scenario", version: 3, title: "x", layerfs: ["sim"], agents: { root: [{ reply: "hi" }] } }, { name: "x", folder: dir }), ScenarioError);
  assert.throws(() => compileScenario({ type: "layerfs-scenario", version: 3, title: "x", layerfs: ["mocked"], agents: { root: [{ pause: 2 }] } }, { name: "x", folder: dir }), ScenarioError, "no pause steps");

  // A small scenario: two bash calls, a child, and the root's last reply
  const s = compileScenario({
    type: "layerfs-scenario", version: 3, title: "Small", layerfs: ["mocked", "real"],
    agents: {
      root: [
        { phase: "Set up", bash: { description: "one", command: "echo 1" } },
        { subagent: { description: "helper", prompt: "Help with the second step." } },
        { reply: "Waiting.", until: ["helper"] },
        { phase: "Finish", bash: { description: "two", command: "echo 2" } },
        { reply: "All done." },
      ],
      helper: [{ bash: { description: "help", command: "echo help" } }, { reply: "Helped." }],
    },
  }, { name: "small", folder: dir });
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const called = (id, name, args = {}) => ({ role: "assistant", content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }] });
  const result = (id, text, isError = false) => ({ role: "tool", toolCallId: id, isError, content: [{ type: "text", text }] });
  const said = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

  assert.equal(agentOf(s, [user("Run the scenario.")]), "root");
  assert.equal(agentOf(s, [user("Help with the second step.")]), "helper");
  let m = [user("Run the scenario.")];
  let r = nextReply(s, "root", m);
  assert.deepEqual([r.kind, r.calls[0].name, r.calls[0].args.command, r.done, r.of, r.phase], ["calls", "bash", "echo 1", 0, 5, "Set up"]);
  m = [...m, called("c1", "bash"), result("c1", "1\n")];
  r = nextReply(s, "root", m);
  assert.deepEqual([r.kind, r.calls[0].name, r.done], ["calls", "subagent", 1]);
  m = [...m, called("c2", "subagent"), result("c2", "started subagent 0a1b2c3d-0000")];
  r = nextReply(s, "root", m);
  assert.deepEqual([r.kind, r.text, r.done, r.children], ["text", "Waiting.", 3, ["0a1b2c3d-0000"]]);
  m = [...m, said("Waiting.")];
  assert.equal(nextReply(s, "root", m).text, "Still waiting for helper.");
  m = [...m, { role: "user", source: { childId: "0a1b2c3d-0000" }, content: [{ type: "text", text: "subagent 0a1b2c3d-0000 finished" }] }];
  r = nextReply(s, "root", m);
  assert.deepEqual([r.kind, r.calls[0].args.command, r.phase], ["calls", "echo 2", "Finish"]);
  // a bash call that exits non-zero stops the scenario; nothing is retried
  const failed = nextReply(s, "root", [...m, called("c3", "bash"), result("c3", "boom\n[exit code: 2]")]);
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /agents\.root\[3\] failed/);
  r = nextReply(s, "root", [...m, called("c3", "bash"), result("c3", "2\n")]);
  assert.deepEqual([r.kind, r.text, r.done, r.of], ["text", "All done.", 5, 5]);

  // Progress: a registered run, its child's steps, passing on the root's last step
  let clock = 1_000;
  const scenarios = new Map([["small", s]]);
  const state = join(dir, "state");
  let progress = new Progress(scenarios, state, () => clock);
  assert.throws(() => progress.register("small", "sim", "root-1"), /backend/);
  progress.register("small", "mocked", "root-1");
  assert.equal(progress.get("small", "mocked").state, "running");
  progress.report("small", "root", { kind: "text", done: 3, of: 5, phase: "Set up", children: ["child-1"] }, "root-1");
  assert.equal(progress.rootOf("child-1"), "root-1");
  progress.report("small", "helper", { kind: "text", done: 2, of: 2, phase: null, children: [] }, "child-1");
  assert.deepEqual([progress.get("small", "mocked").done, progress.get("small", "mocked").of], [5, 7]);
  clock += 5_000;
  progress.report("small", "root", { kind: "text", done: 5, of: 5, phase: "Finish", children: [] }, "root-1");
  const passed = progress.get("small", "mocked");
  assert.deepEqual([passed.state, passed.phase, passed.ended - passed.started], ["passed", "Finish", 5_000]);
  assert.equal(runText(passed), "Passed · 0:05");
  // a scenario error fails the run; a later report changes nothing
  progress.register("small", "real", "root-2");
  progress.report("small", "root", { kind: "error", done: 1, of: 5, phase: null, children: [], message: "agents.root[1] failed" }, "root-2");
  assert.deepEqual([progress.get("small", "real").state, progress.get("small", "real").error], ["failed", "root: agents.root[1] failed"]);
  // an aborted request fails a running run
  progress.register("small", "real", "root-3");
  progress.stop("root-3", "root");
  assert.equal(progress.get("small", "real").error, "stopped while root worked");
  // Stop: the run fails and none of its agents, children included, gets another step
  progress.register("small", "real", "root-3b");
  progress.report("small", "root", { kind: "calls", done: 1, of: 5, phase: null, children: ["child-3b"] }, "root-3b");
  assert.equal(progress.refusal("child-3b"), null);
  assert.equal(progress.halt("root-3b").error, "stopped");
  assert.deepEqual([progress.refusal("root-3b"), progress.refusal("child-3b")], ["the run ended: stopped", "the run ended: stopped"]);
  assert.throws(() => progress.halt("nobody"), /no run's root/);
  // a newer run of the same scenario and backend replaces the older one's Sessions
  progress.register("small", "real", "root-3c");
  assert.equal(progress.refusal("root-3b"), "a newer run of this scenario replaced this one");
  assert.equal(progress.refusal("not-a-run"), null);
  // the time limit: past it the run fails as timedOut, and the adapter answers no further step
  progress.register("small", "mocked", "root-4");
  clock += LIMIT_MS + 1;
  assert.equal(progress.refusal("root-4"), "the run is over its 15-minute limit");
  const late = progress.get("small", "mocked");
  assert.deepEqual([late.state, late.timedOut, late.error], ["failed", true, "over the 15-minute limit"]);
  // a run still running when dsh web restarts reads as interrupted
  progress.register("small", "real", "root-5");
  progress = new Progress(scenarios, state, () => clock);
  assert.deepEqual([progress.get("small", "real").state, progress.get("small", "real").error], ["failed", "interrupted: dsh web restarted"]);
  assert.deepEqual(progress.sessionOf("root-4"), { scenario: "small", backend: "mocked" });

  // The adapter: a tool call for the next step, no step past the limit
  const adapter = createAdapter(class {}, scenarios, progress);
  const collect = async (options) => { const out = []; for await (const e of adapter.stream(options)) out.push(e); return out; };
  progress.register("small", "mocked", "root-6");
  const events = await collect({ model: "small", sessionId: "root-6", tools: [{ name: "bash" }, { name: "subagent" }], messages: [user("Run the scenario.")] });
  const call = events.find((e) => e.type === "block-end" && e.block.type === "tool-call").block;
  assert.deepEqual([call.name, JSON.parse(call.arguments).command, events.at(-1).reason.kind], ["bash", "echo 1", "tool-calls"]);
  clock += LIMIT_MS + 1;
  const stopped = await collect({ model: "small", sessionId: "root-6", tools: [{ name: "bash" }], messages: [user("Run the scenario.")] });
  assert.equal(stopped.at(-1).reason.failure.code, "MOCK_TIME_LIMIT");
  const missing = await collect({ model: "small", sessionId: "x", tools: [{ name: "subagent" }], messages: [user("Run the scenario.")] });
  assert.equal(missing.at(-1).reason.failure.code, "MOCK_TOOL_NOT_OFFERED");

  // The route: the list, a run's root Session, and refusals
  let handler;
  registerRoutes({ connection: { requestRejection: () => undefined }, effect: (f) => f(), webServer: { register: (r) => { handler = r.handler; return () => {}; } } },
    { scenarios, progress, workspace: join(dir, "Scenarios"), preset: "p", provider: "layerfs-mock", prompt: "Run the scenario." });
  const ask = async (method, url, body) => {
    const req = { method, url, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
    const res = { statusCode: 0, setHeader() {}, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handler(req, res);
    return res;
  };
  const list = await ask("GET", "/layerfs-mock");
  assert.deepEqual([list.statusCode, list.body.provider, list.body.scenarios[0].id, list.body.scenarios[0].agents], [200, "layerfs-mock", "small", ["root", "helper"]]);
  assert.equal((await ask("GET", "/layerfs-mock/session/nobody")).statusCode, 404);
  assert.equal((await ask("POST", "/layerfs-mock/small/session", { backend: "sim", sessionId: "s" })).statusCode, 400);
  assert.equal((await ask("POST", "/layerfs-mock/nope/session", { backend: "mocked", sessionId: "s" })).statusCode, 404);
  assert.equal((await ask("POST", "/layerfs-mock/small/session", { backend: "real", sessionId: "root-7" })).statusCode, 200);
  const session = await ask("GET", "/layerfs-mock/session/root-7");
  assert.deepEqual([session.body.scenario, session.body.backend, session.body.run.state], ["small", "real", "running"]);
  const halted = await ask("POST", "/layerfs-mock/session/root-7/stop", {});
  assert.deepEqual([halted.statusCode, halted.body.state, halted.body.error], [200, "failed", "stopped"]);
  assert.equal((await ask("POST", "/layerfs-mock/session/nobody/stop", {})).statusCode, 404);
  const refused = await collect({ model: "small", sessionId: "root-7", tools: [{ name: "bash" }], messages: [user("Run the scenario.")] });
  assert.equal(refused.at(-1).reason.failure.code, "MOCK_RUN_ENDED");

  // The client: projects, the queue's limits per backend, and run text
  assert.equal(projectOf("tour", "mocked"), "mock-tour-mocked");
  assert.ok(isScenarioProject("mock-tour-real") && !isScenarioProject("mock-tour") && !isScenarioProject("tour-mocked"));
  const queue = ["a:mocked", "b:real", "c:mocked", "d:mocked", "e:mocked", "f:mocked", "g:real", "h:real"];
  assert.deepEqual(nextStarts(queue, "mocked", 0), ["a:mocked", "c:mocked", "d:mocked", "e:mocked"]);
  assert.deepEqual(nextStarts(queue, "mocked", 3), ["a:mocked"]);
  assert.deepEqual(nextStarts(queue, "real", 1), ["b:real"]);
  assert.deepEqual(nextStarts(queue, "real", 2), []);
  assert.equal(runText({ state: "running", done: 7, of: 23, phase: "Commit", started: 0, ended: null }), "Step 7 of 23 · Commit");
  assert.equal(runText({ state: "failed", done: 14, of: 31, phase: null, started: 0, ended: 65_000 }), "Failed at step 14 of 31 · 1:05");

  console.log(`mock: ok (${shipped.size} scenarios)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
