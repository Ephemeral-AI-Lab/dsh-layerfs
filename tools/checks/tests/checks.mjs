// The checks' pure parts: a replay's recorded refs, the expected outcomes
// gate and the run checker (run.mjs) on a made-up profile. No Docker, no
// project.
//   node tools/checks/tests/checks.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeOf, expectedOutcomes, matches, openContainers } from "../gates.mjs";
import { checkRun } from "../run.mjs";
import { differenceAt, runIndex } from "../refs.mjs";

// a ref counts the record's Commits; skipped optional ones and extra ones shift it
const none = { skipped: [], extra: [] };
assert.equal(runIndex(3, none), 3);
// Crew's people.5: the record's #1 and #4 were optional and this run skipped both
assert.equal(runIndex(6, { skipped: [1, 4], extra: [] }), 4);
// a ref to a skipped Commit names the one before it; none before: -1
assert.equal(runIndex(4, { skipped: [1, 4], extra: [] }), 2);
assert.equal(runIndex(0, { skipped: [0], extra: [] }), -1);
// an extra Commit at this run's #2 moves every later ref one on
assert.equal(runIndex(1, { skipped: [], extra: [2] }), 1);
assert.equal(runIndex(3, { skipped: [], extra: [2] }), 4);
// where each difference is noted, from the Branch's own Commits after the call
assert.equal(differenceAt("skipped", 1, none), 1); // record #0 made, #1 skipped
assert.equal(differenceAt("skipped", 3, { skipped: [1], extra: [] }), 4);
assert.equal(differenceAt("extra", 3, none), 2);
assert.equal(differenceAt("skipped", 3, { skipped: [], extra: [2] }), 2);

// expected outcomes: bash calls in the order they began, though a background
// call's first line may end after a later call's lines; codes are the SDK's
// method names as the trace writes them
const bash = (at, expect) => ({ kind: "call", call: { name: "bash", args: { description: at } }, expect, at });
const scenario = { agents: { root: [
  bash("root[0]", ["sandbox.create:ok"]),
  bash("root[1]", ["running", "workspace.exec:exit:0"]),
  bash("root[3]", ["fs.write:Committed", "workspace.unmount:Busy"]),
  bash("root[5]", ["workspace.commit:Committed", "sandbox.close:Closed"]),
] } };
const line = (step, start, method, kind) => ({ step, start: `2026-10-20T09:09:${start}Z`, method, ok: true, kind });
const lines = [
  line("z", "06.000", "sandbox.create"),
  line("b", "07.245", "fs.write", "Committed"),
  line("a", "07.225", "backend.daemon.process.start", "running"),
  { ...line("b", "07.349", "workspace.unmount"), ok: false, code: "Busy" },
  line("a", "18.408", "workspace.exec", "exit:0"),
  line("c", "19.000", "workspace.commit", "Committed"),
  line("c", "19.100", "sandbox.close", "Closed"),
];
assert.deepEqual(expectedOutcomes(scenario, () => lines).failures, []);
assert.equal(codeOf(lines[0]), "sandbox.create:ok");
assert.equal(codeOf(lines[3]), "workspace.unmount:Busy");
// a code of the older SDK matches no line of today's
assert.equal(expectedOutcomes({ agents: { root: [bash("root[0]", ["sandbox.exec:exit:0"])] } }, () => [lines[4]]).failures.length, 1);
assert.equal(expectedOutcomes({ agents: { root: [bash("root[1]", ["workspace.exec:exit:1"])] } }, () => [lines[4]]).failures.length, 1);

// | alternatives share what precedes the last ":" before the first "|"
assert.ok(matches("workspace.exec:exit:0", "workspace.exec:exit:1|0"));
assert.ok(matches("workspace.exec:exit:1", "workspace.exec:exit:1|0"));
assert.ok(!matches("workspace.exec:exit:2", "workspace.exec:exit:1|0"));
assert.ok(matches("workspace.commit:UpToDate", "workspace.commit:Committed|UpToDate"));
assert.ok(!matches("fs.write:UpToDate", "workspace.commit:Committed|UpToDate"));
assert.ok(matches("workspace.mount:Mounted", "Mounted") && matches("workspace.exec:exit:0", "exit:0") && !matches("workspace.exec:exit:10", "exit:0"));
const either = (kind) => expectedOutcomes({ agents: { root: [bash("root[0]", ["workspace.exec:exit:1|0", "workspace.commit:Committed|UpToDate"])] } },
  () => [line("a", "01.000", "workspace.exec", "exit:1"), line("a", "02.000", "workspace.commit", kind)]).failures;
assert.deepEqual(either("UpToDate"), []);
assert.equal(either("Committed").length, 0);
assert.equal(either("Merged").length, 1);

