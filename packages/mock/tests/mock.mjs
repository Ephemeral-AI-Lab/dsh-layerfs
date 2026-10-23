// The LayerFS scripted model without dsh: every scenario in scenarios/ loads;
// a scenario's replies follow its conversation (plan.js), a failed bash call
// stops it; a run's progress, its 15-minute limit and a restart (progress.js);
// the /layerfs-mock route (routes.js); the adapter's replies (adapter.js);
// and the client's queue and run text (client scenarios.ts).
//   node packages/mock/tests/mock.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/adapter.js";
import { agentOf, nextReply } from "../src/plan.js";
import { LIMIT_MS, Progress } from "../src/progress.js";
import { registerRoutes } from "../src/routes.js";
import { compileScenario, loadScenarios, ScenarioError } from "../src/scenario.js";
import { writeSeed } from "../src/seed.js";
import { allTags, isScenarioProject, nextStarts, projectOf, runText, withTags } from "../../client/src/client/scenarios.ts";

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-mock-"));
try {
  // Every shipped scenario loads, in order, with its fixture
  const scenariosDir = fileURLToPath(new URL("../../../scenarios/", import.meta.url));
  const shipped = loadScenarios(scenariosDir);
  const folders = readdirSync(scenariosDir).filter((name) => existsSync(join(scenariosDir, name, "scenario.json")));
  assert.equal(shipped.size, folders.length, `${shipped.size} of ${folders.length} scenario folders load`);
  for (const [id, s] of shipped) {
    assert.ok(s.fixture || s.seed, `${id} names its fixture`);
    for (const steps of Object.values(s.agents)) for (const st of steps) {
      // a Sandbox is named by a variable or {{sandbox}}, never a hard-coded id
      if (st.kind === "call" && st.call.name === "bash") assert.ok(!/\blf\.workspace\.mount\("(?!\{\{sandbox\}\}")|\blayerfs workspace mount "?[0-9]/.test(st.call.args.command), `${st.at} mounts in a hard-coded Sandbox`);
    }
  }
  assert.throws(() => compileScenario({ type: "layerfs-scenario", version: 3, title: "x", tags: ["cli", "merge"], layerfs: ["real"], agents: { root: [{ reply: "hi" }] } }, { name: "x", folder: dir }), /unknown field layerfs/);
  assert.throws(() => compileScenario({ type: "layerfs-scenario", version: 3, title: "x", tags: ["cli", "merge"], agents: { root: [{ pause: 2 }] } }, { name: "x", folder: dir }), ScenarioError, "no pause steps");

  // {{scenario}} in a bash command is the scenario folder's absolute path; nothing else is replaced
  const one = (command, folder = dir, expect) => compileScenario({
    type: "layerfs-scenario", version: 3, title: "x", tags: ["cli", "merge"],
    agents: { root: [{ bash: { description: "apply", command }, ...(expect ? { expect } : {}) }] },
  }, { name: "x", folder }).agents.root[0].call.args.command;
  assert.equal(one('layerfs fs apply main --from "{{scenario}}/changes/007.json" && cat "{{scenario}}/a"'), `layerfs fs apply main --from "${dir}/changes/007.json" && cat "${dir}/a"`);
  assert.equal(one("docker ps --format '{{.Names}}' {{ scenario }}"), "docker ps --format '{{.Names}}' {{ scenario }}");
  assert.equal(one('cat "{{scenario}}/x"', "relative/folder"), `cat "${join(process.cwd(), "relative/folder")}/x"`);
  // a folder double quotes would not keep as written is refused, but only where {{scenario}} is used
  for (const bad of ['a"b', "a$b", "a`b", "a\\b"]) {
    assert.throws(() => one('cat "{{scenario}}/x"', join(dir, bad)), (e) => e instanceof ScenarioError && /agents\.root\[0\]\.bash\.command: uses \{\{scenario\}\}/.test(e.message), bad);
    assert.equal(one("echo plain", join(dir, bad)), "echo plain");
  }
  // expect: today's names and | alternatives load; the older SDK's names are refused naming today's
  for (const code of ["workspace.exec:exit:1|0", "workspace.commit:Committed|UpToDate", "sandbox.create:ok", "fs.apply:Committed", "backend.daemon.process.start:running", "Mounted", "exit:0"]) one("echo", dir, [code]);
  const retired = (code, pattern) => assert.throws(() => one("echo", dir, ["branch.fork:Forked", code]), (e) => e instanceof ScenarioError && /agents\.root\[0\]\.expect\[1\]/.test(e.message) && pattern.test(e.message), code);
  retired("sandbox.mount:Mounted", /the trace calls it workspace\.mount \(workspace\.mount:Mounted\)/);
  retired("sandbox.exec:exit:1|0", /workspace\.exec:exit:1\|0/);
  retired("sandbox.commit:Committed|UpToDate", /workspace\.commit:Committed\|UpToDate/);
  retired("sandbox.unmount:Busy", /workspace\.unmount:Busy/);
  retired("operator.process.start:running", /backend\.daemon\.process\.start:running/);
  retired("sandbox.create:Ready", /sandbox\.create:ok/);
  retired("workspace.exec", /write the outcome/);
  retired("workspace.commit:Committed|", /alternative/);
  retired("a|b:c", /alternative/);
  assert.throws(() => one("echo", dir, []), /lists outcome codes/);

  // A long replay: 1,600 bash steps play to the end; each request walks its conversation once
  const long = compileScenario({
    type: "layerfs-scenario", version: 3, title: "Long", tags: ["cli", "merge"],
    agents: { root: [...Array.from({ length: 1600 }, (_, i) => ({ ...(i % 100 ? {} : { phase: `part ${i / 100}` }), bash: { description: `s${i}`, command: `layerfs fs apply main --from "{{scenario}}/changes/${i}.json"` }, expect: ["fs.apply:Committed|UpToDate"] })), { reply: "Replayed." }] },
  }, { name: "long", folder: dir });
  const conversation = [{ role: "user", content: [{ type: "text", text: "Run the scenario." }] }];
  const applied = { traceOf: () => [{ method: "fs.apply", ok: true, kind: "Committed" }], checked: new Set() };
  const began = performance.now();
  for (let i = 0; i < 1600; i++) {
    const step = nextReply(long, "root", conversation, applied);
    assert.equal(step.calls?.[0].args.command, `layerfs fs apply main --from "${dir}/changes/${i}.json"`);
    conversation.push({ role: "assistant", content: [{ type: "tool-call", id: `l${i}`, name: "bash", arguments: "{}" }] }, { role: "tool", toolCallId: `l${i}`, content: [{ type: "text", text: "{}\n" }] });
  }
  const last = nextReply(long, "root", conversation, applied);
  assert.deepEqual([last.kind, last.text, last.done, last.of, last.phase], ["text", "Replayed.", 1601, 1601, "part 15"]);
  // about 0.3 s here; the bound only catches a request that stops being linear in its conversation
  assert.ok(performance.now() - began < 20_000, `1,600 requests took ${Math.round(performance.now() - began)} ms`);

  // A small scenario: two bash calls, a child, and the root's last reply
  const s = compileScenario({
    type: "layerfs-scenario", version: 3, title: "Small", tags: ["cli", "merge"],
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
  assert.match(failed.message, /agents\.root\[3\] exited 2, and the step expects 0/);
  r = nextReply(s, "root", [...m, called("c3", "bash"), result("c3", "2\n")]);
  assert.deepEqual([r.kind, r.text, r.done, r.of], ["text", "All done.", 5, 5]);

  // Live checks and placeholders: a step's exit, its expect against the call's trace lines (read once),
  // {{sandbox}} and {{commit:<ref>}} from what the agent saw, and a Commit id carried by a message
  const live = compileScenario({
    type: "layerfs-scenario", version: 3, title: "Live", tags: ["cli", "conflicts", "multi-agent"],
    agents: {
      root: [
        { bash: { description: "create", command: "layerfs sandbox create" }, expect: ["sandbox.create:ok"] },
        { bash: { description: "work", command: "layerfs workspace mount {{sandbox}} cart" }, expect: ["workspace.mount:Mounted", "workspace.commit:Committed"], commits: ["first"] },
        { bash: { description: "refused", command: "layerfs workspace commit {{ws}}" }, expect: ["workspace.commit:Conflict"], exit: 125 },
        { subagent: { description: "peer", prompt: "Fork from what the lead sends." } },
        { send_message: { agent_id: "@peer", message: "Fork from {{commit:first}} now." } },
        { reply: "Sent.", until: ["peer"] },
        { bash: { description: "log", command: "layerfs branch list_commits side" } },
        { reply: "Peer forked from {{commit:first}}." },
      ],
      peer: [{ reply: "Waiting." }, { bash: { description: "fork", command: "layerfs branch fork side {{commit:first}}" }, expect: ["branch.fork:Forked"] }, { reply: "Forked." }],
    },
  }, { name: "live", folder: dir });
  assert.deepEqual([live.tags, live.form, live.counts], [["cli", "conflicts", "multi-agent"], "cli", { agents: 2, steps: 7, calls: ["branch.fork", "sandbox.create", "workspace.commit", "workspace.mount"] }]);
  const trace = new Map(), reads = [];
  const traceOf = (id) => { reads.push(id); return trace.get(id) ?? []; };
  const line = (method, outcome, ok = true) => ({ method, ok, ...(ok ? (outcome === "ok" ? {} : { kind: outcome }) : { code: outcome }) });
  const checkedLive = new Set();
  const opts = { traceOf, checked: checkedLive };
  let lm = [user("Run the scenario.")];
  assert.equal(nextReply(live, "root", lm, opts).calls[0].args.command, "layerfs sandbox create");
  lm = [...lm, called("l1", "bash"), result("l1", '{"sandbox":"3","image":"sha256:x"}\n')];
  trace.set("l1", [line("sandbox.create", "ok")]);
  assert.equal(nextReply(live, "root", lm, opts).calls[0].args.command, "layerfs workspace mount 3 cart", "{{sandbox}} is the number the agent saw");
  // expect that the trace does not show stops the run, naming what it shows
  lm = [...lm, called("l2", "bash"), result("l2", '{"ws":"3:/workspaces/1"}\n{"kind":"Committed","head":"c0ffee01","commit":{"id":"c0ffee01"}}\n')];
  trace.set("l2", [line("workspace.mount", "Mounted"), line("workspace.commit", "Conflict", false)]);
  assert.match(nextReply(live, "root", lm, opts).message, /agents\.root\[1\] \(work\) expected workspace\.mount:Mounted, workspace\.commit:Committed; its LayerFS calls show workspace\.mount:Mounted, workspace\.commit:Conflict/);
  trace.set("l2", [line("workspace.mount", "Mounted"), line("workspace.commit", "Committed")]);
  assert.equal(nextReply(live, "root", lm, opts).calls[0].args.command, "layerfs workspace commit 3:/workspaces/1");
  // a step's exit: 125 for a refusal it shows; 0 then fails it
  lm = [...lm, called("l3", "bash"), result("l3", '{"code":"Conflict"}\n[exit code: 125]')];
  trace.set("l3", [line("workspace.commit", "Conflict", false)]);
  reads.length = 0;
  assert.equal(nextReply(live, "root", lm, opts).calls[0].name, "subagent");
  assert.deepEqual(reads, ["l3"], "a call whose expect held is not read again");
  assert.match(nextReply(live, "root", [...lm.slice(0, -1), result("l3", "{}\n")], { traceOf }).message, /agents\.root\[2\] exited 0, and the step expects 125/);
  // without a Host, a step with expect stops the run
  assert.match(nextReply(live, "root", lm, {}).message, /no LayerFS Host gives its trace lines/);
  lm = [...lm, called("l4", "subagent"), result("l4", "started subagent 0bad0000-0001")];
  const sent = nextReply(live, "root", lm, opts);
  assert.equal(sent.calls[0].args.message, "Fork from c0ffee01 now.", "a message carries the id the agent's own step printed");
  // the peer finds the id in the message it received, by the sender's text
  const pm = [user("Fork from what the lead sends."), said("Waiting."), user("Message from the lead: Fork from c0ffee01 now.")];
  assert.equal(nextReply(live, "peer", pm, opts).calls[0].args.command, "layerfs branch fork side c0ffee01");
  assert.match(nextReply(live, "peer", [user("Fork from what the lead sends."), said("Waiting."), user("go")], opts).message, /peer has seen no value for \{\{commit:first\}\}/);
  // a commits step must print as many Commits as it names
  assert.match(nextReply(live, "root", [...lm.slice(0, 3), called("l2", "bash"), result("l2", "{}\n")], opts).message, /names 1 Commit\(s\) \(first\) and its call printed 0/);
  // the loader: forms, tags and refs
  const bad = (patch, pattern) => assert.throws(() => compileScenario({ type: "layerfs-scenario", version: 3, title: "B", tags: ["cli", "merge"], agents: { root: [{ bash: { description: "x", command: "layerfs project list_branches" } }] }, ...patch }, { name: "b", folder: dir }), pattern);
  bad({ tags: ["cli"] }, /one to three topics/);
  bad({ tags: ["cli", "sdk", "merge"] }, /exactly one form/);
  bad({ tags: ["cli", "merge", "speedy"] }, /speedy is not a tag/);
  bad({ tags: ["sdk", "merge"] }, /one inline Node script/);
  bad({ agents: { root: [{ bash: { description: "x", command: "node -e 'import(process.env.DSH_LAYERFS_SDK)'" } }] } }, /uses the layerfs command, not the SDK/);
  bad({ agents: { root: [{ bash: { description: "x", command: "layerfs branch fork a {{commit:nowhere}}" } }] } }, /names a Commit no step's commits lists/);
  bad({ agents: { root: [{ bash: { description: "x", command: "layerfs sandbox create --image {{image}}" } }] } }, /names no image/);
  bad({ agents: { root: [{ bash: { description: "x", script: "a.mjs" } }] } }, /unknown field script/);
  const sdk = compileScenario({ type: "layerfs-scenario", version: 3, title: "S", tags: ["sdk", "sandbox"], image: `sha256:${"a".repeat(64)}`,
    agents: { root: [{ bash: { description: "x", command: "# make a Sandbox\nnode --input-type=module <<'JS'\nconsole.log('{{image}}');\nJS" } }] } }, { name: "s", folder: dir });
  assert.match(sdk.agents.root[0].call.args.command, /console\.log\('sha256:a{64}'\)/);

  // Progress: a registered run, its child's steps, passing on the root's last step
  let clock = 1_000;
  const scenarios = new Map([["small", s]]);
  const state = join(dir, "state");
  let progress = new Progress(scenarios, state, () => clock);
  progress.register("small", "root-1");
  assert.equal(progress.get("small").state, "running");
  progress.report("small", "root", { kind: "text", done: 3, of: 5, phase: "Set up", children: ["child-1"] }, "root-1");
  assert.equal(progress.rootOf("child-1"), "root-1");
  progress.report("small", "helper", { kind: "text", done: 2, of: 2, phase: null, children: [] }, "child-1");
  assert.deepEqual([progress.get("small").done, progress.get("small").of], [5, 7]);
  clock += 5_000;
  progress.report("small", "root", { kind: "text", done: 5, of: 5, phase: "Finish", children: [] }, "root-1");
  const passed = progress.get("small");
  assert.deepEqual([passed.state, passed.phase, passed.ended - passed.started], ["passed", "Finish", 5_000]);
  assert.equal(runText(passed), "Passed · 0:05");
  // a scenario error fails the run; a later report changes nothing
  progress.register("small", "root-2");
  progress.report("small", "root", { kind: "error", done: 1, of: 5, phase: null, children: [], message: "agents.root[1] failed" }, "root-2");
  assert.deepEqual([progress.get("small").state, progress.get("small").error], ["failed", "root: agents.root[1] failed"]);
  // an aborted request fails a running run
  progress.register("small", "root-3");
  progress.stop("root-3", "root");
  assert.equal(progress.get("small").error, "stopped while root worked");
  // Stop: the run fails and none of its agents, children included, gets another step
  progress.register("small", "root-3b");
  progress.report("small", "root", { kind: "calls", done: 1, of: 5, phase: null, children: ["child-3b"] }, "root-3b");
  assert.equal(progress.refusal("child-3b"), null);
  assert.equal(progress.halt("root-3b").error, "stopped");
  assert.deepEqual([progress.refusal("root-3b"), progress.refusal("child-3b")], ["the run ended: stopped", "the run ended: stopped"]);
  assert.throws(() => progress.halt("nobody"), /no run's root/);
  // a newer run of the same scenario replaces the older one's Sessions
  progress.register("small", "root-3c");
  assert.equal(progress.refusal("root-3b"), "a newer run of this scenario replaced this one");
  assert.equal(progress.refusal("not-a-run"), null);
  // the time limit: past it the run fails as timedOut, and the adapter answers no further step
  progress.register("small", "root-4");
  clock += LIMIT_MS + 1;
  assert.equal(progress.refusal("root-4"), "the run is over its 15-minute limit");
  const late = progress.get("small");
  assert.deepEqual([late.state, late.timedOut, late.error], ["failed", true, "over the 15-minute limit"]);
  // a run still running when dsh web restarts reads as interrupted
  progress.register("small", "root-5");
  progress = new Progress(scenarios, state, () => clock);
  assert.deepEqual([progress.get("small").state, progress.get("small").error], ["failed", "interrupted: dsh web restarted"]);
  assert.deepEqual(progress.sessionOf("root-4"), { scenario: "small" });

  // The adapter: a tool call for the next step, no step past the limit
  const adapter = createAdapter(class {}, scenarios, progress);
  const collect = async (options) => { const out = []; for await (const e of adapter.stream(options)) out.push(e); return out; };
  progress.register("small", "root-6");
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
  assert.equal((await ask("POST", "/layerfs-mock/small/session", {})).statusCode, 400);
  assert.equal((await ask("POST", "/layerfs-mock/nope/session", { sessionId: "s" })).statusCode, 404);
  assert.equal((await ask("POST", "/layerfs-mock/small/session", { sessionId: "root-7" })).statusCode, 200);
  const session = await ask("GET", "/layerfs-mock/session/root-7");
  assert.deepEqual([session.body.scenario, session.body.run.state], ["small", "running"]);
  const halted = await ask("POST", "/layerfs-mock/session/root-7/stop", {});
  assert.deepEqual([halted.statusCode, halted.body.state, halted.body.error], [200, "failed", "stopped"]);
  assert.equal((await ask("POST", "/layerfs-mock/session/nobody/stop", {})).statusCode, 404);
  const refused = await collect({ model: "small", sessionId: "root-7", tools: [{ name: "bash" }], messages: [user("Run the scenario.")] });
  assert.equal(refused.at(-1).reason.failure.code, "MOCK_RUN_ENDED");

  // The client: projects, the queue's limit, and run text
  assert.equal(projectOf("tour"), "mock-tour");
  assert.ok(isScenarioProject("mock-tour") && !isScenarioProject("tour") && !isScenarioProject("mock-"));
  assert.deepEqual(nextStarts(["a", "b", "c"], 0), ["a", "b"]);
  assert.deepEqual(nextStarts(["a", "b", "c"], 1), ["a"]);
  assert.deepEqual(nextStarts(["a", "b", "c"], 2), []);
  const tagged = [{ id: "a", tags: ["sdk", "merge"] }, { id: "b", tags: ["cli", "rust", "merge"] }, { id: "c", tags: ["cli", "conflicts"] }];
  assert.deepEqual(allTags(tagged), ["cli", "sdk", "rust", "conflicts", "merge"]);
  assert.deepEqual(withTags(tagged, ["cli", "merge"]).map((t) => t.id), ["b"]);
  assert.equal(withTags(tagged, []).length, 3);
  assert.equal(runText({ state: "running", done: 7, of: 23, phase: "Commit", started: 0, ended: null }), "Step 7 of 23 · Commit");
  assert.equal(runText({ state: "failed", done: 14, of: 31, phase: null, started: 0, ended: 65_000 }), "Failed at step 14 of 31 · 1:05");

  // A seed file as the fixture: checked when the scenario loads, written out
  // whole (a .git/HEAD included, modes kept), replacing what was there
  const seeded = join(dir, "seeded");
  mkdirSync(seeded);
  const seedFile = join(seeded, "seed.json");
  writeFileSync(seedFile, JSON.stringify({ format: "layerfs-demo-seed", version: 1, entries: {
    "/.git": { type: "dir", mode: 0o755 }, "/.git/HEAD": { type: "file", mode: 0o644, text: "ref: refs/heads/main\n" },
    "/bin/run": { type: "file", mode: 0o755, base64: Buffer.from("#!/bin/sh\n").toString("base64") }, "/link": { type: "symlink", target: "bin/run" },
  } }));
  const minimal = { type: "layerfs-scenario", version: 3, title: "Seeded", tags: ["cli", "merge"], fixture: "seed.json", agents: { root: [{ reply: "done" }] } };
  const compiled = compileScenario(minimal, { name: "seeded", folder: seeded });
  assert.equal(compiled.seed, seedFile);
  assert.equal(compiled.fixture, null);
  const out = join(dir, "seeds", "seeded");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "stale"), "x");
  assert.equal(writeSeed(seedFile, out), out);
  assert.equal(readFileSync(join(out, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.equal(statSync(join(out, "bin/run")).mode & 0o777, 0o755);
  assert.equal(readlinkSync(join(out, "link")), "bin/run");
  assert.ok(!existsSync(join(out, "stale")));
  writeFileSync(seedFile, JSON.stringify({ format: "layerfs-demo-seed", version: 1, entries: { "/../x": { type: "file", text: "" } } }));
  assert.throws(() => compileScenario(minimal, { name: "seeded", folder: seeded }), /fixture.*not a plain absolute path/);
  assert.throws(() => compileScenario({ ...minimal, fixture: "missing.json" }, { name: "seeded", folder: seeded }), /missing\.json is not a file/);

  console.log(`mock: ok (${shipped.size} scenarios)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
