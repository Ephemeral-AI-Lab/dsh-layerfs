// The demo checks' pure parts: a replay's recorded refs and the expected
// outcomes gate. No Docker, no project.
//   node tools/checks/tests/checks.mjs
import assert from "node:assert/strict";
import { expectedOutcomes, openContainers } from "../gates.mjs";
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
// call's first line may end after a later call's lines. The SDK's workspace.*
// lines answer a record's sandbox.* entries; a recorded sandbox.create or
// sandbox.close no longer has a call and leaves nothing to match (#373).
const bash = (at, expect) => ({ kind: "call", call: { name: "bash", args: { description: at } }, expect, at, retry: null });
const scenario = { agents: { root: [
  bash("root[0]", ["sandbox.create:Ready"]),
  bash("root[1]", ["running", "sandbox.exec:exit:0"]),
  bash("root[3]", ["fs.write:Committed", "sandbox.unmount:Busy"]),
  bash("root[5]", ["sandbox.commit:Committed", "sandbox.close:Closed"]),
] } };
const line = (step, start, method, kind) => ({ step, start: `2026-10-20T09:09:${start}Z`, method, ok: true, kind });
const lines = [
  line("b", "07.245", "fs.write", "Committed"),
  line("a", "07.225", "operator.process.start", "running"),
  { ...line("b", "07.349", "workspace.unmount"), ok: false, code: "Busy" },
  line("a", "18.408", "workspace.exec", "exit:0"),
  line("c", "19.000", "workspace.commit", "Committed"),
];
assert.deepEqual(expectedOutcomes(scenario, () => lines).failures, []);
assert.equal(expectedOutcomes({ agents: { root: [bash("root[1]", ["sandbox.exec:exit:1"])] } }, () => lines).failures.length, 1);
// the closed check: an idle-closed Sandbox's stopped container has closed; a running one has not
const ps = (out) => (file, args) => { assert.deepEqual(args.slice(2, 6), ["ps", "-a", "--filter", "volume=v"]); return out; };
assert.deepEqual(openContainers("v", "/d.sock", ps("layerfs-p-1 exited\nlayerfs-p-2 created\nold dead\n")), []);
assert.deepEqual(openContainers("v", "/d.sock", ps("layerfs-p-1 exited\nlayerfs-p-2 running\nlayerfs-p-3 restarting\n")), ["layerfs-p-2 running", "layerfs-p-3 restarting"]);
console.log("checks: ok");
