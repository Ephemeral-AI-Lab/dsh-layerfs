// Run in an isolated Linux container: exercises the macOS worker entry point,
// without a macOS host, real Stores, or a shared /tmp.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { frame, readFrames } from "../src/port/frames.mjs";

const dir = mkdtempSync(join(tmpdir(), "layerfs-port-worker-")), native = join(dir, "binding.cjs");
writeFileSync(native, "exports.call=async(op,args)=>({value:{op,args}});exports.storeOpen=async()=>({value:null});exports.storeClose=async()=>({value:null});");
const secret = randomBytes(32).toString("hex");
const child = spawn(process.execPath, [fileURLToPath(new URL("../src/port/worker.mjs", import.meta.url))], {
  env: { ...process.env, TMPDIR: dir, DSH_BOX_SECRET: secret, LAYERFS_NATIVE: native }, stdio: ["ignore", "ignore", "pipe"],
});
let log = "", socket;
child.stderr.on("data", (bytes) => { log += bytes; });
const until = Date.now() + 5000;
try {
  while (!log.includes("listening on 7070")) {
    assert.equal(child.exitCode, null, log);
    assert(Date.now() < until, "worker readiness expired");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket = connect({ host: "127.0.0.1", port: 7070 });
  socket.setTimeout(3000, () => socket.destroy(new Error("worker response expired")));
  const pending = new Map();
  socket.on("error", (error) => { for (const p of pending.values()) p.reject(error); });
  readFrames(socket, ({ id, answer }) => { const p = pending.get(id); pending.delete(id); p?.resolve(answer); }, (error) => socket.destroy(error));
  const request = (id, value) => new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.write(frame(value)); });
  assert.deepEqual(await request(0, { secret }), { value: "hello" });
  assert.deepEqual(await request(1, { id: 1, fn: "ping" }), { value: "ready" });
  const args = { project: "proof", home: dir, storePath: "/not-a-real-store", bytes: Buffer.from([0, 128, 255]) };
  assert.deepEqual(await request(2, { id: 2, fn: "call", op: "fs.write", args, open: true }), { value: { op: "fs.write", args } });
  const closed = once(socket, "close");
  socket.write(Buffer.from([0, 0, 0, 1, 255]));
  await closed;
  while (!log.includes("worker protocol")) {
    assert(Date.now() < until, "missing protocol diagnostic");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log("port-worker: authentication, binary call and malformed-frame diagnostic pass");
} finally {
  socket?.destroy();
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  await exited;
  clearTimeout(timer);
}
