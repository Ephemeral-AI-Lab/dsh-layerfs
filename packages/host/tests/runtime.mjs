// Sandbox management reads and actions (runtime.js) on the simulator, without
// Docker: a project's Sandboxes with their Workspaces, the guards on its
// actions, and the All projects overview, whose Docker, worker, older Store
// container and leftovers come from a stand-in @layerfs/runtime.
//   node dsh/packages/host/tests/runtime.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-runtime-"));
const home = join(dir, "home");
const FOLDER = fileURLToPath(new URL("../../../demo-workspace", import.meta.url));
const NAME = "runtime-test";

try {
  const { resolveConfig } = await import("../src/config.js");
  const { BindingStore } = await import("../src/binding.js");
  const { TreeReader } = await import("../src/trees.js");
  const { initProject } = await import("../src/init.js");
  const { deploymentEnv } = await import("../src/layerfs-client.js");
  const { cleanLeftovers, overview, projectAction, projectRuntime, restartStore, startStore, LEFT_MS } = await import("../src/runtime.js");

  // the runtime as the overview and the worker actions call it; Docker does not answer
  const calls = [];
  let status = { platform: "macos", missing: [], docker: { level: "down", error: "Cannot connect to the Docker daemon" }, worker: { name: "layerfs-worker", state: "unknown", error: "no Docker" }, oldStore: null, disk: { home: 1000, volumes: null } };
  const runtime = {
    status: async () => status,
    worker: { start: async (options) => { calls.push(["start", options]); return status; }, restart: async (options) => { calls.push(["restart", options]); return status; } },
    sandbox: { list_leftovers: async () => [{ name: "layerfs-gone-1", project: "gone", running: false, status: "Exited (0)" }], clean_leftovers: async (names) => (calls.push(["clean", names]), { results: names.map((name) => ({ name, ok: true })) }) },
  };
  const spec = { ...resolveConfig({ home }, { dir }), docker: join(dir, "no-docker.sock"), worker: true, runtime: Promise.resolve(runtime) };
  const bindings = new BindingStore(spec.stateDir);
  const project = await initProject(spec, bindings, { folder: FOLDER, name: NAME, backend: "sim" }, () => {});
  for (const [name, value] of Object.entries(deploymentEnv(spec, project))) process.env[`LAYERFS_${name}`] = value;
  const { LayerFS } = await import(spec.simSdk);
  const lf = await LayerFS.open(NAME);
  await lf.branch.fork("feature");
  const ws = await lf.workspace.mount("feature");
  await lf.workspace.exec(ws, "echo new > note.txt");

  const busy = new Set(), mountedAt = Date.now() - LEFT_MS - 1000;
  const collector = { busyOf: () => busy, runningCalls: () => busy.size, mountsOf: () => ({ [`${ws.sandbox}\n${ws.path}`]: { agent: "agent-a", at: mountedAt, lastAt: mountedAt } }) };
  const trees = new TreeReader(spec);

  // the Workspace, with who mounted it, its uncommitted change and how long it sat
  const r = await projectRuntime(trees, collector, project);
  assert.equal(r.sandboxes.length, 1);
  const [w] = r.sandboxes[0].workspaces;
  assert.equal(w.path, ws.path);
  assert.equal(w.branch, "feature");
  assert.equal(w.agent, "agent-a");
  assert.ok(w.uncommitted > 0, "the exec's file is uncommitted");
  assert.ok(w.idleMs >= LEFT_MS);
  assert.equal(w.level, "degraded", "left with uncommitted changes past LEFT_MS");
  assert.equal(r.sandboxes[0].capacity, 16);

  // a call in flight in the Workspace refuses every action on it; discard needs its path as confirm
  busy.add(`${ws.sandbox}\n${ws.path}`);
  await assert.rejects(projectAction(trees, collector, project, { action: "discard", sandbox: ws.sandbox, path: ws.path, confirm: ws.path }), { code: "busy" });
  assert.equal((await projectRuntime(trees, collector, project)).sandboxes[0].workspaces[0].level, "ok", "a busy Workspace is not flagged");
  busy.clear();
  await assert.rejects(projectAction(trees, collector, project, { action: "discard", sandbox: ws.sandbox, path: ws.path }), { code: "not-confirmed" });
  await assert.rejects(projectAction(trees, collector, project, { action: "unmount", sandbox: ws.sandbox, path: ws.path }), { code: "Dirty" });
  await assert.rejects(projectAction(trees, collector, project, { action: "reboot" }), { code: "invalid-action" });
  await projectAction(trees, collector, project, { action: "discard", sandbox: ws.sandbox, path: ws.path, confirm: ws.path });
  assert.deepEqual((await projectRuntime(trees, collector, project)).sandboxes.flatMap((s) => s.workspaces), []);

  // the overview: Docker down, the simulated project read anyway
  const all = await overview(spec, bindings, trees, collector);
  assert.equal(all.engine.level, "down");
  assert.equal(all.level, "down");
  assert.equal(all.projects.length, 1);
  assert.equal(all.projects[0].name, NAME);
  assert.equal(all.projects[0].simulated, true);
  assert.deepEqual(all.leftovers, []);
  assert.equal(all.calls, 0);
  assert.deepEqual([all.store.level, all.store.state, all.oldStore, all.disk], ["down", "unknown", null, { host: 1000, vm: null }]);
  // Docker up: the runtime's leftovers, the worker as the Store card, and the older Store container
  // while it runs (it keeps the worker from starting)
  status = { ...status, docker: { level: "ok", version: "28.0" }, worker: { name: "layerfs-worker", state: "missing" }, disk: { home: 1000, volumes: 2000 },
    oldStore: { name: "layerfs-store", id: "abc", state: "running", message: "the older Store container layerfs-store still runs" } };
  // (the Host's own `docker ps` meets the socket nobody listens on: no containers)
  const up = await overview(spec, bindings, trees, collector);
  assert.deepEqual(up.leftovers.map((l) => l.name), ["layerfs-gone-1"]);
  assert.deepEqual([up.store.state, up.oldStore.state, up.level, up.disk.vm], ["missing", "running", "down", 2000]);
  assert.equal(up.projects[0].simulated, true);
  // a restart needs the confirm word and goes to the runtime (which, with the older Store container
  // running, retires it first); a Host without a worker (Linux) has none to restart or start
  await assert.rejects(restartStore(spec, {}), { code: "not-confirmed" });
  assert.equal((await restartStore(spec, { confirm: "restart" })).name, "layerfs-worker");
  await assert.rejects(restartStore({ ...spec, worker: false }, { confirm: "restart" }), { code: "no-store" });
  await assert.rejects(startStore({ ...spec, worker: false }), { code: "no-store" });
  await startStore(spec);
  status = { ...status, worker: { name: "layerfs-worker", state: "running", answering: true, build: "b1", expected: "b1" } };
  await assert.rejects(startStore(spec), { code: "running" });
  assert.equal((await overview(spec, bindings, trees, collector)).store.level, "ok");
  status = { ...status, worker: { ...status.worker, build: "b0" } };
  assert.equal((await overview(spec, bindings, trees, collector)).store.level, "degraded", "another build than the bundle's");
  // leftovers are removed by the runtime; bad names are refused first
  await assert.rejects(cleanLeftovers(spec, []), { code: "invalid-names" });
  assert.deepEqual(await cleanLeftovers(spec, ["layerfs-gone-1"]), { results: [{ name: "layerfs-gone-1", ok: true }] });
  assert.deepEqual(calls, [["restart", { confirm: "restart" }], ["start", undefined], ["clean", ["layerfs-gone-1"]]]);
  await trees.dispose();

  // a project whose Sandbox does not answer: its tab gets the quick view
  // (pending) after sandboxMs while the read runs on, never asked twice
  {
    let asked = 0;
    const stuck = new TreeReader(spec, async () => ({ layerfs: {}, backend: { daemon: { process: { list: async () => ({ items: [] }) } } }, state: () => (asked++, new Promise(() => {})), close: async () => {} }));
    stuck.sandboxMs = 50;
    const first = await projectRuntime(stuck, collector, project), second = await projectRuntime(stuck, collector, project);
    assert.deepEqual([first.pending, second.pending, first.level], [true, true, "ok"]);
    assert.equal(asked, 1, "the stuck snapshot is not asked again");
  }
  // the All projects cards: each Sandbox container pinged, Workspaces from the
  // traces; no daemon asked, so a closed port shows down within the ping
  {
    const { quickSandboxes, reachable } = await import("../src/runtime.js");
    const { createServer } = await import("node:net");
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const open = server.address().port, closed = await new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    assert.deepEqual([await reachable(open), await reachable(closed)], [true, false]);
    const box = (sandbox, port) => ({ name: `layerfs-p-${sandbox}`, running: true, project: "p", sandbox, image: "img:1", port });
    const traces = { busyOf: () => new Set(), mountsOf: () => ({ "1\n/workspaces/1": { agent: "a", at: 1, lastAt: 2 } }) };
    const started = Date.now();
    const quick = await quickSandboxes(traces, { name: "p" }, [box("1", open), box("2", closed), { ...box("3", open), project: "q" }], 10);
    server.close();
    assert.deepEqual(quick.map((q) => [q.name, q.level, q.workspaces.map((w) => [w.path, w.agent, w.idleMs])]), [
      ["layerfs-p-1", "ok", [["/workspaces/1", "a", 8]]],
      ["layerfs-p-2", "down", []],
    ]);
    assert.ok(Date.now() - started < 1500, "a ping, not a state read");
  }
  console.log("runtime: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
