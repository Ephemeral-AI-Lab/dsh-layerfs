// Simulated LayerFS checks without Docker or a Store: @layerfs/agent and
// @layerfs/backend on the simulator's binding (src/sim) through a Workspace's
// life, the runtime's lfs command on it, the Host's Init, views and removal
// of a simulated project, and the sed stand-in.
//   node dsh/packages/host/tests/sim.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-sim-"));
const home = join(dir, "home"), trace = join(dir, "trace.jsonl");
const FOLDER = fileURLToPath(new URL("../../../demo-workspace", import.meta.url));
const NAME = "sim-test";
const ID = { commit: /^12[0-9a-f]{64}$/, layer: /^32[0-9a-f]{64}$/ };

try {
  const { resolveConfig } = await import("../src/config.js");
  const { BindingStore } = await import("../src/binding.js");
  const { TreeReader } = await import("../src/trees.js");
  const { removeProject } = await import("../src/remove.js");
  const { prepareInit, initProject } = await import("../src/init.js");
  const { deploymentEnv } = await import("../src/layerfs-client.js");
  const { alive } = await import("../src/sim/shell.js");

  // Init: no Docker and no deployment settings; a backend other than sim is refused.
  const spec = resolveConfig({ home }, { dir });
  const bindings = new BindingStore(spec.stateDir);
  assert.throws(() => prepareInit(spec, bindings, { folder: FOLDER, backend: "docker" }), { code: "invalid-backend" });
  assert.throws(() => prepareInit(spec, bindings, { folder: FOLDER }), { code: "not-configured" });
  const steps = [];
  const project = await initProject(spec, bindings, { folder: FOLDER, name: NAME, backend: "sim" }, (fields) => fields.step && steps.push(fields.step));
  assert.deepEqual(steps, ["scan", "volume", "import"]);
  assert.equal(project.backend, "sim");
  assert.equal(bindings.byName(NAME).backend, "sim");
  assert.deepEqual(deploymentEnv(spec, project), { HOME: home, DOCKER: "sim", IMAGE: "sim", DAEMON: "sim", VOLUME: `sim-${NAME}`, STORE_PATH: "sim" });

  // The agent and backend on the simulator, with the environment the Host gives a simulated project's bash calls.
  for (const [name, value] of Object.entries(deploymentEnv(spec, project))) process.env[`LAYERFS_${name}`] = value;
  process.env.LAYERFS_TRACE = trace;
  const { LayerFS, isRefusal } = await import(spec.simSdk);
  const { LayerFSBackend } = await import(spec.simBackend);
  const lf = await LayerFS.open(NAME), backend = LayerFSBackend.of(lf), op = backend.daemon;
  const refused = async (call, code) => {
    try { await call(); } catch (error) { assert.ok(isRefusal(error, code), `expected ${code}, got ${error.code}: ${error.message}`); return error; }
    assert.fail(`expected ${code}`);
  };

  const fork = await lf.branch.fork("feature");
  assert.equal(fork.kind, "Forked");
  assert.match(fork.base, ID.layer);
  const edit = await lf.fs.edit("feature", "/app/page.tsx", "Hello world", "Home", "headline");
  assert.equal(edit.kind, "Committed");
  assert.match(edit.commit.id, ID.commit);
  assert.equal(edit.commit.message, "headline");
  await refused(() => lf.fs.write("main", "/x", "x"), "ReadOnly");

  // LayerFS places the Workspace: the project's first Sandbox, numbered 1
  const ws = await lf.workspace.mount("feature");
  assert.deepEqual(ws, { sandbox: "1", path: "/workspaces/1", image: "sim" });
  const sb = ws.sandbox;
  const built = await lf.workspace.exec(ws, "sh install.sh && sh build.sh");
  assert.equal(built.kind, "exit:0", built.stdout + built.stderr);
  assert.match(built.stdout, /Compiled successfully: 2 pages/);
  const sed = await lf.workspace.exec(ws, "sed -i 's/Home/Welcome/' app/page.tsx && grep h1 app/page.tsx");
  assert.match(sed.stdout, /<h1>Welcome<\/h1>/);
  assert.equal((await lf.workspace.exec(ws, "exit 3")).kind, "exit:3");

  // A background process keeps the Workspace busy until it is stopped.
  const server = await op.process.start(ws, "sleep 30");
  assert.equal(server.kind, "running");
  assert.match(server.process, /^proc_1_[0-9a-f]+$/, "a process id names its Sandbox");
  const busy = await refused(() => lf.workspace.unmount(ws), "Busy");
  assert.deepEqual(busy.detail.processes, [server.process]);
  const listed = await op.process.list();
  assert.deepEqual([listed.items[0].status, listed.items[0].sandbox], ["running", "1"]);
  const pid = JSON.parse(readFileSync(join(home, NAME, "sim", "state.json"), "utf8")).sim.sandboxes[sb].processes[server.process].pid;
  assert.ok(alive(pid));
  assert.equal((await op.process.cancel(server.process)).status, "stopped");

  // The head moves under the Workspace: commit writes the merge's markers and refuses, twice.
  await lf.fs.edit("feature", "/app/page.tsx", "<h1>Home</h1>", "<h1>Hi</h1>", "greeting");
  assert.equal((await op.workspace.status(ws)).headMovedSinceMount, true);
  const conflict = await refused(() => lf.workspace.commit(ws, "welcome"), "Conflict");
  assert.equal(conflict.message, "Conflict: the head moved and 1 file(s) conflict with this Workspace; markers are written and nothing was committed");
  assert.deepEqual(conflict.detail.conflicts.map((c) => c.path), ["/app/page.tsx"]);
  assert.deepEqual(conflict.detail.conflicts[0].hunks[0], { line: 4, ours: ["      <h1>Welcome</h1>"], theirs: ["      <h1>Hi</h1>"] });
  const marked = await lf.workspace.exec(ws, "cat app/page.tsx");
  assert.match(marked.stdout, /^>>>>>>> feature@12[0-9a-f]{64}$/m);
  const markers = await refused(() => lf.workspace.commit(ws, "welcome"), "Conflict");
  assert.equal(markers.message, "Conflict: 1 file(s) still contain conflict markers; nothing committed");
  await lf.workspace.exec(ws, "sed -i '/^<<<<<<< /d; /^=======$/,/^>>>>>>> /d' app/page.tsx");
  const saved = await lf.workspace.commit(ws, "welcome");
  assert.equal(saved.kind, "Committed");
  assert.equal(saved.commit.via, "exec");
  assert.equal((await lf.workspace.unmount(ws)).kind, "Unmounted");
  assert.ok(!existsSync(join(home, NAME, "sim", "ws", sb, "1")), "an unmounted Workspace's folder is removed");
  assert.deepEqual((await lf.project.list_sandboxes()).items.map((x) => [x.sandbox, x.name]), [["1", `layerfs-${NAME}-1`]]);

  // Publish, then read main.
  const published = await lf.branch.publish("feature");
  assert.equal(published.kind, "Added");
  assert.match(published.publishedLayer.id, ID.layer);
  assert.equal((await lf.branch.publish("feature")).kind, "UpToDate");
  const app = await lf.fs.list("main", "/app");
  assert.deepEqual(app.items.map((i) => i.name), ["layout.tsx", "page.tsx"]);
  assert.ok(Number.isInteger(app.items[0].inode));
  assert.match((await lf.fs.read("main", "/app/page.tsx")).text, /<h1>Welcome<\/h1>/);
  assert.equal((await lf.fs.read("main", "/app/page.tsx", 4, 4)).text, "      <h1>Welcome</h1>\n");
  const blame = await lf.fs.blame("main", "/app/page.tsx");
  const welcome = blame.lines.find((l) => l.text.includes("Welcome"));
  assert.equal(welcome.n, 4);
  assert.match(welcome.commit, ID.commit, "main's lines are credited to the Commit that wrote them");
  assert.equal(welcome.message, "welcome");
  assert.match(blame.lines[0].commit, ID.layer, "an unchanged line is the Init Layer's");
  const both = await lf.branch.merge("feature", "main", "both");
  assert.equal(both.kind, "Merged");
  assert.equal(both.fastForward, true);

  // The SDK's own trace lines, with ids in LayerFS's formats.
  const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const codes = lines.filter((l) => l.method === "workspace.commit").map((l) => (l.ok ? l.kind : l.code));
  assert.deepEqual(codes, ["Conflict", "Conflict", "Committed"]);
  assert.match(lines.find((l) => l.method === "workspace.commit" && l.ok).commit, ID.commit);
  assert.deepEqual([lines.find((l) => l.method === "workspace.mount").sandbox, lines.find((l) => l.method === "workspace.exec").args.sandbox], ["1", "1"]);

  // The Host's views read the simulator: the state, Files reads of saved ids and the Store.
  const trees = new TreeReader(spec);
  const state = await trees.state(project);
  assert.deepEqual(state.s.sandboxOrder, [`layerfs-${NAME}-1`]);
  assert.deepEqual(Object.keys(state.s.branches).sort(), ["both", "feature"]);
  assert.equal(Object.keys(state.s.commits).length, 3, "headline, greeting, welcome; the merge with main fast-forwards");
  const head = Object.entries(state.labels).find(([, label]) => label === state.s.branches.feature.head)[0];
  const q = (o) => new URLSearchParams(o);
  assert.ok((await trees.files(project, "list", q({ ref: head, dir: "/app" }))).items.some((e) => e.path === "/app/page.tsx" && e.type === "file"));
  assert.match((await trees.files(project, "read", q({ ref: head, path: "/app/page.tsx" }))).text, /Welcome/);
  const parent = Object.entries(state.labels).find(([, label]) => label === state.s.commits[state.s.branches.feature.head].parent)[0];
  assert.ok((await trees.files(project, "changes", q({ from: parent, to: head }))).items.some((e) => e.path === "/app/page.tsx" && e.kind === "Modified"));
  const storage = await trees.storage(project);
  assert.ok(storage.store.logical > 0 && storage.init.files > 0);
  assert.equal(typeof storage.store.dedupe, "number");
  assert.equal(storage.commits.length, 3);

  // The Store totals and History through the backend, as agents read them
  const totals = await backend.store.project.get_storage();
  assert.ok(totals.logical > 0 && typeof totals.dedupe === "number");
  const history = await backend.store.project.get_history();
  assert.equal((await backend.store.project.get_history(history.version)).kind, "unchanged");

  // `lfs run` (@layerfs/runtime's command, on the simulator: sim/lfs.js): each
  // call mounts a Workspace, which LayerFS places in the project's Sandbox 1,
  // and unmounts it; the Sandbox stays for the next call.
  const lfs = (...args) => execFileSync(process.execPath, [spec.simCli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DSH_LAYERFS_PROJECT: NAME } });
  const before = readFileSync(trace, "utf8").trim().split("\n").length;
  assert.equal(lfs("run", "feature", "echo hi > note.txt && cat note.txt", "note"), "hi\n");
  assert.equal(lfs("run", "feature", "cat note.txt", "--discard"), "hi\n");
  const runs = readFileSync(trace, "utf8").trim().split("\n").slice(before).map((l) => JSON.parse(l));
  assert.deepEqual(runs.filter((l) => ["workspace.mount", "workspace.unmount"].includes(l.method)).map((l) => [l.method, l.ok, l.sandbox ?? l.args.sandbox]), [["workspace.mount", true, "1"], ["workspace.unmount", true, "1"], ["workspace.mount", true, "1"], ["workspace.unmount", true, "1"]]);
  const kept = JSON.parse(readFileSync(join(home, NAME, "sim", "state.json"), "utf8")).sim.sandboxes["1"];
  assert.equal(kept.closed, false, "the Sandbox stays for the next call");
  assert.deepEqual(Object.values(kept.workspaces).filter((w) => w.mounted), [], "no Workspace is left mounted");

  // Removal stops the project's background processes and deletes its home entry.
  // placement: a 17th Workspace starts Sandbox 2
  const held = [];
  for (let i = 0; i < 16; i++) held.push(await lf.workspace.mount("feature"));
  assert.deepEqual([...new Set(held.map((w) => w.sandbox))], ["1"]);
  const ws2 = await lf.workspace.mount("feature");
  assert.equal(ws2.sandbox, "2");
  await lf.workspace.unmount(held[3], true);
  assert.equal((await lf.workspace.mount("feature")).sandbox, "1", "the lowest-numbered Sandbox with room");
  // a mount of another image goes only to a Sandbox of that image: Sandbox 1 has room but runs "sim"
  await lf.workspace.unmount(held[4], true);
  const other = await lf.workspace.mount("feature", { image: "sim-other" });
  assert.deepEqual([other.sandbox, other.image], ["3", "sim-other"]);
  assert.deepEqual([(await lf.workspace.mount("feature")).sandbox, (await lf.workspace.mount("feature", { image: "sim-other" })).sandbox], ["1", "3"]);
  assert.deepEqual((await lf.project.list_sandboxes()).items.map(({ sandbox, image }) => [sandbox, image]), [["1", "sim"], ["2", "sim"], ["3", "sim-other"]]);
  // a Sandbox's Workspaces, as the agent lists them; one not running is refused
  const listed3 = await lf.sandbox.list_workspaces("3");
  assert.deepEqual(listed3.items.map((w) => [w.path, w.branch, w.activity, w.changed]), [[other.path, "feature", "Idle", false], ["/workspaces/2", "feature", "Idle", false]]);
  await refused(() => lf.sandbox.list_workspaces("9"), "NoSuchSandbox");
  await op.process.start(ws2, "sleep 30");
  const running = Object.values(JSON.parse(readFileSync(join(home, NAME, "sim", "state.json"), "utf8")).sim.sandboxes["2"].processes)[0].pid;
  assert.ok(alive(running));
  spec.runtime = Promise.resolve({ project: { remove: () => assert.fail("a simulated project is not the runtime's") } });
  assert.deepEqual(await removeProject(spec, bindings, trees, NAME), { removed: NAME, volume: `sim-${NAME}` });
  for (let i = 0; i < 50 && alive(running); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!alive(running), "removal stops the background process");
  assert.ok(!existsSync(join(home, NAME)));
  assert.equal(bindings.byName(NAME), null);
  await trees.dispose();

  // The sed stand-in, on the demos' scripts.
  const sedJs = fileURLToPath(new URL("../src/sim/sed.js", import.meta.url));
  const sedOn = (text, ...args) => { const file = join(dir, "sed.txt"); writeFileSync(file, text); execFileSync(process.execPath, [sedJs, "-i", ...args, file]); return readFileSync(file, "utf8"); };
  assert.equal(sedOn("<h1>We're</h1>\n", "s/We're/We\\&apos;re/"), "<h1>We&apos;re</h1>\n");
  assert.equal(sedOn("# Website\nx\n", "1s/.*/# Website (with navigation)/"), "# Website (with navigation)\nx\n");
  assert.equal(sedOn('"build": "sh build.sh"\n', 's/\\("build": "sh build.sh[^"]*\\)"/\\1 --profile"/'), '"build": "sh build.sh --profile"\n');
  assert.equal(sedOn("a\n<<<<<<< w\nb\n=======\nc\n>>>>>>> h\nd\n", "/^<<<<<<< /d; /^=======$/,/^>>>>>>> /d"), "a\nb\nd\n");
  assert.equal(sedOn("<<<<<<< w\n<h1>Welcome</h1>\n=======\n<h1>Home</h1>\n>>>>>>> h\n", "/<h1>Home<\\/h1>/d; /^<<<<<<<\\|^=======\\|^>>>>>>>/d; s/<h1>Welcome</<h1>Welcome home</"), "<h1>Welcome home</h1>\n");
  assert.equal(execFileSync(process.execPath, [sedJs, "-n", "2p"], { input: "a\nb\nc\n", encoding: "utf8" }), "b\n");

  console.log("sim: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
