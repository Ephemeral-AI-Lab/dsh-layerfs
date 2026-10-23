// Host plugin checks without dsh, Docker or a Store:
//   node dsh/packages/host/tests/host.mjs
// dsh's appendPluginRecord is replaced by a stand-in that keeps each record
// on the fake Session; Sessions, the web server and Connection are fakes.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STAND_IN = "export function appendPluginRecord(session, type, data) { session.records.push({ type, data }); }";
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "@deepseek-ai/dsh-session") return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(STAND_IN)}`)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);
const { resolveConfig, runtimeState } = await import("../src/config.js");
const { BindingStore } = await import("../src/binding.js");
const { Collector } = await import("../src/collector.js");
const { BIN, contributor, projectContext, shimOnPath } = await import("../src/env.js");
const { spawnSync } = await import("node:child_process");
const { registerRoutes } = await import("../src/route.js");
const { TreeReader } = await import("../src/trees.js");
const { removeProject } = await import("../src/remove.js");
const { UNREACHABLE } = await import("../src/collector.js");
const { adopt, prepareInit, randomName, runInit } = await import("../src/init.js");
const { InitJobs } = await import("../src/jobs.js");
const { overview, removeVolumes, DOCKER_LOW, STARTING_MS } = await import("../src/runtime.js");
const { clientFor } = await import("../src/layerfs-client.js");
const { createServer } = await import("node:net");
const { CALL, PROJECT } = await import("@dsh-layerfs/model/sources/records.js");

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-host-"));
const FOLDER = "/work/website";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function session(id, cwd, parentSession) {
  return { header: parentSession ? { id, cwd, parentSession, origin: "subagent" } : { id, cwd }, records: [] };
}

function host() {
  const spec = resolveConfig({ image: "sha256:img", daemon: "/d/layerfs-daemon", bundle: "/b", home: join(dir, "home"), traceDir: join(dir, "traces"), volumes: join(dir, "volumes") }, { dir: join(dir, "profile") });
  mkdirSync(spec.volumes, { recursive: true });
  const live = new Map();
  const ctx = { sessions: { get: (id) => live.get(id) } };
  const bindings = new BindingStore(spec.stateDir);
  const collector = new Collector(ctx, spec, bindings);
  return { spec, live, ctx, bindings, collector, env: contributor(ctx, spec, bindings, collector) };
}

const trace = (id, method, phase, extra = {}) => JSON.stringify({ layerfs_trace: 1, id, step: "call_1", method, args: {}, start: "2026-10-16T00:00:00.000Z", phase, ...(phase === "end" ? { ms: 1, ok: true, daemon: { t: 1 }, scope: "x" } : {}), ...extra }) + "\n";

try {
  const h = host();
  const root = session("session-root", FOLDER), child = session("child-1", FOLDER, "session-root");
  h.live.set(root.header.id, root).set(child.header.id, child);

  // a session without a project gets no LayerFS environment
  assert.deepEqual(h.env.resolve({ agent: { session: root }, callId: "c0" }), {});
  assert.equal(h.bindings.session("session-root"), null);

  // the folder's only project is used, locked at the first bash call and recorded on the root
  h.bindings.addProject(FOLDER, { name: "website", source: FOLDER, volume: "dsh-layerfs-website-1", created: 1 });
  // the runtime context names it (a subagent sees its root's), before any bash call
  assert.match(projectContext(h.bindings, h.collector, child), /^LayerFS project of this conversation: website\./);
  assert.equal(projectContext(h.bindings, h.collector, undefined), "");
  // the layerfs shim: first on PATH while the Host runs; it runs the conversation's CLI, or says there is none
  {
    const env = { PATH: "/usr/bin:/bin" }, off = shimOnPath(env);
    assert.equal(env.PATH, `${BIN}${process.platform === "win32" ? ";" : ":"}/usr/bin:/bin`);
    off();
    assert.equal(env.PATH, "/usr/bin:/bin");
    const win = { PATH: "C:\\x" };
    const winOff = shimOnPath(win, "win32");
    assert.equal(win.PATH, `${BIN};C:\\x`);
    winOff();
    assert.equal(win.PATH, "C:\\x");
    const cli = join(dir, "fake-cli.mjs");
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const shim = (vars) => spawnSync(process.platform === "win32" ? "cmd.exe" : join(BIN, "layerfs"), process.platform === "win32" ? ["/d", "/c", "layerfs branch fork cart"] : ["branch", "fork", "cart"], { encoding: "utf8", timeout: 10000, env: { ...process.env, DSH_LAYERFS_CLI: "", PATH: `${BIN}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, ...vars } });
    const ok = shim({ DSH_LAYERFS_CLI: cli }), missing = shim({});
    assert.deepEqual([ok.status, ok.stdout.trim()], [0, '["branch","fork","cart"]']);
    assert.deepEqual([missing.status, missing.stderr.trim()], [2, "layerfs: this conversation has no LayerFS project"]);
  }
  const vars = h.env.resolve({ agent: { session: child }, callId: "c1", rootCallId: "r1" });
  assert.equal(vars.DSH_LAYERFS_PROJECT, "website");
  assert.equal(vars.DSH_LAYERFS_VOLUME, "dsh-layerfs-website-1");
  // the installed Store in the project's volume: in Docker's VM where the worker opens it, else under this engine's volumes directory
  assert.equal(vars.DSH_LAYERFS_STORE_PATH, `${process.platform === "linux" ? h.spec.volumes : "/var/lib/docker/volumes"}/dsh-layerfs-website-1/_data/global/store.sqlite`);
  // the packages agents import (#428) and the layerfs command, through the Host's wrappers, which set LAYERFS_* from DSH_LAYERFS_* first
  assert.match(vars.DSH_LAYERFS_SDK, /^file:.*\/packages\/host\/src\/agent\/sdk\.js$/);
  assert.match(vars.DSH_LAYERFS_BACKEND, /^file:.*\/packages\/host\/src\/agent\/backend\.js$/);
  assert.match(vars.DSH_LAYERFS_CLI, /[\\/]packages[\\/]host[\\/]src[\\/]agent[\\/]cli\.js$/);
  assert.ok(!("DSH_LAYERFS_OPERATOR" in vars) && !("DSH_LAYERFS_STORE_CONTAINER" in vars) && !("DSH_LAYERFS_BUNDLE" in vars));
  if (process.platform === "linux") assert.ok(!("DSH_LAYERFS_WORKER_ENDPOINT" in vars), "Linux makes Store calls in the caller");
  else assert.equal(vars.DSH_LAYERFS_WORKER_ENDPOINT, join(h.spec.home, "worker", "endpoint.json"), "macOS and Windows: the home's worker");
  assert.ok(!("DSH_LAYERFS_WORKER_ADAPTER" in vars), "the worker route names no integration");
  assert.equal(vars.DSH_LAYERFS_IMAGE, "sha256:img");
  assert.equal(vars.DSH_LAYERFS_CONTAINER_PREFIX, "layerfs-", "Sandboxes are layerfs-<project>-<n>");
  assert.equal(vars.DSH_LAYERFS_TRACE_STEP, "r1");
  assert.equal(vars.DSH_LAYERFS_TRACE, join(h.spec.traceDir, "child-1.jsonl"));
  assert.ok(Object.keys(vars).every((key) => key in h.env.variables), "every value is a declared variable");
  assert.deepEqual(h.bindings.session("session-root"), { project: "website", locked: true, folder: FOLDER });
  assert.equal(h.bindings.choose("session-root", FOLDER, null), false, "a locked choice is refused");
  assert.deepEqual(root.records.map((r) => r.type), [PROJECT]);
  h.env.resolve({ agent: { session: root }, callId: "c2" });
  assert.equal(root.records.length, 1, "the project is recorded once");

  // the parent's catalog names the child; the child's files land in its own Session
  h.collector.observe(root, { type: "subagent/catalog", data: { childId: "child-1", label: " tester " } });
  assert.equal(h.collector.agentOf(child).name, "tester");
  assert.equal(h.collector.agentOf(root).name, "main");
  appendFileSync(vars.DSH_LAYERFS_TRACE, trace("a-1", "workspace.mount", "start"));
  h.collector.poll();
  assert.equal(h.collector.snapshot("session-root").running.length, 1);
  appendFileSync(vars.DSH_LAYERFS_TRACE, trace("a-1", "workspace.mount", "end", { sandbox: "1" }) + trace("a-2", "workspace.exec", "end").slice(0, 20));
  h.collector.poll();
  const snap = h.collector.snapshot("session-root");
  assert.deepEqual([snap.running.length, snap.lines.length, snap.lines[0].agent], [0, 1, "tester"]);
  assert.deepEqual(snap.agents, { "session-root": "main", "child-1": "tester" });
  const [record] = child.records;
  assert.equal(record.type, CALL);
  assert.deepEqual(record.data.agent, { id: "child-1", name: "tester" });
  assert.equal(record.data.project, "website");
  assert.ok(!("daemon" in record.data.line) && !("scope" in record.data.line), "telemetry stays out of records");
  // one bash call's finished lines, read from the agent's trace file at once (the live expect check)
  const stepOf = (id) => JSON.parse(trace(id, "workspace.mount", "end")).step;
  assert.deepEqual(h.collector.callLines("child-1", stepOf("a-1")).map((l) => [l.method, l.phase, "daemon" in l]), [["workspace.mount", "end", false]]);
  assert.deepEqual(h.collector.callLines("nobody", "s"), []);

  // a partial line waits for its newline; a Session that is not live gets its records later
  h.live.delete("child-1");
  appendFileSync(vars.DSH_LAYERFS_TRACE, trace("a-2", "workspace.exec", "end").slice(20));
  h.collector.afterEvent("child-1");
  await tick();
  assert.equal(child.records.length, 1);
  assert.equal(h.collector.snapshot("session-root").lines.length, 2);
  h.live.set("child-1", child);
  h.collector.observe(child, { type: "turn/start", data: {} });
  await tick();
  assert.deepEqual(child.records.map((r) => r.data.line.method), ["workspace.mount", "workspace.exec"]);

  // a new Host loads earlier lines for the views without recording them again
  const again = host();
  again.live.set("child-1", child);
  assert.equal(again.collector.snapshot("session-root").lines.length, 2);
  again.collector.track({ id: "child-1", root: "session-root" }, { name: "website" });
  again.collector.poll();
  assert.equal(child.records.length, 2);
  assert.equal(JSON.parse(readFileSync(join(h.spec.stateDir, "bindings.json"), "utf8")).agents["child-1"].name, "tester");

  // finished lines outlive the temporary trace files through the journal
  rmSync(h.spec.traceDir, { recursive: true, force: true });
  assert.deepEqual(host().collector.snapshot("session-root").lines.map((l) => l.method), ["workspace.mount", "workspace.exec"]);

  // Windows traces live under the writable workspace. Keep their location
  // across renaming and a Host restart, including a line not yet journaled.
  {
    const windows = host(), cwd = join(dir, "windows-workspace");
    windows.spec.traceInWorkspace = true;
    const agent = { id: "windows-agent", root: "windows-root", name: "maid", cwd };
    const file = windows.collector.track(agent, { name: "website" });
    assert.equal(file, join(cwd, ".dsh-layerfs-traces", "windows-agent.jsonl"));
    appendFileSync(file, trace("windows-call", "fs.write", "end", { kind: "Committed", commit: "windows-commit" }));
    windows.bindings.setAgent(agent.id, agent.root, "renamed maid");
    const restarted = host();
    restarted.spec.traceInWorkspace = true;
    const lines = restarted.collector.snapshot(agent.root).lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].agent, "renamed maid");
    assert.equal(lines[0].commit, "windows-commit");
    assert.equal(restarted.bindings.agent(agent.id).traceFile, file);
  }

  // Files reads (reads.js) on a fake client: a folder page, a file window, a binary
  // file's size (the SDK refuses its text), changed paths and one file's diff
  const REF = "a".repeat(64), reads = [], closed = [];
  const fakeFs = {
    async list(ref, dir) {
      const items = { "/": [{ path: "/node_modules", type: "dir", inode: 2 }, { path: "/src", type: "dir", inode: 3 }, { path: "/big.txt", type: "file", inode: 4 }, { path: "/.DS_Store", type: "file", inode: 7 }], "/src": [{ path: "/src/a.js", type: "file", inode: 5 }, { path: "/src/link", type: "symlink", inode: 6 }], "/node_modules": [{ path: "/node_modules/dep.js", type: "file", inode: 8 }] }[dir] ?? [];
      return { items, hasMore: false };
    },
    async read(ref, path, line) {
      reads.push(path);
      if (path === "/.DS_Store") throw Object.assign(new Error("Binary: text contains NUL or invalid UTF-8"), { code: "Binary" });
      return path === "/big.txt" ? { text: "x".repeat(100_000), nextLine: line + 1 } : { text: "ok\n", nextLine: null };
    },
    async stat() { return { size: 6148 }; },
    async blame(ref, path, from) { return { lines: [{ n: from, text: "ok", commit: ref, message: "m", lineTruncated: false }], versions: 1, nextLine: null }; },
    async diff_files(from, path, to) { return { kind: "Text", hunks: [{ op: "+", text: "ok" }], hunksOmitted: false }; },
  };
  const diffed = [];
  // the root each Commit's diff answer reports: "f…" and "g…" are Commits of retired Branches, not in the snapshot
  const rootOf = { ["a".repeat(64)]: "r1", ["b".repeat(64)]: "r0", ["f".repeat(64)]: "r7", ["0".repeat(64)]: "r6" };
  const fakeBranch = { async diff_commits(from, to, size, position, options) { diffed.push([size, position, options]); return { from: { root: rootOf[from] }, to: { root: rootOf[to] }, items: [{ path: "/src/a.js", kind: "Modified", type: "file", hunks: [] }], hasMore: true, nextPagePos: 1000 }; } };
  // backend.store.project.get_comparable's answers: Commits are themselves; Layer c has Commit a's files;
  // d has no Commit with its files; e and 9 were published from Commits it does not list (not exact)
  const comparable = {
    ["a".repeat(64)]: { commit: "a".repeat(64), root: "r1", exact: true }, ["b".repeat(64)]: { commit: "b".repeat(64), root: "r0", exact: true },
    ["c".repeat(64)]: { commit: "a".repeat(64), root: "r1", exact: true },
    ["e".repeat(64)]: { commit: "f".repeat(64), root: "r7", exact: false }, ["9".repeat(64)]: { commit: "0".repeat(64), root: "r8", exact: false },
  };
  const get_comparable = async (ref) => comparable[ref] ?? Promise.reject(Object.assign(new Error("NotComparable: no Commit"), { code: "NotComparable" }));
  const trees = new TreeReader(h.spec, async () => ({ layerfs: { fs: fakeFs, branch: fakeBranch }, backend: { store: { project: { get_comparable } } }, close: async () => closed.push("store") }));

  // the route answers only requests Connection accepts
  let handler;
  const routeCtx = { ...h.ctx, effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {}; } }, connection: { requestRejection: (req) => (req.headers.cookie ? undefined : 401) } };
  const runs = [];
  const jobs = new InitJobs((prepared, report) => new Promise((resolve, reject) => runs.push({ prepared, report, resolve, reject })));
  registerRoutes(routeCtx, { spec: h.spec, bindings: h.bindings, collector: h.collector, trees, jobs });
  const call = async (method, url, body, cookie = "dsh=1") => {
    const res = { statusCode: 0, headers: {}, text: "", setHeader(k, v) { this.headers[k] = v; }, end(text = "") { this.text = text; } };
    const req = { method, url, headers: cookie ? { cookie } : {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    await handler(req, res);
    return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : null };
  };
  assert.equal((await call("GET", "/layerfs/status", null, null)).status, 401);
  assert.deepEqual((await call("GET", "/layerfs/status")).body.missing, []);
  assert.equal((await call("GET", `/layerfs/workspace?folder=${encodeURIComponent(FOLDER)}`)).body.lastUsed, "website");
  const view = await call("GET", "/layerfs/session/child-1");
  assert.deepEqual([view.status, view.body.root, view.body.project.name, view.body.lines.length], [200, "session-root", "website", 2]);
  // the binding alone: the same project and folder, without the trace lines
  const binding = await call("GET", "/layerfs/session/child-1/binding");
  assert.deepEqual([binding.status, binding.body.root, binding.body.project.name, "lines" in binding.body], [200, "session-root", "website", false]);
  assert.equal((await call("POST", "/layerfs/session/session-root/project", { project: null })).status, 409);
  const fresh = session("session-new", FOLDER);
  h.live.set(fresh.header.id, fresh);
  const chose = await call("POST", "/layerfs/session/session-new/project", { project: null });
  assert.deepEqual([chose.status, chose.body.project, chose.body.lines], [200, null, []]);
  h.live.clear(); // Sessions that are not loaded: the binding keeps the folder
  const cold = await call("GET", "/layerfs/session/child-1");
  assert.deepEqual([cold.body.root, cold.body.folder, cold.body.project.name, cold.body.agents["child-1"]], ["session-root", FOLDER, "website", "tester"]);
  assert.equal((await call("GET", "/layerfs/nope")).status, 404);
  // Files reads: one SDK call each and kept; bad arguments are refused before any call
  const B = "b".repeat(64), files = (q) => call("GET", `/layerfs/session/child-1/${q}`);
  const page = await files(`list?ref=${REF}&dir=/src`);
  assert.deepEqual([page.status, page.body.items.map((i) => i.path), page.body.next], [200, ["/src/a.js", "/src/link"], null]);
  const before = reads.length;
  assert.deepEqual((await files(`read?ref=${REF}&path=/src/a.js`)).body, { text: "ok\n", startLine: 1, nextLine: null, lineTruncated: false, size: null });
  await files(`read?ref=${REF}&path=/src/a.js`);
  assert.equal(reads.length, before + 1, "a window is read once");
  assert.deepEqual((await files(`read?ref=${REF}&path=/.DS_Store`)).body, { binary: true, size: 6148 });
  assert.deepEqual((await files(`blame?ref=${REF}&path=/src/a.js&line=3`)).body, { lines: [{ n: 3, text: "ok", lineTruncated: false, commit: REF, message: "m" }], versions: 1, nextLine: null });
  const changes = await files(`changes?from=${B}&to=${REF}`);
  assert.deepEqual([changes.body, diffed], [{ items: [{ path: "/src/a.js", kind: "Modified", type: "file" }], next: 1000 }, [[1000, 0, { hunks: false }]]]);
  // a Layer is compared as the Commit with its files; one with none is refused
  assert.deepEqual((await files(`changes?from=${"c".repeat(64)}&to=${REF}`)).body, { items: [], next: null });
  assert.equal(diffed.length, 1, "same files: no diff call");
  assert.deepEqual([(await files(`changes?from=${"d".repeat(64)}&to=${REF}`)).status, (await files(`changes?from=${"d".repeat(64)}&to=${REF}`)).body.code], [409, "NotComparable"]);
  // a Layer whose source Commit is not listed is compared as that Commit when the diff shows its root; a merged publish is refused
  assert.equal((await files(`changes?from=${"e".repeat(64)}&to=${REF}`)).body.items.length, 1);
  assert.equal((await files(`changes?from=${"9".repeat(64)}&to=${REF}`)).body.code, "NotComparable");
  assert.equal((await call("GET", `/layerfs/project/website/diff?from=${B}&to=${REF}&path=/src/a.js`)).body.kind, "Text");
  for (const q of ["list?ref=nope", `read?ref=${REF}&path=/a/../b`, `read?ref=${REF}&path=/a&line=0`, `changes?from=${B}`])
    assert.deepEqual([(await files(q)).status, (await files(q)).body.code], [400, "invalid-input"], q);
  await trees.dispose();
  assert.deepEqual(closed, ["store"], "releasing a client closes its Store; Sandboxes close themselves when idle");

  // state reads go through the same per-project client: one client, not one per read
  let opened = 0, snapshots = 0;
  const empty = { project: "p", branches: [], commits: [], layers: [], sandboxes: [], store: {} };
  const shared = new TreeReader(h.spec, async () => { opened++; return { layerfs: { fs: fakeFs }, state: async () => (snapshots++, empty), close: async () => {} }; });
  const P = { name: "p" };
  const [stateA, stateB] = await Promise.all([shared.state(P), shared.state(P), shared.files(P, "list", new URLSearchParams({ ref: REF }))]);
  assert.deepEqual([opened, snapshots, typeof stateA.s, typeof stateB.labels], [1, 1, "object", "object"], "one client, and one snapshot for reads made while it runs");
  await shared.dispose();
  // a snapshot whose Sandbox does not answer: History is drawn from the Store
  // alone after sandboxMs, and later reads share the running snapshot
  {
    let asked = 0, answer;
    const stuck = new Promise((resolve) => { answer = resolve; });
    const history = { project: "p", branches: [{ name: "main", base: null, head: null }], commits: [], layers: [], more: {} };
    const slow = new TreeReader(h.spec, async () => ({ layerfs: {}, backend: { store: { project: { get_history: async () => history } } }, state: () => (asked++, stuck), close: async () => {} }));
    slow.sandboxMs = 50;
    const first = await slow.state(P), second = await slow.state(P);
    assert.deepEqual([first.late, second.late, asked], [true, true, 1], "drawn without Workspaces; the stuck snapshot is not asked again");
    assert.deepEqual(first.s.sandboxOrder, []);
    // the History-only read (a chat's History) asks no Sandbox and does not wait for one
    const started = Date.now(), only = await slow.history(P);
    assert.deepEqual([typeof only.labels, only.late, asked, Date.now() - started < 50], ["object", undefined, 1, true]);
    answer(empty);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await slow.state(P)).late, undefined, "once it answers, the next read is a new snapshot");
    assert.equal(asked, 2);
    await slow.dispose();
  }
  // the project's running Sandboxes are drawn under their container names; one
  // the snapshot found gone after the listing (#373: idle close) is drawn closed
  const placed = { ...empty, sandboxes: [{ id: "1", name: "layerfs-p-1", workspaces: [{ directory: "/workspaces/1", mounted: true, branch: "f", base: null, baseLayer: null, root: null }] }], gone: [{ id: "2", name: "layerfs-p-2", detail: { containerGone: true } }] };
  const drawn = new TreeReader(h.spec, async () => ({ layerfs: {}, state: async () => placed, close: async () => {} }));
  const shown = (await drawn.state(P)).s;
  assert.deepEqual(shown.sandboxOrder.map((id) => [id, shown.sandboxes[id].closed]), [["layerfs-p-1", false], ["layerfs-p-2", true]]);
  assert.deepEqual(shown.sandboxes["layerfs-p-1"].wsOrder, ["/workspaces/1"]);
  await drawn.dispose();
  // forgetting a project releases its client now
  const forgotten = [];
  const owner = new TreeReader(h.spec, async () => ({ layerfs: {}, state: async () => empty, close: async () => forgotten.push("store") }));
  await owner.state(P);
  await owner.forget("p");
  assert.deepEqual(forgotten, ["store"]);

  // storage: Store totals and Init apart; every Branch's Commits once, newest first; main lists none
  const C = (id, time) => ({ id, time, message: id, via: "fs", logical: 10, newCanonical: 5, newStored: 3, newMetadata: 1 });
  const commitsOf = { feature: [C("c2", 2), C("c1", 1)], fix: [C("c3", 3), C("c1", 1)] };
  const listed = [];
  const stores = new TreeReader(h.spec, async () => ({
    layerfs: {
      project: { list_branches: async () => ({ items: ["main", "feature", "fix"].map((name) => ({ name })), hasMore: false }) },
      branch: { list_commits: async (b) => (listed.push(b), { items: commitsOf[b], hasMore: false }) },
    },
    backend: { store: { project: { get_storage: async () => ({ file: 4096, logical: 30, init: { entries: 3 } }) } } },
    close: async () => {},
  }));
  const storage = await stores.storage(P);
  assert.deepEqual([storage.store, storage.init, storage.commits.map((c) => c.id), storage.branches, storage.partial, listed], [{ file: 4096, logical: 30 }, { entries: 3 }, ["c3", "c2", "c1"], 2, false, ["feature", "fix"]]);
  await stores.dispose();

  // projects: any session may use any project; a folder only remembers its default
  const OTHER = "/work/other";
  const listedProjects = (await call("GET", "/layerfs/projects")).body;
  assert.deepEqual([listedProjects.projects.map((p) => [p.name, "folder" in p]), listedProjects.defaults], [[["website", false]], { [FOLDER]: "website" }]);
  assert.deepEqual([h.bindings.workspace(OTHER).projects.map((p) => p.name), h.bindings.projectFor("session-other", OTHER)], [["website"], null], "listed everywhere, nobody's default yet");
  assert.equal((await call("POST", "/layerfs/workspace", { folder: OTHER, project: "website" })).body.lastUsed, "website");
  assert.equal(h.bindings.projectFor("session-other", OTHER).name, "website", "a new session in the folder uses its default");
  assert.equal(h.bindings.choose("session-third", "/work/third", "website"), true, "a session chooses a project imported elsewhere");
  assert.equal(h.bindings.workspace("/work/third").lastUsed, "website");
  assert.equal((await call("POST", "/layerfs/workspace", { folder: OTHER, project: 3 })).status, 400);
  assert.equal((await call("POST", "/layerfs/workspace", { project: "website" })).status, 400);
  assert.equal((await call("POST", "/layerfs/workspace", { folder: OTHER, project: "nope" })).status, 404);
  assert.equal((await call("GET", "/layerfs/project/nope/storage")).status, 404);

  // Init: the route answers a job, and the job its steps
  const src = join(dir, "src-folder");
  mkdirSync(join(src, "lib"), { recursive: true });
  writeFileSync(join(src, "a.txt"), "hello");
  writeFileSync(join(src, "lib", "b.txt"), "abc");
  const started = await call("POST", "/layerfs/init", { folder: dir, source: src });
  assert.deepEqual([started.status, started.body.job.name, started.body.job.step], [202, "src-folder", "scan"]);
  const second = await call("POST", "/layerfs/init", { folder: dir, source: src });
  assert.equal(second.body.job.name, "src-folder-1", "a running Init keeps its name");
  assert.equal(randomName(new Set(["amber-badger"]), join(dir, "no-home"), () => 0), "amber-badger-1", "the pairs run out: numbered");
  assert.equal((await call("POST", "/layerfs/init", { folder: "relative" })).status, 409);
  // an Init's time limit: a positive whole number of ms, refused 400 before anything starts
  for (const timeout of [0, -1, 1.5, "60000", { ms: 1 }]) {
    const refused = await call("POST", "/layerfs/init", { folder: dir, source: src, timeout });
    assert.deepEqual([refused.status, refused.body.code], [400, "invalid-timeout"], JSON.stringify(timeout));
  }
  assert.equal(runs.length, 2, "a refused time limit starts no Init");
  // All projects' Import names no workspace folder: source is the folder, and the project is no folder's default
  const loose = prepareInit(h.spec, h.bindings, { source: src });
  assert.deepEqual([loose.folder, loose.project.source], [null, src]);
  assert.equal((await call("POST", "/layerfs/init", {})).body.code, "invalid-folder", "neither a source nor a workspace folder");
  assert.equal(runs.length, 2, "a refused Init starts nothing");
  const defaultsBefore = h.bindings.defaults();
  h.bindings.addProject(null, { name: "loose-import", source: src, created: Date.now() });
  assert.deepEqual([h.bindings.byName("loose-import")?.source, h.bindings.defaults()], [src, defaultsBefore], "imported, and no workspace's default");
  const limited = prepareInit(h.spec, h.bindings, { folder: dir, source: src, timeout: 900_000 });
  assert.deepEqual([limited.timeout, "timeout" in limited.project], [900_000, false], "the limit stays on the prepared Init, not the project's record");
  assert.equal("timeout" in prepareInit(h.spec, h.bindings, { folder: dir, source: src }), false);
  assert.equal(started.body.job.timeout, null, "a job without a limit of its own");
  const job = (id) => call("GET", `/layerfs/init/${id}`).then((r) => r.body.job);
  runs[0].report({ step: "import", totals: { entries: 4, files: 2, bytes: 8 } });
  assert.deepEqual([(await job(started.body.job.id)).step, (await job(started.body.job.id)).totals.files], ["import", 2]);
  runs[0].resolve({ name: "src-folder" });
  runs[1].reject(Object.assign(new Error("no Docker"), { code: "docker" }));
  await tick();
  assert.deepEqual([(await job(started.body.job.id)).step, (await job(started.body.job.id)).project.name], ["done", "src-folder"]);
  assert.deepEqual((await job(second.body.job.id)).error, { code: "docker", message: "no Docker" });
  runs[1].report({ step: "import" });
  assert.equal((await job(second.body.job.id)).step, "failed", "an ended job takes no more reports");
  assert.equal((await call("GET", "/layerfs/init/nope")).status, 404);
  // a live Init is the runtime's job, read until it ends: its steps and counts reach the Host's job,
  // and the project it made (its volume and time) is bound to the folder
  {
    const jobs = [], seen = [];
    const record = { name: "shop", source: src, volume: "layerfs-shop-store-abc", created: 7 };
    const stages = [{ step: "scan", scanned: { entries: 2 } }, { step: "import", totals: { entries: 4, files: 2, bytes: 8 }, imported: { step: "files", entries: 3, files: 1, bytes: 5 } }, { step: "done", project: record, ended: 9 }];
    const live = { ...h.spec, runtime: Promise.resolve({ project: {
      start_init: async (name, folder, options) => (jobs.push([name, folder, options]), { id: "j1", step: "scan", scanned: null, totals: null, imported: null, ended: null }),
      get_init: async () => ({ id: "j1", scanned: null, totals: null, imported: null, ended: null, ...stages.shift() }),
    } }) };
    const prepared = prepareInit(live, h.bindings, { folder: dir, source: src, name: "shop", image: "sha256:" + "1".repeat(64), timeout: 900_000 });
    const made = await runInit(live, h.bindings, prepared, (fields) => seen.push(fields.step));
    assert.deepEqual(jobs, [["shop", src, { image: "sha256:" + "1".repeat(64), timeout: 900_000 }]], "the time limit reaches start_init");
    assert.equal("timeout" in h.bindings.byName("shop"), false, "the bound project keeps no time limit");
    assert.deepEqual(seen, ["scan", "scan", "import"]);
    assert.equal(made.volume, "layerfs-shop-store-abc");
    assert.deepEqual([h.bindings.byName("shop").volume, h.bindings.workspace(dir).lastUsed], ["layerfs-shop-store-abc", "shop"]);
    // a failed Init fails the Host's job with the runtime's refusal, binds nothing and removes an empty project's folder
    const failing = { ...h.spec, runtime: Promise.resolve({ project: {
      start_init: async (name, folder, options) => (jobs.push([name, folder, options]), { id: "j2", step: "scan", ended: null }),
      get_init: async () => ({ id: "j2", step: "failed", ended: 3, error: { code: "Unsupported", message: "this process cannot write Docker's volumes directory" } }),
    } }) };
    const blankInit = prepareInit(failing, h.bindings, { folder: dir, empty: true, name: "blank-fail" });
    await assert.rejects(runInit(failing, h.bindings, blankInit), { code: "Unsupported" });
    assert.deepEqual(jobs[1][2], {}, "no limit set: start_init gets no timeout");
    assert.deepEqual([h.bindings.byName("blank-fail"), existsSync(blankInit.project.source)], [null, false]);
    h.bindings.remove("shop");
  }

  // who made each node: every journaled session's lines of that project
  const journal = (line) => appendFileSync(join(h.spec.stateDir, "lines", "session-root.jsonl"), JSON.stringify({ agentId: "child-1", agent: "tester", project: "website", ok: true, start: "2026-10-16T00:00:01.000Z", ms: 5, ...line }) + "\n");
  journal({ id: "x-1", method: "fs.write", kind: "Committed", commit: "c".repeat(64) });
  journal({ id: "x-2", method: "branch.publish", kind: "Added", commit: "c".repeat(64), layer: "l".repeat(66) });
  journal({ id: "x-3", method: "branch.fork", kind: "Forked", branch: "feature" });
  const known = h.collector.nodesOf("website"), at = Date.parse("2026-10-16T00:00:01.005Z");
  assert.deepEqual(known.authors, { ["c".repeat(64)]: "tester", ["l".repeat(66)]: "tester" });
  assert.deepEqual([known.times, known.forks], [{ ["l".repeat(66)]: at }, { feature: at }]);
  assert.deepEqual(h.collector.nodesOf("other"), { authors: {}, times: {}, forks: {} });

  // version 1 and 2 files are read as version 3: no attached folder, and a folder's one attached project stays its default
  const old = join(dir, "v1"), two = join(dir, "v2");
  mkdirSync(old); mkdirSync(two);
  writeFileSync(join(old, "bindings.json"), JSON.stringify({ version: 1, workspaces: { [FOLDER]: { projects: [{ name: "a", source: FOLDER, volume: "v", created: 1 }], lastUsed: "a" } }, sessions: {}, agents: {} }));
  const upgraded = new BindingStore(old);
  assert.deepEqual([upgraded.data.version, "folder" in upgraded.byName("a"), upgraded.workspace(FOLDER).lastUsed], [3, false, "a"]);
  const project = (name, folder) => ({ name, source: folder ?? "/s", volume: "v", created: 1, folder });
  writeFileSync(join(two, "bindings.json"), JSON.stringify({ version: 2, projects: { a: project("a", "/one"), b: project("b", "/two"), c: project("c", "/two"), d: project("d", null) }, workspaces: { "/two": { lastUsed: null } }, sessions: {}, agents: {} }));
  const v2 = new BindingStore(two);
  assert.deepEqual([v2.data.version, v2.defaults(), Object.values(v2.data.projects).some((p) => "folder" in p)], [3, { "/one": "a" }, false]);
  // the retired simulator's projects are forgotten on read, as a removal forgets them
  const simDir = join(dir, "sim");
  mkdirSync(simDir);
  writeFileSync(join(simDir, "bindings.json"), JSON.stringify({ version: 3, projects: { a: project("a"), "demo-sim": { ...project("demo-sim"), backend: "sim" } }, workspaces: { "/w": { lastUsed: "demo-sim" } }, sessions: { s: { project: "demo-sim", locked: true, folder: "/w" } }, agents: {} }));
  const sim = new BindingStore(simDir);
  assert.deepEqual([sim.projects().map((p) => p.name), sim.defaults(), sim.session("s")], [["a"], {}, { project: null, locked: false, folder: "/w" }]);

  // projects bound before the runtime kept records get one in its format, once
  {
    const records = join(h.spec.home, ".runtime", "projects");
    assert.deepEqual(adopt(h.spec, h.bindings), ["website"]);
    assert.deepEqual(JSON.parse(readFileSync(join(records, "website.json"), "utf8")), { name: "website", volume: "dsh-layerfs-website-1", source: FOLDER, created: 1 });
    writeFileSync(join(records, "website.json"), JSON.stringify({ name: "website", volume: "kept" }));
    assert.deepEqual(adopt(h.spec, h.bindings), [], "a record the runtime has is never replaced");
    assert.equal(JSON.parse(readFileSync(join(records, "website.json"), "utf8")).volume, "kept");
  }

  // removal: confirmed by name; the runtime removes the Sandbox containers, the volume (the binding's,
  // for a project made before the runtime) and the home entry, refusing Busy while a container runs;
  // then the binding goes
  assert.equal((await call("POST", "/layerfs/project/website/remove", { confirm: "web" })).status, 400);
  const removed = [];
  let busy = true;
  h.spec.runtime = Promise.resolve({ project: { list: async () => [{ name: "website", initialized: true }], remove: async (name, options) => {
    removed.push([name, options]);
    if (busy && !options.stopSandboxes) throw Object.assign(new Error("Busy: 1 running container(s) use dsh-layerfs-website-1"), { code: "Busy" });
    return { kind: "Removed", project: name, volume: options.volume };
  } } });
  const forgot = [], fakeTrees = { forget: async (name) => { forgot.push(name); } };
  await assert.rejects(removeProject(h.spec, h.bindings, fakeTrees, "website"), { code: "busy" });
  assert.notEqual(h.bindings.byName("website"), null, "a refused removal keeps the binding");
  const answered = await call("POST", "/layerfs/project/website/remove", { confirm: "website" });
  assert.deepEqual([answered.status, answered.body.code], [409, "busy"]);
  busy = false;
  assert.deepEqual(await removeProject(h.spec, h.bindings, fakeTrees, "website"), { removed: "website", volume: "dsh-layerfs-website-1" });
  assert.deepEqual(removed.map(([name, o]) => [name, o]), [
    ["website", { confirm: "website", stopSandboxes: false, volume: "dsh-layerfs-website-1" }],
    ["website", { confirm: "website", stopSandboxes: false, volume: "dsh-layerfs-website-1" }],
    ["website", { confirm: "website", stopSandboxes: false, volume: "dsh-layerfs-website-1" }],
  ]);
  assert.deepEqual(forgot, ["website", "website"]);
  mkdirSync(join(dir, "website"), { recursive: true });
  assert.equal(prepareInit(h.spec, h.bindings, { folder: dir, source: join(dir, "website") }).project.name, "website", "a removed name is free again at once");
  assert.equal(prepareInit(h.spec, h.bindings, { folder: dir, name: "website" }).project.name, "website");
  // a new empty project: a random adjective-noun name, an empty folder of its own (runInit removes it)
  const blank = prepareInit(h.spec, h.bindings, { folder: dir, empty: true }).project;
  assert.match(blank.name, /^[a-z]+-[a-z]+$/);
  assert.deepEqual([blank.empty, readdirSync(blank.source)], [true, []]);
  rmSync(blank.source, { recursive: true });
  assert.equal(prepareInit(h.spec, h.bindings, { folder: dir, empty: true, name: "blank" }).project.name, "blank");
  assert.deepEqual([h.bindings.byName("website"), h.bindings.workspace(FOLDER).lastUsed, h.bindings.session("session-root").project], [null, null, null]);
  assert.equal(h.bindings.projectFor("session-root", FOLDER), null, "a session on a removed project has none");
  await assert.rejects(removeProject(h.spec, h.bindings, fakeTrees, "website"), { code: "not-found" });
  // a demo's Replay asks to stop the running Sandboxes instead of refusing
  h.bindings.addProject(FOLDER, { name: "website", source: FOLDER, volume: "dsh-layerfs-website-2", created: 2 });
  busy = true;
  removed.length = 0;
  assert.deepEqual(await removeProject(h.spec, h.bindings, fakeTrees, "website", { stopSandboxes: true }), { removed: "website", volume: "dsh-layerfs-website-2" });
  assert.deepEqual(removed, [["website", { confirm: "website", stopSandboxes: true, volume: "dsh-layerfs-website-2" }]]);
  // the snapshot keeps a few Commits per Branch: History gets the rest from
  // branch.list_commits, so a cut-off Commit keeps its place as a parent
  {
    const { stateOf } = await import("../src/layerfs-client.js");
    const id = (n) => "12" + String(n).padStart(64, "0"), L0 = "32" + "0".repeat(64);
    const commit = (n, parent) => ({ id: id(n), branch: "feature", parent: parent && id(parent), base: L0, root: "a".repeat(63) + n, via: "fs", message: `c${n}`, time: n });
    const all = [commit(4, 3), commit(3, 2), commit(2, 1), commit(1, null)];
    const pages = [];
    const client = {
      state: async () => ({ project: "website", commits: all.slice(0, 3), more: { feature: "cursor" }, layers: [{ id: L0, parent: null, root: "b".repeat(64) }], branches: [{ name: "main", base: L0, head: null }, { name: "feature", base: L0, head: id(4) }], sandboxes: [], gone: [] }),
      layerfs: { branch: { list_commits: async (branch, size, pos) => { pages.push([branch, pos]); return pos === 0 ? { items: all.slice(0, 2), hasMore: true, nextPagePos: 2 } : { items: all.slice(2), hasMore: false, nextPagePos: null }; } } },
    };
    const state = await stateOf(client, await client.state());
    assert.deepEqual(pages, [["feature", 0], ["feature", 2]]);
    assert.equal(Object.keys(state.s.commits).length, 4, "the cut-off Commit is listed");
    assert.equal(state.s.commits[state.labels[id(2)]].parent, state.labels[id(1)], "and is its child's parent");
  }
  // History is kept with its Store version: an unchanged History lists no Commit, a changed
  // one lists only Commits it has not seen, and a chain it cannot finish is listed in full
  {
    const { allCommits } = await import("../src/layerfs-client.js");
    const { historyAnswer } = await import("../src/route.js");
    const id = (n) => "12" + String(n).padStart(64, "0"), L0 = "32" + "0".repeat(64);
    const commit = (n, parent) => ({ id: id(n), branch: "feature", parent: parent && id(parent), base: L0, root: "a".repeat(63) + n, via: "fs", message: `c${n}`, time: n });
    const chain = (...ns) => ns.map((n, i) => commit(n, ns[i + 1] ?? null));
    const snapOf = (commits, head) => ({ project: "website", commits: commits.slice(0, 2), more: { feature: null }, layers: [{ id: L0, parent: null, root: "b".repeat(64) }], branches: [{ name: "main", base: L0, head: null }, { name: "feature", base: L0, head: id(head) }] });
    const lister = (commits, pages) => ({ branch: { list_commits: async (branch, size, pos) => { pages.push(pos); const items = commits.slice(pos, pos + 2); return { items, hasMore: pos + 2 < commits.length, nextPagePos: pos + 2 < commits.length ? pos + 2 : null }; } } });
    const ids = (snap) => snap.commits.map((c) => c.id).sort();
    const byId = (commits) => new Map(commits.map((c) => [c.id, c]));
    const first = chain(4, 3, 2, 1), pages = [];
    const full = await allCommits(lister(first, pages), snapOf(first, 4));
    assert.deepEqual([ids(full), pages], [first.map((c) => c.id).sort(), [0, 2]]);
    // a known head: nothing listed
    pages.length = 0;
    assert.deepEqual([ids(await allCommits(lister(first, pages), snapOf(first, 4), byId(first))), pages], [ids(full), []]);
    // one new Commit: one page, stopped at the first known Commit
    const grown = chain(6, 5, 4, 3, 2, 1);
    pages.length = 0;
    assert.deepEqual([ids(await allCommits(lister(grown, pages), snapOf(grown, 6), byId(first))), pages], [grown.map((c) => c.id).sort(), [0, 2]]);
    // a forced Commit displaced the head: the displaced Commits drop out, as in a full listing
    const forced = [commit(7, 3), ...chain(3, 2, 1)];
    pages.length = 0;
    const kept = await allCommits(lister(forced, pages), snapOf(forced, 7), byId(grown));
    assert.deepEqual([ids(kept), pages], [[id(1), id(2), id(3), id(7)], [0]]);
    // known Commits that do not reach the root: the Branch is listed in full
    pages.length = 0;
    const partial = await allCommits(lister(grown, pages), snapOf(grown, 6), byId([commit(4, 3)]));
    assert.deepEqual([ids(partial), pages], [grown.map((c) => c.id).sort(), [0, 2, 0, 2, 4]]);

    // TreeReader.history: the Store is asked since the kept version; unchanged answers the kept History
    let history = { kind: "ok", version: "v1", ...snapOf(first, 4) };
    const sinces = [], listed = [];
    const reader = new TreeReader(h.spec, async () => ({ layerfs: lister(first, listed), backend: { store: { project: { get_history: async (since) => (sinces.push(since), since === history.version ? { kind: "unchanged", version: since } : history) } } }, close: async () => {} }));
    const P = { name: "website" };
    const one = await reader.history(P), again = await reader.history(P);
    assert.deepEqual([sinces, listed, one.version, again === one], [[undefined, "v1"], [0, 2], "v1", true], "the second read lists nothing and answers the kept History");
    history = { kind: "ok", version: "v2", ...snapOf(grown, 6) };
    reader.open = async () => ({ layerfs: lister(grown, listed), backend: { store: { project: { get_history: async (since) => (sinces.push(since), history) } } }, close: async () => {} });
    await reader.forget("other");
    listed.length = 0;
    const [moved, shared] = await Promise.all([reader.history(P), reader.history(P)]);
    assert.deepEqual([sinces.at(-1), sinces.length, listed, moved.version, moved === shared, Object.keys(moved.s.commits).length], ["v1", 3, [0], "v2", true, 6], "a changed History lists only its new Commits, once for both readers");
    await reader.forget("website");
    assert.deepEqual([reader.histories.size, reader.commits.size], [0, 0], "forgetting a project drops what was kept");
    await reader.dispose();

    // the route's version covers the Store's History and the traces' authors and times
    const nodes = { authors: { [id(4)]: "ann" }, times: {}, forks: {} };
    const answer = historyAnswer(one, nodes, null);
    assert.equal(answer.authors[id(4)], "ann");
    assert.deepEqual(historyAnswer(one, nodes, answer.version), { kind: "unchanged", version: answer.version });
    assert.notEqual(historyAnswer(one, { ...nodes, authors: { [id(4)]: "bob" } }, answer.version).kind, "unchanged", "a new author is a new version");
    assert.equal(historyAnswer({ ...one, version: undefined }, nodes, undefined).version, undefined, "a History without a version is never unchanged");
  }
  // a live project's client: LayerFS.open with the project's deployment (here on a stand-in binding in
  // this process), its backend beside it, its state from the runtime; releasing it closes its Store
  {
    const { clientFor, release } = await import("../src/layerfs-client.js");
    const binding = join(dir, "binding.cjs"), seen = join(dir, "binding-calls.jsonl");
    writeFileSync(binding, `const { appendFileSync } = require("node:fs");
const log = (fn) => async (op, args) => { appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ fn, op, args }) + "\\n"); return { value: op === "backend.store.project.get_storage" ? { logical: 5, dedupe: "1.5", compression: null } : { items: [], hasMore: false } }; };
module.exports = { call: log("call"), backendCall: log("backendCall"), storeOpen: (args) => log("storeOpen")("open", args), storeClose: (args) => log("storeClose")("close", args) };`);
    process.env.LAYERFS_NATIVE = binding;
    const states = [];
    const live = { ...h.spec, worker: false, runtime: Promise.resolve({ project: { list: async () => [{ name: "shop", initialized: true }], get_state: async (name) => (states.push(name), { kind: "ok", project: name }) } }) };
    const client = await clientFor(live, { name: "shop", volume: "layerfs-shop-store-1", image: "sha256:" + "2".repeat(64) });
    assert.deepEqual(await client.backend.store.project.get_storage(), { logical: 5, dedupe: 1.5, compression: null });
    assert.deepEqual(await client.state(), { kind: "ok", project: "shop" });
    assert.deepEqual(states, ["shop"]);
    await release(client);
    const lines = readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.fn), ["storeOpen", "call", "backendCall", "storeClose"]);
    const lookup = lines[1].args;
    // Windows projects belong to the configured Linux home even when this
    // test substitutes an in-process binding for the worker transport.
    const projectHome = process.platform === "win32" ? h.spec.wsl.home : h.spec.home;
    assert.deepEqual([lines[1].op, lookup.project, lookup.home, lookup.storePath], ["project.list_branches", "shop", projectHome, `${h.spec.volumes}/layerfs-shop-store-1/_data/global/store.sqlite`]);
    assert.deepEqual([lookup.deploy.volume, lookup.deploy.image, lookup.deploy.containerPrefix], ["layerfs-shop-store-1", "sha256:" + "2".repeat(64), "layerfs-"]);
    assert.ok(!("LAYERFS_VOLUME" in process.env), "the deployment is set for the open only");
  }
  // an agent's call that found the home's worker down or gone tells the Host, which starts it again; other failures do not
  {
    const healing = host();
    let heals = 0;
    healing.collector.onUnreachable = () => heals++;
    const file = healing.collector.track({ id: "heal-1", root: "heal-root" }, { name: "website" });
    const failed = (id, message) => JSON.stringify({ layerfs_trace: 1, id, method: "fs.read", start: new Date().toISOString(), ms: 1, ok: false, code: "Failed", message }) + "\n";
    appendFileSync(file, failed("u-1", "the LayerFS worker did not answer (connect ECONNREFUSED 127.0.0.1:55012); the call was not sent")
      + failed("u-2", "NoSuchPath: /nope.js"));
    healing.collector.poll();
    assert.equal(heals, 1);
  }
  // All projects: everything Docker-side comes from the runtime; a running project gets a card with
  // each Sandbox's scratch, an idle one a row with its Store volume, a missing volume a problem card
  {
    const daemon = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => daemon.once("listening", resolve));
    const port = daemon.address().port;
    const allDir = join(dir, "all");
    mkdirSync(allDir);
    const all = new BindingStore(allDir);
    for (const [name, created] of [["alpha", 1], ["beta", 2], ["gamma", 3], ["delta", 4], ["epsilon", 5]]) all.addProject("/w", { name, source: "/w", volume: `vol-${name}`, created });
    const removedVolumes = [];
    const fake = {
      // delta lost its home entry (project.record); epsilon has neither entry nor volume
      project: { list: async () => ["alpha", "beta", "gamma"].map((name) => ({ name, initialized: true })).concat([{ name: "delta", initialized: false }]) },
      status: async () => ({ docker: { level: "ok", version: "29.0" }, worker: null, disk: { home: 5e11, volumes: DOCKER_LOW - 1 }, sweep: { state: "done", at: "2026-10-24T00:00:00Z", reclaimed: { beta: ["1"] }, failed: [] } }),
      sandbox: {
        list: async () => [{ name: "t-alpha-1", project: "alpha", sandbox: "1", state: "running", running: true, image: "sha256:abc", ports: [{ container: "7000/tcp", host: "127.0.0.1", port }], scratch: 123456, owned: true }],
        list_leftovers: async () => [{ name: "t-old-1", running: false, status: "Exited (0)", project: "old" }],
      },
      volume: {
        list: async () => [
          { name: "vol-alpha", size: 1e6, containers: 1, owner: "this", project: "alpha", live: true, removable: false },
          { name: "vol-beta", size: 2e6, containers: 0, owner: "this", project: "beta", live: true, removable: false },
          { name: "vol-delta", size: 6e6, containers: 0, owner: "unknown", project: null, live: false, removable: false },
          { name: "vol-old", size: 3e6, containers: 0, owner: "this", project: "old", live: false, removable: true },
          { name: "anon", size: 4e6, containers: 0, owner: "unknown", project: null, live: false, removable: false },
          { name: "theirs", size: 5e6, containers: 0, owner: "other", project: "x", live: false, removable: false },
        ],
        remove: async (names) => { removedVolumes.push(names); return { results: names.map((name) => ({ name, ok: true })) }; },
      },
    };
    const allSpec = { ...h.spec, runtime: Promise.resolve(fake) };
    const quiet = { mountsOf: () => ({}), busyOf: () => new Set(), runningCalls: () => 0 };
    const v = await overview(allSpec, all, null, quiet);
    daemon.close();
    assert.deepEqual(v.projects.map((p) => [p.name, p.level, p.note, p.removable]), [
      ["delta", "down", "its record is missing; see layerfs-home.md", false],
      ["epsilon", "down", "it has no record and no Store volume (vol-epsilon): nothing to recover", true],
      ["gamma", "down", "its Store volume vol-gamma is missing", false],
      ["alpha", "ok", null, false],
    ]);
    assert.deepEqual(v.projects[3].sandboxes.map((s) => [s.id, s.scratch, s.used]), [["1", 123456, 0]]);
    assert.deepEqual(v.idle, [{ name: "beta", volume: 2e6 }]);
    assert.deepEqual(v.volumes, { orphans: [{ name: "vol-old", size: 3e6, project: "old", containers: 0, removable: true }], unknown: { count: 2, size: 10e6 } });
    assert.deepEqual([v.disk.docker, v.disk.dockerLevel, v.sweep.state], [DOCKER_LOW - 1, "degraded", "done"]);
    assert.deepEqual(v.reasons.map((r) => r.text), ["3 projects need a look", "Docker disk low", "2 leftovers"]);
    assert.deepEqual([v.level, v.totals], ["down", { projects: 5, sandboxes: 1, workspaces: 0 }]);
    // a daemon that does not answer: starting within STARTING_MS of its container's start, then down
    {
      const closed = createServer().listen(0, "127.0.0.1");
      await new Promise((resolve) => closed.once("listening", resolve));
      const silentPort = closed.address().port;
      await new Promise((resolve) => closed.close(resolve));
      const silentAt = (ago) => ({ ...fake, sandbox: { ...fake.sandbox, list: async () => [{ name: "t-alpha-1", project: "alpha", sandbox: "1", state: "running", running: true, startedAt: new Date(Date.now() - ago).toISOString(), image: "sha256:abc", ports: [{ container: "7000/tcp", host: "127.0.0.1", port: silentPort }], scratch: 1, owned: true }] } });
      const alphaOf = async (ago) => (await overview({ ...h.spec, runtime: Promise.resolve(silentAt(ago)) }, all, null, quiet)).projects.find((p) => p.name === "alpha");
      const young = await alphaOf(2_000);
      assert.deepEqual([young.level, young.note, young.sandboxes[0].starting], ["ok", null, true], "a just-started Sandbox is starting, not down");
      const old = await alphaOf(STARTING_MS + 5_000);
      assert.deepEqual([old.level, old.note, old.sandboxes[0].starting], ["down", "t-alpha-1 does not accept a connection", false], "still silent after STARTING_MS: down");
    }
    // Docker down: no listing is read, and the page says why
    const down = await overview({ ...h.spec, runtime: Promise.resolve({ ...fake, status: async () => ({ docker: { level: "down" }, worker: null, disk: { home: null, volumes: null }, sweep: null }) }) }, all, null, quiet);
    // without Docker no volume is known missing; a lost home entry still shows
    assert.deepEqual([down.reasons[0].text, down.volumes, down.disk.dockerLevel, down.idle.map((p) => p.name)], ["Docker not answering", null, null, ["alpha", "beta", "gamma"]]);
    // a project with no home entry and no Store volume is only forgotten, with the record adopt wrote for it;
    // a project with no home entry does not open
    const forgotten = [], adopted = join(runtimeState(allSpec), "projects", "epsilon.json");
    mkdirSync(dirname(adopted), { recursive: true });
    writeFileSync(adopted, JSON.stringify({ name: "epsilon", volume: "vol-epsilon" }));
    assert.deepEqual(await removeProject(allSpec, all, { forget: async (name) => { forgotten.push(name); } }, "epsilon"), { removed: "epsilon", volume: null });
    assert.deepEqual([forgotten, all.byName("epsilon"), existsSync(adopted)], [["epsilon"], null, false]);
    await assert.rejects(clientFor(allSpec, { name: "delta" }), { code: "no-record", message: "delta: its record is missing; see layerfs-home.md" });
    assert.deepEqual(await removeVolumes(allSpec, ["vol-old"]), { results: [{ name: "vol-old", ok: true }] });
    await assert.rejects(removeVolumes(allSpec, []), { code: "invalid-names" });
    assert.deepEqual(removedVolumes, [["vol-old"]]);
  }
  // @layerfs/agent's worker client answers when the worker is down or went away, as trace lines carry them
  for (const message of ["the LayerFS worker is not running for this home: ENOENT: no such file or directory, open '/h/worker/endpoint.json'",
    "the LayerFS worker did not answer (connect ECONNREFUSED 127.0.0.1:1); the call was not sent",
    "the connection to the LayerFS worker was lost (read ECONNRESET) after the call was sent; it may have completed: check the project before going on"]) assert.match(message, UNREACHABLE);
  assert.doesNotMatch("NoSuchPath: the LayerFS worker folder is not here", UNREACHABLE);
  console.log("host: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
