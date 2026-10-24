import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/adapter.js";
import { nextReply } from "../src/plan.js";
import { Progress } from "../src/progress.js";
import { compileScenario } from "../src/scenario.js";
import { registerRoutes } from "../src/routes.js";

const directory = mkdtempSync(join(tmpdir(), "layerfs-progress-failures-"));
try {
  const scenario = compileScenario(
    {
      type: "layerfs-scenario",
      version: 3,
      title: "Failure propagation",
      tags: ["cli", "multi-agent"],
      agents: {
        root: [
          { subagent: { description: "helper", prompt: "Help now." } },
          { reply: "Waiting.", until: ["helper"] },
          { bash: { description: "finish", command: "echo finish" } },
          { reply: "Finished." },
        ],
        helper: [{ bash: { description: "work", command: "echo work" } }, { reply: "Helped." }],
      },
    },
    { name: "failure", folder: directory },
  );
  const scenarios = new Map([[scenario.name, scenario]]);
  const user = (text, source) => ({ role: "user", content: [{ type: "text", text }], source });
  const child = "12345678-abcd";
  const messages = [
    user("Run."),
    { role: "assistant", content: [{ type: "tool-call", id: "spawn", name: "subagent", arguments: "{}" }] },
    { role: "tool", toolCallId: "spawn", content: [{ type: "text", text: `started subagent ${child}` }] },
    { role: "assistant", content: [{ type: "text", text: "Waiting." }] },
  ];
  for (const ending of [
    "failed before it finished.",
    "was stopped before it finished.",
    "ran out of room before it finished.",
    "declined the task.",
    "ended abnormally (unknown) before it finished.",
  ]) {
    const summary = `Background subagent ${child} ${ending}`;
    for (const source of [undefined, { kind: "subagent-settled", senderSessionId: child, summary }]) {
      const reply = nextReply(scenario, "root", [...messages, user(summary, source)]);
      assert.equal(reply.kind, "error");
      assert.equal(reply.message, summary);
    }
  }
  assert.equal(
    nextReply(scenario, "root", [...messages, user(`Background subagent ${child} finished.`)]).calls[0].args.command,
    "echo finish",
  );
  assert.equal(
    nextReply(scenario, "root", [...messages, user("Background subagent 99999999-abcd failed before it finished.")])
      .text,
    "Still waiting for helper.",
  );

  let now = 100;
  const progress = new Progress(scenarios, directory, () => now);
  progress.register("failure", "root", "mock-failure-unique");
  const adapter = createAdapter(class {}, scenarios, progress, () => {
    throw new Error("launcher failed");
  });
  const collect = async (adapter, options) => {
    const out = [];
    for await (const item of adapter.stream(options)) out.push(item);
    return out;
  };
  const options = { model: "failure", sessionId: child, messages: [user("Help now.")], tools: [{ name: "bash" }] };
  const failed = await collect(adapter, options);
  assert.equal(failed.at(-1).reason.failure.code, "MOCK_FAILED");
  assert.equal(progress.get("failure").state, "running", "child's parent is not known before the spawn result");
  now = 150;
  progress.report("failure", "root", nextReply(scenario, "root", messages), "root");
  assert.equal(progress.get("failure").state, "failed");
  assert.equal(progress.get("failure").error, "helper: launcher failed");
  assert.equal(progress.get("failure").ended, 150);
  assert.equal(progress.get("failure").project, "mock-failure-unique");
  assert.match(progress.refusal(child), /launcher failed/);
  assert.equal(new Progress(scenarios, directory).get("failure").error, "helper: launcher failed");

  progress.register("failure", "new-root");
  progress.fail("root", "root", "old failure");
  assert.equal(progress.get("failure").state, "running", "old runs cannot fail their replacements");
  const missing = await collect(createAdapter(class {}, scenarios, progress), {
    ...options,
    sessionId: "new-root",
    messages: [user("Run.")],
  });
  assert.equal(missing.at(-1).reason.failure.code, "MOCK_TOOL_NOT_OFFERED");
  assert.equal(progress.get("failure").state, "failed");
  assert.match(progress.get("failure").error, /subagent.*does not offer/);

  progress.register("failure", "third-root");
  progress.report("failure", "helper", { kind: "error", message: "bad exit", children: [] }, "early-child");
  progress.report("failure", "root", { kind: "text", done: 3, of: 3, children: ["early-child"] }, "third-root");
  assert.equal(progress.get("failure").state, "failed", "pending child error takes precedence over root completion");
  assert.equal(progress.get("failure").error, "helper: bad exit");

  let handler;
  registerRoutes(
    {
      effect(fn) {
        fn();
      },
      connection: { requestRejection() {} },
      webServer: {
        register(route) {
          handler = route.handler;
        },
      },
    },
    { scenarios, progress, workspace: directory, preset: "p", provider: "p", prompt: "Run." },
  );
  for (const [project, expected] of [
    ["mock-failure-next", 200],
    ["unrelated", 400],
    [123, 400],
  ]) {
    let response;
    const req = {
      method: "POST",
      url: "/layerfs-mock/failure/session",
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({ sessionId: "route-root", project });
      },
    };
    const res = {
      setHeader() {},
      end(body) {
        response = JSON.parse(body);
      },
    };
    await handler(req, res);
    assert.equal(res.statusCode, expected);
    if (expected === 200) assert.equal(response.run.project, project);
  }
  for (const sessionId of ["third-root", "route-root"]) {
    let response;
    const res = {
      setHeader() {},
      end(body) {
        response = JSON.parse(body);
      },
    };
    await handler({ method: "GET", url: `/layerfs-mock/session/${sessionId}` }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(response.scenario, "failure");
    if (sessionId === "third-root")
      assert.equal(response.run, null, "an older Session must not show its replacement's run or project");
    else {
      assert.equal(response.run.sessionId, sessionId);
      assert.equal(response.run.project, "mock-failure-next");
    }
  }
  console.log(
    "PASS: adapter failures, child-registration race, failed settlement notices, persistent project identity, old-session isolation",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
