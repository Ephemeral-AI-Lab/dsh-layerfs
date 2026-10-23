// Windows + WSL correctness proof. Run once with a sealed Linux bundle and exact local image.
// node windows-real.mjs <Linux bundle> <image sha256:...> [distribution]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { resolveConfig } from "../src/config.js";
import { BindingStore } from "../src/binding.js";
import { initProject } from "../src/init.js";
import { clientFor, release } from "../src/layerfs-client.js";
import { closeWindows, ensureWindows, restartWindows, windowsState } from "../src/windows/host.js";
import { removeProject } from "../src/remove.js";
import { overview } from "../src/runtime.js";

assert.equal(process.platform, "win32", "this proof needs a real Windows Host");
const [bundle, image, distribution = "Ubuntu"] = process.argv.slice(2);
assert(bundle && /^sha256:[a-f0-9]{64}$/.test(image), "supply bundle and image");
const work = mkdtempSync(join(tmpdir(), "layerfs-windows-proof-"));
const source = join(work, "source space ' unicode-中文");
mkdirSync(source);
mkdirSync(join(source, ".git"));
writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
writeFileSync(join(source, "ignored.txt"), "included despite gitignore\n");
writeFileSync(join(source, "hello.txt"), "Windows import\n");
const id = randomBytes(6).toString("hex");
const spec = resolveConfig({ image, bundle, wslDistribution: distribution, wslHome: `/var/lib/dsh-layerfs-windows/proof-${id}`, home: join(work, "home"), stateDir: join(work, "state"), traceDir: join(work, "traces"), containerPrefix: `winproof-${id}-` });
const bindings = new BindingStore(spec.stateDir);
const receipt = { work, linuxHome: spec.windows.home, outcomes: {} };
const record = (step, value) => {
  receipt.outcomes[step] = value;
  writeFileSync(join(work, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(step, JSON.stringify(value));
};
let client;
try {
  const project = await initProject(spec, bindings, { folder: source, name: "windows-proof" });
  record("init", project);
  client = await clientFor(spec, project);
  const lf = client.layerfs;
  assert.equal((await lf.fs.read("main", "/ignored.txt")).text, "included despite gitignore\n");
  assert.equal((await lf.fs.read("main", "/.git/HEAD")).text, "ref: refs/heads/main\n");
  record("fork", await lf.branch.fork("work"));
  record("write", await lf.fs.write("work", "/from-windows.txt", "SDK write\n", "Windows SDK write"));
  const ws = await lf.workspace.mount("work");
  record("mount", ws);
  try {
    const ran = await lf.workspace.exec(ws, "timeout 20 bash -c 'cat from-windows.txt; printf \"WSL exec\\n\" > from-linux.txt'", "Windows to WSL exec");
    record("exec", ran);
    record("commit", await lf.workspace.commit(ws, "Windows Workspace capture"));
    assert.equal(ran.exitCode, 0);
    assert.equal(ran.stdout, "SDK write\n");
    const large = await lf.workspace.exec(ws, `timeout 20 node -e 'process.stdout.write("x".repeat(1048577))'`, "spooled output across Windows boundary");
    assert.equal(large.exitCode, 0);
    assert.equal(large.stdout, "x".repeat(1048577));
    record("largeOutput", { bytes: large.stdout.length, exitCode: large.exitCode });
    const sink = createHash("sha256");
    const binary = await lf.workspace.exec(ws, `timeout 20 node -e 'process.stdout.write(Buffer.alloc(1048577,255))'`, "binary output across Node versions", { stdout: sink });
    assert.equal(binary.exitCode, 0);
    assert.equal(binary.stdout, null);
    assert.equal(binary.stdoutBytes, 1048577);
    assert.equal(sink.digest("hex"), createHash("sha256").update(Buffer.alloc(1048577, 255)).digest("hex"));
    record("binaryOutput", { bytes: binary.stdoutBytes, exitCode: binary.exitCode });
  } finally { record("unmount", await lf.workspace.unmount(ws)); }
  record("publish", await lf.branch.publish("work"));
  assert.equal((await lf.fs.read("main", "/from-linux.txt")).text, "WSL exec\n");
  record("history", await client.history());
  await release(client); client = null;
  // One quiet interval exercises the actual native close and a later explicit read, not a timed gate.
  await pause(61_000);
  const idle = await windowsState(spec);
  assert.equal(idle.stores, 0);
  record("idleClose", idle);
  client = await clientFor(spec, project);
  assert.equal((await client.layerfs.fs.read("main", "/from-linux.txt")).text, "WSL exec\n");
  await release(client); client = null;
  record("worker", await windowsState(spec));
  record("restart", await restartWindows(spec, { confirm: "restart" }));
  client = await clientFor(spec, project);
  assert.equal((await client.layerfs.fs.read("main", "/from-linux.txt")).text, "WSL exec\n");
  record("reopen", "published data survived worker restart");
  const collector = { mountsOf: () => ({}), runningCalls: () => [], busyOf: () => new Set() };
  const runtime = await overview(spec, bindings, { spec }, collector);
  assert.equal(runtime.engine.level, "ok");
  assert.equal(runtime.store.level, "ok");
  assert(runtime.disk.vm > 0);
  record("runtime", runtime);
  await release(client); client = null;
  record("remove", await removeProject(spec, bindings, { forget: async () => {} }, project.name, undefined, { stopSandboxes: true }));
  assert.equal(bindings.byName(project.name), null);
  record("verdict", "PASS");
} finally {
  if (client) await release(client);
  await closeWindows(spec);
  console.log("Receipt:", join(work, "receipt.json"));
}
