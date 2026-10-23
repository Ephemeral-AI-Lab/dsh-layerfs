// Replays a recorded SDK trace through the view model: the Branches, heads
// and Sandboxes LayerFS reported, attribution, and the merge cases of #347
// row 51. Ported from the former sdk_sim/test_dsh_view.mjs's trace mode.
// The fixture is a trace of the older SDK (sandbox.* calls, one Sandbox per
// create); its recorder used that API and was deleted with it (#373).
//   node dsh/packages/model/tests/trace.mjs [trace.jsonl]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as X from "../src/index.js";

const file = process.argv[2] || new URL("./fixtures/real-trace.jsonl", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("./fixtures/real-trace.expect.json", import.meta.url), "utf8"));
const lines = X.parseTrace(readFileSync(file, "utf8"));
const E = new X.ReplayEngine({ project: expected.project });
const w = X.createView(E, { lead: "main" });
X.derive(w);
for (const st of X.traceSteps(lines)) await X.runStep(w, st, {});
const s = E.s;
// Branches and heads, Sandboxes and their Workspaces, as LayerFS reported them at the end
const branches = Object.fromEntries(s.branchOrder.map((b) => [b, E.m.real(s.branches[b].head) ?? null]));
assert.deepEqual(branches, expected.branches);
assert.equal(E.m.real(s.main.head), expected.mainLayer);
assert.deepEqual(s.sandboxOrder.map((id) => [E.m.real(id), s.sandboxes[id].closed]), expected.sandboxes);
assert.deepEqual(Object.keys(w.ws), [], "nothing mounted at the end");
// attribution: every call in the trace is the main agent's; the script's step groups them
for (const [node, by] of Object.entries(w.attrib)) assert.equal(by, "main", node);
assert.ok(Object.keys(w.attrib).length >= expected.minNodes);
assert.ok(w.hist.every((h) => h.group === expected.step) && w.hist.length > 0);
// A merge that needs no Commit (head null) makes a fresh Branch on main's Layer, and a
// later merge with an unknown Commit is a new Commit, not a fast-forward to it (#347 row 51)
const R = new X.ReplayEngine({ project: "p" }), L0 = "a".repeat(64), C1 = "12" + "b".repeat(64);
const end = (method, args, rest) => R.apply({ method, args, ok: true, phase: "end", ...rest });
end("project.init", {}, {});
end("branch.fork", { name: "a", from: "main" }, { branch: "a", base: L0, head: null });
end("branch.merge", { branch: "a", with: "main", name: "b" }, { branch: "b", head: null });
end("branch.merge", { branch: "b", with: "main", name: "c" }, { branch: "c", head: C1, commit: C1 });
end("branch.fork", { name: "d", from: "c" }, { branch: "d", base: L0, head: C1 });
assert.ok(!("null" in R.s.commits), "no Commit without an id");
assert.equal(R.s.branches.b.head, null);
assert.equal(R.s.branches.b.base, R.s.main.head);
assert.equal(R.m.real(R.s.branches.c.head), C1);
assert.equal(R.s.commits[R.s.branches.c.head].via, "merge");
assert.equal(R.s.branches.d.from, R.s.branches.c.head);
// The Workspace API's lines (#373): a numbered Sandbox, named as its
// container, and a process id that names its Sandbox.
const C2 = "12" + "c".repeat(64), WS = { sandbox: "1", path: "/workspaces/1" };
end("workspace.mount", { branch: "d" }, { sandbox: "1", path: "/workspaces/1", branch: "d", base: C1, baseLayer: L0 });
assert.deepEqual(R.s.sandboxOrder, ["layerfs-p-1"]);
assert.equal(R.s.sandboxes["layerfs-p-1"].workspaces["/workspaces/1"].branch, "d");
assert.equal(end("workspace.exec", { ...WS, command: "npm test" }, { exitCode: 0 }).ok, true);
end("operator.process.start", { ...WS, command: "npm run dev" }, { process: "proc_1_ab" });
assert.equal(R.s.sandboxes["layerfs-p-1"].processes.proc_1_ab.status, "running");
end("operator.process.cancel", { process: "proc_1_ab" }, { kind: "Stopped" });
assert.equal(R.s.sandboxes["layerfs-p-1"].processes.proc_1_ab.status, "stopped");
end("workspace.commit", { ...WS, message: "tests" }, { kind: "Committed", commit: C2 });
assert.equal(R.m.real(R.s.branches.d.head), C2);
end("workspace.unmount", { ...WS }, { kind: "Unmounted" });
assert.equal(R.s.sandboxes["layerfs-p-1"].workspaces["/workspaces/1"].mounted, false);
// A chat's History starts from the project's history (seeded): replaying the
// chat's older calls never moves a Branch head or main back; a new call moves them.
const L1 = "d".repeat(64), C3 = "12" + "e".repeat(64);
end("branch.publish", { branch: "d" }, { commit: C2, layer: L1 });
const S = new X.ReplayEngine({ project: "p" });
S.m.s = structuredClone(R.s); S.m.toLabel = new Map(R.m.toLabel); S.m.toReal = new Map(R.m.toReal);
S.m.next = { ...R.m.next }; S.m.slot = R.m.slot; S.seeded = true;
const old = (method, args, rest) => S.apply({ method, args, ok: true, phase: "end", ...rest });
const [dHead, mainHead] = [S.s.branches.d.head, S.s.main.head];
old("branch.fork", { name: "d", from: "c" }, { branch: "d", base: L0, head: C1 });
old("fs.write", { branch: "d", path: "x" }, { commit: C2, kind: "Committed" });
old("branch.publish", { branch: "c" }, { commit: C1, layer: L0 });
assert.deepEqual([S.s.branches.d.head, S.s.main.head], [dHead, mainHead]);
old("fs.write", { branch: "d", path: "y" }, { commit: C3, kind: "Committed" });
assert.equal(S.m.real(S.s.branches.d.head), C3);
assert.equal(S.s.commits[S.s.branches.d.head].parent, dHead);
// and as an agent's steps: the mount opens the Workspace's pane under the Sandbox's label
const V = X.createView(new X.ReplayEngine({ project: "q" }), { lead: "main" });
X.derive(V);
const t0 = "2026-10-21T00:00:00.000Z", traced = (n, method, args, rest) => ({ layerfs_trace: 1, id: `r-${n}`, method, args, start: t0, ms: 1, ok: true, phase: "end", ...rest });
const steps = X.traceSteps([
  traced(1, "project.init", {}, {}),
  traced(2, "branch.fork", { name: "e", from: "main" }, { branch: "e", base: L0, head: null }),
  traced(3, "workspace.mount", { branch: "e" }, { sandbox: "1", path: "/workspaces/1", branch: "e", base: null, baseLayer: L0 }),
  traced(4, "workspace.exec", { ...WS, command: "ls" }, { exitCode: 0 }),
]);
for (const st of steps) await X.runStep(V, st, {});
assert.ok(V.panes["layerfs-q-1:/workspaces/1"], Object.keys(V.panes).join(","));
assert.deepEqual(V.panes["layerfs-q-1:/workspaces/1"].lines.map((l) => l.text), ["mount e", "ls"]);
console.log(`PASS model trace: ${lines.length} lines, ${s.branchOrder.length} Branches, ${s.sandboxOrder.length} Sandboxes, ${Object.keys(w.attrib).length} attributed nodes`);
