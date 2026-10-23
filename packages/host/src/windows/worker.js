// One WSL process per Windows LayerFS home. Linux owns all native handles and Store I/O.
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, createReadStream, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { made, storeOf } from "../port/call.mjs";
import { decode, frame, readFrames } from "../port/frames.mjs";

const IDLE_MS = 60_000;
process.env.UV_THREADPOOL_SIZE ??= "64";
let bytes = Buffer.alloc(0), booted = false;
process.stdin.on("data", (chunk) => {
  if (booted) return;
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32BE(0)) return;
  // The parent sends one startup frame, never a secret in command-line arguments.
  booted = true;
  Promise.resolve().then(() => start(decode(bytes.subarray(4))))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; process.stdin.destroy(); });
});

async function start(config) {
  const secret = Buffer.from(config.secret, "hex");
  if (secret.length !== 32 || !config.home?.startsWith("/") || !config.bundle?.startsWith("/")) throw new Error("invalid WSL worker startup settings");
  const manifest = JSON.parse(readFileSync(join(config.bundle, "manifest.json"), "utf8"));
  if (manifest.status !== "sealed" || manifest.platform !== "linux") throw new Error("Windows requires a sealed Linux bundle");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = resolve(config.bundle, name);
    if (!path.startsWith(resolve(config.bundle) + sep)) throw new Error("bundle file escapes its root");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== expected) throw new Error(`sealed bundle file changed: ${name}`);
  }
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  // A private temp directory prevents PID reuse from colliding with another opener's files.
  const temp = join(config.home, "worker-" + randomBytes(12).toString("hex"));
  mkdirSync(temp, { mode: 0o700 });
  process.env.TMPDIR = temp;
  process.env.LAYERFS_CONSTRUCTION_WORKERS = "1";
  const binding = createRequire(import.meta.url)(join(config.bundle, "layerfs.node"));
  const stores = new Map(), sockets = new Set();
  let active = 0, closing = false, finishing = false;
  async function closeStore(path) {
    const held = stores.get(path);
    if (!held) return { value: null };
    if (held.users) return { refused: { code: "Busy", message: "the project's Store has active calls", detail: null } };
    clearTimeout(held.timer);
    held.closing ??= held.opening.then(() => binding.storeClose(storeOf(held.args))).then((answer) => {
      if (answer?.refused) throw new Error(JSON.stringify(answer.refused));
      if (stores.get(path) === held) stores.delete(path);
    });
    await held.closing;
    return { value: null };
  }
  async function withStore(args, work) {
    let held = stores.get(args.storePath);
    while (held?.closing) { await held.closing; held = stores.get(args.storePath); }
    if (!held) stores.set(args.storePath, held = { opening: binding.storeOpen(storeOf(args)), users: 0, timer: null, args });
    held.users++;
    clearTimeout(held.timer);
    try {
      const answer = await held.opening;
      if (answer.refused) { stores.delete(args.storePath); return answer; }
      return await work();
    } finally {
      if (--held.users === 0 && stores.get(args.storePath) === held) held.timer = setTimeout(async () => {
        try { await closeStore(args.storePath); } catch (error) { console.error(error); }
      }, IDLE_MS);
    }
  }
  async function shutdown() {
    if (!closing) { closing = true; server.close(); }
    if (active || finishing) return;
    finishing = true;
    for (const path of stores.keys()) await closeStore(path);
    for (const socket of sockets) socket.end();
    rmdirSync(temp);
    process.stdin.destroy();
  }
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let trusted = false;
    readFrames(socket, async (request) => {
      if (!trusted) {
        const given = Buffer.from(String(request?.secret ?? ""), "hex");
        if (given.length !== secret.length || !timingSafeEqual(given, secret)) return socket.destroy();
        trusted = true;
        return socket.write(frame({ id: 0, answer: { value: "hello" } }));
      }
      const { id, fn, op, args, open } = request;
      if (fn === "ping") return socket.write(frame({ id, answer: { value: { ready: true, active, stores: stores.size, build: manifest.build_id } } }));
      if (closing) return socket.write(frame({ id, answer: { refused: { code: "Failed", message: "WSL worker is closing; operation was not attempted", detail: null } } }));
      if (!["call", "operatorCall", "releaseStore"].includes(fn) || args?.home !== config.home) return socket.destroy();
      active++;
      let answer;
      try { answer = fn === "releaseStore" ? await closeStore(args.storePath) : await (open ? withStore(args, () => made(binding, fn, op, args)) : made(binding, fn, op, args)); }
      catch (error) { answer = { refused: { code: "Unknown", message: String(error.stack ?? error), detail: null } }; }
      finally { active--; }
      if (!socket.destroyed) socket.write(frame({ id, answer }));
      if (closing && active === 0) shutdown().catch((error) => console.error(error));
    }, (error) => { console.error(error.message); socket.destroy(); });
  });
  process.stdin.on("end", () => shutdown().catch((error) => console.error(error)));
  server.listen(0, "127.0.0.1", () => {
    const sdk = Object.fromEntries(Object.entries(manifest.files).filter(([path]) => path.startsWith("sdk/js/src/") || path.startsWith("sdk/js/operator/")));
    process.stdout.write(frame({ port: server.address().port, build: manifest.build_id, sdk }));
    if (process.stdin.readableEnded) shutdown().catch((error) => console.error(error));
  });
}
