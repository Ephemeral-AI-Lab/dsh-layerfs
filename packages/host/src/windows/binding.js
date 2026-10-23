// Windows-only native binding adapter. A sent call is never replayed after a lost connection.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { frame, readFrames } from "../port/frames.mjs";
import { linuxPath } from "./paths.js";

const homes = new Map(), opened = new Map(), links = new Map();
const refused = (code, message) => ({ refused: { code, message, detail: null } });

/** Captured by the Windows SDK constructor before the Host restores its environment. */
export function configure(home, endpoint) {
  if (!home || !endpoint) throw new Error("Windows LayerFS needs HOME and WSL_ENDPOINT");
  homes.set(home, endpoint);
}

function infoFor(home) {
  const file = homes.get(home);
  if (!file) throw new Error("no WSL worker endpoint is configured for this LayerFS home");
  const info = JSON.parse(readFileSync(file, "utf8"));
  if (info.home !== home || !Number.isInteger(info.port) || !/^[0-9a-f]{64}$/.test(info.secret)) throw new Error("invalid WSL worker endpoint");
  return info;
}

export function connection(info) {
  const key = `${info.port}:${info.secret}`;
  if (links.has(key)) return links.get(key);
  const socket = connect({ host: "127.0.0.1", port: info.port });
  const pending = new Map();
  let next = 1, greeted = false, closed = false;
  socket.setNoDelay(true);
  socket.unref();
  socket.write(frame({ secret: info.secret }));
  const timer = setTimeout(() => lost("authentication timed out"), 5000);
  timer.unref();
  const lost = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    links.delete(key);
    for (const p of pending.values()) p.resolve(refused(p.sent ? "Unknown" : "Failed", `WSL worker connection lost (${why}); ${p.sent ? "the operation may have completed: inspect the project before continuing" : "the operation was not sent"}`));
    pending.clear();
    socket.destroy();
  };
  const send = (id, p) => { p.sent = true; socket.write(frame({ id, ...p.request })); };
  readFrames(socket, ({ id, answer }) => {
    if (id === 0) {
      if (greeted || answer?.value !== "hello") return lost("invalid greeting");
      greeted = true;
      clearTimeout(timer);
      for (const [n, p] of pending) send(n, p);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (!pending.size) socket.unref();
    p.resolve(answer);
  }, (error) => lost(error.message));
  socket.on("error", (error) => lost(error.message));
  socket.on("close", () => lost("socket closed"));
  const link = {
    call(request) {
      if (closed) return Promise.resolve(refused("Failed", "WSL worker connection is closed; no call was sent"));
      return new Promise((resolve) => {
        const id = next++, p = { resolve, request, sent: false };
        pending.set(id, p);
        socket.ref();
        if (greeted) send(id, p);
      });
    },
  };
  links.set(key, link);
  return link;
}

async function invoke(fn, op, args) {
  let info, sent = args;
  try {
    info = infoFor(args.home);
    if (op === "project.init") sent = { ...args, path: await linuxPath(args.path, info) };
  } catch (error) { return refused("Failed", error.message); }
  return connection(info).call({ fn, op, args: sent, open: opened.has(args.storePath) });
}

export const call = (op, args) => invoke("call", op, args);
export const operatorCall = (op, args) => invoke("operatorCall", op, args);
export async function storeOpen({ storePath }) {
  opened.set(storePath, (opened.get(storePath) ?? 0) + 1);
  return { value: null };
}
export async function storeClose({ storePath }) {
  const left = (opened.get(storePath) ?? 1) - 1;
  if (left > 0) opened.set(storePath, left); else opened.delete(storePath);
  return { value: null };
}
export async function execOutput() { return refused("Failed", "WSL exec output is returned by its original call"); }