// a bash step without expect may have LayerFS lines: one unmatched call per such step is passed over, no more
const free = { kind: "call", call: { name: "bash", args: { description: "free" } }, expect: null, at: "root[1]" };
const two = [line("p", "01.000", "fs.write", "Committed"), line("q", "02.000", "branch.fork", "Forked")];
assert.deepEqual(expectedOutcomes({ agents: { root: [free, bash("root[2]", ["branch.fork:Forked"])] } }, () => two).failures, []);
assert.match(expectedOutcomes({ agents: { root: [bash("root[2]", ["branch.fork:Forked"])] } }, () => two).failures[0], /root\[2\].*\[fs\.write:Committed\]/);
// a failed step does not take the next step's call
const failedFirst = expectedOutcomes({ agents: { root: [bash("root[0]", ["fs.write:UpToDate"]), bash("root[1]", ["branch.fork:Forked"])] } }, () => two).failures;
assert.equal(failedFirst.length, 1);
assert.match(failedFirst[0], /^root\[0\]/);

// run.mjs: a run's record, its journal of root and subagent lines, and the scenario it played
const home = mkdtempSync(join(tmpdir(), "checks-run-"));
try {
  const scenarios = join(home, "scenarios"), profile = join(home, "profile");
  mkdirSync(join(scenarios, "small"), { recursive: true });
  writeFileSync(join(scenarios, "small", "scenario.json"), JSON.stringify({
    type: "layerfs-scenario", version: 3, title: "Small", layerfs: ["real"],
    agents: {
      root: [{ bash: { description: "fork", command: "layerfs branch fork cart" }, expect: ["branch.fork:Forked"] }, { subagent: { description: "helper", prompt: "Help." } }, { reply: "Waiting.", until: ["helper"] }, { bash: { description: "log", command: "layerfs branch list_commits cart" } }],
      helper: [{ bash: { description: "apply", command: 'layerfs fs apply cart --from "{{scenario}}/changes/000.json"' }, expect: ["fs.apply:Committed|UpToDate"] }],
    },
  }));
  mkdirSync(join(profile, "dsh-layerfs-mock"), { recursive: true });
  mkdirSync(join(profile, "dsh-layerfs", "lines"), { recursive: true });
  const record = (state, error = null) => writeFileSync(join(profile, "dsh-layerfs-mock", "runs.json"), JSON.stringify({
    sessions: { "session-r1": { scenario: "small", backend: "real" } },
    runs: { "small:real": { sessionId: "session-r1", state, error, agents: {}, started: 0, ended: 4200 } },
  }));
  record("passed");
  const journal = (rows) => writeFileSync(join(profile, "dsh-layerfs", "lines", "session-r1.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  journal([
    { ...line("s1", "01.000", "project.list_branches"), agent: "main", agentId: "session-r1" },
    { ...line("s1", "01.100", "branch.fork", "Forked"), agent: "main", agentId: "session-r1" },
    { ...line("s2", "02.000", "fs.apply", "UpToDate"), agent: "helper", agentId: "child-1" },
  ]);
  let result = checkRun(profile, "r1", scenarios);
  assert.deepEqual([result.scenario, result.backend, result.project, result.failures], ["small", "real", "mock-small-real", []]);
  assert.deepEqual(result.notRun, []);
  // a failed run, a line of an agent the scenario lacks, and a missing outcome fail
  record("failed", "root: agents.root[0] failed");
  journal([{ ...line("s2", "02.000", "fs.apply", "UpToDate"), agent: "helper", agentId: "child-1" }, { ...line("s3", "03.000", "fs.write", "Committed"), agent: "agent-0a1b", agentId: "child-2" }]);
  result = checkRun(profile, "session-r1", scenarios);
  assert.equal(result.failures.length, 3, result.failures.join("\n"));
  assert.match(result.failures.join("\n"), /run: failed \(root: agents\.root\[0\] failed\)[^]*agent named agent-0a1b[^]*root: no LayerFS calls/);
  // a recorded final.json: the order and final-tree checks are reported, not run
  writeFileSync(join(scenarios, "small", "final.json"), "{}");
  assert.match(checkRun(profile, "r1", scenarios).notRun[0], /NOT_RUN/);
  assert.throws(() => checkRun(profile, "nobody", scenarios), /no scripted run's root Session/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

// the closed check: an idle-closed Sandbox's stopped container has closed; a running one has not
const ps = (out) => (file, args) => { assert.deepEqual(args.slice(2, 6), ["ps", "-a", "--filter", "volume=v"]); return out; };
assert.deepEqual(openContainers("v", "/d.sock", ps("layerfs-p-1 exited\nlayerfs-p-2 created\nold dead\n")), []);
assert.deepEqual(openContainers("v", "/d.sock", ps("layerfs-p-1 exited\nlayerfs-p-2 running\nlayerfs-p-3 restarting\n")), ["layerfs-p-2 running", "layerfs-p-3 restarting"]);
console.log("checks: ok");
