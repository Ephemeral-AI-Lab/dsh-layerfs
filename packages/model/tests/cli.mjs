// The SDK-to-CLI table covers every SDK and operator method, and prints the
// documented lines. A method the SDK gains without a row here fails.
//   node dsh/packages/model/tests/cli.mjs
import assert from "node:assert/strict";
import { LayerFS } from "../../../../sdk/js/src/index.js";
import { LayerFSOperator } from "../../../../sdk/js/operator/index.js";
import { CLI, cliOf, commandOf, routeOf } from "../src/cli.js";

const methods = (client) => Object.entries(client)
  .filter(([, group]) => group && typeof group === "object" && !(group instanceof Set) && Object.values(group).some((f) => typeof f === "function"))
  .flatMap(([name, group]) => Object.keys(group).filter((m) => typeof group[m] === "function").map((m) => `${name}.${m}`));
const sdk = new LayerFS("cli-test");
const all = [...methods(sdk), ...methods(new LayerFSOperator(sdk))];
// the #328 standard's 29 methods, less sandbox.create and sandbox.close (#373)
assert.equal(methods(sdk).length, 27, "the 27-method SDK");
for (const call of all) {
  assert.ok(CLI[call], `${call} has a row in cli.js`);
  assert.ok(["project", "fs", "workspace", null].includes(CLI[call].at), `${call}: terminal`);
  if (CLI[call].at === null) continue;
  // every drawn SDK line starts with its group, except a Workspace's shell command
  if (call !== "workspace.exec" && call !== "process.start") assert.ok(commandOf(call, {}).startsWith(call.split(".")[0] + " "), `${call}: group prefix`);
}

const image = "sha256:" + "2d929c6d66c2".padEnd(64, "0");
const lines = [
  ["project.init", { path: "/src/website" }, "project", "project init /src/website"],
  ["project.list_branches", { pageSize: 50, pagePos: 0 }, "project", "project list_branches"],
  ["branch.fork", { name: "feature", from: "main" }, "project", "branch fork feature"],
  ["branch.fork", { name: "try-ui", branch: "feature" }, "project", "branch fork try-ui --from-ref feature"],
  ["branch.list_commits", { branch: "feature", pageSize: 20, pagePos: 0 }, "project", "branch list_commits feature --page-size 20"],
  ["branch.diff_branches", { from: "feature", to: "try-ui" }, "project", "branch diff_branches feature try-ui"],
  ["branch.merge", { branch: "feature", with: "try-ui", name: "release", message: "join" }, "project", 'branch merge feature try-ui release -m "join"'],
  ["branch.publish", { branch: "release" }, "project", "branch publish release"],
  // an older trace's Sandbox calls
  ["sandbox.create", { name: "tester", project: "docs", image }, "project", "sandbox create tester docs sha256:2d929c6d66c2"],
  ["sandbox.close", { sandbox: "tester" }, "project", "sandbox close tester"],
  ["fs.read", { branch: "try", path: "/app/theme.css", startLine: 1 }, "fs", "fs read /app/theme.css"],
  ["fs.read", { branch: "try", path: "/a.txt", startLine: 5, endLine: 9 }, "fs", "fs read /a.txt --start-line 5 --end-line 9"],
  ["fs.write", { branch: "try", path: "/app/theme.css", contentBytes: 8, message: "warm theme" }, "fs", 'fs write /app/theme.css -m "warm theme"'],
  ["fs.apply", { branch: "try", changes: [{}, {}], message: "two" }, "fs", 'fs apply 2 changes -m "two"'],
  ["fs.mv", { branch: "try", from: "/a", to: "/b" }, "fs", "fs mv /a /b"],
  ["fs.diff_files", { leftRef: "main", leftPath: "/a", rightRef: "try", rightPath: "/a" }, "fs", "fs diff_files main /a try /a"],
  ["workspace.mount", { branch: "feature" }, "workspace", "workspace mount feature"],
  ["workspace.exec", { command: "npm test" }, "workspace", "npm test"],
  ["process.start", { command: "npm run dev" }, "workspace", "npm run dev &"],
  ["process.cancel", { process: "proc_1_ab" }, "workspace", "process cancel proc_1_ab"],
  ["workspace.status", {}, "workspace", "workspace status"],
  ["workspace.commit", { message: "add hero", force: false }, "workspace", 'workspace commit -m "add hero"'],
  ["workspace.commit", { force: true }, "workspace", "workspace commit --force"],
  ["workspace.unmount", { discard: false }, "workspace", "workspace unmount"],
  ["workspace.unmount", { discard: true }, "workspace", "workspace unmount --discard"],
  // the simulator's and older traces' names print as the Workspace calls
  ["sandbox.mount", { sandbox: "tester", branch: "feature" }, "workspace", "workspace mount feature"],
  ["sandbox.commit", { message: "add hero" }, "workspace", 'workspace commit -m "add hero"'],
];
for (const [call, args, at, text] of lines) {
  assert.equal(routeOf(call).at, at, `${call}: terminal`);
  assert.equal(commandOf(call, args), text, call);
  // the terminal hides the group it implies
  const shown = at === "fs" ? text.replace(/^fs /, "") : at === "workspace" ? text.replace(/^workspace /, "") : text;
  assert.equal(cliOf(call, args), shown, `${call} in its terminal`);
}
assert.equal(cliOf("fs.read", { path: "/a.txt" }), "read /a.txt");
assert.equal(cliOf("workspace.commit", { message: "x" }), 'commit -m "x"');
assert.equal(cliOf("process.cancel", { process: "p" }), "process cancel p", "an operator group stays");
assert.equal(cliOf("sandbox.create", { name: "b" }), "sandbox create b", "the project terminal keeps every group");
assert.equal(routeOf("no.such").at, "project", "an unknown call falls back to the project terminal");
console.log(`PASS cli: ${all.length} methods routed, ${lines.length} lines`);
