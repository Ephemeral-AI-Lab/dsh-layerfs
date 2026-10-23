// WSL lifecycle and Docker control for the Windows Host. No Store I/O runs here.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { frame, readFrames } from "../port/frames.mjs";
import { connection } from "./binding.js";
import { absoluteLinux, linuxPath, projectHome, wsl, wslArgs } from "./paths.js";

const workers = new Map();
const refuse = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export const endpointFile = (home) => join(home, "wsl-worker", "endpoint.json");
export const windowsDocker = (spec, args, options = {}) => wsl(spec.windows, ["docker", "-H", `unix://${spec.docker}`, ...args], options);

export function windowsConfig(config, home, prefix) {
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const linuxHome = absoluteLinux(config.wslHome || `/var/lib/dsh-layerfs-windows/${hash}`, "wslHome");
  if (linuxHome === "/") throw new Error("wslHome must be a private directory, not the Linux root");
  return {
    distribution: config.wslDistribution || "Ubuntu",
    user: config.wslUser || "root",
    node: absoluteLinux(config.wslNode || "/usr/local/bin/node", "wslNode"),
    home: linuxHome,
    name: `${prefix}wsl-worker`,
    endpoint: endpointFile(home),
  };
}

async function protectEndpoint(directory) {
  if (process.platform !== "win32") throw new Error("the Windows Host adapter requires Windows");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const sid = /S-1-[0-9-]+/.exec(stdout)?.[0];
  if (!sid) throw new Error("could not determine the Windows user's SID");
  await run("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true });
}

/** One start per Host/home. Failed starts stay failed until an explicit runtime start. */
export function ensureWindows(spec) {
  let held = workers.get(spec.home);
  if (held) return held.ready;
  held = { child: null, ready: null };
  workers.set(spec.home, held);
  held.ready = start(spec, held);
  return held.ready;
}

async function start(spec, held) {
  if (!spec.bundle || !spec.image || !spec.daemon) throw new Error("Windows Live needs image and a sealed Linux bundle");
  const windows = spec.windows, directory = join(spec.home, "wsl-worker");
  mkdirSync(directory, { recursive: true });
  await protectEndpoint(directory);
  // Refuse to replace a worker of another live Host, including a silent one.
  let old;
  try { old = JSON.parse(readFileSync(windows.endpoint, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (old) {
    let alive = false;
    try { process.kill(old.pid, 0); alive = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (alive) throw new Error("this LayerFS home already has a WSL worker owner; close its Host or select another home");
  }
  const script = await linuxPath(fileURLToPath(new URL("./worker.js", import.meta.url)), windows);
  const child = spawn("wsl.exe", wslArgs(windows, [windows.node, script]), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  held.child = child;
  const log = createWriteStream(join(directory, "worker.log"), { flags: "a" });
  child.stderr.pipe(log);
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const secret = randomBytes(32).toString("hex");
  const ready = await new Promise((resolve, reject) => {
    const fail = (error) => { clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => { child.stdin.end(); fail(new Error("WSL worker did not become ready within 20 seconds; inspect worker.log")); }, 20_000);
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`WSL worker ended before readiness (${signal || code}); inspect worker.log`)));
    readFrames(child.stdout, (value) => {
      if (!Number.isInteger(value.port) || value.port < 1) return fail(new Error("invalid WSL readiness reply"));
      clearTimeout(timer);
      resolve(value);
    }, () => fail(new Error("invalid WSL readiness frame")));
    child.stdin.write(frame({ secret, home: windows.home, bundle: absoluteLinux(spec.bundle, "bundle") }));
  });
  // The Windows-side SDK must match the sealed native build (Git line endings are normalized).
  const sdkRoot = fileURLToPath(new URL("../", import.meta.resolve("@layerfs/sdk")));
  try {
    if (!ready.sdk || !Object.keys(ready.sdk).length) throw new Error("WSL worker supplied no SDK identity");
    for (const [path, expected] of Object.entries(ready.sdk)) {
      if (!/^sdk\/js\/(src|operator)\//.test(path) || path.includes("..")) throw new Error("invalid SDK identity path");
      const source = readFileSync(join(sdkRoot, path.slice("sdk/js/".length)), "utf8").replaceAll("\r\n", "\n");
      if (createHash("sha256").update(source).digest("hex") !== expected) throw new Error(`Windows SDK differs from the sealed Linux build: ${path}`);
    }
  } catch (error) { child.stdin.end(); throw error; }
  const info = { ...windows, port: ready.port, build: ready.build, secret, pid: child.pid, startedAt: new Date().toISOString() };
  writeFileSync(`${windows.endpoint}.new`, JSON.stringify(info));
  renameSync(`${windows.endpoint}.new`, windows.endpoint);
  held.info = info;
  // Loopback forwarding may become ready after WSL's listener itself.
  const until = Date.now() + 10_000;
  for (;;) {
    const reply = await ping(info);
    if (reply?.ready) break;
    if (Date.now() >= until) throw new Error("WSL worker's loopback listener is unreachable from Windows");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return info;
}

async function ping(info) {
  // A bounded diagnostic owns its own socket; it never cancels an SDK request.
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: info.port });
    const done = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(null), 1000);
    socket.on("connect", () => socket.write(frame({ secret: info.secret })));
    readFrames(socket, ({ id, answer }) => {
      if (id === 0 && answer?.value === "hello") socket.write(frame({ id: 1, fn: "ping" }));
      else if (id === 1) done(answer?.value);
      else done(null);
    }, () => done(null));
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

export async function windowsState(spec) {
  const held = workers.get(spec.home);
  let info;
  try { info = held ? await held.ready : JSON.parse(readFileSync(spec.windows.endpoint, "utf8")); }
  catch (error) { return { level: "down", state: "stopped", name: spec.windows.name, error: error.message }; }
  const reply = await ping(info);
  return { level: reply?.ready ? "ok" : "down", state: reply?.ready ? "running" : "unknown", answering: !!reply?.ready, name: spec.windows.name, active: reply?.active, stores: reply?.stores, build: reply?.build, startedAt: info.startedAt };
}

/** Graceful only: admitted SDK calls drain. No process or mounted command is killed. */
export async function closeWindows(spec) {
  const held = workers.get(spec.home);
  if (!held?.child) return;
  const child = held.child;
  child.stdin.end();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("WSL worker is still draining; retained without a forced stop")), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  workers.delete(spec.home);
  rmSync(spec.windows.endpoint, { force: true });
}

export async function startWindows(spec) {
  const held = workers.get(spec.home);
  if (held?.child && held.child.exitCode === null && held.child.signalCode === null) throw refuse("busy", "the WSL worker still has a live owner");
  workers.delete(spec.home);
  await ensureWindows(spec);
  return windowsState(spec);
}

export async function restartWindows(spec, body) {
  if (body?.confirm !== "restart") throw refuse("not-confirmed", "confirm the WSL worker restart with restart");
  const state = await windowsState(spec);
  if (!state.answering || state.active) throw refuse("busy", "the WSL worker is unavailable or has active calls; it was not stopped");
  await closeWindows(spec);
  await ensureWindows(spec);
  return windowsState(spec);
}

export async function removeWindowsHome(spec, name) {
  // rm receives one checked child directory as an argv item, never shell text.
  await wsl(spec.windows, ["rm", "-rf", "--", projectHome(spec.windows, name)], { timeout: 10_000 });
}

/** Before deleting a volume, finish the worker's cached Store ownership explicitly. */
export async function releaseWindowsStore(spec, volume) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) throw new Error("invalid Store volume name");
  const info = await ensureWindows(spec);
  const answer = await connection(info).call({ fn: "releaseStore", args: { home: spec.windows.home, storePath: `/var/lib/docker/volumes/${volume}/_data/global/store.sqlite` } });
  if (answer.refused) throw Object.assign(new Error(answer.refused.message), { code: answer.refused.code });
}

export async function windowsFree(spec) {
  try {
    const { stdout } = await wsl(spec.windows, ["df", "-kP", spec.windows.home], { timeout: 5000 });
    const kb = Number(stdout.trim().split("\n").pop().trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch { return null; }
}
